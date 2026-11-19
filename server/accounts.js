// Public accounts: email registration with a verification code, password recovery by email code, and Google sign-in accounts.
// Storage (PostgreSQL, migration 004): users.email / email_verified_at / google_sub, pending_registrations, password_reset_codes.
//
// Rules that hold everywhere in this file:
//  * Every account created here is a PASSENGER. Roles are never taken from the request; staff roles are still given only by
//    an administrator (Users page) or the command line.
//  * Codes: 6 digits from crypto.randomInt, stored only as bcrypt hashes, valid 10 minutes, 5 attempts, single use. Only the
//    newest code counts, so requesting a new one retires the old ones. At most one code per minute and five per hour per address.
//  * Answers about email addresses are generic ("if an account exists ..."): the caller cannot learn whether an address is
//    registered. The address owner is told by email instead.
//  * A Google account is matched by Google's stable "sub" id only. An existing account with the same email is NEVER linked
//    automatically.
//  * Codes and passwords are never logged. Functions return data; the HTTP layer (auth-routes.js) writes the audit records.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { query, tx, violates } from "./db.js";
import { USERNAME_RE, passwordProblem, normalizeEmail, isEmail, hashSecret } from "./users.js";
import { sendMail } from "./mailer.js";
import { createLimiter } from "./auth.js";

export const CODE_TTL_MINUTES = 10;
export const CODE_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;
export const SENDS_PER_HOUR = 5;
const CODE_RE = /^\d{6}$/;
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
const DUMMY = bcrypt.hashSync(crypto.randomBytes(8).toString("hex"), 12); // equal work when there is nothing to compare against
const fail = (field, error, status = 400, code = "invalid") => ({ error, field, status, code });
const BAD_CODE = { error: "That code is not valid or has expired. Check the latest email or request a new code.", status: 400, code: "invalid_code" };
// Informational emails (no code) to the same address: at most one a minute, five an hour.
const noticeLimiter = createLimiter({ max: 1, windowMs: 60_000 });
const noticeHourly = createLimiter({ max: SENDS_PER_HOUR, windowMs: 3_600_000 });
const mayNotify = (email) => { if (noticeLimiter.blockedFor(email) || noticeHourly.blockedFor(email)) return false; noticeLimiter.fail(email); noticeHourly.fail(email); return true; };

const MAIL = {
  register: (code) => ({ subject: "Your RouteWatch verification code", text: `Your RouteWatch verification code is ${code}\n\nIt expires in ${CODE_TTL_MINUTES} minutes and can be used once.\n\nIf you did not try to create a RouteWatch account, ignore this email. No account is created without this code.` }),
  alreadyRegistered: () => ({ subject: "RouteWatch sign-up attempt", text: "Someone tried to create a RouteWatch account with this email address, but an account already uses it.\n\nIf it was you, sign in instead, or use \"Forgot password\". If you signed up with Google, use \"Continue with Google\".\n\nIf it was not you, no action is needed: nothing was changed." }),
  reset: (code) => ({ subject: "Your RouteWatch password reset code", text: `Your RouteWatch password reset code is ${code}\n\nIt expires in ${CODE_TTL_MINUTES} minutes and can be used once.\n\nIf you did not ask to reset your password, ignore this email. Your password stays the same.` }),
  googleOnly: () => ({ subject: "RouteWatch password reset", text: "You asked to reset your RouteWatch password, but this account signs in with Google and has no RouteWatch password.\n\nUse \"Continue with Google\" on the sign-in page.\n\nIf you did not ask for this, no action is needed." }),
};

// ---------------------------------------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------------------------------------

