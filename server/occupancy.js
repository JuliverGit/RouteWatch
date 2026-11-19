// Passenger occupancy and conductor assignments.
// Storage (PostgreSQL): buses.passenger_count / buses.occupancy_updated_at and the table conductor_assignments.
// This is the only code that changes a passenger count or an assignment. Every function is async.
//
// A count of NULL means "not reported" (nobody is counting that bus right now). It is never shown as 0 or guessed.
// The browser only ever says WHAT happened (a passenger boarded or got off). It never sends a number: the new value is
// worked out here, from the value locked in the database, so the page cannot set a count it should not.
import { query, tx, violates } from "./db.js";

export const ACTIONS = ["board", "alight", "reset"];
const fail = (error, status, code, field) => ({ error, status, code, field });

const LEVELS = {
  none: { label: "Not reported", tone: "off" },
  low: { label: "Plenty of seats", tone: "ok" },
  mid: { label: "Filling up", tone: "warn" },
  high: { label: "Almost full", tone: "bad" },
  full: { label: "Full", tone: "bad" },
};

/**
 * What passengers (and everyone else) may see. `counted` says whether a conductor is assigned to the bus right now.
 * Without a conductor, without a capacity, or before the first count, the answer is "Not reported" with no numbers.
 */
export function occupancyView({ capacity, passengerCount, occupancyUpdatedAt }, counted) {
  const cap = capacity ?? null;
  if (!counted || cap == null || passengerCount == null) {
    return { reported: false, count: null, capacity: cap, available: null, percent: null, level: "none", ...LEVELS.none, updatedAt: null };
  }
  const ratio = passengerCount / cap;
  const level = passengerCount >= cap ? "full" : ratio >= 0.85 ? "high" : ratio >= 0.5 ? "mid" : "low";
  return {
    reported: true, count: passengerCount, capacity: cap, available: cap - passengerCount, percent: Math.round(ratio * 100),
    level, ...LEVELS[level], updatedAt: occupancyUpdatedAt ?? null,
  };
}

const rowBus = (r) => ({
  busId: r.bus_id, name: r.name, capacity: r.capacity ?? null, status: r.status, passengerCount: r.passenger_count ?? null,
  occupancyUpdatedAt: r.occupancy_updated_at ? r.occupancy_updated_at.toISOString() : null,
});

// ---- Reading assignments ----
/** busId -> conductor username, for every assignment (used to decide whether a bus's count is being kept). */
export async function conductorMap() {
  return new Map((await query("SELECT bus_id, conductor FROM conductor_assignments")).rows.map((r) => [r.bus_id, r.conductor]));
}

/** The bus a conductor is assigned to, with its count, or null. */
export async function assignedBus(username) {
  const r = await query(
    `SELECT b.bus_id, b.name, b.capacity, b.status, b.passenger_count, b.occupancy_updated_at
       FROM conductor_assignments a JOIN buses b ON b.bus_id = a.bus_id WHERE a.conductor = $1`, [username]);
  return r.rows[0] ? rowBus(r.rows[0]) : null;
}

/** All conductor accounts with their assigned bus (for administrators and dispatchers). */
export async function listConductors() {
  const r = await query(
    `SELECT u.username, u.active, a.bus_id, b.name AS bus_name
       FROM users u LEFT JOIN conductor_assignments a ON a.conductor = u.username LEFT JOIN buses b ON b.bus_id = a.bus_id
      WHERE u.role = 'conductor' ORDER BY u.username`);
  return r.rows.map((x) => ({ username: x.username, active: x.active, busId: x.bus_id ?? null, busName: x.bus_name ?? null }));
}

// ---- Assigning a conductor to a bus ----
/**
 * Assigns a conductor account to an ACTIVE bus, moves them to another one, or removes the assignment (busId null).
 * One conductor counts one bus at a time and a bus has one conductor at a time. The checks run in one transaction with
 * the user and bus rows locked; the database triggers and unique keys repeat them in case two administrators act at once.
 * Returns { from, to, changed } or an error object { error, status, field }.
 */
