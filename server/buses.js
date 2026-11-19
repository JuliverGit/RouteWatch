// Bus registry: the single source of truth for which buses exist and their operational status.
// Buses live in the PostgreSQL table "buses". Tracking devices (devices.js) only point at a bus id, and
// the latest GPS position lives in memory (tracking.js), so nothing about a bus is stored twice.
//
// Operational status is NOT the same as GPS tracking status:
//   status "active" | "inactive" | "maintenance"   <- set by an administrator (this file)
//   tracking "current" | "delayed" | "stale" | "unavailable"   <- measured from GPS updates (tracking.js)
// A bus can be Active but offline, and only Active buses accept or show GPS updates.
//
// Buses are deactivated, never deleted: their id is referenced by tracking devices, route assignments and the audit log.
// This module is the only code that reads or writes the table. Every function is async.
import { query, tx, violates } from "./db.js";

export const STATUSES = ["active", "inactive", "maintenance"];
export const STATUS_LABEL = { active: "Active", inactive: "Inactive", maintenance: "Under maintenance" };
export const CAPACITY_MAX = 120;

const ID_RE = /^[A-Z0-9][A-Z0-9-]{1,15}$/;                  // RW-01, BUS-12 (2-16 characters)
const TEXT_RE = /^[A-Za-z0-9][A-Za-z0-9 .,'#()/_-]{1,59}$/; // names and models: 2-60 plain characters
const PLATE_RE = /^[A-Z0-9][A-Z0-9 -]{2,11}$/;              // e.g. ABC 1234 (3-12 characters)

const view = (b) => ({
  busId: b.bus_id, name: b.name, plate: b.plate ?? null, capacity: b.capacity ?? null, model: b.model ?? null,
  status: b.status, createdAt: b.created_at ? b.created_at.toISOString() : null, updatedAt: b.updated_at ? b.updated_at.toISOString() : null,
  // The current passenger count (null = not reported). It is only ever changed by occupancy.js, never by editing a bus.
  passengerCount: b.passenger_count ?? null, occupancyUpdatedAt: b.occupancy_updated_at ? b.occupancy_updated_at.toISOString() : null,
});
const COLS = "bus_id, name, plate, capacity, model, status, created_at, updated_at, passenger_count, occupancy_updated_at";
export const listBuses = async () => (await query(`SELECT ${COLS} FROM buses ORDER BY created_at, bus_id`)).rows.map(view);
export const getBus = async (busId) => { const r = await query(`SELECT ${COLS} FROM buses WHERE bus_id = $1`, [busId]); return r.rows[0] ? view(r.rows[0]) : null; };

// ---- Validation ----
const fail = (field, error, status = 400) => ({ error, field, status });
const text = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : null);

/** Validates ONE field. Returns { value } or an error object. Nothing outside this list is ever accepted. */
function checkField(field, raw) {
  switch (field) {
    case "busId": {
      const v = text(raw)?.toUpperCase();
      return v && ID_RE.test(v) ? { value: v } : fail(field, "Bus ID must be 2-16 characters: letters, numbers and hyphens.");
    }
    case "name": {
      const v = text(raw);
      return v && TEXT_RE.test(v) ? { value: v } : fail(field, "Name must be 2-60 characters (letters, numbers, spaces and . , ' # ( ) / _ -).");
    }
    case "plate": {
      if (raw === null || raw === "") return { value: null };
      const v = text(raw)?.toUpperCase();
      return v && PLATE_RE.test(v) ? { value: v } : fail(field, "Plate number must be 3-12 characters: letters, numbers, spaces or hyphens.");
    }
    case "capacity":
      return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= CAPACITY_MAX
        ? { value: raw } : fail(field, `Capacity must be a whole number from 1 to ${CAPACITY_MAX}.`);
    case "model": {
      if (raw === null || raw === "") return { value: null };
      const v = text(raw);
      return v && TEXT_RE.test(v) ? { value: v } : fail(field, "Model must be 2-60 characters (letters, numbers, spaces and . , ' # ( ) / _ -).");
    }
    case "status":
      return STATUSES.includes(raw) ? { value: raw } : fail(field, "Status must be Active, Inactive or Under maintenance.");
    default: return fail(field, "Invalid field.");
  }
}

