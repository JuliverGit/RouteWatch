// Route network: bus stops, routes, the ordered stops of each route, and which bus runs which route.
// This module is the ONLY code that reads or writes this data. It lives in PostgreSQL:
//
//   stops                  (stop_id PK, name UNIQUE, address, lat, lng, status)
//   routes                 (route_id PK, name UNIQUE, description, start_point, destination, status)
//   route_stops            (route_id FK, stop_id FK, position)   PK (route_id, stop_id): a stop appears once per route
//   bus_route_assignments  (bus_id PK/FK -> buses, route_id FK)  PK on bus_id: a bus runs one route at a time
//
// Records point at each other by stable ids, never by array position. The API keeps the camelCase shapes the
// browser already uses (stopId, routeId, startPoint ...); the SQL names are snake_case.
//
// Rules enforced here (the database repeats the structural ones as constraints, so they hold for any writer):
//  * ids and names are unique; ids cannot be changed; nothing is ever deleted (stops and routes are
//    deactivated, so references from routes, buses and the audit log stay valid);
//  * an inactive stop stays in its routes (the reference is kept) but is skipped for passengers and tracking;
//  * deactivating a route removes its bus assignments (a deactivated route cannot be operated);
//  * the TRACKED route (the one with road geometry and arrival estimates) must stay active with 2+ active stops.
//
// Concurrency: every change runs in ONE transaction that first takes an advisory lock. Network edits are rare
// administrator actions, so serialising them is simple and removes whole classes of races (two people reordering
// the same route, two people deactivating the last stops of the tracked route at once, and so on).
// Reads are single statements, so each one sees a consistent snapshot.
import { query, tx, advisoryLock, violates } from "./db.js";
import { SERVICE_AREA } from "./route.js";

export const TRACKED_ROUTE_ID = (process.env.TRACKED_ROUTE_ID || "R-01").toUpperCase();
export const STOP_STATUSES = ["active", "inactive"];
export const ROUTE_STATUSES = ["active", "inactive"];

const ID_RE = /^[A-Z0-9][A-Z0-9-]{1,15}$/;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,'#()/&–-]{1,79}$/u; // names: 2-80 plain characters (letters of any language, digits, a few symbols)
const LONG_RE = /^[^<>\u0000-\u001f]{1,200}$/;                    // address / description: up to 200 characters, no markup or control characters
export const ID_PATTERN = ID_RE;
const NET_LOCK = 727_002; // advisory lock id for network changes

const fail = (field, error, status = 400) => ({ error, field, status });
const clean = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : null);
const iso = (t) => (t ? new Date(t).toISOString() : null);

// ---- Reading ----
// One statement returns all four tables, so the result is a consistent snapshot. The network is small (tens of rows).
const LOAD_SQL = `
  SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.created_at, s.stop_id), '[]') FROM stops s) AS stops,
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at, r.route_id), '[]') FROM routes r) AS routes,
    (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.route_id, x.position), '[]') FROM route_stops x) AS route_stops,
    (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.assigned_at, a.bus_id), '[]') FROM bus_route_assignments a) AS assignments`;
async function load(c = { query }) {
  const row = (await c.query(LOAD_SQL)).rows[0];
  return {
    stops: row.stops.map((s) => ({ stopId: s.stop_id, name: s.name, address: s.address, lat: s.lat, lng: s.lng, status: s.status, createdAt: iso(s.created_at), updatedAt: iso(s.updated_at) })),
    routes: row.routes.map((r) => ({ routeId: r.route_id, name: r.name, description: r.description, startPoint: r.start_point, destination: r.destination, status: r.status, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) })),
    routeStops: row.route_stops.map((x) => ({ routeId: x.route_id, stopId: x.stop_id, position: x.position })),
    assignments: row.assignments.map((a) => ({ busId: a.bus_id, routeId: a.route_id, assignedAt: iso(a.assigned_at) })),
  };
}

