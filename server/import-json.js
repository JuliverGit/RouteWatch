// One-time (and safely repeatable) import of the old JSON storage into PostgreSQL.
//
//   npm run db:import                    import server/data/*.json and audit.log
//   npm run db:import -- --dry-run       only read and validate the files, change nothing (needs no database)
//   npm run db:import -- --dir <folder>  read the files from another folder (default: server/data)
//
// What it does, in order:
//   1. BACKUP   copies every source file into <data>/backups/pre-postgres-<time>/ with a SHA-256 manifest and checks the copies.
//   2. VALIDATE reads the files and checks every record against the same rules the database enforces. Nothing is dropped silently:
//               each problem is listed with what was done about it (corrected / quarantined / rejected).
//   3. LOAD     inserts everything in ONE transaction (all or nothing). Existing rows are never overwritten, so running it again is safe.
//   4. VERIFY   re-reads PostgreSQL and compares it with the source: record counts, password hashes, every field, relationships.
// The original files are only ever READ. They are not changed, moved or deleted.
import "./env.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOwnerPool } from "./db.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const dirArg = args.includes("--dir") ? path.resolve(args[args.indexOf("--dir") + 1] || "") : null;
const DATA = dirArg || path.join(HERE, "data");
const pick = (env, name) => (dirArg ? path.join(dirArg, name) : process.env[env] || path.join(DATA, name));
const FILES = {
  users: pick("USERS_FILE", "users.json"), buses: pick("BUSES_FILE", "buses.json"), devices: pick("DEVICES_FILE", "devices.json"),
  network: pick("NETWORK_FILE", "network.json"), audit: pick("AUDIT_FILE", "audit.log"),
};

// ---- the same rules as the application and the database ----
const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/, BCRYPT_RE = /^\$2[aby]\$[0-9]{2}\$.{53}$/;
const ID_RE = /^[A-Z0-9][A-Z0-9-]{1,15}$/, PLATE_RE = /^[A-Z0-9][A-Z0-9 -]{2,11}$/, DEVICE_RE = /^[a-z0-9_-]{3,32}$/, HASH_RE = /^[0-9a-f]{64}$/;
const ROLES = ["admin", "dispatcher", "conductor", "passenger"], BUS_STATUS = ["active", "inactive", "maintenance"], ACTIVE_STATUS = ["active", "inactive"], SOURCES = ["simulation", "gps"];
const SECRET_KEY = /pass|token|secret|hash|cookie|session/i;

const issues = [];   // { table, key, level: corrected | quarantined | rejected | info, reason, action }
const issue = (table, key, level, reason, action) => issues.push({ table, key: String(key ?? ""), level, reason, action });
const str = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : null);
const date = (v) => { const d = new Date(v); return v && !Number.isNaN(d.getTime()) ? d : null; };
const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ---- 1. read ----
const found = {}, raw = {};
for (const [k, f] of Object.entries(FILES)) if (fs.existsSync(f)) found[k] = f;
if (!Object.keys(found).length) { console.error(`No JSON files found (looked in ${DATA}). Nothing to import.`); process.exit(1); }
function readJson(k, fallback) {
  if (!found[k]) return fallback;
  try { return JSON.parse(fs.readFileSync(found[k], "utf8")); }
  catch (e) { console.error(`ABORTED: ${path.basename(found[k])} is not valid JSON (${e.message}). Restore it from a backup or fix it, then run the import again. Nothing was changed.`); process.exit(1); }
}
raw.users = readJson("users", []); raw.buses = readJson("buses", []); raw.devices = readJson("devices", []); raw.network = readJson("network", {});
for (const k of ["users", "buses", "devices"]) if (!Array.isArray(raw[k])) { console.error(`ABORTED: ${path.basename(found[k])} should contain a list. Nothing was changed.`); process.exit(1); }
if (!raw.network || typeof raw.network !== "object" || Array.isArray(raw.network)) { console.error("ABORTED: network.json should contain an object. Nothing was changed."); process.exit(1); }
const auditLines = found.audit ? fs.readFileSync(found.audit, "utf8").split("\n").filter((l) => l.trim()) : [];

