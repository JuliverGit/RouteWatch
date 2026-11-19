// Road geometry for routes OTHER than the tracked one, used only to DRAW them on the map.
// (The tracked route has its own pipeline in routing.js, which also drives arrival estimates and the simulator.)
//
// The server asks OSRM for the driving route through a route's active stops and checks the answer is
// plausible (inside the service area, continuous, every stop within 1 km of a road). The result is kept
// in memory for this run. When OSRM cannot be reached or the answer fails the checks, status is
// "unavailable" and the map draws a clearly labelled straight stop-to-stop link instead. That link is
// NOT a road route and is never described as one.
import crypto from "node:crypto";
import { fetchFromOsrm } from "./routing.js";
import { SERVICE_AREA, hv } from "./route.js";

const cache = new Map(); // routeId -> { key, status, path, source, failedAt }
const RETRY_MS = 60_000;
const MAX = 100;

const inArea = ([lat, lng]) => lat >= SERVICE_AREA.minLat - 0.05 && lat <= SERVICE_AREA.maxLat + 0.05 && lng >= SERVICE_AREA.minLng - 0.05 && lng <= SERVICE_AREA.maxLng + 0.05;
function check(path, dists) {
  if (!Array.isArray(path) || path.length < 2) throw new Error("no route geometry");
  if (!path.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && inArea(p))) throw new Error("route leaves the service area");
  for (let i = 1; i < path.length; i++) if (hv(path[i - 1], path[i]) > 5000) throw new Error("route is not continuous");
  if (dists.some((m) => typeof m === "number" && m > 1000)) throw new Error("a stop is more than 1 km from a road");
}

/** { status: "ready"|"loading"|"unavailable", path, source }. Starts (or retries) the lookup in the background; never waits for OSRM. */
export function roadGeometry(routeId, points) {
  if (points.length < 2) return { status: "none", path: [], source: null };
  const key = crypto.createHash("sha1").update(JSON.stringify(points)).digest("hex");
  let e = cache.get(routeId);
  if (!e || e.key !== key) {
    if (cache.size >= MAX) cache.delete(cache.keys().next().value);
    e = { key, status: "loading", path: [], source: null, failedAt: 0 };
    cache.set(routeId, e);
    start(e, points);
  } else if (e.status === "unavailable" && Date.now() - e.failedAt > RETRY_MS) {
    e.status = "loading"; start(e, points);
  }
  return { status: e.status, path: e.status === "ready" ? e.path : [], source: e.source };
}

function start(e, points) {
  fetchFromOsrm(points).then((r) => {
    check(r.path, r.snapDistances);
    e.status = "ready"; e.path = r.path; e.source = "osrm";
  }).catch(() => { e.status = "unavailable"; e.failedAt = Date.now(); });
}