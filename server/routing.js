// Road-following route geometry from OSRM (Open Source Routing Machine) using OpenStreetMap data.
//
// The server asks OSRM for the driving route through all stops, in order. The server (not the
// browser) does this so that the map, the bus simulation and the arrival estimates all use the
// SAME road geometry, and so OSRM is contacted once rather than by every visitor.
//
// Resilience:
//  * The result is cached in server/data/route-cache.json. If OSRM is unreachable later (for
//    example no internet at a presentation) the cached road route is used.
//  * With no cache and no OSRM, the status is "unavailable". The API then sends NO route line.
//    A straight line between stops would cross water, so it is deliberately never drawn.
//  * While unavailable the server retries in the background (30 s, then slower).
//
// OSRM_URL defaults to the public demo server (https://router.project-osrm.org), which is fine for
// a student project but is not meant for heavy use. For production, run your own OSRM.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STOPS, SERVICE_AREA, analyzeRoute, setRoadGeometry, hv } from "./route.js";
import { audit } from "./audit.js";

const BASE = (process.env.OSRM_URL || "https://router.project-osrm.org").replace(/\/+$/, "");
const PROFILE = process.env.OSRM_PROFILE || "driving";
const TIMEOUT_MS = Number(process.env.OSRM_TIMEOUT_MS) || 12_000;
const CACHE_TTL_MS = 7 * 24 * 3600_000; // refresh a cached route after a week (the cache is still used if the refresh fails)
export const CACHE_FILE = process.env.ROUTE_CACHE_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "route-cache.json");

/** status: "loading" (first attempt running) | "ready" | "unavailable" (no route; will retry). */
export const routing = { status: "loading", source: null, updatedAt: null };
let lastError = null, lastAttempt = 0, inflight = null, retryTimer = null, failures = 0, generation = 0;
export const lastRoutingError = () => lastError; // for logs and the check script, never sent to the browser

const stopsKey = () => crypto.createHash("sha1").update(JSON.stringify([PROFILE, STOPS.map((s) => [s.name, s.p0])])).digest("hex");

// ---- Validation: a route is only used when it makes sense for THESE stops ----
const MARGIN = 0.05; // degrees around the service area
const inArea = ([lat, lng]) => lat > SERVICE_AREA.minLat - MARGIN && lat < SERVICE_AREA.maxLat + MARGIN && lng > SERVICE_AREA.minLng - MARGIN && lng < SERVICE_AREA.maxLng + MARGIN;
const isPoint = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** Throws an Error with a plain-language reason if the route is unusable. coords/snapped are [lat,lng]. */
export function checkRoute(coords, snapped, snapDistances = []) {
  if (!Array.isArray(coords) || coords.length < 10) throw new Error("route has too few points");
  if (!coords.every(isPoint)) throw new Error("route contains an invalid coordinate");
  if (!coords.every(inArea)) throw new Error("route leaves the service area");
  if (!Array.isArray(snapped) || snapped.length !== STOPS.length || !snapped.every(isPoint)) throw new Error("route does not report every stop");
  const far = snapDistances.map((m, i) => (typeof m === "number" && m > 1000 ? `"${STOPS[i].name}" (${Math.round(m)} m)` : null)).filter(Boolean);
  if (far.length) throw new Error(`stops too far from a road (over 1 km): ${far.join(", ")}. Fix their coordinates in server/route.js`);
  let maxGap = 0;
  for (let i = 1; i < coords.length; i++) maxGap = Math.max(maxGap, hv(coords[i - 1], coords[i]));
  if (maxGap > 5000) throw new Error("route has a gap of more than 5 km (it is not a continuous road)");
  const { total, stops } = analyzeRoute(coords, snapped);
  const straight = hv(STOPS[0].p0, STOPS.at(-1).p0);
  if (total < straight * 0.95 || total > straight * 3) throw new Error(`route length ${(total / 1000).toFixed(1)} km does not fit the stops (${(straight / 1000).toFixed(1)} km apart in a straight line)`);
  stops.forEach((s, i) => { if (s.off > 300) throw new Error(`route does not pass through stop "${STOPS[i].name}" (${Math.round(s.off)} m away)`); });
  stops.forEach((s, i) => { if (i && s.d < stops[i - 1].d + 100) throw new Error(`stops are not visited in order at "${STOPS[i].name}"`); });
  if (stops[0].d > 500 || total - stops.at(-1).d > 500) throw new Error("route does not start and end at the first and last stop");
}

