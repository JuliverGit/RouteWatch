// HTTP endpoints for registration, email verification, password recovery and Google sign-in.
// The existing POST /api/login, /api/logout and /api/me stay in index.js unchanged in behaviour.
//
//   GET  /api/auth/options               which sign-in methods are available (no secrets)
//   POST /api/session/activity           a person is using the page: keeps the session from going idle (always 204)
//   GET  /api/auth/google                start Google sign-in (redirect)
//   GET  /api/auth/google/callback       Google returns here (GOOGLE_REDIRECT_URI)
//   POST /api/auth/register              { username, email, password }        -> code emailed
//   POST /api/auth/register/verify       { email, code, password }            -> passenger account + session
//   POST /api/auth/register/resend       { email }
//   POST /api/auth/password/forgot       { email }                            -> code emailed (generic answer)
//   POST /api/auth/password/reset        { email, code, password }            -> password changed, every session ended
//
// Answers about an email address are identical whether or not an account exists, and are sent BEFORE the database and email
// work is done, so neither the content nor the response time reveals anything.
import { createSession, destroySession, setSessionCookie, readCookie, createLimiter, IS_PROD } from "./auth.js";
import { permissionsFor } from "./permissions.js";
import { audit } from "./audit.js";
import { mailAvailable, mailMode } from "./mailer.js";
import { checkRegistration, startRegistration, resendRegistration, verifyRegistration, requestPasswordReset, completePasswordReset, googleAccount, CODE_TTL_MINUTES } from "./accounts.js";
import { googleConfig, beginFlow, takeFlow, sameString, exchangeCode, verifyGoogleIdToken } from "./google-auth.js";

const FLOW_COOKIE = "rw_oauth";
// SameSite=Lax (not Strict): the browser must send this cookie on the top-level redirect coming back from accounts.google.com.
// Path-limited to the Google endpoints and valid 10 minutes; it holds only a random handle, never a token.
const flowCookie = (value, maxAge) => `${FLOW_COOKIE}=${value}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Path=/api/auth/google${IS_PROD ? "; Secure" : ""}`;