// ---- Derived data (pure functions over a loaded snapshot) ----
const rowsOf = (d, routeId) => d.routeStops.filter((r) => r.routeId === routeId).sort((a, b) => a.position - b.position);
const stopById = (d, id) => d.stops.find((s) => s.stopId === id);
const routeById = (d, id) => d.routes.find((r) => r.routeId === id);
const activeStopsOf = (d, routeId) => rowsOf(d, routeId).map((r) => stopById(d, r.stopId)).filter((s) => s && s.status === "active");

const stopView = (d, s) => ({ ...s, routeIds: d.routeStops.filter((r) => r.stopId === s.stopId).map((r) => r.routeId) });
const routeView = (d, r) => ({
  ...r, tracked: r.routeId === TRACKED_ROUTE_ID,
  stops: rowsOf(d, r.routeId).map((row, i) => { const s = stopById(d, row.stopId); return { stopId: s.stopId, name: s.name, address: s.address, lat: s.lat, lng: s.lng, status: s.status, order: i + 1 }; }),
  buses: d.assignments.filter((a) => a.routeId === r.routeId).map((a) => a.busId),
});
export const listStops = async () => { const d = await load(); return d.stops.map((s) => stopView(d, s)); };
export const listRoutes = async () => { const d = await load(); return d.routes.map((r) => routeView(d, r)); };
export const getRoute = async (id) => { const d = await load(); const r = routeById(d, id); return r ? routeView(d, r) : null; };

/** busId -> { routeId, routeName, routeStatus } for every assigned bus (one query, used by tracking and bus listings). */
export async function assignmentMap() {
  const r = await query("SELECT a.bus_id, r.route_id, r.name, r.status FROM bus_route_assignments a JOIN routes r USING (route_id)");
  return new Map(r.rows.map((x) => [x.bus_id, { routeId: x.route_id, routeName: x.name, routeStatus: x.status }]));
}

/** What passengers and visitors may see: active routes, their active stops in order, and the buses on them. */
export async function publicNetwork() {
  const d = await load();
  const routes = d.routes.filter((r) => r.status === "active").map((r) => ({
    routeId: r.routeId, name: r.name, description: r.description, startPoint: r.startPoint, destination: r.destination, tracked: r.routeId === TRACKED_ROUTE_ID,
    stops: activeStopsOf(d, r.routeId).map((s, i) => ({ stopId: s.stopId, name: s.name, address: s.address, lat: s.lat, lng: s.lng, order: i + 1 })),
    busIds: d.assignments.filter((a) => a.routeId === r.routeId).map((a) => a.busId),
  }));
  const seen = new Map();
  for (const r of routes) for (const s of r.stops) {
    const e = seen.get(s.stopId) ?? { stopId: s.stopId, name: s.name, address: s.address, lat: s.lat, lng: s.lng, routeIds: [] };
    e.routeIds.push(r.routeId); seen.set(s.stopId, e);
  }
  return { routes, stops: [...seen.values()] };
}

/** The route tracking is configured from, or null when it is missing or not usable. */
export async function trackedSpec() {
  const d = await load(), r = routeById(d, TRACKED_ROUTE_ID);
  if (!r || r.status !== "active") return null;
  const stops = activeStopsOf(d, r.routeId);
  if (stops.length < 2) return null;
  return { routeId: r.routeId, name: r.name, stops: stops.map((s) => ({ id: s.stopId, name: s.name, p: [s.lat, s.lng] })) };
}
const trackedUsable = async (c) => (await c.query(
  `SELECT EXISTS (SELECT 1 FROM routes r WHERE r.route_id = $1 AND r.status = 'active'
     AND (SELECT count(*) FROM route_stops rs JOIN stops s USING (stop_id) WHERE rs.route_id = r.route_id AND s.status = 'active') >= 2) AS ok`, [TRACKED_ROUTE_ID])).rows[0].ok;