// ---- OSRM ----
export async function fetchFromOsrm(points = STOPS.map((s) => s.p0)) {
  const coords = points.map((p) => `${p[1]},${p[0]}`).join(";"); // OSRM wants lng,lat
  const url = `${BASE}/route/v1/${PROFILE}/${coords}?overview=full&geometries=geojson&steps=false&alternatives=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": "RouteWatch-student-project", Accept: "application/json" } });
  if (!res.ok) throw new Error(`OSRM answered HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body || body.code !== "Ok") throw new Error(`OSRM could not route the stops (${body?.code ?? "invalid response"})`);
  const line = body.routes?.[0]?.geometry;
  if (line?.type !== "LineString" || !Array.isArray(line.coordinates)) throw new Error("OSRM returned no route geometry");
  const path = line.coordinates.map(([lng, lat]) => [round6(lat), round6(lng)]);
  const wps = body.waypoints ?? [];
  const snapped = wps.map((w) => (Array.isArray(w?.location) ? [round6(w.location[1]), round6(w.location[0])] : null));
  return { path, snapped, snapDistances: wps.map((w) => w?.distance) };
}

function install(route, source, fetchedAt) {
  checkRoute(route.path, route.snapped, route.snapDistances);
  setRoadGeometry(route.path, route.snapped);
  routing.status = "ready"; routing.source = source; routing.updatedAt = new Date(fetchedAt).toISOString();
}

function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (c.version !== 1 || c.key !== stopsKey()) return null; // stops (or profile) changed since it was saved
    return c;
  } catch { return null; }
}
function writeCache(route) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, key: stopsKey(), provider: BASE, fetchedAt: new Date().toISOString(), path: route.path, snapped: route.snapped }), { mode: 0o600 });
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) { console.warn("[routing] could not save the route cache:", e.message); }
}

/** One attempt to get a fresh route from OSRM. Resolves true on success. Never throws. */
export function refresh() {
  if (inflight) return inflight;
  lastAttempt = Date.now();
  const gen = generation;
  inflight = (async () => {
    try {
      const route = await fetchFromOsrm();
      if (gen !== generation) return false; // the stops changed while this was running: this answer is for the old stops
      install(route, "osrm", Date.now());
      writeCache(route);
      failures = 0; lastError = null;
      audit({ action: "route_loaded", actor: "system", outcome: "success", detail: { source: "osrm", points: route.path.length } });
      console.log(`[routing] road route loaded from OSRM (${route.path.length} points)`);
      return true;
    } catch (e) {
      if (gen !== generation) return false;
      lastError = e.name === "TimeoutError" ? "OSRM did not answer in time" : e.message;
      failures++;
      if (routing.status !== "ready") {
        const first = routing.status !== "unavailable";
        routing.status = "unavailable";
        if (first) audit({ action: "route_unavailable", actor: "system", outcome: "failure", detail: { reason: lastError } });
      }
      console.warn(`[routing] ${lastError}${routing.status === "ready" ? " (keeping the cached road route)" : " (no road route; the map shows stops only; retrying)"}`);
      return false;
    } finally { if (gen === generation) { inflight = null; scheduleRetry(); } }
  })();
  return inflight;
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  const stale = routing.status === "ready" && routing.source === "cache" && Date.now() - Date.parse(routing.updatedAt) > CACHE_TTL_MS;
  if (routing.status === "ready" && !stale) return;
  const wait = Math.min(30_000 * 2 ** Math.max(0, failures - 1), 300_000);
  retryTimer = setTimeout(() => refresh(), wait);
  retryTimer.unref();
}

/** Called once at startup: use a saved route straight away, then (if needed) refresh it from OSRM. */
export function startRouting() {
  const cached = readCache();
  if (cached) {
    try {
      install({ path: cached.path, snapped: cached.snapped }, "cache", Date.parse(cached.fetchedAt));
      console.log("[routing] road route loaded from the saved cache");
    } catch (e) { console.warn("[routing] ignoring the saved route:", e.message); }
  }
  const age = routing.updatedAt ? Date.now() - Date.parse(routing.updatedAt) : Infinity;
  if (routing.status !== "ready" || age > CACHE_TTL_MS) refresh();
}

/** The tracked route's stops changed: forget the old road route and load the one for the new stops (saved copy first, then OSRM). */
export function reloadRouting() {
  generation++; inflight = null; failures = 0; lastError = null; lastAttempt = 0;
  clearTimeout(retryTimer);
  routing.status = "loading"; routing.source = null; routing.updatedAt = null;
  startRouting();
}

/** Lets a visitor's request nudge a retry, at most once every 15 seconds. */
export function requestRetry() {
  if (routing.status === "ready" || inflight || Date.now() - lastAttempt < 15_000) return;
  refresh();
}

/** For the check script: fetch and validate a fresh route without touching the running state. */
export async function previewRoute() {
  const route = await fetchFromOsrm();
  checkRoute(route.path, route.snapped, route.snapDistances);
  return { ...route, provider: BASE };
}
export { writeCache as saveRouteCache };