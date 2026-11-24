// Map focus regression tests. A "show on map" request is one-shot and belongs to the session that made it.
// Alerts and a conductor's assigned bus are injected into this page's fetch responses only: nothing is written to the database.
// The zoom level shows where the map went: a fresh map opens at zoom 11, a focused map flies to zoom 15.
import { api, APP, check, section, sleep, tokenHash } from "./harness.mjs";

const DEFAULT_ZOOM = 11, FOCUS_ZOOM = 15;
const SHOW_BUS = '[aria-label^="Show bus"]', SHOW_STOP = '[aria-label^="Show stop"]';
const settledZoom = async (p) => { await p.waitFor("document.querySelectorAll('img.leaflet-tile').length > 0", 8000); await sleep(2200); return (await p.mapZooms()).at(-1); };
const logOut = async (p) => { await p.click('[aria-label="Log out"]'); return p.waitFor("!!document.querySelector('#au-id')"); };
const onPage = (p, label) => p.waitFor(`document.querySelector('.topbar h1')?.textContent === ${JSON.stringify(label)}`, 6000);
const hasButton = (p, text) => p.waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes(${JSON.stringify(text)}))`, 10000);

async function inject(p, { alert = null, conductorBus = null }) {
  await p.s("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    window.__testAlert = ${JSON.stringify(alert)};
    window.__testConductorBus = ${JSON.stringify(conductorBus)};
    const realFetch = window.fetch.bind(window);
    const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { "Content-Type": "application/json" } });
    window.fetch = async (url, options) => {
      const path = String(url);
      if (path.startsWith("/api/conductor/bus") && window.__testConductorBus) return json(window.__testConductorBus);
      const r = await realFetch(url, options);
      if (!window.__testAlert || !r.ok) return r;
      if (path.startsWith("/api/dashboard")) { const d = await r.json(); d.serviceAlerts = [window.__testAlert]; return json(d); }
      if (path.startsWith("/api/alerts/active")) return json({ alerts: [window.__testAlert] });
      return r;
    };
  })();` });
  await p.reload();
}

