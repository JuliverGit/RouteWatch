// SIMULATED GPS devices (Option C). Each simulated bus sends its position to the server over
// HTTP with its own device token, exactly like a real device would, so the whole pipeline
// (authentication, validation, status, Socket.IO) is exercised. These coordinates are
// generated, NOT real GPS, and the server labels them "simulation" because the device is
// registered with that source.
//
//   npm run seed-simulator    (once: registers 2 demo devices and saves their tokens)
//   npm run simulate          (runs them; the server also starts this automatically in development)
import fs from "node:fs";
import { TOTAL, at, setRoadGeometry } from "./route.js";
import { SIM_TOKENS_FILE as TOKENS_FILE } from "./devices.js";

const SERVER = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 5000}`;
const SPEED = Number(process.env.SIM_SPEED) || 60; // metres/second (demo speed so buses visibly move)
const PERIOD = 2000;   // one location update every 2 seconds

process.on("disconnect", () => process.exit(0)); // started by the server: stop when it stops

// The buses drive along the ROAD route the server calculated (OSRM), not in straight lines between stops.
// The server may still be loading that route (also after an administrator changes the tracked route's stops), so wait for it.
let routeKey = null, routeReady = false;
async function checkRoute() {
  try {
    const d = await (await fetch(`${SERVER}/api/route`, { signal: AbortSignal.timeout(5000) })).json();
    if (d.status === "ready" && Array.isArray(d.path) && d.path.length >= 2) {
      const key = `${d.path.length}:${d.path[0]}:${d.path.at(-1)}`;
      if (key !== routeKey) { // first load, or the route changed: drive the new road from the ends again
        routeKey = key; setRoadGeometry(d.path);
        for (const b of buses) { b.d = b.start === "cdo" ? TOTAL : 0; b.dir = b.start === "cdo" ? -1 : 1; }
        console.log(`[simulator] road route ${routeReady ? "changed" : "loaded"}: ${(TOTAL / 1000).toFixed(1)} km`);
      }
      routeReady = true; return true;
    }
    if (routeReady) { routeReady = false; console.log(`[simulator] paused: the server says the route is ${d.status}`); }
  } catch { if (routeReady) { routeReady = false; console.log("[simulator] paused: cannot reach the server"); } }
  return false;
}
const buses = [];
while (!(await checkRoute())) { console.log("[simulator] waiting for the road route..."); await new Promise((r) => setTimeout(r, 3000)); }
setInterval(checkRoute, 5000);

// The set of simulated devices follows the tokens file, which Bus Management updates when an administrator
// registers a bus with simulated GPS (or turns it off). New buses start driving within a few seconds.
let tokensMtime = -1;
function syncDevices() {
  let mtime = 0;
  try { mtime = fs.statSync(TOKENS_FILE).mtimeMs; } catch { /* no file: no simulated devices */ }
  if (mtime === tokensMtime) return;
  tokensMtime = mtime;
  let list = [];
  try { list = mtime ? JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")) : []; } catch { return; } // half-written file: try again next time
  if (!Array.isArray(list)) return;
  const ids = new Set(list.map((x) => x.deviceId));
  for (let i = buses.length - 1; i >= 0; i--) if (!ids.has(buses[i].deviceId)) { console.log(`[simulator] ${buses[i].deviceId} removed`); buses.splice(i, 1); }
  for (const x of list) {
    const known = buses.find((b) => b.deviceId === x.deviceId);
    if (known) { known.token = x.token; continue; }
    buses.push({ token: x.token, deviceId: x.deviceId, start: x.start, d: x.start === "cdo" ? TOTAL : 0, dir: x.start === "cdo" ? -1 : 1, warned: false });
    console.log(`[simulator] ${x.deviceId} added`);
  }
}
syncDevices();
console.log(`[simulator] driving a ${(TOTAL / 1000).toFixed(1)} km road route -> ${SERVER}/api/tracking/location (SIMULATED data, not GPS)`);
setInterval(syncDevices, 3000);

async function tick() {
  if (!routeReady) return; // do not send positions measured along a route the server no longer uses
  for (const b of [...buses]) {
    b.d += b.dir * SPEED * (PERIOD / 1000);
    if (b.d >= TOTAL) { b.d = TOTAL; b.dir = -1; }
    if (b.d <= 0) { b.d = 0; b.dir = 1; }
    const [lat, lng] = at(b.d);
    try {
      const r = await fetch(`${SERVER}/api/tracking/location`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${b.token}` },
        body: JSON.stringify({ lat, lng, timestamp: Date.now() }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok && !b.warned) { b.warned = true; console.error(`[simulator] ${b.deviceId}: server answered ${r.status}`); }
      if (r.ok) b.warned = false;
    } catch {
      if (!b.warned) { b.warned = true; console.error(`[simulator] ${b.deviceId}: cannot reach the server (will keep trying)`); }
    }
  }
}
setInterval(tick, PERIOD);
tick();