export async function assignConductor(username, busId) {
  try {
    return await tx(async (c) => {
      const u = (await c.query("SELECT username, role, active FROM users WHERE username = $1 FOR SHARE", [username])).rows[0];
      if (!u) return fail("User not found.", 404, "user_not_found", "username");
      const from = (await c.query("SELECT bus_id FROM conductor_assignments WHERE conductor = $1 FOR UPDATE", [username])).rows[0]?.bus_id ?? null;
      if (busId === null) {
        if (from) await c.query("DELETE FROM conductor_assignments WHERE conductor = $1", [username]);
        return { from, to: null, changed: from !== null };
      }
      if (u.role !== "conductor") return fail("Only a conductor account can be assigned to a bus.", 409, "not_conductor", "username");
      if (!u.active) return fail("This account is inactive. Activate it first.", 409, "user_inactive", "username");
      const b = (await c.query("SELECT status FROM buses WHERE bus_id = $1 FOR SHARE", [busId])).rows[0];
      if (!b) return fail("Bus not found.", 404, "bus_not_found", "busId");
      if (b.status !== "active") return fail("Only an Active bus can have a conductor.", 409, "bus_not_active", "busId");
      if (from === busId) return { from, to: busId, changed: false };
      const other = (await c.query("SELECT conductor FROM conductor_assignments WHERE bus_id = $1", [busId])).rows[0]?.conductor;
      if (other) return fail(`${busId} already has a conductor (${other}). Remove that assignment first.`, 409, "bus_taken", "busId");
      await c.query(
        `INSERT INTO conductor_assignments (conductor, bus_id) VALUES ($1, $2)
         ON CONFLICT (conductor) DO UPDATE SET bus_id = EXCLUDED.bus_id, assigned_at = now()`, [username, busId]);
      return { from, to: busId, changed: true };
    });
  } catch (e) {
    if (violates(e, "conductor_assignments_bus_id_key")) return fail(`${busId} already has a conductor.`, 409, "bus_taken", "busId");
    if (violates(e, "conductor_must_be_active_conductor")) return fail("Only an active conductor account can be assigned to a bus.", 409, "not_conductor", "username");
    if (violates(e, "conductor_bus_must_be_active")) return fail("Only an Active bus can have a conductor.", 409, "bus_not_active", "busId");
    throw e;
  }
}

// ---- Counting passengers ----
/**
 * Applies one action from a conductor to the bus they are assigned to:
 *   board  -> +1 (refused when the bus is full)     alight -> -1 (refused at 0)     reset -> back to 0 (start of a trip)
 * The bus row is locked (SELECT ... FOR UPDATE) while the new value is worked out and written, so simultaneous taps from the
 * same or different devices are applied one after another and none is lost. The permission is the assignment itself:
 * a conductor who is not assigned to this bus is refused, and so is a bus that does not exist (same answer, no hints).
 * The database CHECK constraints (0 <= count <= capacity) are a second line of defence.
 * Returns { bus, from, to } or an error object { error, status, code }.
 */
export async function changeCount(username, busId, action) {
  if (!ACTIONS.includes(action)) return fail("Invalid action.", 400, "invalid_action", "action");
  return tx(async (c) => {
    const r = (await c.query(
      `SELECT b.bus_id, b.name, b.capacity, b.status, b.passenger_count, b.occupancy_updated_at, a.conductor
         FROM buses b LEFT JOIN conductor_assignments a ON a.bus_id = b.bus_id
        WHERE b.bus_id = $1 FOR UPDATE OF b`, [busId])).rows[0];
    if (!r || r.conductor !== username) return fail("You are not assigned to this bus.", 403, "not_assigned");
    if (r.status !== "active") return fail("This bus is not in service.", 409, "bus_not_active");
    if (r.capacity == null) return fail("This bus has no capacity set. Ask an administrator.", 409, "no_capacity");
    const from = r.passenger_count ?? null;
    let to;
    if (action === "board") {
      if ((from ?? 0) >= r.capacity) return fail(`The bus is full (capacity ${r.capacity}).`, 409, "full");
      to = (from ?? 0) + 1;
    } else if (action === "alight") {
      if ((from ?? 0) <= 0) return fail("No passengers are counted on board.", 409, "empty");
      to = from - 1;
    } else to = 0;
    const u = await c.query("UPDATE buses SET passenger_count = $2, occupancy_updated_at = now() WHERE bus_id = $1 RETURNING occupancy_updated_at", [busId, to]);
    return { bus: { ...rowBus(r), passengerCount: to, occupancyUpdatedAt: u.rows[0].occupancy_updated_at.toISOString() }, from, to };
  });
}
