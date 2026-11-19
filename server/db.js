// PostgreSQL access: one connection pool for the whole server, built from environment variables only.
// No credential is written in the code, and nothing here is ever sent to the browser.
//
//   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD   connection (or one DATABASE_URL instead)
//   DB_SSL            off (default for localhost) | require | verify-full   (+ DB_SSL_CA = path to the CA certificate)
//   DB_POOL_MAX, DB_CONNECT_TIMEOUT_MS, DB_STATEMENT_TIMEOUT_MS
//
// Every query in the application uses $1, $2 ... placeholders: values are sent to PostgreSQL separately
// from the SQL text, so input can never change the meaning of a query (SQL injection).
import fs from "node:fs";
import pg from "pg";

const num = (name, fallback) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : fallback; };

/** Reads the connection settings. `prefix` "MIGRATE_" lets the migration tools use a separate (owner) account. */
export function dbConfig(prefix = "") {
  const url = process.env[`${prefix}DATABASE_URL`] || (prefix ? "" : process.env.DATABASE_URL);
  const base = url ? { connectionString: url } : {
    host: process.env.DB_HOST || "localhost",
    port: num("DB_PORT", 5432),
    database: process.env.DB_NAME,
    user: process.env[`${prefix}DB_USER`] || (prefix ? process.env.DB_USER : undefined),
    password: process.env[`${prefix}DB_PASSWORD`] ?? (prefix ? process.env.DB_PASSWORD : undefined),
  };
  if (!url) {
    for (const k of ["database", "user"]) if (!base[k]) throw new Error(`Database is not configured: set ${k === "database" ? "DB_NAME" : `${prefix}DB_USER`} (see .env.example).`);
    if (!base.password) throw new Error(`Database is not configured: set ${prefix}DB_PASSWORD (see .env.example).`);
  }
  const host = url ? new URL(url).hostname : base.host;
  const mode = (process.env.DB_SSL || (["localhost", "127.0.0.1", "::1"].includes(host) ? "off" : "require")).toLowerCase();
  let ssl = false;
  if (mode === "require") ssl = { rejectUnauthorized: false };           // encrypted, certificate not checked
  else if (mode === "verify-full") ssl = { rejectUnauthorized: true, ...(process.env.DB_SSL_CA ? { ca: fs.readFileSync(process.env.DB_SSL_CA, "utf8") } : {}) };
  else if (mode !== "off") throw new Error("DB_SSL must be off, require or verify-full.");
  return {
    ...base, ssl,
    max: num("DB_POOL_MAX", 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: num("DB_CONNECT_TIMEOUT_MS", 5_000),
    statement_timeout: num("DB_STATEMENT_TIMEOUT_MS", 10_000),                // a runaway query is cancelled by the server
    idle_in_transaction_session_timeout: 15_000,                               // a stuck transaction cannot hold locks forever
    application_name: "routewatch",
  };
}

function makePool(prefix = "") {
  const p = new pg.Pool(dbConfig(prefix));
  // An idle connection can be dropped (database restart, network). The pool replaces it; log only the error code.
  p.on("error", (e) => console.error(`[db] idle connection error (${e.code || "unknown"})`));
  return p;
}

let pool = null;
const getPool = () => (pool ??= makePool()); // created on first use, so importing this file never connects

/** Runs one parameterised query. Always pass user-supplied values in `params`, never inside `text`. */
export const query = (text, params) => getPool().query(text, params);

/**
 * Runs fn(client) in a transaction: COMMIT when it finishes, ROLLBACK when it throws or returns { error }
 * (the business-rule errors used by the data modules). Every query in fn must use the `client` it is given.
 * If PostgreSQL aborts the transaction because of a deadlock or a serialization conflict (codes 40P01, 40001),
 * the whole function is run again (up to 3 times); fn must therefore only touch the database.
 */
export async function tx(fn) {
  for (let attempt = 1; ; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const r = await fn(client);
      if (r && r.error) { await client.query("ROLLBACK"); return r; }
      await client.query("COMMIT");
      return r;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
      if ((e.code === "40P01" || e.code === "40001") && attempt < 3) continue;
      throw e;
    } finally { client.release(); }
  }
}

/** Serialises changes to one area (for example the route network) across all connections and server instances. Released at COMMIT/ROLLBACK. */
export const advisoryLock = (client, key) => client.query("SELECT pg_advisory_xact_lock($1)", [key]);

/** Is this error a violation of the named unique/check/foreign-key constraint? */
export const violates = (e, constraint) => !!e && ["23505", "23503", "23514"].includes(e.code) && (!constraint || e.constraint === constraint);

/** Connectivity check for startup and `npm run db:check`. Returns the server version and the applied schema version. */
export async function ping() {
  const r = await query("SELECT current_user AS who, current_setting('server_version') AS version");
  let schema = 0;
  try { schema = (await query("SELECT COALESCE(max(version), 0) AS v FROM schema_migrations")).rows[0].v; } catch { /* not migrated yet */ }
  return { user: r.rows[0].who, version: r.rows[0].version, schema: Number(schema) };
}

export async function close() { if (pool) { const p = pool; pool = null; await p.end(); } }

/** A separate pool for tools that need the owner account (migrations, import). Caller must end() it. */
export const createOwnerPool = () => makePool(process.env.MIGRATE_DB_USER || process.env.MIGRATE_DATABASE_URL ? "MIGRATE_" : "");