export function registerAuthRoutes(app, { A, dropSockets }) {
  const WINDOW = 15 * 60_000;
  const ipLimit = { // per IP address, per kind of request
    register: createLimiter({ max: 10, windowMs: WINDOW }), verify: createLimiter({ max: 20, windowMs: WINDOW }),
    resend: createLimiter({ max: 10, windowMs: WINDOW }), forgot: createLimiter({ max: 10, windowMs: WINDOW }),
    reset: createLimiter({ max: 20, windowMs: WINDOW }), google: createLimiter({ max: 30, windowMs: WINDOW }),
  };
  const limited = (kind, req, res) => {
    const l = ipLimit[kind], wait = l.blockedFor(req.ip);
    if (wait) { res.set("Retry-After", String(wait)); res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, code: "rate_limited" }); return true; }
    l.fail(req.ip);
    return false;
  };
  const noMail = (res) => res.status(503).json({ error: "Email is not set up on this server yet, so this is not available. Contact the RouteWatch administrator.", code: "email_unavailable" });
  // Background work after a generic answer: failures are logged by code only (never the address, code or password).
  const later = (label, fn) => setImmediate(() => fn().catch((e) => console.error(`[auth] ${label} failed (${e.code || e.message})`)));
  const signIn = async (req, res, user) => {
    await destroySession(req.sessionToken); // a fresh session id after every sign-in
    setSessionCookie(res, await createSession(user));
  };

  // The idle deadline itself is moved by touchSession. The same answer with or without a session, so it reveals nothing.
  app.post("/api/session/activity", (req, res) => res.status(204).end());

  app.get("/api/auth/options", (req, res) => res.json({
    google: !!googleConfig(), email: mailAvailable(), devOutbox: mailMode() === "dev-outbox", codeMinutes: CODE_TTL_MINUTES,
  }));

  // ---- Registration ----
  app.post("/api/auth/register", A(async (req, res) => {
    if (!mailAvailable()) return noMail(res);
    if (limited("register", req, res)) return;
    const { username, email, password } = req.body ?? {};
    const r = await checkRegistration({ username, email, password });
    if (r.error) return res.status(r.status).json({ error: r.error, field: r.field, code: r.code });
    res.json({ ok: true, email: r.email }); // same answer whether or not the address is already registered
    later("registration", async () => {
      const outcome = await startRegistration({ username: r.username, email: r.email, password });
      audit({ action: "registration_started", target: r.username, ip: req.ip, detail: { outcome } });
    });
  }));

  app.post("/api/auth/register/resend", A(async (req, res) => {
    if (!mailAvailable()) return noMail(res);
    if (limited("resend", req, res)) return;
    res.json({ ok: true });
    later("registration resend", () => resendRegistration(req.body?.email));
  }));

  app.post("/api/auth/register/verify", A(async (req, res) => {
    if (limited("verify", req, res)) return;
    const { email, code, password } = req.body ?? {};
    const r = await verifyRegistration({ email, code, password });
    if (r.error) {
      audit({ action: "registration_verify_failed", outcome: "failure", ip: req.ip, detail: { reason: r.code } });
      return res.status(r.status).json({ error: r.error, code: r.code, field: r.field });
    }
    await signIn(req, res, r.user);
    audit({ action: "account_registered", actor: r.user.username, role: r.user.role, target: r.user.username, ip: req.ip, detail: { method: "email" } });
    res.status(201).json({ ...r.user, permissions: permissionsFor(r.user.role) });
  }));

  // ---- Password recovery ----
  app.post("/api/auth/password/forgot", A(async (req, res) => {
    if (!mailAvailable()) return noMail(res);
    if (limited("forgot", req, res)) return;
    if (typeof req.body?.email !== "string" || !req.body.email.includes("@")) return res.status(400).json({ error: "Enter the email address of your account.", field: "email" });
    res.json({ ok: true });
    later("password reset request", async () => {
      const r = await requestPasswordReset(req.body.email);
      if (r.username) audit({ action: "password_reset_requested", target: r.username, ip: req.ip, detail: { outcome: r.outcome } }); // unknown addresses are not recorded
    });
  }));

  app.post("/api/auth/password/reset", A(async (req, res) => {
    if (limited("reset", req, res)) return;
    const { email, code, password } = req.body ?? {};
    const r = await completePasswordReset({ email, code, password });
    if (r.error) {
      if (r.code === "invalid_code") audit({ action: "password_reset_failed", outcome: "failure", ip: req.ip, detail: { reason: r.code } });
      return res.status(r.status).json({ error: r.error, code: r.code, field: r.field });
    }
    await dropSockets((s) => s.data.user === r.username); // live connections of the ended sessions stop at once
    audit({ action: "password_reset_completed", target: r.username, ip: req.ip, detail: { signed_out: r.sessionsEnded } });
    res.json({ ok: true });
  }));

  // ---- Google ----
  app.get("/api/auth/google", (req, res) => {
    const cfg = googleConfig();
    if (!cfg) return res.redirect(303, "/?auth_error=google_unavailable");
    if (ipLimit.google.blockedFor(req.ip)) return res.redirect(303, "/?auth_error=rate_limited");
    ipLimit.google.fail(req.ip);
    const { handle, url } = beginFlow(cfg);
    res.append("Set-Cookie", flowCookie(handle, 600));
    res.redirect(302, url);
  });

  app.get("/api/auth/google/callback", A(async (req, res) => {
    const flow = takeFlow(readCookie(req, FLOW_COOKIE)); // one use only, whatever happens next
    res.append("Set-Cookie", flowCookie("", 0));
    const fail = (reason, detail) => {
      audit({ action: "google_login_failed", outcome: "failure", ip: req.ip, detail: { reason, ...detail } });
      return res.redirect(303, `/?auth_error=${reason}`);
    };
    const cfg = googleConfig();
    if (!cfg) return fail("google_unavailable");
    if (typeof req.query.error === "string") return fail(req.query.error === "access_denied" ? "google_cancelled" : "google_failed", { google: req.query.error.slice(0, 40) });
    if (!flow) return fail("google_expired");                                   // no, used or expired sign-in attempt in this browser
    if (!sameString(req.query.state, flow.state)) return fail("google_state");  // not the attempt this browser started (CSRF)
    const code = req.query.code;
    if (typeof code !== "string" || !code || code.length > 2048) return fail("google_failed", { step: "code" });
    let identity;
    try { identity = await verifyGoogleIdToken(await exchangeCode(cfg, code, flow.verifier), { clientId: cfg.id, nonce: flow.nonce }); }
    catch (e) { return fail(e.reason === "email_unverified" ? "google_email_unverified" : "google_failed", { step: e.reason ?? "unexpected" }); }
    const r = await googleAccount(identity);
    if (r.error) return fail(r.error === "email_in_use" ? "google_email_in_use" : r.error === "account_disabled" ? "account_disabled" : "google_failed", { step: r.error });
    await signIn(req, res, r.user);
    audit({ action: r.created ? "account_registered" : "google_login", actor: r.user.username, role: r.user.role, target: r.user.username, ip: req.ip, detail: { method: "google" } });
    res.redirect(303, "/");
  }));
}