// ---- 2. validate and normalise ----
const plan = { users: [], buses: [], devices: [], stops: [], routes: [], routeStops: [], assignments: [], audit: [] };
const sourceCount = { users: raw.users.length, buses: raw.buses.length, devices: raw.devices.length, stops: (raw.network.stops ?? []).length, routes: (raw.network.routes ?? []).length,
  routeStops: (raw.network.routeStops ?? []).length, assignments: (raw.network.assignments ?? []).length, audit: auditLines.length };

// users
{
  const seen = new Set();
  for (const u of raw.users) {
    const name = str(u?.username)?.toLowerCase();
    if (!name || !USERNAME_RE.test(name)) { issue("users", name ?? "(missing)", "rejected", "username is not valid", "not imported; create the account again with npm run seed-user"); continue; }
    if (seen.has(name)) { issue("users", name, "rejected", "duplicate username", "first record kept, this one not imported"); continue; }
    if (typeof u.hash !== "string" || !BCRYPT_RE.test(u.hash)) { issue("users", name, "rejected", "no valid bcrypt password hash", "not imported; create the account again with npm run seed-user"); continue; }
    seen.add(name);
    let role = u.role, active = u.active !== false;
    if (!ROLES.includes(role)) {
      issue("users", name, "quarantined", `role "${clip(String(u.role), 20)}" is not valid`, "imported as an INACTIVE passenger; an administrator must assign the correct role");
      role = "passenger"; active = false;
    }
    const created = date(u.createdAt);
    if (u.createdAt && !created) issue("users", name, "corrected", "createdAt is not a valid date", "set to the import time");
    plan.users.push({ username: name, hash: u.hash, role, active, createdAt: created });
  }
}
// buses (plus the buses that devices point at)
const busById = new Map(), plateSeen = new Map();
{
  for (const b of raw.buses) {
    const id = str(b?.busId)?.toUpperCase();
    if (!id || !ID_RE.test(id)) { issue("buses", id ?? "(missing)", "rejected", "bus ID is not valid", "not imported"); continue; }
    if (busById.has(id)) { issue("buses", id, "rejected", "duplicate bus ID", "first record kept, this one not imported"); continue; }
    let name = str(b.name); if (!name || name.length < 2 || name.length > 60) { issue("buses", id, "corrected", "name missing or not 2-60 characters", "bus ID used as the name"); name = id; }
    let plate = null;
    if (b.plate != null && b.plate !== "") {
      const p = str(b.plate)?.toUpperCase();
      if (!p || !PLATE_RE.test(p)) issue("buses", id, "corrected", "plate number is not valid", "plate left empty; an administrator must enter it");
      else if (plateSeen.has(p.replace(/[\s-]/g, ""))) { issue("buses", id, "corrected", `plate ${p} is already used by bus ${plateSeen.get(p.replace(/[\s-]/g, ""))}`, "plate left empty; an administrator must check which bus owns it"); }
      else { plate = p; plateSeen.set(p.replace(/[\s-]/g, ""), id); }
    }
    let capacity = null;
    if (b.capacity != null) { if (Number.isInteger(b.capacity) && b.capacity >= 1 && b.capacity <= 120) capacity = b.capacity; else issue("buses", id, "corrected", "capacity is not a whole number from 1 to 120", "capacity left empty"); }
    let model = null;
    if (b.model != null && b.model !== "") { const m = str(b.model); if (m && m.length >= 2 && m.length <= 60) model = m; else issue("buses", id, "corrected", "model is not 2-60 characters", "model left empty"); }
    let status = b.status;
    if (!BUS_STATUS.includes(status)) { issue("buses", id, "corrected", `status "${clip(String(b.status), 20)}" is not valid`, "set to inactive (out of service) for safety"); status = "inactive"; }
    busById.set(id, { busId: id, name, plate, capacity, model, status, createdAt: date(b.createdAt), updatedAt: date(b.updatedAt) });
  }
  plan.buses = [...busById.values()];
}
// devices
{
  const ids = new Set(), tokens = new Set(), activeBus = new Set();
  for (const d of raw.devices) {
    const id = str(d?.deviceId)?.toLowerCase();
    if (!id || !DEVICE_RE.test(id)) { issue("tracking_devices", id ?? "(missing)", "rejected", "device ID is not valid", "not imported"); continue; }
    if (ids.has(id)) { issue("tracking_devices", id, "rejected", "duplicate device ID", "first record kept"); continue; }
    const busId = str(d.busId)?.toUpperCase();
    if (!busId || !ID_RE.test(busId)) { issue("tracking_devices", id, "rejected", `bus ID "${clip(String(d.busId), 20)}" is not a valid bus ID`, "not imported; register the device again for a valid bus"); continue; }
    if (!SOURCES.includes(d.source)) { issue("tracking_devices", id, "rejected", "source is not simulation or gps", "not imported"); continue; }
    if (typeof d.tokenHash !== "string" || !HASH_RE.test(d.tokenHash)) { issue("tracking_devices", id, "rejected", "no valid token hash", "not imported; register the device again to get a new token"); continue; }
    if (tokens.has(d.tokenHash)) { issue("tracking_devices", id, "rejected", "same token as another device", "not imported"); continue; }
    if (!busById.has(busId)) {
      const nm = str(d.busName); busById.set(busId, { busId, name: nm && nm.length >= 2 && nm.length <= 60 ? nm : busId, plate: null, capacity: null, model: null, status: "active", createdAt: date(d.createdAt), updatedAt: null });
      plan.buses.push(busById.get(busId));
      issue("buses", busId, "info", "a tracking device points at this bus but the bus had no record", "bus record created from the device (plate and capacity empty)");
    }
    let active = d.active !== false;
    if (active && activeBus.has(busId)) { issue("tracking_devices", id, "corrected", `bus ${busId} already has another active device`, "imported as inactive"); active = false; }
    if (active) activeBus.add(busId);
    ids.add(id); tokens.add(d.tokenHash);
    plan.devices.push({ deviceId: id, busId, source: d.source, active, tokenHash: d.tokenHash, createdAt: date(d.createdAt) });
  }
}
// network
const stopById = new Map(), routeById = new Map();
{
  const nameSeen = new Set(), stopsRaw = Array.isArray(raw.network.stops) ? raw.network.stops : [];
  for (const s of stopsRaw) {
    const id = str(s?.stopId)?.toUpperCase();
    if (!id || !ID_RE.test(id)) { issue("stops", id ?? "(missing)", "rejected", "stop ID is not valid", "not imported"); continue; }
    if (stopById.has(id)) { issue("stops", id, "rejected", "duplicate stop ID", "first record kept"); continue; }
    let name = str(s.name);
    if (!name || name.length < 2 || name.length > 80) { issue("stops", id, "rejected", "name is missing or not 2-80 characters", "not imported"); continue; }
    if (!(typeof s.lat === "number" && typeof s.lng === "number" && Number.isFinite(s.lat) && Number.isFinite(s.lng) && Math.abs(s.lat) <= 90 && Math.abs(s.lng) <= 180)) {
      issue("stops", id, "rejected", "coordinates are missing or out of range", "not imported (coordinates are never invented); routes lose this stop"); continue; }
    if (nameSeen.has(name.toLowerCase())) { const n2 = `${name} (${id})`.slice(0, 80); issue("stops", id, "corrected", `name "${name}" is already used by another stop`, `renamed to "${n2}"`); name = n2; }
    nameSeen.add(name.toLowerCase());
    let status = s.status; if (!ACTIVE_STATUS.includes(status)) { issue("stops", id, "corrected", "status is not active or inactive", "set to inactive"); status = "inactive"; }
    const address = typeof s.address === "string" && s.address.trim() && s.address.length <= 200 ? s.address.trim() : null;
    stopById.set(id, { stopId: id, name, address, lat: s.lat, lng: s.lng, status, createdAt: date(s.createdAt), updatedAt: date(s.updatedAt) });
  }
  plan.stops = [...stopById.values()];
  const routesRaw = Array.isArray(raw.network.routes) ? raw.network.routes : [], rname = new Set();
  for (const r of routesRaw) {
    const id = str(r?.routeId)?.toUpperCase();
    if (!id || !ID_RE.test(id)) { issue("routes", id ?? "(missing)", "rejected", "route ID is not valid", "not imported"); continue; }
    if (routeById.has(id)) { issue("routes", id, "rejected", "duplicate route ID", "first record kept"); continue; }
    let name = str(r.name);
    if (!name || name.length < 2 || name.length > 80) { issue("routes", id, "rejected", "name is missing or not 2-80 characters", "not imported"); continue; }
    const sp = str(r.startPoint), dest = str(r.destination);
    if (!sp || sp.length < 2 || sp.length > 80 || !dest || dest.length < 2 || dest.length > 80) { issue("routes", id, "rejected", "starting point or destination is missing", "not imported"); continue; }
    if (rname.has(name.toLowerCase())) { const n2 = `${name} (${id})`.slice(0, 80); issue("routes", id, "corrected", `name "${name}" is already used by another route`, `renamed to "${n2}"`); name = n2; }
    rname.add(name.toLowerCase());
    let status = r.status; if (!ACTIVE_STATUS.includes(status)) { issue("routes", id, "corrected", "status is not active or inactive", "set to inactive"); status = "inactive"; }
    const description = typeof r.description === "string" && r.description.trim() && r.description.length <= 200 ? r.description.trim() : null;
    routeById.set(id, { routeId: id, name, description, startPoint: sp, destination: dest, status, createdAt: date(r.createdAt), updatedAt: date(r.updatedAt) });
  }
  plan.routes = [...routeById.values()];
  // ordered stops of each route
  const byRoute = new Map();
  (Array.isArray(raw.network.routeStops) ? raw.network.routeStops : []).forEach((x, i) => {
    const rid = str(x?.routeId)?.toUpperCase(), sid = str(x?.stopId)?.toUpperCase();
    if (!routeById.has(rid)) { issue("route_stops", `${rid}/${sid}`, "rejected", "the route does not exist (or was not imported)", "link not imported"); return; }
    if (!stopById.has(sid)) { issue("route_stops", `${rid}/${sid}`, "rejected", "the stop does not exist (or was not imported)", "link not imported"); return; }
    if (!byRoute.has(rid)) byRoute.set(rid, []);
    byRoute.get(rid).push({ stopId: sid, position: Number.isInteger(x.position) ? x.position : Infinity, i });
  });
  for (const [rid, list] of byRoute) {
    list.sort((a, b) => a.position - b.position || a.i - b.i);
    const seen = new Set(); let n = 0, renumbered = false;
    for (const x of list) {
      if (seen.has(x.stopId)) { issue("route_stops", `${rid}/${x.stopId}`, "rejected", "the stop is listed twice on the route", "first entry kept"); continue; }
      seen.add(x.stopId); n++;
      if (x.position !== n) renumbered = true;
      plan.routeStops.push({ routeId: rid, stopId: x.stopId, position: n });
    }
    if (renumbered) issue("route_stops", rid, "corrected", "stop positions had gaps, repeats or were missing", "renumbered 1..n in the saved order");
  }
  const bseen = new Set();
  for (const a of Array.isArray(raw.network.assignments) ? raw.network.assignments : []) {
    const busId = str(a?.busId)?.toUpperCase(), routeId = str(a?.routeId)?.toUpperCase(), key = `${busId}→${routeId}`;
    if (bseen.has(busId)) { issue("bus_route_assignments", key, "rejected", "the bus is assigned to more than one route", "first assignment kept"); continue; }
    const bus = busById.get(busId), route = routeById.get(routeId);
    if (!bus) { issue("bus_route_assignments", key, "rejected", "the bus does not exist", "not imported"); continue; }
    if (!route) { issue("bus_route_assignments", key, "rejected", "the route does not exist", "not imported"); continue; }
    if (bus.status !== "active") { issue("bus_route_assignments", key, "rejected", "the bus is not Active", "not imported (an inactive bus cannot be on a route)"); continue; }
    if (route.status !== "active") { issue("bus_route_assignments", key, "rejected", "the route is not active", "not imported"); continue; }
    bseen.add(busId); plan.assignments.push({ busId, routeId, assignedAt: date(a.assignedAt) });
  }
}
// audit log: one JSON object per line
{
  let bad = 0;
  auditLines.forEach((line, i) => {
    let e; try { e = JSON.parse(line); } catch { e = null; }
    const ts = e && date(e.ts), action = e && typeof e.action === "string" && e.action ? e.action.slice(0, 120) : null;
    if (!e || typeof e !== "object" || !ts || !action) { bad++; if (bad <= 50) issue("audit_logs", `line ${i + 1}`, "rejected", "damaged or incomplete log line", "not imported (the line is still in the original file)"); return; }
    let detail = null;
    if (e.detail && typeof e.detail === "object" && !Array.isArray(e.detail)) { // scrubbed again, in case an older version ever logged a sensitive-looking key
      detail = {}; for (const [k, v] of Object.entries(e.detail)) if (!SECRET_KEY.test(k) && ["string", "number", "boolean"].includes(typeof v)) detail[k.slice(0, 40)] = typeof v === "string" ? v.slice(0, 120) : v;
    }
    plan.audit.push({ ts, action, actor: clip(e.actor, 120), role: clip(e.role, 120), target: clip(e.target, 120), outcome: clip(e.outcome, 120) || "success", ip: clip(e.ip, 64), detail });
  });
  if (bad > 50) issue("audit_logs", "(more)", "rejected", `${bad - 50} more damaged lines (only the first 50 are listed)`, "not imported");
}

