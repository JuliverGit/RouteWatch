// A delayed response from an earlier session must not disturb the session on screen. A real expiry must still end the session.
// Requests are held inside this page and answered later, so they simulate slow responses. Held writes never reach the server.
import { APP, check, section, sleep, tokenHash } from "./harness.mjs";

const page = `(() => {
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
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });
  window.__who = who;
  window.__notifsBy = {};
  window.__holds = [];
  window.__armed = null;
  window.__meCalls = 0;
  window.__meFails = false;
  window.__release = (status, body) => {
    const resolve = window.__holds.shift();
    if (!resolve) return false;
    resolve(json(body ?? { error: "Please sign in." }, status));
    return true;
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, options = {}) => {
    const path = String(url), method = (options.method || "GET").toUpperCase();
    if (path === "/api/me") window.__meCalls++;
    const armed = window.__armed;
    if (armed && armed.method === method && (armed.exact ? path === armed.path : path.startsWith(armed.path))) {
      window.__armed = null;
      return new Promise((resolve) => window.__holds.push(resolve));
    }
    if (path === "/api/me" && window.__meFails) throw new TypeError("offline");
    if (path === "/api/notifications") { const list = window.__notifsBy[who()] ?? []; return json({ unread: list.filter((n) => !n.read).length, notifications: list }); }
    if (path.startsWith("/api/notifications/")) return json({ unread: 0 });
    return realFetch(url, options);
  };
})();`;

let nextId = 770001;
const note = (title) => ({ id: nextId++, receivedAt: new Date().toISOString(), read: false, alert: { id: nextId, title, description: "Injected by the smoke test.", category: "general", categoryLabel: "General announcement", severity: "info", audience: "public", status: "published", state: "active", busId: null, busName: null, routeId: null, routeName: null, stopId: null, stopName: null, publishedAt: new Date().toISOString(), expiresAt: null } });
const js = (v) => JSON.stringify(v);
const EXPIRED = "Your session has expired";
const DASHBOARD_WITHOUT_VIEWER = { viewer: null, route: { stops: [] }, alerts: [], tracking: {}, serviceAlerts: [], occupancy: [] };

const arm = (p, method, path, exact = false) => p.eval(`window.__armed = ${js({ method, path, exact })}; true`);
const held = (p) => p.waitFor("window.__holds.length > 0", 20000);
const release = (p, status = 401, body = null) => p.eval(`window.__release(${status}, ${js(body)})`);
const setList = (p, username, list) => p.eval(`window.__notifsBy[${js(username)}] = ${js(list)}; true`);
const logOut = async (p) => { await p.click('[aria-label="Log out"]'); return p.waitFor("!!document.querySelector('#au-id')"); };
const socketReady = (p) => p.waitFor("window.__push('test:noop', {})", 12000);
const reloadList = async (p) => { await socketReady(p); await p.eval(`window.__push("notification:read", {})`); };
const signInTo = async (p, a, title) => {
  const n = note(title);
  await setList(p, a.username, [n]);
  await p.signIn(a);
  await p.open("Notifications");
  await p.waitFor(`document.querySelector('.notiflist')?.textContent.includes(${js(title)})`, 5000);
  return n;
};
/** The account, page and notifications on screen are still the expected ones, shortly after a late response arrived. */
async function undisturbed(p, username, pageTitle, title) {
  await sleep(1000);
  const s = await p.eval(`({ who: window.__who(), page: document.querySelector('.topbar h1')?.textContent ?? null, signIn: !!document.querySelector('#au-id'), expired: document.body.innerText.includes(${js(EXPIRED)}), list: ${title ? `!!document.querySelector('.notiflist')?.textContent.includes(${js(title)})` : "true"} })`);
  return { ok: s.who === username && s.page === pageTitle && !s.signIn && !s.expired && s.list, note: `on screen: ${s.who ?? "signed out"}, ${s.page ?? "no page"}` };
}
async function open(browser) {
  const p = await browser.open();
  await p.s("Page.addScriptToEvaluateOnNewDocument", { source: page });
  await p.reload();
  return p;
}
const sessionHash = async (p) => { const { cookies } = await p.s("Network.getCookies", { urls: [APP] }); return tokenHash(`x=${cookies.find((c) => c.name === "rw_session").value}`); };

