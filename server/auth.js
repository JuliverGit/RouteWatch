// Sessions, login rate limiting and request guards.
import crypto from "node:crypto";
import { query } from "./db.js";
import { can, isRole } from "./permissions.js";
import { audit } from "./audit.js";

const COOKIE = "rw_session";
const SESSION_MS = Number(process.env.SESSION_MINUTES || 120) * 60_000; // absolute lifetime, not extended by activity
const IDLE_S = Number(process.env.SESSION_IDLE_MINUTES || 30) * 60;      // ...and a session unused for this long ends too
export const IS_PROD = process.env.NODE_ENV === "production";
export const ALLOWED_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

// ---- Server-side sessions (PostgreSQL, table "sessions": they survive a server restart) ----
// The browser holds a random token; only its SHA-256 hash is stored.
const digest = (token) => crypto.createHash("sha256").update(token).digest("hex");
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

export async function createSession(user) {
  const token = crypto.randomBytes(32).toString("base64url");
  // Only the username is stored. The role is NOT copied here: it is re-read from the user store on every
  // request (the JOIN in loadUser), so role changes and deactivation take effect immediately.
  await query("INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))", [digest(token), user.username, SESSION_MS / 1000]);
  return token;
}
export async function destroySession(token) { if (typeof token === "string" && TOKEN_RE.test(token)) await query("DELETE FROM sessions WHERE token_hash = $1", [digest(token)]); }
export const destroyUserSessions = (username) => query("DELETE FROM sessions WHERE username = $1", [username]);

// Expired or idle sessions are never accepted (see loadUser); this just removes the old rows.
setInterval(() => { query("DELETE FROM sessions WHERE expires_at <= now() OR last_seen_at <= now() - make_interval(secs => $1)", [IDLE_S]).catch(() => {}); }, 60_000).unref();

// ---- Cookie helpers ----
export function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const cookieAttrs = `HttpOnly; SameSite=Strict; Path=/${IS_PROD ? "; Secure" : ""}`;
export const setSessionCookie = (res, token) =>
  res.append("Set-Cookie", `${COOKIE}=${token}; Max-Age=${Math.floor(SESSION_MS / 1000)}; ${cookieAttrs}`);
export const clearSessionCookie = (res) => res.append("Set-Cookie", `${COOKIE}=; Max-Age=0; ${cookieAttrs}`);

// ---- Middleware ----
/**
 * Finds the signed-in user for a request (HTTP or WebSocket handshake) and sets req.user / req.sessionToken.
 * Identity comes from the server-side session; the role comes from the user store.
 * Nothing the client sends (body, headers, query) can set either of them.
 */
export async function loadUser(req, { touch = false } = {}) {
  const token = readCookie(req, COOKIE);
  req.sessionToken = token;
  req.user = null;
  if (!token || !TOKEN_RE.test(token)) return;
  // Valid = not past its absolute expiry AND used within the idle limit.
  const r = await query(
    `SELECT u.username, u.role, u.active, s.last_seen_at < now() - interval '60 seconds' AS touch_due
       FROM sessions s JOIN users u ON u.username = s.username
      WHERE s.token_hash = $1 AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(secs => $2)`, [digest(token), IDLE_S]);
  const account = r.rows[0];
  if (!account) return;
  if (account.active && isRole(account.role)) {
    req.user = { username: account.username, role: account.role };
    // An HTTP request is activity: move the idle deadline (at most once a minute, so requests do not each write).
    if (touch && account.touch_due) await query("UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1", [digest(token)]);
  } else await destroySession(token); // account deactivated, or holds no valid role
}

/** Express middleware. If the database cannot be reached the request is refused (fail closed), never treated as "signed out". */
export function attachUser(req, res, next) {
  loadUser(req, { touch: true }).then(() => next(), (e) => {
    console.error(`[auth] session lookup failed (${e.code || e.message})`);
    res.status(503).json({ error: "The service is temporarily unavailable. Please try again." });
  });
}

/** 401 when not signed in. */
export const requireAuth = () => (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: "Please sign in." });

/** Records and sends a 403 (the user is signed in but lacks the permission). */
export function forbid(req, res, permission) {
  audit({
    action: "access_denied", actor: req.user?.username, role: req.user?.role, outcome: "denied", ip: req.ip,
    detail: { method: req.method, path: req.originalUrl.split("?")[0], permission },
  });
  return res.status(403).json({ error: "You do not have permission to do that." });
}

/** Default deny: 401 when not signed in, 403 unless the user's role grants the permission. */
export const requirePermission = (permission) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  if (!can(req.user.role, permission)) return forbid(req, res, permission);
  next();
};

/** CSRF defence for cookie auth: JSON bodies only, and a browser Origin (if sent) must be ours. */
export function csrfGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (origin && origin !== ALLOWED_ORIGIN) return res.status(403).json({ error: "Request blocked." });
  if (!req.is("application/json")) return res.status(415).json({ error: "Unsupported request." });
  next();
}

export function securityHeaders(_req, res, next) {
  res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
  next();
}

// ---- Login rate limiting (in memory) ----
export function createLimiter({ max, windowMs }) {
  const hits = new Map();
  const live = (key) => {
    const e = hits.get(key);
    if (e && e.resetAt <= Date.now()) { hits.delete(key); return null; }
    return e || null;
  };
  setInterval(() => { for (const k of hits.keys()) live(k); }, 60_000).unref();
  return {
    /** Seconds until allowed again, or 0 when the key is not blocked. */
    blockedFor(key) { const e = live(key); return e && e.count >= max ? Math.ceil((e.resetAt - Date.now()) / 1000) : 0; },
    fail(key) { const e = live(key) || { count: 0, resetAt: Date.now() + windowMs }; e.count++; hits.set(key, e); },
    reset(key) { hits.delete(key); },
  };
}