export async function mapFocusSuite({ browser, accounts, live, query }) {
  section("regression: map focus");
  const bus = (await api("GET", "/api/tracking/buses")).data.find((b) => b.pos && ["current", "delayed"].includes(b.status)) ?? live[0];
  if (!bus) return check("map focus tests have a live bus to focus on", false);
  const stop = (await api("GET", "/api/network/public")).data.stops[0];
  const alert = { id: 999001, title: "Test alert (browser only)", description: "Injected by the smoke test.", category: "bus_delay", categoryLabel: "Bus delay", severity: "warning", audience: "public", status: "published", state: "active", busId: bus.id, busName: bus.name, routeId: null, routeName: null, stopId: stop.stopId, stopName: stop.name, publishedAt: new Date().toISOString(), expiresAt: null };
  const showFromDashboard = async (p, selector = SHOW_BUS) => {
    await p.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 10000);
    await p.click(selector);
    await onPage(p, "Live map");
    return settledZoom(p);
  };

  const control = await browser.open();
  await control.signIn(accounts.passenger2); await control.open("Live map");
  const fresh = await settledZoom(control);
  check("control: a fresh sign-in opens the map at the default view", fresh === DEFAULT_ZOOM, `zoom ${fresh}`);
  await logOut(control); await control.close();

  // ---- The current user's session ----
  const p = await browser.open();
  await inject(p, { alert });
  check("user A signs in", await p.signIn(accounts.passenger));
  const focused = await showFromDashboard(p);
  check("user A: Show on map focuses the bus", focused >= FOCUS_ZOOM, `zoom ${focused}`);
  await p.open("Dashboard"); await p.open("Live map");
  const back = await settledZoom(p);
  check("same user: returning to the map does not replay the old alert focus", back === DEFAULT_ZOOM, `zoom ${back}, expected ${DEFAULT_ZOOM}`);
  await p.open("Dashboard");
  const again = await showFromDashboard(p);
  check("same user: Show on map works again after returning", again >= FOCUS_ZOOM, `zoom ${again}`);
  await p.open("Dashboard");
  const toStop = await showFromDashboard(p, SHOW_STOP);
  check("same user: an alert's stop can be shown on the map", toStop >= FOCUS_ZOOM, `zoom ${toStop}`);
  await p.open("Dashboard"); await p.open("Live map");
  await settledZoom(p);
  const sidebarButton = `.side ${SHOW_BUS}`;
  await p.waitFor(`!!document.querySelector(${JSON.stringify(sidebarButton)})`, 8000);
  await p.click(sidebarButton);
  const sidebar = await settledZoom(p);
  check("same user: an alert in the map sidebar still focuses the map", sidebar >= FOCUS_ZOOM, `zoom ${sidebar}`);

  // ---- Log out, then another user in the same tab, without a page reload ----
  await p.open("Dashboard");
  await showFromDashboard(p);
  check("user A logs out", await logOut(p));
  await p.signIn(accounts.passenger2);
  await p.open("Live map");
  const leaked = await settledZoom(p);
  check("next user in the same tab does not inherit the previous user's map focus", leaked === DEFAULT_ZOOM, `user B opened the map at zoom ${leaked}; a fresh sign-in opens at ${fresh}`);
  await p.open("Dashboard");
  const own = await showFromDashboard(p);
  check("next user: their own Show on map works", own >= FOCUS_ZOOM, `zoom ${own}`);
  await logOut(p);
  await p.signIn(accounts.passenger2);
  await p.open("Live map");
  const sameAgain = await settledZoom(p);
  check("same user signing in again starts with no map focus", sameAgain === DEFAULT_ZOOM, `zoom ${sameAgain}`);

  // ---- A session that expires instead of logging out ----
  await p.open("Dashboard");
  await showFromDashboard(p);
  const { cookies } = await p.s("Network.getCookies", { urls: [APP] });
  await p.open("Dashboard");
  await query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(`x=${cookies.find((x) => x.name === "rw_session").value}`)]);
  check("expired session returns to sign-in", await p.waitFor("!!document.querySelector('#au-id') && document.body.innerText.includes('Your session has expired')", 9000));
  await p.signIn(accounts.passenger);
  await p.open("Live map");
  const afterExpiry = await settledZoom(p);
  check("after session expiry the next sign-in has no map focus", afterExpiry === DEFAULT_ZOOM, `zoom ${afterExpiry}`);
  await logOut(p);

  // ---- Guest to member ----
  await p.click(".au-guest");
  await p.waitFor("document.querySelector('.rail__who')?.innerText.includes('Guest')");
  const guestFocus = await showFromDashboard(p);
  check("guest: Show on map works", guestFocus >= FOCUS_ZOOM, `zoom ${guestFocus}`);
  await p.click('[aria-label="Back to sign in"]');
  await p.signIn(accounts.passenger2);
  await p.open("Live map");
  const afterGuest = await settledZoom(p);
  check("a member signing in after a guest has no map focus", afterGuest === DEFAULT_ZOOM, `zoom ${afterGuest}`);
  check("no JavaScript errors in the same-tab user switches", p.errors.length === 0, p.errors.slice(0, 2).join(" / "));
  await logOut(p);
  await p.close();

  // ---- The account changes underneath an open map (for example, a sign-in in another tab) ----
  const swap = await browser.open();
  await inject(swap, { alert });
  await swap.signIn(accounts.passenger);
  await showFromDashboard(swap);
  const b = accounts.passenger2;
  const switched = await swap.eval(`fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(${JSON.stringify({ username: b.username, password: b.password })}) }).then((r) => r.ok)`);
  check("another sign-in replaces the session while the map is open", switched);
  check("the open page follows the new account (60-second session check)", await swap.waitFor(`document.querySelector('.rail__who')?.innerText.includes(${JSON.stringify(b.username)})`, 70000));
  const swapped = await settledZoom(swap);
  check("the open map drops the previous account's focus", swapped === DEFAULT_ZOOM, `zoom ${swapped}`);
  check("no JavaScript errors during the account switch", swap.errors.length === 0, swap.errors.slice(0, 2).join(" / "));
  await logOut(swap); await swap.close();

  // ---- Conductor "View my bus" (the same one-shot rule) ----
  const c = await browser.open();
  await inject(c, { conductorBus: { bus: { busId: bus.id, name: bus.name, plate: null, capacity: 30, routeName: bus.route, status: "active" }, occupancy: bus.occupancy, tracking: { status: "current", source: bus.source, updatedAt: bus.updatedAt, ageSeconds: 1, hasPosition: true } } });
  check("conductor signs in", await c.signIn(accounts.conductor));
  await hasButton(c, "View my bus on Live Map");
  await c.clickText("button", "View my bus on Live Map");
  await onPage(c, "Live map");
  const mine = await settledZoom(c);
  check("conductor: View my bus focuses the assigned bus", mine >= FOCUS_ZOOM, `zoom ${mine}`);
  await c.open("Dashboard"); await c.open("Live map");
  const mineBack = await settledZoom(c);
  check("conductor: returning to the map does not replay View my bus", mineBack === DEFAULT_ZOOM, `zoom ${mineBack}`);
  await hasButton(c, "Focus on my bus");
  await c.clickText("button", "Focus on my bus");
  const button = await settledZoom(c);
  check("conductor: Focus on my bus still works on the map", button >= FOCUS_ZOOM, `zoom ${button}`);
  await c.open("Dashboard");
  await hasButton(c, "View my bus on Live Map");
  await c.clickText("button", "View my bus on Live Map");
  await onPage(c, "Live map");
  const second = await settledZoom(c);
  check("conductor: View my bus works a second time", second >= FOCUS_ZOOM, `zoom ${second}`);
  await logOut(c);
  await c.eval("window.__testConductorBus = null");
  await c.signIn(accounts.passenger);
  await c.open("Live map");
  const afterConductor = await settledZoom(c);
  check("next user after a conductor has no map focus", afterConductor === DEFAULT_ZOOM, `zoom ${afterConductor}`);
  check("no JavaScript errors in the conductor flow", c.errors.length === 0, c.errors.slice(0, 2).join(" / "));
  await logOut(c); await c.close();
}
