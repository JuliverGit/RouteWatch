// Tracking-device registry: which device may report for which bus (PostgreSQL, table "tracking_devices").
// Only a SHA-256 hash of each device token is stored, never the token itself. Tokens are
// long random values (not passwords), so a fast hash is appropriate and lets us look a
// device up directly from the token it presents.
// This is NOT bus management: it only ties a credential to a bus id for the tracking feature.
//
// The only file left here is the demo simulator's private token list (SIM_TOKENS_FILE). The simulator is a
// separate process that has to HOLD its devices' tokens in order to send them, so they cannot live as hashes;
// the file is git-ignored, mode 600, development-only, and is not part of the database.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, violates } from "./db.js";

// Where `npm run seed-simulator` saves the demo devices' tokens for the simulator (git-ignored data folder).
export const SIM_TOKENS_FILE = process.env.SIM_TOKENS_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "simulator-tokens.json");
export const DEVICE_ID_RE = /^[a-z0-9_-]{3,32}$/;
export const SOURCES = ["simulation", "gps"]; // how the device obtains its coordinates; set here, never by the device

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// What the rest of the server may see about a device. Never includes the token hash.
const view = (d) => ({ deviceId: d.device_id, busId: d.bus_id, source: d.source, active: d.active });
const COLS = "device_id, bus_id, source, active";
export const listDevices = async () => (await query(`SELECT ${COLS} FROM tracking_devices ORDER BY created_at, device_id`)).rows.map(view);

/** The active device that owns this token, or null. The token is hashed first, so only the hash reaches the database. */
export async function findByToken(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const r = await query(`SELECT ${COLS} FROM tracking_devices WHERE token_hash = $1 AND active`, [sha(token)]);
  return r.rows[0] ? view(r.rows[0]) : null;
}

/** The active device registered for a bus, or null. */
export async function deviceForBus(busId) {
  const r = await query(`SELECT ${COLS} FROM tracking_devices WHERE bus_id = $1 AND active`, [busId]);
  return r.rows[0] ? view(r.rows[0]) : null;
}

function readSimTokens() { try { const t = JSON.parse(fs.readFileSync(SIM_TOKENS_FILE, "utf8")); return Array.isArray(t) ? t : []; } catch { return []; } }
function writeSimTokens(list) {
  fs.mkdirSync(path.dirname(SIM_TOKENS_FILE), { recursive: true });
  const tmp = `${SIM_TOKENS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SIM_TOKENS_FILE);
}

/**
 * Turns the SIMULATED GPS device of a bus on or off (used by Bus Management).
 * On: registers a "simulation" device and hands its token to the demo simulator through the private
 * tokens file; the token is never returned to the browser. Off: deactivates the device and removes its token.
 * Returns true if something changed. A bus that already has a real "gps" device is left alone.
 */
export async function setSimulation(busId, busName, enabled) {
  const id = `sim-${String(busId).toLowerCase()}`;
  const existing = await deviceForBus(busId);
  if (enabled) {
    if (existing) return false;
    const token = await saveDevice({ deviceId: id, busId, source: "simulation" });
    try {
      const list = readSimTokens().filter((t) => t.deviceId !== id);
      list.push({ deviceId: id, start: list.length % 2 ? "cdo" : "villanueva", token });
      writeSimTokens(list);
    } catch (e) { // the simulator could never learn the token, so do not leave a device that nothing can use
      await query("UPDATE tracking_devices SET active = false WHERE device_id = $1", [id]);
      throw e;
    }
    return true;
  }
  if (!existing || existing.source !== "simulation") return false;
  await query("UPDATE tracking_devices SET active = false WHERE device_id = $1", [existing.deviceId]);
  writeSimTokens(readSimTokens().filter((t) => t.deviceId !== existing.deviceId));
  return true;
}

/** Creates (or replaces) a device and returns its new token. The token is shown once and never stored. */
export async function saveDevice({ deviceId, busId, source }) {
  const id = String(deviceId ?? "").toLowerCase();
  if (!DEVICE_ID_RE.test(id)) throw new Error("Device id must be 3-32 characters: letters, numbers, _ -");
  if (!/^[A-Za-z0-9_-]{2,16}$/.test(String(busId ?? ""))) throw new Error("Bus id must be 2-16 characters: letters, numbers, _ -");
  if (!SOURCES.includes(source)) throw new Error(`Source must be one of: ${SOURCES.join(", ")}`);
  const token = "rwd_" + crypto.randomBytes(32).toString("base64url");
  try {
    await query(
      `INSERT INTO tracking_devices (device_id, bus_id, source, active, token_hash) VALUES ($1, $2, $3, true, $4)
       ON CONFLICT (device_id) DO UPDATE SET bus_id = EXCLUDED.bus_id, source = EXCLUDED.source, active = true, token_hash = EXCLUDED.token_hash, created_at = now()`,
      [id, busId, source, sha(token)]);
  } catch (e) {
    if (violates(e, "tracking_devices_one_active_per_bus")) throw new Error(`Bus ${busId} already has an active device`);
    if (violates(e, "tracking_devices_bus_id_fkey")) throw new Error(`Bus ${busId} is not registered`);
    throw e;
  }
  return token;
}
