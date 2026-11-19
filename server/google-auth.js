// Google sign-in (OpenID Connect, authorization code flow with PKCE). Server side only: the client secret is read from the
// environment here and is never sent to the browser.
//
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI   (server/.env; see README-DATABASE.md section 14)
//
// Flow: /api/auth/google creates a one-time flow { state, PKCE verifier, nonce } kept in server memory for 10 minutes, puts only
// a random handle in a short-lived HttpOnly cookie, and redirects to Google. The callback looks the flow up by that cookie,
// requires the returned state to match, exchanges the code (sending the PKCE verifier and the secret) and then verifies the ID
// token: RS256 signature against Google's published keys, issuer, audience, expiry, nonce and a verified email.
// Scope is "openid email" only: RouteWatch does not ask for the name, photo or anything else.
// No token is ever logged or stored.
import crypto from "node:crypto";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const FLOW_MS = 10 * 60_000, MAX_FLOWS = 5000, SKEW_S = 60;

/** The configuration, or null when Google sign-in is not set up (then the button is hidden). Never returned to the browser. */
export function googleConfig() {
  const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET, redirect = process.env.GOOGLE_REDIRECT_URI;
  return id && secret && redirect ? { id, secret, redirect } : null;
}

/** An error with a fixed reason code (safe for the audit log: never contains token data). */
class GoogleError extends Error { constructor(reason) { super(reason); this.reason = reason; } }

// ---- one-time flows ----
const flows = new Map(); // handle -> { state, verifier, nonce, exp }
const rnd = (n) => crypto.randomBytes(n).toString("base64url");

/** Starts a sign-in: returns { handle, url }. The handle goes into the cookie; the URL is where the browser is sent. */
export function beginFlow(cfg) {
  const now = Date.now();
  for (const [k, f] of flows) if (f.exp <= now) flows.delete(k);
  while (flows.size >= MAX_FLOWS) flows.delete(flows.keys().next().value); // bounded memory: the oldest flow goes first
  const handle = rnd(32), state = rnd(32), verifier = rnd(48), nonce = rnd(32);
  flows.set(handle, { state, verifier, nonce, exp: now + FLOW_MS });
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: cfg.id, redirect_uri: cfg.redirect, response_type: "code", scope: "openid email",
    state, nonce, code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { handle, url: url.toString() };
}

/** The flow for a cookie handle, removed so it can be used only once. null when missing or expired. */
export function takeFlow(handle) {
  if (typeof handle !== "string" || handle.length > 100) return null;
  const f = flows.get(handle);
  flows.delete(handle);
  return f && f.exp > Date.now() ? f : null;
}

/** Constant-time string comparison. */
export const sameString = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---- code exchange ----
/** Exchanges the authorization code for an ID token (server to Google over TLS). Throws GoogleError("token_exchange"). */
export async function exchangeCode(cfg, code, verifier) {
  let r;
  try {
    r = await fetch(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ code, client_id: cfg.id, client_secret: cfg.secret, redirect_uri: cfg.redirect, grant_type: "authorization_code", code_verifier: verifier }),
    });
  } catch { throw new GoogleError("token_unreachable"); }
  const body = await r.json().catch(() => null);
  if (!r.ok || typeof body?.id_token !== "string") throw new GoogleError(`token_exchange_${r.status}`); // the response body is not logged
  return body.id_token;
}

// ---- ID token verification ----
let jwks = { keys: [], exp: 0 };
async function googleKeys(force = false) {
  if (!force && jwks.exp > Date.now() && jwks.keys.length) return jwks.keys;
  let r;
  try { r = await fetch(JWKS_URL, { signal: AbortSignal.timeout(10_000) }); } catch { throw new GoogleError("keys_unreachable"); }
  const body = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(body?.keys)) throw new GoogleError("keys_unavailable");
  const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get("cache-control") || "")?.[1] || 3600);
  jwks = { keys: body.keys, exp: Date.now() + Math.min(maxAge, 86_400) * 1000 };
  return jwks.keys;
}

const part = (s) => { try { return JSON.parse(Buffer.from(s, "base64url").toString("utf8")); } catch { throw new GoogleError("malformed"); } };

/**
 * Verifies a Google ID token against `keys` (a JWKS key list). Pure: no network, so it can be tested with any key pair.
 * Returns { sub, email } for a valid token whose email Google has verified; throws GoogleError(reason) otherwise.
 */
export function verifyIdToken(idToken, { keys, clientId, nonce, now = Date.now() }) {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  if (parts.length !== 3) throw new GoogleError("malformed");
  const header = part(parts[0]), claims = part(parts[1]);
  if (header.alg !== "RS256") throw new GoogleError("bad_algorithm");                      // never "none", never HMAC
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) throw new GoogleError("unknown_key");
  let ok = false;
  try { ok = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }), Buffer.from(parts[2], "base64url")); }
  catch { ok = false; }
  if (!ok) throw new GoogleError("bad_signature");
  if (!ISSUERS.includes(claims.iss)) throw new GoogleError("bad_issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId) || (aud.length > 1 && claims.azp !== clientId)) throw new GoogleError("bad_audience");
  const nowS = now / 1000;
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < nowS) throw new GoogleError("expired");
  if (typeof claims.iat !== "number" || claims.iat - SKEW_S > nowS) throw new GoogleError("issued_in_future");
  if (!nonce || !sameString(claims.nonce, nonce)) throw new GoogleError("bad_nonce");
  if (typeof claims.sub !== "string" || !/^[0-9A-Za-z_-]{1,255}$/.test(claims.sub)) throw new GoogleError("bad_subject");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new GoogleError("email_unverified");
  if (typeof claims.email !== "string" || claims.email.length > 254) throw new GoogleError("no_email");
  return { sub: claims.sub, email: claims.email.toLowerCase() };
}

/** verifyIdToken with Google's current keys (fetched and cached; refreshed once if Google has rotated its keys). */
export async function verifyGoogleIdToken(idToken, opts) {
  try { return verifyIdToken(idToken, { ...opts, keys: await googleKeys() }); }
  catch (e) {
    if (e.reason !== "unknown_key") throw e;
    return verifyIdToken(idToken, { ...opts, keys: await googleKeys(true) });
  }
}
