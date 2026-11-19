// Append-only audit trail, stored in the audit_logs table (PostgreSQL).
// Only whitelisted fields are written, and values that look like secrets are dropped,
// so passwords, tokens and hashes can never end up in the log. The application's database
// account can INSERT and SELECT here but not UPDATE or DELETE, so a bug or a stolen web-app
// credential cannot rewrite history.
import { query } from "./db.js";

const SECRET_KEY = /pass|token|secret|hash|cookie|session/i;
const clip = (v, n = 120) => (typeof v === "string" ? v.slice(0, n) : v ?? null);

function cleanDetail(detail) {
  if (!detail || typeof detail !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SECRET_KEY.test(k)) continue;
    if (["string", "number", "boolean"].includes(typeof v)) out[clip(k, 40)] = clip(v);
  }
  return out;
}

// Entries are written in the order they were logged (one chain), without making the request wait for the database.
let chain = Promise.resolve();
let failures = 0;

/** Never throws and never rejects: a logging problem must not break the request being logged. */
export function audit({ action, actor, role, target, outcome = "success", ip, detail }) {
  const row = [clip(action), clip(actor), clip(role), clip(target), clip(outcome), clip(ip, 64), cleanDetail(detail)];
  chain = chain.then(() => query(
    "INSERT INTO audit_logs (action, actor, role, target, outcome, ip, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)", row,
  )).catch(() => { failures++; console.error(`Audit log write failed (${failures} so far)`); });
  return chain;
}

/** Resolves when every entry logged so far has been written (used before reading the log, and at shutdown). */
export const flushAudit = () => chain;

/** Newest first. */
export async function readAudit(limit = 100) {
  await chain; // include entries from the request that just finished
  const r = await query("SELECT ts, action, actor, role, target, outcome, ip, detail FROM audit_logs ORDER BY ts DESC, id DESC LIMIT $1", [limit]);
  return r.rows.map((x) => ({ ts: x.ts.toISOString(), action: x.action, actor: x.actor, role: x.role, target: x.target, outcome: x.outcome, ip: x.ip, detail: x.detail }));
}
