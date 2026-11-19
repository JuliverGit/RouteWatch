// Bus tracking: receives location updates from registered devices, validates them, keeps the
// latest known position of each bus and works out how fresh that position is.
//
// Storage: the LATEST position of each bus is kept in memory only (a deliberate choice, see below). Everything
// that is configuration or a business record (buses, devices, route assignments) comes from PostgreSQL.
// A position is a few seconds old by the time anyone could use it, so writing every update to the database
// (one row per bus every 2 seconds) would add load without adding value, and after a server restart a stored
// position would wrongly look "last known" for a bus that may have gone silent. After a restart buses show
// "unavailable" until their devices report again, which is the honest state. Position HISTORY (a table such as
// bus_locations) would be a new, separate feature; it is not needed by any current screen.
import { STOPS, SERVICE_AREA, hv, project } from "./route.js";
import { assignmentMap, TRACKED_ROUTE_ID } from "./network.js";
import { findByToken, listDevices } from "./devices.js";
import { listBuses, getBus } from "./buses.js";
import { createLimiter } from "./auth.js";
import { audit } from "./audit.js";
import { conductorMap, occupancyView } from "./occupancy.js";

const num = (name, fallback) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : fallback; };
export const CONFIG = {
  currentS: num("TRACK_CURRENT_SECONDS", 15),   // seen within this long ago  -> "current"
  delayedS: num("TRACK_DELAYED_SECONDS", 60),   // ... within this            -> "delayed"
  staleS: num("TRACK_STALE_SECONDS", 300),      // ... within this            -> "stale" (last known position), after that "unavailable"
  maxAgeS: num("TRACK_MAX_AGE_SECONDS", 30),    // a reading older than this is rejected
  futureS: 5,                                   // a reading dated further ahead than this is rejected
  // Fastest plausible movement between two readings. Generous because the demo simulator
  // runs at 60 m/s so buses visibly move; use about 35 (126 km/h) for real buses.
  maxSpeed: num("TRACK_MAX_SPEED_MPS", 80),
  ratePerMinute: num("TRACK_RATE_PER_MINUTE", 60),
  offRouteM: 500,                               // further than this from the route: shown on the map, but no arrival estimate
  area: SERVICE_AREA,                           // service area around the Villanueva–CDO corridor
};

const buses = new Map();      // busId -> latest known state
const stats = { unauthorized: 0 };
const hits = new Map();       // deviceId -> timestamps of recent submissions (rate limit)
const authLimiter = createLimiter({ max: 20, windowMs: 60_000 }); // failed device logins, per IP

// The audit log must not be flooded by a misbehaving or hostile device, so repeats are summarised.
const lastAudit = new Map();
function auditOnce(key, event, everyMs = 60_000) {
  const now = Date.now();
  if (now - (lastAudit.get(key) ?? 0) < everyMs) return;
  lastAudit.set(key, now);
  if (lastAudit.size > 500) for (const [k, t] of lastAudit) if (now - t > everyMs) lastAudit.delete(k);
  audit(event);
}

/** One consistent read of what the views need from the database: the bus registry, the devices, the route assignments and the conductors. */
export async function fleetContext() {
  const [buses, devices, assigned, conductors] = await Promise.all([listBuses(), listDevices(), assignmentMap(), conductorMap()]);
  return { buses, devices: devices.filter((d) => d.active), assigned, conductors };
}
const deviceOf = (ctx, busId) => ctx.devices.find((d) => d.busId === busId) ?? null;

const state = (device) => {
  let s = buses.get(device.busId);
  if (!s) { s = { busId: device.busId, last: null, speed: null, dir: null, accepted: 0, rejected: 0, lastRejection: null }; buses.set(device.busId, s); }
  return s;
};

/** Checks a submitted body. Returns { fix } or { reason }. Reasons are fixed codes, so nothing from the input is echoed back. */
function validate(body, prev, now) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { reason: "invalid_body" };
  const { lat, lng, timestamp } = body; // everything else in the body is ignored, never stored (a device cannot report passenger numbers)
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return { reason: "invalid_coordinates" };
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { reason: "coordinates_out_of_range" };
  const a = CONFIG.area;
  if (lat < a.minLat || lat > a.maxLat || lng < a.minLng || lng > a.maxLng) return { reason: "outside_service_area" };

  let ts = NaN;
  if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 1e12) ts = timestamp;          // epoch milliseconds
  else if (typeof timestamp === "string" && timestamp.length <= 40) ts = Date.parse(timestamp);                   // ISO 8601
  if (!Number.isFinite(ts)) return { reason: "invalid_timestamp" };
  if (ts < now - CONFIG.maxAgeS * 1000) return { reason: "timestamp_too_old" };
  if (ts > now + CONFIG.futureS * 1000) return { reason: "timestamp_in_future" };
  if (prev && ts <= prev.ts) return { reason: "timestamp_out_of_order" }; // also stops a captured request from being replayed
  if (prev) {
    const dt = (ts - prev.ts) / 1000;
    if (hv([prev.lat, prev.lng], [lat, lng]) / dt > CONFIG.maxSpeed) return { reason: "implausible_jump" };
  }
  return { fix: { lat, lng, ts } };
}