/** Checks the sign-up form. Returns { username, email } or a field error. The only thing it reveals is a taken USERNAME. */
export async function checkRegistration({ username, email, password }) {
  const name = String(username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return fail("username", "Username must be 3-32 characters: lowercase letters, numbers, . _ -");
  const mail = normalizeEmail(email);
  if (!isEmail(mail)) return fail("email", "Enter a valid email address.");
  const problem = passwordProblem(password);
  if (problem) return fail("password", `${problem}.`);
  if ((await query("SELECT 1 FROM users WHERE username = $1", [name])).rowCount) return fail("username", "That username is taken. Choose another one.", 409, "username_taken");
  return { username: name, email: mail };
}

/**
 * Second half of sign-up, run AFTER the generic answer has been sent (so its timing reveals nothing).
 * New address: stores the pending registration and emails a code. Address already in use: emails the owner a notice instead.
 * Returns what happened, for the audit log: "code_sent" | "throttled" | "already_registered" | "notice_throttled".
 */
export async function startRegistration({ username, email, password }) {
  if ((await query("SELECT 1 FROM users WHERE email = $1", [email])).rowCount) {
    await Promise.all([hashSecret(password), hashSecret(newCode())]); // same CPU work as a new registration (see requestPasswordReset)
    if (!mayNotify(email)) return "notice_throttled";
    await sendMail({ to: email, ...MAIL.alreadyRegistered() });
    return "already_registered";
  }
  const code = newCode();
  const [passwordHash, codeHash] = await Promise.all([hashSecret(password), hashSecret(code)]);
  const r = await tx(async (c) => {
    const row = (await c.query("SELECT sends, window_started_at, last_sent_at FROM pending_registrations WHERE email = $1 FOR UPDATE", [email])).rows[0];
    if (row && throttled(row.last_sent_at, row.window_started_at, row.sends)) return { throttled: true };
    await c.query(
      `INSERT INTO pending_registrations (email, username, password_hash, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))
       ON CONFLICT (email) DO UPDATE SET username = EXCLUDED.username, password_hash = EXCLUDED.password_hash, code_hash = EXCLUDED.code_hash,
         expires_at = EXCLUDED.expires_at, attempts = 0, last_sent_at = now(),
         sends = CASE WHEN pending_registrations.window_started_at > now() - interval '1 hour' THEN pending_registrations.sends + 1 ELSE 1 END,
         window_started_at = CASE WHEN pending_registrations.window_started_at > now() - interval '1 hour' THEN pending_registrations.window_started_at ELSE now() END`,
      [email, username, passwordHash, codeHash, CODE_TTL_MINUTES]);
    return { throttled: false };
  });
  if (r.throttled) return "throttled";
  await sendMail({ to: email, ...MAIL.register(code) });
  return "code_sent";
}

/** A new code for an unfinished registration (same username and password). Run after the generic answer. */
export async function resendRegistration(emailRaw) {
  const email = normalizeEmail(emailRaw);
  if (!isEmail(email)) return "invalid";
  const code = newCode(), codeHash = await hashSecret(code);
  const r = await tx(async (c) => {
    const row = (await c.query("SELECT sends, window_started_at, last_sent_at FROM pending_registrations WHERE email = $1 AND created_at > now() - interval '1 day' FOR UPDATE", [email])).rows[0];
    if (!row) return { none: true };
    if (throttled(row.last_sent_at, row.window_started_at, row.sends)) return { throttled: true };
    await c.query(
      `UPDATE pending_registrations SET code_hash = $2, expires_at = now() + make_interval(mins => $3), attempts = 0, last_sent_at = now(),
         sends = CASE WHEN window_started_at > now() - interval '1 hour' THEN sends + 1 ELSE 1 END,
         window_started_at = CASE WHEN window_started_at > now() - interval '1 hour' THEN window_started_at ELSE now() END
       WHERE email = $1`, [email, codeHash, CODE_TTL_MINUTES]);
    return {};
  });
  if (r.none) return "none";
  if (r.throttled) return "throttled";
  await sendMail({ to: email, ...MAIL.register(code) });
  return "code_sent";
}

/**
 * Finishes sign-up: the code AND the password chosen at sign-up must both match. Requiring the password means that someone
 * who re-submits the form with your address (and their own password) cannot end up owning the account you complete.
 * Each call uses up one attempt BEFORE checking, so guesses are limited even when requests run in parallel.
 * Returns { user } (a new passenger account) or an error.
 */
export async function verifyRegistration({ email: emailRaw, code, password }) {
  const email = normalizeEmail(emailRaw);
  if (!isEmail(email) || typeof code !== "string" || !CODE_RE.test(code.trim()) || typeof password !== "string") { await bcrypt.compare("x", DUMMY); return BAD_CODE; }
  const row = (await query(
    `UPDATE pending_registrations SET attempts = attempts + 1 WHERE email = $1 AND attempts < $2 AND expires_at > now()
     RETURNING username, password_hash, code_hash`, [email, CODE_ATTEMPTS])).rows[0];
  const [codeOk, pwOk] = await Promise.all([bcrypt.compare(code.trim(), row?.code_hash ?? DUMMY), bcrypt.compare(password, row?.password_hash ?? DUMMY)]);
  if (!row || !codeOk || !pwOk) return BAD_CODE;
  try {
    return await tx(async (c) => {
      const del = await c.query("DELETE FROM pending_registrations WHERE email = $1 AND code_hash = $2", [email, row.code_hash]); // single use
      if (del.rowCount !== 1) return BAD_CODE;
      await c.query(
        "INSERT INTO users (username, password_hash, role, email, email_verified_at) VALUES ($1, $2, 'passenger', $3, now())",
        [row.username, row.password_hash, email]);
      return { user: { username: row.username, role: "passenger" } };
    });
  } catch (e) {
    if (violates(e, "users_pkey")) return { error: "That username was taken while you were signing up. Start again with another username.", status: 409, code: "username_taken", field: "username" };
    if (violates(e, "users_email_key")) return BAD_CODE; // the address was registered meanwhile (for example with Google)
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Password recovery
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * Run AFTER the generic answer. Emails a reset code when the address belongs to an active account with a verified email and a
 * password; a Google-only account is told to keep using Google. Returns what happened (for the audit log), plus the username.
 */
export async function requestPasswordReset(emailRaw) {
  const email = normalizeEmail(emailRaw);
  if (!isEmail(email)) return { outcome: "invalid" };
  const u = (await query("SELECT username, active, password_hash, email_verified_at FROM users WHERE email = $1", [email])).rows[0];
  // Same CPU work whatever the outcome: otherwise a request sent right after this one would be delayed only for real accounts.
  if (!u || !u.active || !u.email_verified_at) { await hashSecret(newCode()); return { outcome: "no_account" }; }
  if (!u.password_hash) {
    await hashSecret(newCode());
    if (!mayNotify(email)) return { outcome: "notice_throttled", username: u.username };
    await sendMail({ to: email, ...MAIL.googleOnly() });
    return { outcome: "google_only", username: u.username };
  }
  const code = newCode(), codeHash = await hashSecret(code);
  const r = await tx(async (c) => {
    await c.query("SELECT 1 FROM users WHERE username = $1 FOR UPDATE", [u.username]); // one request at a time per account
    const s = (await c.query(
      "SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS n, max(created_at) AS last FROM password_reset_codes WHERE username = $1", [u.username])).rows[0];
    if (Number(s.n) >= SENDS_PER_HOUR || (s.last && Date.now() - s.last.getTime() < RESEND_COOLDOWN_SECONDS * 1000)) return { throttled: true };
    await c.query("INSERT INTO password_reset_codes (username, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))", [u.username, codeHash, CODE_TTL_MINUTES]);
    return {};
  });
  if (r.throttled) return { outcome: "throttled", username: u.username };
  await sendMail({ to: email, ...MAIL.reset(code) });
  return { outcome: "code_sent", username: u.username };
}

/**
 * Sets a new password with the newest unused reset code. On success every reset code of the account is retired and every
 * session of the account is ended, in one transaction. Returns { username, sessionsEnded } or an error.
 */
export async function completePasswordReset({ email: emailRaw, code, password }) {
  const problem = passwordProblem(password);
  if (problem) return fail("password", `${problem}.`);
  const email = normalizeEmail(emailRaw);
  const u = isEmail(email) ? (await query("SELECT username FROM users WHERE email = $1 AND active AND password_hash IS NOT NULL", [email])).rows[0] : null;
  const row = u && typeof code === "string" && CODE_RE.test(code.trim()) ? (await query(
    `UPDATE password_reset_codes SET attempts = attempts + 1
      WHERE id = (SELECT id FROM password_reset_codes WHERE username = $1 AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC, id DESC LIMIT 1)
        AND attempts < $2
      RETURNING id, code_hash`, [u.username, CODE_ATTEMPTS])).rows[0] : null;
  const ok = await bcrypt.compare(String(code ?? "").trim(), row?.code_hash ?? DUMMY);
  if (!row || !ok) return BAD_CODE;
  const newHash = await hashSecret(password);
  return tx(async (c) => {
    const used = await c.query("UPDATE password_reset_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL", [row.id]);
    if (used.rowCount !== 1) return BAD_CODE; // already used by a parallel request
    await c.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE username = $1", [u.username, newHash]); // password only: role, status, assignments untouched
    await c.query("UPDATE password_reset_codes SET consumed_at = now() WHERE username = $1 AND consumed_at IS NULL", [u.username]);
    const s = await c.query("DELETE FROM sessions WHERE username = $1", [u.username]);
    return { username: u.username, sessionsEnded: s.rowCount };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Google accounts
// ---------------------------------------------------------------------------------------------------------------------------

/** A free username derived from the email's local part (maria.cruz@gmail.com -> maria.cruz, or maria.cruz-4821 when taken). */
async function freeUsername(c, email) {
  let base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_.-]/g, "").replace(/^[._-]+/, "").slice(0, 24);
  if (base.length < 3) base = `rider${base}`;
  for (let i = 0; i < 12; i++) {
    const name = i === 0 ? base : `${base}-${crypto.randomInt(1000, 10000)}`;
    if (!(await c.query("SELECT 1 FROM users WHERE username = $1", [name])).rowCount) return name;
  }
  return `rider-${crypto.randomBytes(5).toString("hex")}`;
}

/**
 * Signs in (or signs up) with a VERIFIED Google identity { sub, email } (google-auth.js has already checked the ID token).
 *  - an account with this Google id: signed in with ITS OWN role (nothing about it changes)
 *  - none, and no account uses the email: a new passenger account is created (email verified by Google, no password)
 *  - none, but an account already uses the email: refused. It is not linked automatically, because only that account's own
 *    password should be able to decide that.
 * Returns { user, created } or { error: "account_disabled" | "email_in_use" }.
 */
export async function googleAccount({ sub, email: emailRaw }) {
  const email = normalizeEmail(emailRaw);
  try {
    return await tx(async (c) => {
      const known = (await c.query("SELECT username, role, active FROM users WHERE google_sub = $1 FOR SHARE", [sub])).rows[0];
      if (known) return known.active ? { user: { username: known.username, role: known.role }, created: false } : { error: "account_disabled" };
      if (!isEmail(email)) return { error: "email_invalid" };
      if ((await c.query("SELECT 1 FROM users WHERE email = $1", [email])).rowCount) return { error: "email_in_use" };
      const username = await freeUsername(c, email);
      await c.query(
        "INSERT INTO users (username, password_hash, role, email, email_verified_at, google_sub) VALUES ($1, NULL, 'passenger', $2, now(), $3)",
        [username, email, sub]);
      await c.query("DELETE FROM pending_registrations WHERE email = $1", [email]); // Google proved the address; an unfinished sign-up for it is void
      return { user: { username, role: "passenger" }, created: true };
    });
  } catch (e) {
    if (violates(e, "users_email_key")) return { error: "email_in_use" };
    if (violates(e, "users_google_sub_key") || violates(e, "users_pkey")) return { error: "retry" }; // a parallel sign-in won the race
    throw e;
  }
}

function throttled(lastSentAt, windowStartedAt, sends) {
  const now = Date.now();
  if (now - lastSentAt.getTime() < RESEND_COOLDOWN_SECONDS * 1000) return true;
  return now - windowStartedAt.getTime() < 3_600_000 && sends >= SENDS_PER_HOUR;
}

// Housekeeping: unfinished sign-ups and old reset codes are removed (they are already unusable once expired).
setInterval(() => {
  query("DELETE FROM pending_registrations WHERE expires_at < now() - interval '1 day'").catch(() => {});
  query("DELETE FROM password_reset_codes WHERE created_at < now() - interval '1 day'").catch(() => {});
}, 3_600_000).unref();