// ---- report helpers ----
const rejectedBy = (t) => issues.filter((x) => x.table === t && x.level === "rejected").length;
const TABLES = [["users", "users", "users"], ["buses", "buses", "buses"], ["devices", "tracking_devices", "devices"], ["stops", "stops", "stops"], ["routes", "routes", "routes"],
  ["routeStops", "route_stops", "route_stops"], ["assignments", "bus_route_assignments", "bus_route_assignments"], ["audit", "audit_logs", "audit_logs"]];
function printIssues() {
  if (!issues.length) { console.log("No problems found in the source data."); return; }
  const by = { quarantined: [], rejected: [], corrected: [], info: [] };
  for (const x of issues) by[x.level].push(x);
  console.log(`\nRecords that need attention (${issues.length}):`);
  for (const lv of ["rejected", "quarantined", "corrected", "info"]) for (const x of by[lv]) console.log(`  ${lv.toUpperCase().padEnd(11)} ${x.table} ${x.key}: ${x.reason} -> ${x.action}`);
}
console.log(`RouteWatch JSON -> PostgreSQL import${DRY ? " (DRY RUN: nothing will be written)" : ""}`);
console.log("Source files:"); for (const [k, f] of Object.entries(FILES)) console.log(`  ${k.padEnd(8)} ${found[k] ? f : "(not found, skipped)"}`);

