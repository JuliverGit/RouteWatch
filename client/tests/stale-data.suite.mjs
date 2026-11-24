// Page data belongs to the identity that asked for it. A's data, on screen or in a delayed response, must never appear in B's session.
// Each response of the page under test is labelled with a marker of whoever is meant to see it (added inside this page only; nothing is
// written to the database). A DOM observer records any state that shows a marker to someone else. It runs before the browser paints,
// so even a single frame is caught. The test conductors have no bus, so their /api/conductor/bus answer is made up in the page.
import { APP, check, section, sleep, tokenHash } from "./harness.mjs";

const page = (occupancy, busId) => `(() => {
  const Native = window.WebSocket;
  let live = null;
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      if (String(args[0]).includes("/socket.io/")) this.addEventListener("message", (e) => { if (typeof e.data === "string" && e.data.startsWith("42")) live = this; });
    }
  };
  window.__push = (event, data) => {
    if (!live || live.readyState !== 1) return false;
    live.dispatchEvent(new MessageEvent("message", { data: "42" + JSON.stringify([event, data]) }));
    return true;
  };
  const who = () => document.querySelector(".rail__who strong")?.textContent ?? null;
  window.__who = who;
  window.__tag = null; window.__tagPath = null; window.__armed = null; window.__holds = []; window.__fail401 = null;
  window.__calls = {}; window.__watch = {}; window.__leaks = [];
  const scan = () => {
    const text = document.body ? document.body.textContent : "";
    for (const [m, owner] of Object.entries(window.__watch)) if (text.includes(m) && who() !== owner && window.__leaks.length < 20) window.__leaks.push({ marker: m, shownTo: who() });
  };
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true });
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });
  const now = () => new Date().toISOString();
  const alert = (M) => ({ id: 880000 + Math.floor(Math.random() * 99999), title: M, description: "Injected by the smoke test.", category: "general", categoryLabel: "General announcement", severity: "info", audience: "public", status: "published", state: "active", busId: null, busName: null, routeId: null, routeName: null, stopId: null, stopName: null, publishedAt: now(), expiresAt: null });
  const mark = (path, d, M) => {
    if (path === "/api/dashboard") d.serviceAlerts = [alert(M)];
    else if (path === "/api/users") d.unshift({ username: M, role: "passenger", active: true });
    else if (path.startsWith("/api/audit")) d.unshift({ ts: now(), action: "test_marker", actor: M, target: null, outcome: "success", ip: null, detail: null });
    else if (path === "/api/buses") d.buses.unshift({ busId: M, name: M, plate: null, capacity: 30, routeName: null, status: "inactive", model: null });
    else if (path === "/api/routes") d.routes.unshift({ routeId: M, name: M, startPoint: "Test", destination: "Test", stops: [], buses: [], status: "inactive", tracked: false });
    else if (path === "/api/stops") d.stops.unshift({ stopId: M, name: M, address: null, lat: 8.5, lng: 124.7, routeIds: [], status: "inactive" });
    else if (path === "/api/alerts?status=all") d.alerts.unshift({ ...alert(M), status: "draft", state: "draft", createdBy: "test", createdAt: now(), publishedAt: null });
    return d;
  };
  const conductorBus = (M) => ({ bus: { busId: ${JSON.stringify(busId)}, name: M, plate: null, capacity: 30, routeName: null, status: "active" }, occupancy: ${JSON.stringify(occupancy)}, tracking: { status: "current", source: "simulation", updatedAt: now(), ageSeconds: 1, hasPosition: true } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, options = {}) => {
    const path = String(url), method = (options.method || "GET").toUpperCase();
    window.__calls[path] = (window.__calls[path] || 0) + 1;
    if (window.__fail401 === path) { window.__fail401 = null; return json({ error: "Please sign in." }, 401); }
    const armed = window.__armed && window.__armed.method === method && window.__armed.path === path ? window.__armed : null;
    if (armed) window.__armed = null;
    const M = armed?.tag ?? window.__tag, tagged = method === "GET" && window.__tagPath === path && !!M;
    const produce = async () => {
      if (tagged && path === "/api/conductor/bus") return json(conductorBus(M));
      const r = await realFetch(url, options);
      if (!tagged || !r.ok) return r;
      return json(mark(path, await r.json(), M));
    };
    if (!armed) return produce();
    const answer = produce(); // asked now, with the session of now; delivered when the test releases it
    return new Promise((resolve) => window.__holds.push(() => resolve(answer)));
  };
  window.__release = () => { const go = window.__holds.shift(); if (!go) return false; go(); return true; };
})();`;

