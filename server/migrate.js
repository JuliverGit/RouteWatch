// Applies the numbered SQL files in ./migrations to the database, once each, in order.  Usage: npm run db:migrate
// Safe to run again: applied migrations are recorded in schema_migrations and skipped. If an applied file was
// edited afterwards (its checksum changed) this stops instead of guessing.
//
// Accounts: set MIGRATE_DB_USER / MIGRATE_DB_PASSWORD to an account that may create tables (the owner). The server
// itself then runs as DB_USER, a least-privilege account that is granted only what it needs (see grantApp below).
// If MIGRATE_* is not set, DB_USER does both jobs (fine for a local demo, not recommended for deployment).
import "./env.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createOwnerPool, dbConfig } from "./db.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const LOCK = 727_001; // advisory lock id: two people running the migration at once cannot clash

const tableExists = async (client, name) => (await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${name}`])).rows[0].ok;

export async function grantApp(client, appRole) {
  const q = pg.escapeIdentifier(appRole);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${q}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE ON users, buses, tracking_devices, stops, routes TO ${q}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, route_stops, bus_route_assignments, conductor_assignments TO ${q}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE ON service_alerts TO ${q}`);   // alerts are never deleted: they end as 'resolved'
  await client.query(`GRANT SELECT, INSERT ON notifications TO ${q}`);
  await client.query(`GRANT UPDATE (read_at) ON notifications TO ${q}`);          // the only column the web server may change
  await client.query(`GRANT SELECT, INSERT ON audit_logs TO ${q}`);   // append-only: no UPDATE, no DELETE
  if (await tableExists(client, "pending_registrations")) // migration 004: unfinished sign-ups and password reset codes (short-lived, removed when used or expired)
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON pending_registrations, password_reset_codes TO ${q}`);
  await client.query(`GRANT SELECT ON schema_migrations TO ${q}`);
}

/** The highest migration number shipped with this version of the server (the server refuses to start on an older schema). */
export const latestVersion = () => Math.max(0, ...fs.readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).map((f) => Number(f.slice(0, 3))));

export async function migrate({ log = console.log } = {}) {
  const pool = createOwnerPool();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version int PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map((await client.query("SELECT version, name, checksum FROM schema_migrations")).rows.map((r) => [r.version, r]));
    const files = fs.readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    let applied = 0;
    for (const file of files) {
      const version = Number(file.slice(0, 3)), sql = fs.readFileSync(path.join(DIR, file), "utf8");
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");
      const prev = done.get(version);
      if (prev) {
        if (prev.checksum !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead of editing it.`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [version, file, checksum]);
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK"); throw e; }
      applied++; log(`applied ${file}`);
    }
    if (!applied) log("schema is up to date");
    const owner = dbConfig(process.env.MIGRATE_DB_USER || process.env.MIGRATE_DATABASE_URL ? "MIGRATE_" : "").user;
    const app = dbConfig().user;
    if (app && owner && app !== owner) { await grantApp(client, app); log(`granted the application account "${app}" its limited privileges`); }
    return { applied, latest: files.length ? Number(files.at(-1).slice(0, 3)) : 0 };
  } finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [LOCK]); } catch { /* ignore */ }
    client.release(); await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { await migrate(); }
  catch (e) { console.error(`Migration failed: ${e.message}`); process.exit(1); }
}