// The database is the final judge of uniqueness (two administrators can submit at the same moment), so a unique
// violation is turned into the same clear message the user would get from a normal duplicate.
const duplicate = (e) => {
  if (violates(e, "buses_pkey")) return fail("busId", "A bus with this ID already exists.", 409);
  if (violates(e, "buses_plate_key_uq")) return fail("plate", "That plate number is already registered to another bus.", 409);
  if (violates(e, "buses_occupancy_within_capacity")) return fail("capacity", "Capacity cannot be lower than the number of passengers currently counted on board.", 409);
  throw e;
};

/** Registers a bus. Only whitelisted fields are read from input (no mass assignment). */
export async function createBus(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("body", "Invalid request.");
  const out = {};
  for (const f of ["busId", "name", "capacity"]) { // required
    if (input[f] === undefined || input[f] === null || input[f] === "") return fail(f, "This field is required.");
    const r = checkField(f, input[f]); if (r.error) return r; out[f] = r.value;
  }
  for (const f of ["plate", "model", "status"]) { // optional
    if (input[f] === undefined) continue;
    const r = checkField(f, input[f]); if (r.error) return r; out[f] = r.value;
  }
  try {
    const r = await query(
      `INSERT INTO buses (bus_id, name, plate, capacity, model, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
      [out.busId, out.name, out.plate ?? null, out.capacity, out.model ?? null, out.status ?? "active"]);
    return { bus: view(r.rows[0]) };
  } catch (e) { return duplicate(e); }
}

/**
 * Updates the editable fields of a bus. The bus ID can never be changed (other records point at it).
 * The row is locked while it is changed, so two simultaneous edits are applied one after the other, each
 * touching only the fields it was given (no lost update of a field the other administrator did not change).
 * When the bus leaves "active", its route assignment and its conductor assignment are removed in the SAME transaction and
 * returned as `unassigned` (route id) and `unassignedConductor` (username); its passenger count goes back to "not reported".
 */
export async function updateBus(busId, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("body", "Invalid request.");
  const changes = {};
  for (const f of ["name", "plate", "capacity", "model", "status"]) {
    if (!(f in input)) continue;
    const r = checkField(f, input[f]); if (r.error) return r; changes[f] = r.value;
  }
  if (!Object.keys(changes).length) return fail("body", "Nothing to update.");
  try {
    return await tx(async (c) => {
      const cur = (await c.query(`SELECT ${COLS} FROM buses WHERE bus_id = $1 FOR UPDATE`, [busId])).rows[0];
      if (!cur) return fail("busId", "Bus not found.", 404);
      const before = view(cur);
      const changed = Object.keys(changes).filter((f) => (before[f] ?? null) !== changes[f]);
      if (!changed.length) return { bus: before, before, changed, unassigned: null, unassignedConductor: null };
      // The counted passengers are a fact the administrator cannot see here, so a capacity below them is refused with a clear message.
      if (changed.includes("capacity") && before.passengerCount != null && changes.capacity < before.passengerCount)
        return fail("capacity", `Capacity cannot be lower than the ${before.passengerCount} passengers currently counted on board.`, 409);
      let unassigned = null, unassignedConductor = null;
      if (changed.includes("status") && changes.status !== "active") {
        unassigned = (await c.query("DELETE FROM bus_route_assignments WHERE bus_id = $1 RETURNING route_id", [busId])).rows[0]?.route_id ?? null;
        unassignedConductor = (await c.query("DELETE FROM conductor_assignments WHERE bus_id = $1 RETURNING conductor", [busId])).rows[0]?.conductor ?? null;
      }
      const col = { name: "name", plate: "plate", capacity: "capacity", model: "model", status: "status" };
      const sets = changed.map((f, i) => `${col[f]} = $${i + 2}`); // column names come from this fixed map, values are parameters
      const r = await c.query(`UPDATE buses SET ${sets.join(", ")}, updated_at = now() WHERE bus_id = $1 RETURNING ${COLS}`, [busId, ...changed.map((f) => changes[f])]);
      return { bus: view(r.rows[0]), before, changed, unassigned, unassignedConductor };
    });
  } catch (e) { return duplicate(e); }
}

/** Makes sure a bus record exists (used by the setup scripts). Returns true when it was created. */
export async function ensureBus({ busId, name }) {
  const r = await query("INSERT INTO buses (bus_id, name) VALUES ($1, $2) ON CONFLICT (bus_id) DO NOTHING RETURNING bus_id", [busId, name || busId]);
  return r.rowCount > 0;
}