const js = (v) => JSON.stringify(v);
let n = 0;
const marker = (who) => `Data-of-${who}-${++n}#`;
const EXPIRED = "Your session has expired";

const tag = (p, path, M, owner) => p.eval(`window.__tagPath = ${js(path)}; window.__tag = ${js(M)}; ${owner ? `window.__watch[${js(M)}] = ${js(owner)};` : ""} true`);
const watch = (p, text, owner) => p.eval(`window.__watch[${js(text)}] = ${js(owner)}; true`);
const forbid = (p, text) => p.eval(`window.__watch[${js(text)}] = "\\u0000"; true`); // from now on, nobody may see it
const arm = (p, path, M = null) => p.eval(`window.__armed = ${js({ method: "GET", path, tag: M })}; true`);
const held = (p, ms = 20000) => p.waitFor("window.__holds.length > 0", ms);
const release = (p) => p.eval("window.__release()");
const shows = (p, text, ms = 20000) => p.waitFor(`document.body.textContent.includes(${js(text)})`, ms);
const leaks = (p) => p.eval("window.__leaks");
const reset = (p) => p.eval("window.__tag = null; window.__tagPath = null; window.__armed = null; window.__holds = []; window.__watch = {}; window.__leaks = []; true");
const logOut = async (p) => { await p.click('[aria-label="Log out"]'); return p.waitFor("!!document.querySelector('#au-id')"); };
const socketReady = (p) => p.waitFor("window.__push('test:noop', {})", 12000);
const leakNote = (l) => (l.length ? `shown: ${l.slice(0, 3).map((x) => `${x.marker} to ${x.shownTo ?? "signed out"}`).join(", ")}` : "");

/** Another sign-in replaces the cookie (as from another tab); a 401 makes this tab ask the server who it is, as in a real switch. */
async function switchInPlace(p, b) {
  await socketReady(p);
  const ok = await p.eval(`fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(${js({ username: b.username, password: b.password })}) }).then((r) => r.ok)`);
  await p.eval(`window.__fail401 = "/api/notifications"; window.__push("notification:read", {}); true`);
  return ok && !!(await p.waitFor(`window.__who() === ${js(b.username)}`, 8000));
}

