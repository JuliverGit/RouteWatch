// The configured route: its stops (the only hand-written data) and the ROAD GEOMETRY between them.
// The road geometry is NOT written here. It is calculated from OpenStreetMap road data by
// OSRM (see routing.js) and installed with setRoadGeometry(). Until that has happened
// there is no route line, so nothing can be drawn across water by mistake.
// Shared by the API (index.js), tracking.js, routing.js and the demo simulator (simulator.js).

// Bus stops, in travel order. Coordinates (lat,lng) are the town/barangay centres from PhilAtlas,
// NOT exact bus stops: OSRM moves each one onto the nearest road, so they only need to be close
// (within 1 km of a road, or the route is refused). To use an exact bus stop, right-click it in
// Google Maps and click the coordinates to copy them.
// These are only the STARTING data: they become route R-01 and its bus stops the first time the server
// runs (see network.js). After that, the stops and route are managed in the app, and configureStops()
// below replaces them with what the administrators saved.
const CONFIG_STOPS = [
  { id: "S-01", name: "Villanueva", p: [8.5859, 124.7704] },
  { id: "S-02", name: "Tagoloan", p: [8.5385, 124.754] },
  { id: "S-03", name: "Bugo", p: [8.5069, 124.7537] },
  { id: "S-04", name: "Macabalan", p: [8.5028, 124.6613] },
  { id: "S-05", name: "CDO Divisoria", p: [8.478, 124.648] },
];
export const SEED_STOPS = CONFIG_STOPS.map((s) => ({ ...s, p: [...s.p] }));
// Anything outside this box is rejected (bad location updates and bad routes alike).
export const SERVICE_AREA = { minLat: 8.3, maxLat: 8.8, minLng: 124.4, maxLng: 125.0 };

// Each stop: name, p (where it is drawn: the original point until a road route exists, then the
// spot on the road), p0 (the configured point), d (metres along the road route, null until known).
export const STOPS = CONFIG_STOPS.map((s) => ({ id: s.id, name: s.name, p: [...s.p], p0: [...s.p], d: null }));
export let ROUTE_NAME = `${STOPS[0].name} – ${STOPS.at(-1).name}`; // live binding: importers see a renamed route

/** Replaces the tracked route's stops (after an administrator changed them) and forgets the old road geometry. */
export function configureStops(name, list) {
  STOPS.length = 0;
  list.forEach((s) => STOPS.push({ id: s.id, name: s.name, p: [...s.p], p0: [...s.p], d: null }));
  ROUTE_NAME = name;
  clearRoadGeometry();
}
/** A rename (route or stop names only) changes no geometry, so the road route and tracking are kept. */
export function renameStops(name, list) {
  ROUTE_NAME = name;
  list.forEach((s, i) => { if (STOPS[i]) STOPS[i].name = s.name; });
}

// Great-circle distance in metres.
export const hv = (a, b) => {
  const r = (x) => (x * Math.PI) / 180, dLa = r(b[0] - a[0]), dLo = r(b[1] - a[1]);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLo / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
};

// ---- Road geometry ----
// These are live bindings: importers see the new values after setRoadGeometry() runs.
export let W = [];      // [[lat,lng], ...] along the road, in travel order (empty until loaded)
export let TOTAL = 0;   // length of W in metres
let cum = [];           // cum[i] = metres from the start to W[i]
export const isReady = () => W.length >= 2;

const index = (coords) => {
  const c = [0];
  for (let i = 1; i < coords.length; i++) c.push(c[i - 1] + hv(coords[i - 1], coords[i]));
  return c;
};

/**
 * Where a coordinate lies relative to a path: { d, off }
 *   d   = distance along the path in metres (nearest point on the line)
 *   off = how far the coordinate is from the line, in metres
 * minD keeps the search ahead of a given distance, so stops are found in order. Uses a flat
 * local approximation, which is accurate to well under a metre over a few hundred metres.
 */
function locate(coords, c, p, minD = 0) {
  const k = Math.cos((p[0] * Math.PI) / 180);
  const xy = (q) => [(q[1] - p[1]) * k * 111320, (q[0] - p[0]) * 110540]; // metres relative to p
  let best = { d: 0, off: Infinity };
  for (let i = 1; i < coords.length; i++) {
    if (c[i] < minD) continue;
    const [ax, ay] = xy(coords[i - 1]), [bx, by] = xy(coords[i]);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const off = Math.hypot(ax + dx * t, ay + dy * t);
    if (off < best.off) best = { d: Math.max(minD, c[i - 1] + (c[i] - c[i - 1]) * t), off };
  }
  return best;
}

/**
 * Checks a candidate road route against the stops WITHOUT installing it.
 * Returns { total, stops: [{ d, off }] } where each stop is located in travel order.
 */
export function analyzeRoute(coords, snapped = null) {
  const c = index(coords);
  let minD = 0;
  const stops = STOPS.map((s, i) => {
    const r = locate(coords, c, snapped?.[i] ?? s.p0, minD);
    minD = r.d;
    return r;
  });
  return { total: c.at(-1), stops };
}

/** Installs a road route. snapped = where OSRM placed each stop on the road (optional). */
export function setRoadGeometry(coords, snapped = null) {
  const c = index(coords);
  W = coords; cum = c; TOTAL = c.at(-1);
  const { stops } = analyzeRoute(coords, snapped);
  STOPS.forEach((s, i) => { s.d = stops[i].d; s.p = snapped?.[i] ? [...snapped[i]] : [...s.p0]; });
}

/** Forgets the road route (no line, no distances). */
export function clearRoadGeometry() {
  W = []; cum = []; TOTAL = 0;
  STOPS.forEach((s) => { s.d = null; s.p = [...s.p0]; });
}

/** Point at distance d (metres) along the road route. */
export const at = (d) => {
  if (!isReady()) throw new Error("No road route loaded");
  const x = Math.max(0, Math.min(TOTAL, d));
  let lo = 1, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; }
  const span = cum[lo] - cum[lo - 1];
  const t = span ? (x - cum[lo - 1]) / span : 0;
  return [W[lo - 1][0] + (W[lo][0] - W[lo - 1][0]) * t, W[lo - 1][1] + (W[lo][1] - W[lo - 1][1]) * t];
};

/** Position of a coordinate relative to the road route, or null when no route is loaded. */
export const project = (p) => (isReady() ? locate(W, cum, p, 0) : null);