// ---- Writing ----
// Turns the database's constraint violations into the same clear errors the user gets from the normal checks.
// This matters when two administrators submit the same thing at the same moment: both pass a "does it exist?" check,
// and the constraint is what stops the second one.
function mapViolation(e) {
  if (violates(e, "stops_pkey")) return fail("stopId", "A bus stop with this ID already exists.", 409);
  if (violates(e, "stops_name_uq")) return fail("name", "A bus stop with this name already exists.", 409);
  if (violates(e, "routes_pkey")) return fail("routeId", "A route with this ID already exists.", 409);
  if (violates(e, "routes_name_uq")) return fail("name", "A route with this name already exists.", 409);
  if (violates(e, "route_stops_pkey")) return fail("stopId", "This stop is already on the route.", 409);
  if (violates(e, "assignment_bus_active")) return fail("busId", "Only Active buses can be assigned to a route.", 409);
  if (violates(e, "assignment_route_active")) return fail("routeId", "Buses can only be assigned to an active route.", 409);
  if (violates(e, "bus_route_assignments_bus_id_fkey")) return fail("busId", "Bus not found.", 404);
  throw e;
}

/** Runs a change in one locked transaction. It is committed only if it succeeded AND the tracked route is still usable. */
async function netTx(fn) {
  try {
    return await tx(async (c) => {
      await advisoryLock(c, NET_LOCK);
      const was = await trackedUsable(c);
      const r = await fn(c);
      if (r.error) return r;
      if (was && !(await trackedUsable(c))) return fail("routeId", `${TRACKED_ROUTE_ID} is the route used for live tracking. It must stay active and keep at least 2 active stops.`, 409);
      return r;
    });
  } catch (e) { return mapViolation(e); }
}

// Positions of a route are always 1..n with no gaps. The unique (route_id, position) constraint is deferred, so rows can be renumbered freely inside the transaction.
const renumber = (c, routeId) => c.query(
  `UPDATE route_stops rs SET position = x.rn FROM (SELECT stop_id, row_number() OVER (ORDER BY position) AS rn FROM route_stops WHERE route_id = $1) x
   WHERE rs.route_id = $1 AND rs.stop_id = x.stop_id AND rs.position <> x.rn`, [routeId]);
const touchRoute = (c, routeId) => c.query("UPDATE routes SET updated_at = now() WHERE route_id = $1", [routeId]);