export async function staleDataSuite({ browser, accounts, query, live }) {
  const P = accounts.passenger, P2 = accounts.passenger2, D = accounts.dispatcher, X = accounts.admin, X2 = accounts.admin2, C = accounts.conductor, C2 = accounts.conductor2;
  const bus = live[0] ?? { id: "BUS-01", occupancy: { onboard: 0, capacity: 30 } };
  const open = async () => { const p = await browser.open(); await p.s("Page.addScriptToEvaluateOnNewDocument", { source: page(bus.occupancy ?? null, bus.id) }); await p.reload(); return p; };
  // hold: how the test catches a request of the open page in flight (its own poll, the Refresh button, or none for a page that loads once).
  const PAGES = [
    { name: "dashboard (staff to passenger)", label: "Dashboard", path: "/api/dashboard", a: D, b: P2, hold: "poll", staffOnly: "Operations overview" },
    { name: "service alerts", label: "Service alerts", path: "/api/alerts?status=all", a: X, b: X2, hold: "poll" },
    { name: "buses", label: "Buses", path: "/api/buses", a: X, b: X2, hold: "poll" },
    { name: "routes", label: "Routes", path: "/api/routes", a: X, b: X2, hold: "poll" },
    { name: "bus stops", label: "Bus stops", path: "/api/stops", a: X, b: X2, hold: "poll" },
    { name: "users", label: "Users", path: "/api/users", a: X, b: X2, hold: null },
    { name: "audit log", label: "Audit log", path: "/api/audit?limit=100", a: X, b: X2, hold: "refresh" },
    { name: "conductor home", label: "Dashboard", path: "/api/conductor/bus", a: C, b: C2, hold: "poll" },
    { name: "passenger counter", label: "Passenger counter", path: "/api/conductor/bus", a: C, b: C2, hold: "poll" },
  ];

  section("stale page data: the account changes while the page is open");
  for (const f of PAGES) {
    const p = await open();
    const MA = marker("A"), MB = marker("B");
    await tag(p, f.path, MA, f.a.username);
    if (f.staffOnly) await watch(p, f.staffOnly, f.a.username);
    await p.signIn(f.a); await p.open(f.label);
    check(`${f.name}: A's own data loads`, !!(await shows(p, MA)));
    let wasHeld = true;
    if (f.hold) { await arm(p, f.path); if (f.hold === "refresh") await p.clickText("button", "Refresh"); wasHeld = !!(await held(p)); }
    await tag(p, f.path, MB);
    const switched = await switchInPlace(p, f.b);
    if (f.hold) await release(p);
    const own = await p.waitFor(`window.__who() === ${js(f.b.username)} && document.body.textContent.includes(${js(MB)})`, 20000);
    await sleep(1000);
    const l = await leaks(p);
    check(`${f.name}: A's data never appears in B's session${f.hold ? ", including A's delayed response" : ""}`, switched && wasHeld && l.length === 0, switched ? (wasHeld ? leakNote(l) : "request was not caught") : "switch failed");
    check(`${f.name}: B's own data is shown after the switch`, !!own);
    if (p.errors.length) check(`${f.name}: no JavaScript errors`, false, p.errors.slice(0, 2).join(" / "));
    await logOut(p); await p.close();
  }

  section("stale page data: A logs out before the response arrives, then B signs in");
  const s = await open();
  for (const f of PAGES) {
    await reset(s);
    const MA = marker("A"), MB = marker("B");
    await tag(s, f.path, MA, f.a.username);
    await s.signIn(f.a);
    await s.open("Live map"); await arm(s, f.path); await s.open(f.label);
    const wasHeld = !!(await held(s));
    await logOut(s);
    await forbid(s, MA); if (f.staffOnly) await forbid(s, f.staffOnly);
    await tag(s, f.path, MB);
    await s.signIn(f.b); await s.open(f.label);
    await release(s);
    const own = await shows(s, MB);
    await sleep(1000);
    const l = await leaks(s);
    check(`${f.name}: A's late data never appears for the next user`, wasHeld && l.length === 0, wasHeld ? leakNote(l) : "request was not caught");
    check(`${f.name}: the next user's own data is shown`, !!own);
    await logOut(s);
  }
  check("no JavaScript errors in the log-out flows", s.errors.length === 0, s.errors.slice(0, 2).join(" / "));
  await s.close();

  section("stale page data: expiry, guest and same-user transitions");
  const t = await open();
  {
    const MA = marker("A"), MB = marker("B");
    await tag(t, "/api/buses", MA, X.username);
    await t.signIn(X); await t.open("Buses"); await shows(t, MA);
    await arm(t, "/api/buses"); const wasHeld = !!(await held(t));
    const { cookies } = await t.s("Network.getCookies", { urls: [APP] });
    await query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(`x=${cookies.find((c) => c.name === "rw_session").value}`)]);
    const expired = await t.waitFor(`!!document.querySelector('#au-id') && document.body.innerText.includes(${js(EXPIRED)})`, 12000);
    await forbid(t, MA); await tag(t, "/api/buses", MB);
    await t.signIn(X2); await t.open("Buses");
    await release(t);
    const own = await shows(t, MB); await sleep(1000);
    const l = await leaks(t);
    check("after A's session expires, A's late data never appears for the next user", wasHeld && !!expired && l.length === 0, expired ? leakNote(l) : "session did not end");
    check("... and the next user's own data is shown", !!own);
    await logOut(t);
  }
  {
    await reset(t);
    const MA = marker("A"), MG = marker("Guest"), MB = marker("B");
    await tag(t, "/api/dashboard", MA, P.username);
    await t.signIn(P); await shows(t, MA);
    await arm(t, "/api/dashboard"); const aHeld = !!(await held(t));
    await logOut(t); await forbid(t, MA);
    await tag(t, "/api/dashboard", MG, "Guest");
    await t.click(".au-guest"); await t.waitFor("window.__who() === 'Guest'");
    await release(t);
    const guestOwn = await shows(t, MG); await sleep(1000);
    let l = await leaks(t);
    check("user to guest: the user's late data never appears for the guest", aHeld && l.length === 0, leakNote(l));
    check("... and the guest's own dashboard is shown", !!guestOwn);
    await arm(t, "/api/dashboard"); const gHeld = !!(await held(t));
    await t.click('[aria-label="Back to sign in"]'); await t.waitFor("!!document.querySelector('#au-id')");
    await forbid(t, MG); await tag(t, "/api/dashboard", MB);
    await t.signIn(P2);
    await release(t);
    const own = await shows(t, MB); await sleep(1000);
    l = await leaks(t);
    check("guest to user: the guest's late data never appears for the user", gHeld && l.length === 0, leakNote(l));
    check("... and the user's own dashboard is shown", !!own);
    await logOut(t);
  }
  {
    await reset(t);
    const M1 = marker("A-first"), M2 = marker("A-again");
    await tag(t, "/api/users", M1, X.username);
    await t.signIn(X); await t.open("Live map"); await arm(t, "/api/users"); await t.open("Users");
    const wasHeld = !!(await held(t));
    await logOut(t); await forbid(t, M1);
    await tag(t, "/api/users", M2, X.username);
    await t.signIn(X); await t.open("Users");
    await release(t);
    const own = await shows(t, M2); await sleep(1000);
    const l = await leaks(t);
    check("same user signing in again: the earlier session's late data never appears", wasHeld && l.length === 0, leakNote(l));
    check("... and the new session's data is shown", !!own);
    await logOut(t);
  }
  check("no JavaScript errors in the transitions", t.errors.length === 0, t.errors.slice(0, 2).join(" / "));
  await t.close();

  section("page data for the current user (no account change)");
  const u = await open();
  const M1 = marker("A"), M2 = marker("A-late");
  await tag(u, "/api/buses", M1, X.username);
  await u.signIn(X); await u.open("Buses");
  check("buses page loads the signed-in user's data", !!(await shows(u, M1)));
  await arm(u, "/api/buses", M2); await watch(u, M2, X.username);
  const wasHeld = !!(await held(u));
  await release(u);
  check("a delayed response for the current session still updates the page", wasHeld && !!(await shows(u, M2, 4000)));
  await u.open("Dashboard"); await shows(u, "Service alerts", 8000);
  await u.eval(`window.__calls["/api/dashboard"] = 0; true`);
  await sleep(10500);
  const calls = await u.eval(`window.__calls["/api/dashboard"]`);
  check("the dashboard keeps its normal polling (no extra requests)", calls >= 2 && calls <= 3, `${calls} request(s) in 10.5 s, polling every 5 s`);
  check("nothing was shown to the wrong user, and no JavaScript errors", (await leaks(u)).length === 0 && u.errors.length === 0, u.errors.slice(0, 2).join(" / "));
  await logOut(u); await u.close();
}
