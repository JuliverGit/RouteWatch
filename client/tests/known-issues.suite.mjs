// Documented defects that are NOT fixed yet. A reproduced issue is reported as KNOWN and does not fail the run.
// When one is fixed, turn its known(...) into check(...) with the opposite expectation, so it stays fixed.
//
// Map focus leak: App keeps `mapFocus` (set by "show on map") across pages and across log out. LiveMap applies it whenever it mounts.
import { known, check, section, sleep } from "./harness.mjs";

const DEFAULT_ZOOM = 11, FOCUS_ZOOM = 15;

/** Adds one alert about a real bus to /api/dashboard answers, in this page only: nothing is written to the database. */
async function injectBusAlert(p, bus) {
  const alert = { id: 999001, title: "Test alert (browser only)", description: "Injected by the smoke test.", category: "bus_delay", categoryLabel: "Bus delay", severity: "warning", audience: "public", status: "published", state: "active", busId: bus.id, busName: bus.name, routeId: null, routeName: null, stopId: null, stopName: null, publishedAt: new Date().toISOString(), expiresAt: null };
  await p.s("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    window.__testAlert = ${JSON.stringify(alert)};
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      const r = await realFetch(url, options);
      if (!window.__testAlert || !String(url).startsWith("/api/dashboard") || !r.ok) return r;
      const d = await r.json();
      d.serviceAlerts = [window.__testAlert];
      return new Response(JSON.stringify(d), { status: 200, headers: { "Content-Type": "application/json" } });
    };
  })();` });
  await p.reload();
}
const settledZoom = async (p) => { await p.waitFor("document.querySelectorAll('img.leaflet-tile').length > 0", 8000); await sleep(2200); const z = await p.mapZooms(); return z.at(-1); };

export async function knownIssuesSuite({ browser, accounts, live }) {
  section("known issue: map focus leak");
  const bus = live[0];
  if (!bus) return check("map focus test has a live bus to focus on", false);

  const control = await browser.open();
  await control.signIn(accounts.passenger2); await control.open("Live map");
  const fresh = await settledZoom(control);
  check("control: a fresh sign-in opens the map at the default view", fresh === DEFAULT_ZOOM, `zoom ${fresh}`);
  await control.click('[aria-label="Log out"]'); await control.waitFor("!!document.querySelector('#au-id')");
  await control.close();

  const p = await browser.open();
  await injectBusAlert(p, bus);
  check("user A signs in", await p.signIn(accounts.passenger));
  check("user A sees a bus alert with a Show-on-map button", await p.waitFor(`!!document.querySelector('[aria-label^="Show bus"]')`, 10000), await p.eval("(document.querySelector('.topbar h1')?.textContent ?? 'no topbar') + ': ' + [...document.querySelectorAll('.alertcard h3')].map((x) => x.textContent).join()"));
  await p.click('[aria-label^="Show bus"]');
  await p.waitFor(`document.querySelector('.topbar h1')?.textContent === 'Live map'`, 5000);
  const focused = await settledZoom(p);
  check("user A: Show on map focuses the bus", focused >= FOCUS_ZOOM, `zoom ${focused}`);

  await p.open("Dashboard"); await p.open("Live map");
  const back = await settledZoom(p);
  known("same user: returning to the map replays the old alert focus", back >= FOCUS_ZOOM, `zoom ${back}, expected ${DEFAULT_ZOOM} if the focus were cleared`);

  await p.eval("window.__testAlert = null");
  await p.click('[aria-label="Log out"]');
  await p.waitFor("!!document.querySelector('#au-id')");
  await p.signIn(accounts.passenger2); // same tab, no page reload
  await p.open("Live map");
  const leaked = await settledZoom(p);
  known("next user in the same tab inherits the previous user's map focus", leaked >= FOCUS_ZOOM, `user B opened the map at zoom ${leaked}; a fresh sign-in opens at ${fresh}`);
  check("no JavaScript errors during the map focus test", p.errors.length === 0, p.errors.slice(0, 2).join(" / "));
  await p.close();
}
