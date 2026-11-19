// Passenger-side geography for the Nearby Buses finder. Pure functions with no network and no storage:
// the passenger's own position is used only inside the browser and is never sent to the server.

const EARTH_RADIUS_M = 6371008.8; // mean Earth radius in metres

/** Nearby search radius choices (metres) and the default. */
export const RADIUS_OPTIONS = [1000, 3000, 5000, 10000];
export const DEFAULT_RADIUS_M = 3000;

/** Accuracy (metres) above which the passenger is told their position is approximate. */
export const POOR_ACCURACY_M = 100;

/** Only these tracking states are treated as a live position. "stale" is a last known position, "unavailable" has none. */
const LIVE_STATES = new Set(["current", "delayed"]);

/** True for a finite [lat, lng] pair inside the valid coordinate range. */
export const isLatLng = (p) =>
  Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;

/** Straight-line ("as the crow flies") distance in metres between two [lat, lng] points, using the Haversine formula. */
export function haversineMeters(a, b) {
  if (!isLatLng(a) || !isLatLng(b)) return NaN;
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "under 10 m", "450 m" (rounded to 10 m), "2.3 km", "14 km". */
export function formatDistance(m) {
  if (!Number.isFinite(m) || m < 0) return "–";
  if (m < 10) return "under 10 m";
  const tens = Math.round(m / 10) * 10;
  if (tens < 1000) return `${tens} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

/** A search radius as a short label: "1 km", "3 km", "10 km". */
export const formatRadius = (m) => `${Math.round(m / 100) / 10} km`;

/** Does this bus have a position that may be shown as LIVE (not stale, not missing)? */
export const hasLivePosition = (bus) => !!bus && LIVE_STATES.has(bus.status) && isLatLng(bus.pos);

/**
 * Buses within `radiusM` of the passenger, nearest first (ties by bus id, so the order is stable between updates).
 * Returns { nearby: [{ bus, distance }], nearest, outside, notLive }:
 *   nearest  the closest live bus even if it is outside the radius (for the empty state), or null
 *   outside  how many live buses are farther than the radius
 *   notLive  how many buses have no live position (stale or unavailable) and were therefore left out
 */
export function findNearby(buses, here, radiusM) {
  const out = { nearby: [], nearest: null, outside: 0, notLive: 0 };
  if (!Array.isArray(buses) || !isLatLng(here)) return out;
  const live = [];
  for (const bus of buses) {
    if (!hasLivePosition(bus)) { out.notLive++; continue; }
    live.push({ bus, distance: haversineMeters(here, bus.pos) });
  }
  live.sort((x, y) => x.distance - y.distance || String(x.bus.id).localeCompare(String(y.bus.id)));
  out.nearest = live[0] ?? null;
  for (const x of live) {
    if (x.distance <= radiusM) out.nearby.push(x);
    else out.outside++;
  }
  return out;
}

/** What to tell the passenger when their location cannot be used. `kind` is a GeolocationPositionError code (1, 2, 3) or a name. */
export function locationProblem(kind) {
  switch (kind) {
    case "unsupported":
      return { title: "Location is not supported", text: "This browser cannot share your location. The map and the bus list still work; try a current version of Chrome, Edge, Firefox or Safari to see nearby buses." };
    case "insecure":
      return { title: "Location needs a secure connection", text: "Browsers only share your location with secure (https) pages or with localhost. Open RouteWatch through its https address to use this feature. The map still works." };
    case 1: case "denied":
      return { title: "Location permission is blocked", text: "RouteWatch is not allowed to use your location, so nearby buses cannot be found. To allow it: select the lock or site-information icon next to the web address, open the site permissions, set Location to Allow, then press My location again. On a phone, also make sure the browser is allowed to use location in your device settings. The map still works without it." };
    case 2: case "unavailable":
      return { title: "Location unavailable", text: "Your device could not work out where you are. Check that location services (GPS) are turned on in your device settings, then try again." };
    case 3: case "timeout":
      return { title: "Location request timed out", text: "Finding your location took too long. Move closer to a window or an open area, check that location services are on, then try again." };
    default:
      return { title: "Location unavailable", text: "Your location could not be determined. Please try again." };
  }
}
