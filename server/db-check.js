// Verifies the database connection and setup.  Usage: npm run db:check
// Prints where it connected (never the password), the PostgreSQL and schema versions, the privileges of the
// application account, and the number of rows per table.
import "./env.js";
import { query, ping, close, dbConfig } from "./db.js";
import { latestVersion } from "./migrate.js";

let ok = true;
const line = (pass, text) => { if (!pass) ok = false; console.log(`${pass ? "OK  " : "FAIL"} ${text}`); };
try {
  const c = dbConfig();
  console.log(`Connecting to ${c.connectionString ? "DATABASE_URL" : `${c.host}:${c.port}/${c.database} as ${c.user}`} (TLS: ${c.ssl ? (c.ssl.rejectUnauthorized ? "verified" : "on, certificate not verified") : "off"})`);
  const info = await ping();
  line(true, `connected as "${info.user}", PostgreSQL ${info.version}`);
  line(info.schema === latestVersion(), `schema version ${info.schema} (this server needs ${latestVersion()})${info.schema < latestVersion() ? " - run: npm run db:migrate" : ""}`);
  const p = (await query(
    `SELECT has_table_privilege('audit_logs', 'INSERT') AS ins, has_table_privilege('audit_logs', 'UPDATE') AS upd, has_table_privilege('audit_logs', 'DELETE') AS del,
            has_table_privilege('users', 'DELETE') AS udel, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`)).rows[0];
  line(p.ins && !p.upd && !p.del, `audit_logs is append-only for this account (insert ${p.ins}, update ${p.upd}, delete ${p.del})`);
  line(!p.super, `account is not a superuser${p.super ? " (use a least-privilege account in deployment)" : ""}`);
  for (const t of ["users", "sessions", "buses", "tracking_devices", "stops", "routes", "route_stops", "bus_route_assignments", "conductor_assignments", "service_alerts", "notifications", "pending_registrations", "password_reset_codes", "audit_logs"])
    console.log(`     ${t.padEnd(22)} ${(await query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n} row(s)`);
} catch (e) {
  line(false, `cannot use the database: ${e.message}`);
} finally { await close(); }
process.exitCode = ok ? 0 : 1;