// ---- 1b. backup ----
let backupDir = null;
if (!DRY) {
  backupDir = path.join(path.dirname(path.join(DATA, "x")), "backups", `pre-postgres-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const manifest = [];
  for (const [k, f] of Object.entries(found)) {
    const dest = path.join(backupDir, path.basename(f));
    fs.copyFileSync(f, dest); fs.chmodSync(dest, 0o600);
    const a = sha256(fs.readFileSync(f)), b = sha256(fs.readFileSync(dest));
    if (a !== b) { console.error(`ABORTED: the backup copy of ${path.basename(f)} does not match the original. Nothing was changed.`); process.exit(1); }
    manifest.push({ file: path.basename(f), kind: k, bytes: fs.statSync(f).size, sha256: a });
  }
  fs.writeFileSync(path.join(backupDir, "MANIFEST.json"), JSON.stringify({ createdAt: new Date().toISOString(), files: manifest }, null, 2), { mode: 0o600 });
  console.log(`\nBackup written and verified: ${backupDir}`);
}

console.log("\nValidation of the source data:");
console.log(`  ${"table".padEnd(24)} ${"in file".padStart(8)} ${"valid".padStart(8)} ${"rejected".padStart(9)}`);
for (const [k, t] of TABLES) console.log(`  ${t.padEnd(24)} ${String(sourceCount[k]).padStart(8)} ${String(plan[k].length).padStart(8)} ${String(rejectedBy(t)).padStart(9)}`);
printIssues();
if (DRY) { console.log("\nDry run finished. Nothing was written."); process.exit(0); }

// ---- 3. load (one transaction) ----
const pool = createOwnerPool();
const result = {}, checks = [];
const check = (pass, text) => { checks.push({ pass, text }); console.log(`  ${pass ? "PASS" : "FAIL"}  ${text}`); };
let committed = false;
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(727002)"); // the same lock the server uses for route changes
  const row = async (name, sql, params) => { // one record, in its own savepoint so a rejected row is reported instead of aborting the import
    await client.query("SAVEPOINT r");
    try { const r = await client.query(sql, params); await client.query("RELEASE SAVEPOINT r"); return r.rowCount > 0 ? "inserted" : "existing"; }
    catch (e) { await client.query("ROLLBACK TO SAVEPOINT r"); issue(name.table, name.key, "rejected", `the database refused it (${e.constraint || e.code})`, "not imported"); return "rejected"; }
  };
  const tally = (k) => (result[k] ??= { inserted: 0, existing: 0, rejected: 0 });
  const ins = new Map(); // table -> Set of keys inserted by THIS run (only these are compared field by field)
  const run = async (k, table, list, keyOf, sql, params) => {
    ins.set(k, new Set()); tally(k); // an empty source list still gets a (zero) line in the summary
    for (const x of list) { const s = await row({ table, key: keyOf(x) }, sql, params(x)); tally(k)[s]++; if (s === "inserted") ins.get(k).add(keyOf(x)); }
  };
  await run("users", "users", plan.users, (x) => x.username, "INSERT INTO users (username, password_hash, role, active, created_at) VALUES ($1, $2, $3, $4, COALESCE($5, now())) ON CONFLICT DO NOTHING", (x) => [x.username, x.hash, x.role, x.active, x.createdAt]);
  await run("buses", "buses", plan.buses, (x) => x.busId, "INSERT INTO buses (bus_id, name, plate, capacity, model, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), COALESCE($8, $7, now())) ON CONFLICT DO NOTHING", (x) => [x.busId, x.name, x.plate, x.capacity, x.model, x.status, x.createdAt, x.updatedAt]);
  await run("devices", "tracking_devices", plan.devices, (x) => x.deviceId, "INSERT INTO tracking_devices (device_id, bus_id, source, active, token_hash, created_at) VALUES ($1, $2, $3, $4, $5, COALESCE($6, now())) ON CONFLICT DO NOTHING", (x) => [x.deviceId, x.busId, x.source, x.active, x.tokenHash, x.createdAt]);
  await run("stops", "stops", plan.stops, (x) => x.stopId, "INSERT INTO stops (stop_id, name, address, lat, lng, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), COALESCE($8, $7, now())) ON CONFLICT DO NOTHING", (x) => [x.stopId, x.name, x.address, x.lat, x.lng, x.status, x.createdAt, x.updatedAt]);
  await run("routes", "routes", plan.routes, (x) => x.routeId, "INSERT INTO routes (route_id, name, description, start_point, destination, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), COALESCE($8, $7, now())) ON CONFLICT DO NOTHING", (x) => [x.routeId, x.name, x.description, x.startPoint, x.destination, x.status, x.createdAt, x.updatedAt]);
  await run("routeStops", "route_stops", plan.routeStops, (x) => `${x.routeId}/${x.stopId}`, "INSERT INTO route_stops (route_id, stop_id, position) SELECT $1::text, $2::text, $3::int WHERE NOT EXISTS (SELECT 1 FROM route_stops WHERE route_id = $1::text AND stop_id = $2::text)", (x) => [x.routeId, x.stopId, x.position]);
  await run("assignments", "bus_route_assignments", plan.assignments, (x) => x.busId, "INSERT INTO bus_route_assignments (bus_id, route_id, assigned_at) VALUES ($1, $2, COALESCE($3, now())) ON CONFLICT DO NOTHING", (x) => [x.busId, x.routeId, x.assignedAt]);
  // audit log: only into an EMPTY table, so running the import twice cannot duplicate history
  const existingAudit = Number((await client.query("SELECT count(*) AS n FROM audit_logs")).rows[0].n);
  result.audit = { inserted: 0, existing: 0, rejected: 0 };
  if (existingAudit > 0) { result.audit.existing = existingAudit; issue("audit_logs", "(all)", "info", `audit_logs already holds ${existingAudit} row(s)`, "log not imported again (this prevents duplicates)"); }
  else for (let i = 0; i < plan.audit.length; i += 500) {
    const part = plan.audit.slice(i, i + 500), col = (f) => part.map(f);
    await client.query(
      `INSERT INTO audit_logs (ts, action, actor, role, target, outcome, ip, detail)
       SELECT ts, action, actor, role, target, outcome, ip, detail::jsonb
       FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) WITH ORDINALITY AS t(ts, action, actor, role, target, outcome, ip, detail, ord) ORDER BY ord`,
      [col((x) => x.ts), col((x) => x.action), col((x) => x.actor), col((x) => x.role), col((x) => x.target), col((x) => x.outcome), col((x) => x.ip), col((x) => (x.detail ? JSON.stringify(x.detail) : null))]);
    result.audit.inserted += part.length;
  }
  const refusedRows = issues.filter((x) => x.level === "rejected" && x.reason.startsWith("the database refused"));
  if (refusedRows.length) { // validation said these were fine, so something is wrong: undo everything rather than import a partial set
    printIssues();
    throw new Error(`${refusedRows.length} record(s) that passed validation were refused by a database constraint (listed above)`);
  }
  await client.query("COMMIT");
  committed = true;
  console.log("\nLoaded into PostgreSQL (one transaction, committed):");
  for (const [k, t] of TABLES) { const r = result[k]; console.log(`  ${t.padEnd(24)} inserted ${String(r.inserted).padStart(5)}   already there ${String(r.existing).padStart(5)}   refused by database ${String(r.rejected).padStart(3)}`); }

  // ---- 4. verify ----
  console.log("\nVerification (PostgreSQL compared with the source files):");
  const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const keys = { users: plan.users.map((x) => x.username), buses: plan.buses.map((x) => x.busId), tracking_devices: plan.devices.map((x) => x.deviceId), stops: plan.stops.map((x) => x.stopId), routes: plan.routes.map((x) => x.routeId) };
  const pk = { users: "username", buses: "bus_id", tracking_devices: "device_id", stops: "stop_id", routes: "route_id" };
  for (const [t, list] of Object.entries(keys)) {
    const n = Number((await q(`SELECT count(*) AS n FROM ${t} WHERE ${pk[t]} = ANY($1::text[])`, [list]))[0].n);
    check(n === list.length, `${t}: ${list.length} valid in the files, ${n} found in the database`);
  }
  const rs = Number((await q("SELECT count(*) AS n FROM route_stops WHERE (route_id, stop_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))", [plan.routeStops.map((x) => x.routeId), plan.routeStops.map((x) => x.stopId)]))[0].n);
  check(rs === plan.routeStops.length, `route_stops: ${plan.routeStops.length} valid in the files, ${rs} found in the database`);
  const as = Number((await q("SELECT count(*) AS n FROM bus_route_assignments WHERE bus_id = ANY($1::text[])", [plan.assignments.map((x) => x.busId)]))[0].n);
  check(as === plan.assignments.length, `bus_route_assignments: ${plan.assignments.length} valid in the files, ${as} found in the database`);
  if (result.audit.inserted) {
    const n = Number((await q("SELECT count(*) AS n FROM audit_logs"))[0].n);
    check(n >= plan.audit.length, `audit_logs: ${plan.audit.length} valid log lines in the file, ${n} rows in the database`);
    const first = (await q("SELECT ts, action FROM audit_logs ORDER BY id ASC LIMIT 1"))[0], last = (await q("SELECT ts, action FROM audit_logs ORDER BY id DESC LIMIT 1"))[0];
    check(first.action === plan.audit[0].action && +first.ts === +plan.audit[0].ts && last.action === plan.audit.at(-1).action && +last.ts === +plan.audit.at(-1).ts, "audit_logs: the first and last entries match the file, in the same order");
  }
  // password hashes and roles, exactly as in the source
  const u = new Map((await q("SELECT username, password_hash, role, active FROM users WHERE username = ANY($1::text[])", [keys.users])).map((x) => [x.username, x]));
  const uBad = plan.users.filter((x) => ins.get("users").has(x.username) && (u.get(x.username)?.password_hash !== x.hash || u.get(x.username)?.role !== x.role || u.get(x.username)?.active !== x.active));
  check(uBad.length === 0, `users: password hash, role and status are identical to the source for all ${ins.get("users").size} imported account(s)${uBad.length ? ` (differs: ${uBad.map((x) => x.username).join(", ")})` : ""}`);
  const adminsOk = plan.users.filter((x) => x.role === "admin" && x.active).length;
  console.log(`  INFO  ${adminsOk} active administrator account(s) in the imported data${adminsOk ? "" : " - NONE: create one with npm run seed-user -- <name> admin"}`);
  const b = new Map((await q("SELECT bus_id, name, plate, capacity, model, status FROM buses WHERE bus_id = ANY($1::text[])", [keys.buses])).map((x) => [x.bus_id, x]));
  const bBad = plan.buses.filter((x) => ins.get("buses").has(x.busId) && ["name", "plate", "capacity", "model", "status"].some((f) => (b.get(x.busId)?.[f] ?? null) !== x[f]));
  check(bBad.length === 0, `buses: every field is identical to the source for the ${ins.get("buses").size} imported bus(es)${bBad.length ? ` (differs: ${bBad.map((x) => x.busId).join(", ")})` : ""}`);
  const s = new Map((await q("SELECT stop_id, name, lat, lng, status FROM stops WHERE stop_id = ANY($1::text[])", [keys.stops])).map((x) => [x.stop_id, x]));
  const sBad = plan.stops.filter((x) => ins.get("stops").has(x.stopId) && (s.get(x.stopId)?.lat !== x.lat || s.get(x.stopId)?.lng !== x.lng || s.get(x.stopId)?.name !== x.name || s.get(x.stopId)?.status !== x.status));
  check(sBad.length === 0, `stops: coordinates, name and status are identical to the source for the ${ins.get("stops").size} imported stop(s)`);
  // relationships
  const orphan = async (sql) => Number((await q(sql))[0].n);
  check(await orphan("SELECT count(*) AS n FROM tracking_devices d LEFT JOIN buses b USING (bus_id) WHERE b.bus_id IS NULL") === 0, "relationships: every tracking device points at an existing bus");
  check(await orphan("SELECT count(*) AS n FROM route_stops x LEFT JOIN routes r USING (route_id) LEFT JOIN stops s USING (stop_id) WHERE r.route_id IS NULL OR s.stop_id IS NULL") === 0, "relationships: every route-stop link points at an existing route and stop");
  check(await orphan("SELECT count(*) AS n FROM bus_route_assignments a LEFT JOIN buses b USING (bus_id) LEFT JOIN routes r USING (route_id) WHERE b.bus_id IS NULL OR r.route_id IS NULL OR b.status <> 'active' OR r.status <> 'active'") === 0, "relationships: every assignment is an active bus on an active route");
  check(await orphan("SELECT count(*) AS n FROM (SELECT route_id FROM route_stops GROUP BY route_id HAVING max(position) <> count(*) OR min(position) <> 1) g") === 0, "relationships: the stops of every route are numbered 1..n with no gaps");
  check(await orphan("SELECT count(*) AS n FROM (SELECT bus_id FROM tracking_devices WHERE active GROUP BY bus_id HAVING count(*) > 1) g") === 0, "relationships: no bus has two active devices");
  // data that stayed in the database when it differs from the files (a repeat run after the app has been used)
  const stale = [...u.values()].filter((x) => !ins.get("users").has(x.username) && plan.users.find((p) => p.username === x.username)?.hash !== x.password_hash).length;
  if (stale) console.log(`  INFO  ${stale} account(s) already existed in the database with a different password hash than the file; the database version was kept (never overwritten).`);

  printIssues();
  const report = { createdAt: new Date().toISOString(), dryRun: false, files: found, sourceCount, loaded: result, checks, issues };
  fs.writeFileSync(path.join(backupDir, "import-report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${failed ? `FAILED: ${failed} check(s) did not pass. The original files are untouched; see the report.` : "All checks passed."} The original JSON files were not changed.`);
  console.log(`Report: ${path.join(backupDir, "import-report.json")}`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  if (committed) console.error(`The data WAS committed, but a later step failed (${e.message}). Check it with: npm run db:check`);
  else {
    try { await client.query("ROLLBACK"); } catch { /* already closed */ }
    console.error(`IMPORT FAILED and was rolled back; the database was not changed: ${e.message}`);
  }
  process.exitCode = 1;
} finally { client.release(); await pool.end(); }