export async function lateResponseSuite({ browser, accounts, query }) {
  const A = accounts.passenger, B = accounts.passenger2, D = accounts.dispatcher, C = accounts.conductor, X = accounts.admin;
  const viaPage = (label, method, path, exact = false) => async (p) => { await p.open("Live map"); await arm(p, method, path, exact); await p.open(label); };
  const viaButton = (text, method, path) => async (p, a) => {
    await setList(p, a.username, [note("Item to mark")]);
    await reloadList(p);
    await p.open("Live map"); await p.open("Notifications");
    await p.waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${js(text)})`, 5000);
    await arm(p, method, path);
    await p.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${js(text)}).click()`);
  };
  const FLOWS = [
    ["mark one notification as read", A, viaButton("Mark as read", "PATCH", "/api/notifications/")],
    ["mark all notifications as read", A, viaButton("Mark all as read", "POST", "/api/notifications/read-all")],
    ["notification list load", A, async (p) => { await socketReady(p); await arm(p, "GET", "/api/notifications", true); await p.eval(`window.__push("notification:read", {})`); }],
    ["dashboard that lost its viewer", A, viaPage("Dashboard", "GET", "/api/dashboard"), 200, DASHBOARD_WITHOUT_VIEWER],
    ["conductor home", C, viaPage("Dashboard", "GET", "/api/conductor/bus")],
    ["passenger counter", C, viaPage("Passenger counter", "GET", "/api/conductor/bus")],
    ["service alerts page", D, viaPage("Service alerts", "GET", "/api/alerts?status=all", true)],
    ["buses page", D, viaPage("Buses", "GET", "/api/buses", true)],
    ["routes page", D, viaPage("Routes", "GET", "/api/routes", true)],
    ["bus stops page", D, viaPage("Bus stops", "GET", "/api/stops", true)],
    ["users page", X, viaPage("Users", "GET", "/api/users", true)],
    ["audit log page", X, viaPage("Audit log", "GET", "/api/audit?limit=100", true)],
    ["a saved change (user role)", X, async (p) => {
      await p.open("Users");
      const sel = `select[aria-label=${js(`Role for ${B.username}`)}]`;
      await p.waitFor(`!!document.querySelector(${js(sel)})`, 6000);
      await arm(p, "PATCH", "/api/users/");
      await p.eval(`(() => { const s = document.querySelector(${js(sel)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "dispatcher"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    }],
  ];

  section("late responses: every 401 flow, after a different user signed in");
  const p = await open(browser);
  for (const [name, owner, start, status = 401, body = null] of FLOWS) {
    await p.signIn(owner);
    await start(p, owner);
    const wasHeld = await held(p);
    await logOut(p);
    const title = `Own list of B ${nextId}`;
    await signInTo(p, B, title);
    await release(p, status, body);
    const r = await undisturbed(p, B.username, "Notifications", title);
    check(`late response from "${name}" does not disturb the next user`, wasHeld && r.ok, r.note);
    if (await p.eval("!!document.querySelector('[aria-label=\"Log out\"]')")) await logOut(p);
    await p.eval("window.__holds.length = 0; window.__armed = null; true");
  }

  section("late responses: session transitions");
  const holdRead = async (t) => { await setList(t, A.username, [note("Item to mark")]); await reloadList(t); await t.open("Live map"); await t.open("Notifications"); await t.waitFor("[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Mark as read')", 5000); await arm(t, "PATCH", "/api/notifications/"); await t.eval("[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Mark as read').click()"); return held(t); };

  await p.signIn(A); await holdRead(p); await logOut(p);
  const again = `Own list of A ${nextId}`;
  await signInTo(p, A, again);
  await release(p);
  let r = await undisturbed(p, A.username, "Notifications", again);
  check("same user signing in again is not signed out by their old session's 401", r.ok, r.note);
  await logOut(p); await p.eval("window.__holds.length = 0; true");

  await p.signIn(A); await holdRead(p); await logOut(p);
  await p.click(".au-guest");
  await p.waitFor("window.__who() === 'Guest'");
  await p.open("Live map");
  await release(p);
  r = await undisturbed(p, "Guest", "Live map");
  check("a guest is not sent back to sign-in by the previous user's 401", r.ok, r.note);

  await p.click('[aria-label="Back to sign in"]');
  await p.waitFor("!!document.querySelector('#au-id')");
  await p.signIn(A); await holdRead(p); await logOut(p);
  await p.click(".au-guest");
  await p.waitFor("window.__who() === 'Guest'");
  await p.click('[aria-label="Back to sign in"]');
  await p.waitFor("!!document.querySelector('#au-id')");
  const afterGuest = `Own list of B ${nextId}`;
  await signInTo(p, B, afterGuest);
  await release(p);
  r = await undisturbed(p, B.username, "Notifications", afterGuest);
  check("user -> guest -> new user: the first user's late 401 changes nothing", r.ok, r.note);
  await logOut(p); await p.eval("window.__holds.length = 0; true");

  await p.signIn(A); await holdRead(p);
  await query("DELETE FROM sessions WHERE token_hash = $1", [await sessionHash(p)]);
  await p.open("Dashboard");
  check("A's session genuinely expires", await p.waitFor(`!!document.querySelector('#au-id') && document.body.innerText.includes(${js(EXPIRED)})`, 9000));
  const afterExpiry = `Own list of B ${nextId}`;
  await signInTo(p, B, afterExpiry);
  await release(p);
  r = await undisturbed(p, B.username, "Notifications", afterExpiry);
  check("after a real expiry, a second late 401 does not sign out the next user", r.ok, r.note);
  await logOut(p); await p.eval("window.__holds.length = 0; window.__armed = null; true");
  check("no JavaScript errors in the same-tab flows", p.errors.length === 0, p.errors.slice(0, 2).join(" / "));
  await p.close();

  section("late responses: account switch from another tab");
  const before = await open(browser);
  const beforeTitle = `Own list of B ${nextId}`;
  await setList(before, B.username, [note(beforeTitle)]);
  await before.signIn(A); await holdRead(before);
  await before.eval(`fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(${js({ username: B.username, password: B.password })}) })`);
  await release(before);
  check("401 from the replaced session, before the page noticed: follows the new account", await before.waitFor(`window.__who() === ${js(B.username)}`, 5000), `on screen: ${await before.eval("window.__who()")}`);
  r = await undisturbed(before, B.username, "Notifications");
  check("... and the new account is not signed out", r.ok, r.note);
  await logOut(before); await before.close();

  const after = await open(browser);
  await after.signIn(A); await holdRead(after);
  await setList(after, D.username, []);
  await after.open("Dashboard");
  await after.eval(`fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(${js({ username: D.username, password: D.password })}) })`);
  await after.waitFor(`window.__who() === ${js(D.username)}`, 12000);
  await release(after);
  r = await undisturbed(after, D.username, "Dashboard");
  check("401 from the replaced session, after the page noticed: nothing changes", r.ok, r.note);
  await logOut(after); await after.close();

  section("late responses: previous user's /api/me success");
  const me = await open(browser);
  await me.signIn(A);
  await arm(me, "GET", "/api/me", true); // the page's 60-second session check
  const meHeld = await me.waitFor("window.__holds.length > 0", 65000);
  await logOut(me);
  const meTitle = `Own list of B ${nextId}`;
  await signInTo(me, B, meTitle);
  await release(me, 200, { username: A.username, role: "passenger", permissions: [] });
  r = await undisturbed(me, B.username, "Notifications", meTitle);
  check("a late /api/me success cannot put the previous user back on screen", meHeld && r.ok, r.note);
  await logOut(me); await me.close();

  section("401 handling for the current session");
  const g = await open(browser);
  const gTitle = `Own list of A ${nextId}`;
  await signInTo(g, A, gTitle);
  await holdRead(g);
  await g.eval("window.__meCalls = 0; true");
  await release(g);
  r = await undisturbed(g, A.username, "Notifications");
  check("a stray 401 while the session is still valid does not sign the user out", r.ok, r.note);
  check("... the server was asked before deciding", (await g.eval("window.__meCalls")) === 1, `${await g.eval("window.__meCalls")} session check(s)`);

  await holdRead(g);
  await g.eval("window.__meFails = true; true");
  await release(g);
  r = await undisturbed(g, A.username, "Notifications");
  check("if the session check cannot reach the server, the user is not signed out", r.ok, r.note);
  await g.eval("window.__meFails = false; true");

  await holdRead(g);
  await query("DELETE FROM sessions WHERE token_hash = $1", [await sessionHash(g)]);
  await release(g);
  check("a genuine 401 for the current session returns to sign-in with the expired message", await g.waitFor(`!!document.querySelector('#au-id') && document.body.innerText.includes(${js(EXPIRED)})`, 5000));
  check("... and the signed-out state holds after a refresh", (await g.reload(), await g.waitFor("!!document.querySelector('#au-id')", 8000)));
  check("no JavaScript errors in current-session handling", g.errors.length === 0, g.errors.slice(0, 2).join(" / "));
  await g.close();

  const m = await open(browser);
  await m.signIn(A);
  await m.open("Live map");
  await setList(m, A.username, [note("One"), note("Two")]);
  await reloadList(m);
  await m.open("Notifications");
  await m.waitFor("[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Mark as read').length === 2", 5000);
  for (let i = 0; i < 2; i++) {
    await arm(m, "PATCH", "/api/notifications/");
    await m.eval(`[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Mark as read')[0].click()`);
    await m.waitFor(`window.__holds.length === ${i + 1}`, 3000);
  }
  await query("DELETE FROM sessions WHERE token_hash = $1", [await sessionHash(m)]);
  await m.eval("window.__meCalls = 0; window.__release(401); window.__release(401); true");
  check("several 401s at once still end an expired session", await m.waitFor(`!!document.querySelector('#au-id') && document.body.innerText.includes(${js(EXPIRED)})`, 5000));
  check("... with a single session check", (await m.eval("window.__meCalls")) === 1, `${await m.eval("window.__meCalls")} session check(s)`);
  await m.close();
}
