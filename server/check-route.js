// Fetches the road route from OSRM, checks it, saves it for offline use and writes a GeoJSON file
// you can open to LOOK at the route on a real map. Usage:  npm run check-route
//   1. Run it once with internet. It saves server/data/route-cache.json so the demo also works offline.
//   2. Open server/data/route.geojson at https://geojson.io (drag and drop the file) and confirm
//      the line follows the roads and stays on land.
import fs from "node:fs";
import path from "node:path";
import { fetchFromOsrm, checkRoute, saveRouteCache, CACHE_FILE } from "./routing.js";
import { STOPS, analyzeRoute, hv } from "./route.js";

try {
  console.log("Asking OSRM for the road route through the stops...");
  const route = await fetchFromOsrm();
  route.provider = process.env.OSRM_URL || "https://router.project-osrm.org";
  // Show how far OSRM had to move each stop BEFORE judging the route, so a bad coordinate is easy to find.
  console.log("\nStop                  distance to nearest road");
  STOPS.forEach((s, i) => console.log(`${s.name.padEnd(20)}  ${String(Math.round(route.snapDistances[i] ?? -1)).padStart(6)} m${route.snapDistances[i] > 1000 ? "   <-- too far: fix this stop's coordinates in server/route.js" : ""}`));
  checkRoute(route.path, route.snapped, route.snapDistances);
  const { total, stops } = analyzeRoute(route.path, route.snapped);
  const straight = STOPS.slice(1).reduce((sum, s, i) => sum + hv(STOPS[i].p0, s.p0), 0);
  console.log(`\nProvider: ${route.provider}`);
  console.log(`Road route: ${route.path.length} points, ${(total / 1000).toFixed(1)} km (straight lines between the stops would be ${(straight / 1000).toFixed(1)} km)\n`);
  STOPS.forEach((s, i) => console.log(`${s.name.padEnd(20)}  km along the route: ${(stops[i].d / 1000).toFixed(1)}`));
  console.log("\nAll checks passed: continuous, inside the service area, passes through every stop in order.");

  saveRouteCache(route);
  const geo = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { name: "Road route (OSRM)" }, geometry: { type: "LineString", coordinates: route.path.map(([lat, lng]) => [lng, lat]) } },
      ...STOPS.map((s, i) => ({ type: "Feature", properties: { name: s.name, order: i + 1 }, geometry: { type: "Point", coordinates: [route.snapped[i][1], route.snapped[i][0]] } })),
    ],
  };
  const out = path.join(path.dirname(CACHE_FILE), "route.geojson");
  fs.writeFileSync(out, JSON.stringify(geo));
  console.log(`\nSaved: ${path.relative(process.cwd(), CACHE_FILE)} (used by the server) and ${path.relative(process.cwd(), out)} (open it at https://geojson.io to see the route on a map).`);
} catch (e) {
  console.error(`\nThe route could not be loaded or did not pass the checks: ${e.message}`);
  console.error("Check your internet connection. If a stop is far from a road, fix its coordinates in server/route.js.");
  process.exit(1);
}