// User store (PostgreSQL, table "users"). Only bcrypt hashes are stored, never a password.
// This module is the single place that touches user data. Every function is async.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { query, tx, violates } from "./db.js";
import { ROLES, isRole } from "./permissions.js";

export { ROLES };
const COST = 12;
export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72; // bcrypt only uses the first 72 bytes

// Compared against when a username does not exist, so "unknown user" and
// "wrong password" take about the same time (reduces account enumeration).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), COST);

const normalize = (u) => String(u ?? "").trim().toLowerCase();

// Safe view of an account: never includes the password hash.
const publicView = (u) => ({ username: u.username, role: u.role, active: u.active !== false, createdAt: u.created_at ? u.created_at.toISOString() : null });
const COLS = "username, role, active, created_at";

export async function countUsers() { return Number((await query("SELECT count(*) AS n FROM users")).rows[0].n); }

export async function findUser(username) {
  const name = normalize(username);
  if (!USERNAME_RE.test(name)) return null; // cannot exist, so no query is needed
  const r = await query(`SELECT ${COLS} FROM users WHERE username = $1`, [name]);
  return r.rows[0] ? publicView(r.rows[0]) : null;
}
export async function listUsers() { return (await query(`SELECT ${COLS} FROM users ORDER BY created_at, username`)).rows.map(publicView); }

// ---- Email addresses (migration 004). Stored lower-case; never part of publicView, so lists and /api/users do not expose them. ----
export const EMAIL_MAX = 254;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$/;
export const normalizeEmail = (e) => String(e ?? "").trim().toLowerCase();
export const isEmail = (e) => typeof e === "string" && e.length <= EMAIL_MAX && EMAIL_RE.test(e);

/** The account a sign-in name refers to: an email address (contains "@") or a username. Returns the raw row or null. */
async function loginRow(identifier) {
  const id = String(identifier ?? "").trim();
  if (id.includes("@")) {
    const email = normalizeEmail(id);
    return isEmail(email) ? (await query("SELECT username, role, active, password_hash FROM users WHERE email = $1", [email])).rows[0] ?? null : null;
  }
  const name = normalize(id);
  return USERNAME_RE.test(name) ? (await query("SELECT username, role, active, password_hash FROM users WHERE username = $1", [name])).rows[0] ?? null : null;
}

/** The username behind a sign-in name (email or username), or null. Used only to label audit records. */
export async function findUserByLogin(identifier) { return (await loginRow(identifier))?.username ?? null; }

/**
 * Returns { username, role } when the credentials are valid and the account is active, otherwise null.
 * `identifier` is a username or an email address. An account without a password (created with Google) never matches,
 * and the comparison always runs, so "unknown account" and "wrong password" take about the same time.
 */
export async function verifyCredentials(identifier, password) {
  const user = await loginRow(identifier);
  const ok = await bcrypt.compare(String(password), user?.password_hash ?? DUMMY_HASH);
  return user && user.password_hash && ok && user.active !== false ? { username: user.username, role: user.role } : null;
}

/** bcrypt with the existing cost, for the account modules (registration, recovery codes). */
export const hashSecret = (s) => bcrypt.hash(s, COST);

/** Changes a role and/or active flag. Only these two fields can ever be changed here. */
export async function updateUser(username, changes) {
  const sets = [], vals = [];
  if ("role" in changes) {
    if (!isRole(changes.role)) throw new Error("Invalid role");
    vals.push(changes.role); sets.push(`role = $${vals.length}`);
  }
  if ("active" in changes) {
    if (typeof changes.active !== "boolean") throw new Error("Invalid status");
    vals.push(changes.active); sets.push(`active = $${vals.length}`);
  }
  if (!sets.length) return findUser(username);
  vals.push(normalize(username));
  const r = await query(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE username = $${vals.length} RETURNING ${COLS}`, vals);
  return r.rows[0] ? publicView(r.rows[0]) : null;
}

export async function createUser(username, password, role) {
  const name = normalize(username);
  if (!USERNAME_RE.test(name)) throw new Error("Username must be 3-32 characters: letters, numbers, . _ -");
  if (!isRole(role)) throw new Error(`Role must be one of: ${ROLES.join(", ")}`);
  if (typeof password !== "string" || password.length < PASSWORD_MIN) throw new Error(`Password must be at least ${PASSWORD_MIN} characters`);
  if (Buffer.byteLength(password) > PASSWORD_MAX) throw new Error(`Password must be at most ${PASSWORD_MAX} bytes`);
  try {
    await query("INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)", [name, await bcrypt.hash(password, COST), role]);
  } catch (e) {
    if (violates(e, "users_pkey")) throw new Error("That username already exists");
    throw e;
  }
  return { username: name, role };
}

/** The existing password policy (same rules as createUser). Returns an error message, or null when the password is acceptable. */
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (Buffer.byteLength(password) > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} bytes`;
  return null;
}

/**
 * Replaces the password of an EXISTING account (used by `npm run reset-password`). Never creates an account.
 * Only password_hash (and updated_at) are written; username, role, active and created_at are re-read afterwards and the
 * whole change is rolled back if any of them differs. Because role/active are not in the UPDATE, the database trigger
 * that drops conductor assignments (AFTER UPDATE OF role, active) does not fire, so assignments are untouched.
 * The account's existing sign-in sessions are ended in the same transaction, so a session opened with the old password
 * cannot outlive the reset. Returns { user, sessionsEnded } or { error } (nothing changed).
 */
export async function setPassword(username, password) {
  const name = normalize(username);
  if (!USERNAME_RE.test(name)) return { error: "No account with that username exists." };
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  const hash = await bcrypt.hash(password, COST); // hashed before the transaction, so the row lock is held only briefly
  return tx(async (c) => {
    const before = (await c.query(`SELECT ${COLS} FROM users WHERE username = $1 FOR UPDATE`, [name])).rows[0];
    if (!before) return { error: "No account with that username exists." };
    const u = await c.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE username = $1", [name, hash]);
    if (u.rowCount !== 1) throw new Error("Password update did not match exactly one account; nothing was changed.");
    const after = (await c.query(`SELECT ${COLS} FROM users WHERE username = $1`, [name])).rows[0];
    if (after.username !== before.username || after.role !== before.role || after.active !== before.active || after.created_at.getTime() !== before.created_at.getTime())
      throw new Error("Account details changed unexpectedly; nothing was changed.");
    const s = await c.query("DELETE FROM sessions WHERE username = $1", [name]);
    return { user: publicView(after), sessionsEnded: s.rowCount };
  });
}