// ---- Validation ----
function checkField(field, raw) {
  switch (field) {
    case "stopId": case "routeId": {
      const v = clean(raw)?.toUpperCase();
      return v && ID_RE.test(v) ? { value: v } : fail(field, `${field === "stopId" ? "Stop" : "Route"} ID must be 2-16 characters: letters, numbers and hyphens.`);
    }
    case "name": case "startPoint": case "destination": {
      const v = clean(raw), label = { name: "Name", startPoint: "Starting point", destination: "Destination" }[field];
      return v && NAME_RE.test(v) ? { value: v } : fail(field, `${label} must be 2-80 characters (letters, numbers, spaces and . , ' # ( ) / & – -).`);
    }
    case "address": case "description": {
      if (raw === null || raw === "") return { value: null };
      const v = clean(raw);
      return v && LONG_RE.test(v) ? { value: v } : fail(field, `${field === "address" ? "Address" : "Description"} can have up to 200 characters and no < or >.`);
    }
    default: return fail(field, "Invalid field.");
  }
}
function checkStatus(raw, list) { return list.includes(raw) ? { value: raw } : fail("status", `Status must be ${list.join(" or ")}.`); }
function checkCoords(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return fail("lat", "Enter both latitude and longitude as numbers.");
  if (lat < -90 || lat > 90) return fail("lat", "Latitude must be between -90 and 90.");
  if (lng < -180 || lng > 180) return fail("lng", "Longitude must be between -180 and 180.");
  const a = SERVICE_AREA;
  if (lat < a.minLat || lat > a.maxLat || lng < a.minLng || lng > a.maxLng)
    return fail("lat", `These coordinates are outside the RouteWatch service area (latitude ${a.minLat}–${a.maxLat}, longitude ${a.minLng}–${a.maxLng}).`);
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
// Column names come from these fixed maps (never from input); the values are always bound parameters.
const STOP_COL = { name: "name", address: "address", lat: "lat", lng: "lng", status: "status" };
const ROUTE_COL = { name: "name", description: "description", startPoint: "start_point", destination: "destination", status: "status" };
const setClause = (cols, changed, first = 2) => changed.map((f, i) => `${cols[f]} = $${i + first}`).join(", ");

// ---- Bus stops ----
export async function createStop(input) {
  if (!isObj(input)) return fail("body", "Invalid request.");
  const out = {};
  for (const f of ["stopId", "name"]) { if (input[f] == null || input[f] === "") return fail(f, "This field is required."); const r = checkField(f, input[f]); if (r.error) return r; out[f] = r.value; }
  if (input.address !== undefined) { const r = checkField("address", input.address); if (r.error) return r; out.address = r.value; }
  const c = checkCoords(input.lat, input.lng); if (c.error) return c;
  let status = "active";
  if (input.status !== undefined) { const r = checkStatus(input.status, STOP_STATUSES); if (r.error) return r; status = r.value; }
  return netTx(async (cl) => {
    await cl.query("INSERT INTO stops (stop_id, name, address, lat, lng, status) VALUES ($1, $2, $3, $4, $5, $6)", [out.stopId, out.name, out.address ?? null, c.lat, c.lng, status]);
    const d = await load(cl);
    return { stop: stopView(d, stopById(d, out.stopId)) };
  });
}

export async function updateStop(stopId, input) {
  if (!isObj(input)) return fail("body", "Invalid request.");
  const ch = {};
  for (const f of ["name", "address"]) if (f in input) { const r = checkField(f, input[f]); if (r.error) return r; ch[f] = r.value; }
  if ("name" in ch && ch.name === null) return fail("name", "This field is required.");
  if ("lat" in input || "lng" in input) { const c = checkCoords(input.lat, input.lng); if (c.error) return c; ch.lat = c.lat; ch.lng = c.lng; }
  if ("status" in input) { const r = checkStatus(input.status, STOP_STATUSES); if (r.error) return r; ch.status = r.value; }
  if (!Object.keys(ch).length) return fail("body", "Nothing to update.");
  return netTx(async (c) => {
    const d = await load(c), s = stopById(d, stopId);
    if (!s) return fail("stopId", "Bus stop not found.", 404);
    const before = stopView(d, s);
    const changed = Object.keys(ch).filter((f) => (s[f] ?? null) !== ch[f]);
    if (changed.length) await c.query(`UPDATE stops SET ${setClause(STOP_COL, changed)}, updated_at = now() WHERE stop_id = $1`, [stopId, ...changed.map((f) => ch[f])]);
    const d2 = changed.length ? await load(c) : d;
    return { stop: stopView(d2, stopById(d2, stopId)), before, changed };
  });
}

// ---- Routes ----
export async function createRoute(input) {
  if (!isObj(input)) return fail("body", "Invalid request.");
  const out = {};
  for (const f of ["routeId", "name", "startPoint", "destination"]) { if (input[f] == null || input[f] === "") return fail(f, "This field is required."); const r = checkField(f, input[f]); if (r.error) return r; out[f] = r.value; }
  if (input.description !== undefined) { const r = checkField("description", input.description); if (r.error) return r; out.description = r.value; }
  let status = "active";
  if (input.status !== undefined) { const r = checkStatus(input.status, ROUTE_STATUSES); if (r.error) return r; status = r.value; }
  return netTx(async (c) => {
    await c.query("INSERT INTO routes (route_id, name, description, start_point, destination, status) VALUES ($1, $2, $3, $4, $5, $6)",
      [out.routeId, out.name, out.description ?? null, out.startPoint, out.destination, status]);
    const d = await load(c);
    return { route: routeView(d, routeById(d, out.routeId)) };
  });
}

/** Edits a route. Deactivating it also removes the bus assignments (returned as `unassigned`). */
export async function updateRoute(routeId, input) {
  if (!isObj(input)) return fail("body", "Invalid request.");
  const ch = {};
  for (const f of ["name", "startPoint", "destination", "description"]) if (f in input) { const r = checkField(f, input[f]); if (r.error) return r; ch[f] = r.value; }
  for (const f of ["name", "startPoint", "destination"]) if (f in ch && ch[f] === null) return fail(f, "This field is required.");
  if ("status" in input) { const r = checkStatus(input.status, ROUTE_STATUSES); if (r.error) return r; ch.status = r.value; }
  if (!Object.keys(ch).length) return fail("body", "Nothing to update.");
  return netTx(async (c) => {
    const d = await load(c), r = routeById(d, routeId);
    if (!r) return fail("routeId", "Route not found.", 404);
    const before = routeView(d, r);
    const changed = Object.keys(ch).filter((f) => (r[f] ?? null) !== ch[f]);
    let unassigned = [];
    if (changed.length) {
      if (ch.status && ch.status !== "active") unassigned = (await c.query("DELETE FROM bus_route_assignments WHERE route_id = $1 RETURNING bus_id", [routeId])).rows.map((x) => x.bus_id);
      await c.query(`UPDATE routes SET ${setClause(ROUTE_COL, changed)}, updated_at = now() WHERE route_id = $1`, [routeId, ...changed.map((f) => ch[f])]);
    }
    const d2 = changed.length ? await load(c) : d;
    return { route: routeView(d2, routeById(d2, routeId)), before, changed, unassigned };
  });
}

// ---- Route <-> stop relationship (ordered) ----
export async function addRouteStop(routeId, stopId, position) {
  const sid = checkField("stopId", stopId); if (sid.error) return sid;
  if (position !== undefined && position !== null && (!Number.isInteger(position) || position < 1)) return fail("position", "Position must be a whole number starting at 1.");
  return netTx(async (c) => {
    const d = await load(c);
    const r = routeById(d, routeId); if (!r) return fail("routeId", "Route not found.", 404);
    const s = stopById(d, sid.value); if (!s) return fail("stopId", "Bus stop not found.", 404);
    if (s.status !== "active") return fail("stopId", "Only active bus stops can be added to a route.", 409);
    if (d.routeStops.some((x) => x.routeId === routeId && x.stopId === sid.value)) return fail("stopId", "This stop is already on the route.", 409);
    const n = rowsOf(d, routeId).length;
    const at = Math.min(position ?? n + 1, n + 1);
    await c.query("UPDATE route_stops SET position = position + 1 WHERE route_id = $1 AND position >= $2", [routeId, at]);
    await c.query("INSERT INTO route_stops (route_id, stop_id, position) VALUES ($1, $2, $3)", [routeId, sid.value, at]);
    await renumber(c, routeId); await touchRoute(c, routeId);
    const d2 = await load(c);
    return { route: routeView(d2, routeById(d2, routeId)), position: at };
  });
}

export async function removeRouteStop(routeId, stopId) {
  return netTx(async (c) => {
    const r = (await c.query("SELECT 1 FROM routes WHERE route_id = $1", [routeId])).rowCount; if (!r) return fail("routeId", "Route not found.", 404);
    const del = await c.query("DELETE FROM route_stops WHERE route_id = $1 AND stop_id = $2", [routeId, stopId]);
    if (!del.rowCount) return fail("stopId", "This stop is not on the route.", 404);
    await renumber(c, routeId); await touchRoute(c, routeId);
    const d = await load(c);
    return { route: routeView(d, routeById(d, routeId)) };
  });
}

/** Sets the order of the stops. The list must contain exactly the stops already on the route (add and remove are separate). */
export async function reorderRouteStops(routeId, stopIds) {
  if (!Array.isArray(stopIds) || stopIds.length > 200 || !stopIds.every((x) => typeof x === "string")) return fail("stopIds", "Send the list of stop IDs in the new order.");
  const ids = stopIds.map((x) => x.trim().toUpperCase());
  return netTx(async (c) => {
    const d = await load(c);
    const r = routeById(d, routeId); if (!r) return fail("routeId", "Route not found.", 404);
    const cur = rowsOf(d, routeId);
    if (ids.length !== cur.length || new Set(ids).size !== ids.length || !cur.every((x) => ids.includes(x.stopId))) return fail("stopIds", "The list must contain each stop on the route exactly once.");
    const changed = ids.some((id, i) => cur[i].stopId !== id);
    if (changed) {
      await c.query(
        `UPDATE route_stops rs SET position = v.pos FROM unnest($2::text[], $3::int[]) AS v(stop_id, pos) WHERE rs.route_id = $1 AND rs.stop_id = v.stop_id`,
        [routeId, ids, ids.map((_, i) => i + 1)]);
      await touchRoute(c, routeId);
    }
    const d2 = changed ? await load(c) : d;
    return { route: routeView(d2, routeById(d2, routeId)), changed };
  });
}

// ---- Bus <-> route assignment ----
/** Assigns a bus to a route (replacing any earlier assignment) or, with routeId null, removes it. The caller has already checked that the bus exists and is active (the database checks it again). */
export async function assignBus(busId, routeId) {
  return netTx(async (c) => {
    // No row lock here: the advisory lock already serialises network changes, and locking the assignment first would reverse the
    // bus-then-assignment lock order used by updateBus (a deadlock risk).
    const from = (await c.query("SELECT route_id FROM bus_route_assignments WHERE bus_id = $1", [busId])).rows[0]?.route_id ?? null;
    if (routeId === null) {
      if (from) await c.query("DELETE FROM bus_route_assignments WHERE bus_id = $1", [busId]);
      return { from, to: null, changed: !!from };
    }
    const r = (await c.query("SELECT status FROM routes WHERE route_id = $1", [routeId])).rows[0];
    if (!r) return fail("routeId", "Route not found.", 404);
    if (r.status !== "active") return fail("routeId", "Buses can only be assigned to an active route.", 409);
    if (from === routeId) return { from, to: routeId, changed: false };
    await c.query(
      "INSERT INTO bus_route_assignments (bus_id, route_id) VALUES ($1, $2) ON CONFLICT (bus_id) DO UPDATE SET route_id = EXCLUDED.route_id, assigned_at = now()", [busId, routeId]);
    return { from, to: routeId, changed: true };
  });
}
/** Used when a bus leaves service. Returns the route it was on, or null. */
export const unassignBus = async (busId) => { const r = await assignBus(busId, null); return r.error ? null : r.from; };

/**
 * One-time setup for an EMPTY network. The single route that RouteWatch always had becomes route R-01 with its stops,
 * and every Active bus registered at that moment is assigned to it. Nothing is invented: the coordinates are the ones
 * already used by tracking. When the network already has data (for example after `npm run db:import`) this does nothing.
 */
export async function bootstrapNetwork({ routeName, stops }) {
  return tx(async (c) => {
    await advisoryLock(c, NET_LOCK);
    const n = (await c.query("SELECT (SELECT count(*) FROM routes) + (SELECT count(*) FROM stops) AS n")).rows[0].n;
    if (Number(n) > 0) return false;
    for (const s of stops) await c.query("INSERT INTO stops (stop_id, name, lat, lng) VALUES ($1, $2, $3, $4)", [s.id, s.name, s.p[0], s.p[1]]);
    await c.query("INSERT INTO routes (route_id, name, description, start_point, destination) VALUES ($1, $2, 'Original RouteWatch route', $3, $4)",
      [TRACKED_ROUTE_ID, routeName, stops[0].name, stops.at(-1).name]);
    for (const [i, s] of stops.entries()) await c.query("INSERT INTO route_stops (route_id, stop_id, position) VALUES ($1, $2, $3)", [TRACKED_ROUTE_ID, s.id, i + 1]);
    await c.query("INSERT INTO bus_route_assignments (bus_id, route_id) SELECT bus_id, $1 FROM buses WHERE status = 'active'", [TRACKED_ROUTE_ID]);
    return true;
  });
}