/** POST /api/tracking/location. The device is identified by its token; the bus it may report for comes from the registry, never from the request. */
export async function ingest(req, res) {
  const wait = authLimiter.blockedFor(req.ip);
  if (wait) { res.set("Retry-After", String(wait)); return res.status(429).json({ error: "Too many requests." }); }

  const m = /^Bearer (\S+)$/.exec(req.get("authorization") || "");
  const device = m ? await findByToken(m[1]) : null;
  if (!device) {
    authLimiter.fail(req.ip);
    stats.unauthorized++;
    auditOnce(`auth:${req.ip}`, { action: "device_auth_failed", outcome: "denied", ip: req.ip });
    res.set("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: "Unauthorized." }); // same answer whatever was wrong with the token
  }

  const now = Date.now();
  const recent = (hits.get(device.deviceId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= CONFIG.ratePerMinute) {
    hits.set(device.deviceId, recent);
    auditOnce(`rate:${device.deviceId}`, { action: "device_rate_limited", actor: `device:${device.deviceId}`, target: device.busId, outcome: "denied", ip: req.ip });
    res.set("Retry-After", "10");
    return res.status(429).json({ error: "Too many requests." });
  }
  recent.push(now); hits.set(device.deviceId, recent);

  // The bus registry decides whether this bus may report: it must exist and be Active.
  // (Inactive and under-maintenance buses are not tracked, and their old position is not shown.)
  const bus = await getBus(device.busId);
  if (!bus || bus.status !== "active") {
    const reason = bus ? "bus_not_in_service" : "bus_not_registered";
    auditOnce(`svc:${device.deviceId}:${reason}`, { action: "location_rejected", actor: `device:${device.deviceId}`, target: device.busId, outcome: "denied", ip: req.ip, detail: { reason } });
    return res.status(403).json({ error: "Location rejected.", reason });
  }

  const s = state(device);
  const v = validate(req.body, s.last, now);
  if (!v.fix) {
    s.rejected++; s.lastRejection = { reason: v.reason, at: new Date(now).toISOString() };
    auditOnce(`bad:${device.deviceId}:${v.reason}`, { action: "location_rejected", actor: `device:${device.deviceId}`, target: device.busId, outcome: "failure", ip: req.ip, detail: { reason: v.reason } });
    return res.status(400).json({ error: "Location rejected.", reason: v.reason });
  }

  const { lat, lng, ts } = v.fix;
  // Position along the road route. With no road route loaded yet, the bus is still shown but gets no arrival estimate.
  const { d, off } = project([lat, lng]) ?? { d: 0, off: Infinity };
  const prev = s.last;
  if (prev && prev.off <= CONFIG.offRouteM && off <= CONFIG.offRouteM) {
    const velocity = (d - prev.d) / ((ts - prev.ts) / 1000); // metres/second along the route; negative = towards Villanueva
    s.speed = s.speed == null ? velocity : 0.5 * s.speed + 0.5 * velocity; // smoothed, so one noisy reading does not swing the estimate
    if (Math.abs(s.speed) >= 1) s.dir = s.speed > 0 ? 1 : -1;
  }
  s.last = { lat, lng, ts, d, off, receivedAt: now };
  s.accepted++;
  return res.json({ ok: true, serverTime: new Date(now).toISOString() });
}

const statusOf = (s, now) => {
  if (!s?.last) return "unavailable";
  const age = (now - s.last.receivedAt) / 1000;
  return age <= CONFIG.currentS ? "current" : age <= CONFIG.delayedS ? "delayed" : age <= CONFIG.staleS ? "stale" : "unavailable";
};

/** What every viewer may see about each registered bus. Contains no device ids or credentials. */
export async function snapshot(ctx) {
  ctx ??= await fleetContext();
  const now = Date.now();
  // Registry-driven: only ACTIVE buses are ever presented. A bus with no device or no position yet is listed as "unavailable".
  const assigned = ctx.assigned;
  return ctx.buses.filter((b) => b.status === "active").map((bus) => {
    const dev = deviceOf(ctx, bus.busId);
    const s = buses.get(bus.busId);
    const status = statusOf(s, now);
    const live = status !== "unavailable";
    const a = assigned.get(bus.busId) ?? null;
    const onRoute = !!s?.last && s.last.off <= CONFIG.offRouteM;
    // Arrival estimates exist only for buses on the tracked route, because only that route has road geometry and stop distances.
    const canEstimate = a?.routeId === TRACKED_ROUTE_ID && status === "current" && onRoute && s.dir && Math.abs(s.speed ?? 0) >= 1;
    return {
      id: bus.busId, name: bus.name, route: a?.routeName ?? null, routeId: a?.routeId ?? null, source: dev?.source ?? null, status,
      ageSeconds: s?.last ? Math.round((now - s.last.receivedAt) / 1000) : null,
      updatedAt: s?.last ? new Date(s.last.receivedAt).toISOString() : null,
      pos: live ? [s.last.lat, s.last.lng] : null,
      dir: live ? s.dir : null,
      // Real passenger count kept by the bus's conductor (PostgreSQL). "Not reported" when nobody is counting; never a guess.
      occupancy: occupancyView(bus, ctx.conductors.has(bus.busId)),
      // Arrival estimates only while the position is current; they are estimates from recent movement, not confirmed times.
      etas: STOPS.map((stop) => {
        if (!canEstimate) return null;
        const gap = (stop.d - s.last.d) * s.dir;
        return gap >= 0 ? Math.round(gap / Math.abs(s.speed)) : null;
      }),
    };
  });
}

/** Operational detail for dispatchers and administrators only. */
export async function staffSnapshot(ctx) {
  ctx ??= await fleetContext();
  const now = Date.now();
  const assigned = ctx.assigned;
  return ctx.buses.map((bus) => {
    const dev = deviceOf(ctx, bus.busId);
    const s = buses.get(bus.busId);
    return {
      busId: bus.busId, routeId: assigned.get(bus.busId)?.routeId ?? null, deviceId: dev?.deviceId ?? null, source: dev?.source ?? null, operation: bus.status,
      status: dev && bus.status === "active" ? statusOf(s, now) : "unavailable",
      accepted: s?.accepted ?? 0, rejected: s?.rejected ?? 0, lastRejection: s?.lastRejection ?? null,
      lastAcceptedAt: s?.last ? new Date(s.last.receivedAt).toISOString() : null,
    };
  });
}
export const trackingStats = () => ({ unauthorizedAttempts: stats.unauthorized });

/** "gps" only when every tracked bus reports real GPS. Anything else is labelled as simulated. */
export async function trackingSource(ctx) {
  ctx ??= await fleetContext();
  const ids = new Set(ctx.buses.filter((b) => b.status === "active").map((b) => b.busId));
  const devs = ctx.devices.filter((d) => ids.has(d.busId));
  if (!devs.length) return "none";
  return devs.every((d) => d.source === "gps") ? "gps" : "simulation";
}

// Records when a bus that was reporting goes silent, and when it comes back.
const lost = new Set();
export async function watchConnections(ctx) {
  ctx ??= await fleetContext();
  const now = Date.now();
  for (const bus of ctx.buses.filter((b) => b.status === "active")) {
    const s = buses.get(bus.busId);
    if (!s?.last) continue;
    const status = statusOf(s, now);
    if ((status === "stale" || status === "unavailable") && !lost.has(bus.busId)) {
      lost.add(bus.busId);
      audit({ action: "tracking_lost", actor: "system", target: bus.busId, outcome: "failure", detail: { silentSeconds: Math.round((now - s.last.receivedAt) / 1000) } });
    } else if (status === "current" && lost.has(bus.busId)) {
      lost.delete(bus.busId);
      audit({ action: "tracking_restored", actor: "system", target: bus.busId });
    }
  }
}

/** Forgets a bus's last position. Called when a bus leaves service, so an old position can never reappear as "current" later. */
export function forget(busId) { buses.delete(busId); lost.delete(busId); }
/** The tracked route changed, so every stored position/direction (measured along the OLD road) is dropped. Buses reappear with their next update. */
export function forgetAll() { buses.clear(); lost.clear(); }
