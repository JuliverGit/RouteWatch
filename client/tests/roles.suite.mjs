// Role-based smoke tests: what each role can open in the UI and what the server allows it to do.
// Write attempts below are all ones the server must REFUSE, so they change no data.
import { api, check, section, sleep } from "./harness.mjs";

const NAV = {
  admin: ["Dashboard", "Live map", "Notifications", "Service alerts", "Buses", "Routes", "Bus stops", "Users", "Audit log"],
  dispatcher: ["Dashboard", "Live map", "Notifications", "Service alerts", "Buses", "Routes", "Bus stops"],
  conductor: ["Dashboard", "Passenger counter", "Live map", "Notifications"],
  passenger: ["Dashboard", "Live map", "Notifications"],
  guest: ["Dashboard", "Live map"],
};
const REGION = { Buses: "Bus list", Routes: "Route list", "Bus stops": "Bus stop list", "Service alerts": "Service alert list", Users: "User accounts table" };
const ROLE_ORDER = ["admin", "dispatcher", "conductor", "passenger", "guest"];

// Expected status per role, in ROLE_ORDER.
const READS = {
  "/api/me": [200, 200, 200, 200, 401], "/api/users": [200, 403, 403, 403, 401], "/api/audit": [200, 403, 403, 403, 401],
  "/api/tracking/devices": [200, 200, 403, 403, 401], "/api/buses": [200, 200, 403, 403, 401], "/api/routes": [200, 200, 403, 403, 401],
  "/api/stops": [200, 200, 403, 403, 401], "/api/conductors": [200, 200, 403, 403, 401], "/api/alerts": [200, 200, 403, 403, 401],
  "/api/conductor/bus": [403, 403, 200, 403, 401], "/api/notifications": [200, 200, 200, 200, 401],
  "/api/tracking/buses": [200, 200, 200, 200, 200], "/api/route": [200, 200, 200, 200, 200], "/api/network/public": [200, 200, 200, 200, 200],
  "/api/alerts/active": [200, 200, 200, 200, 200], "/api/dashboard": [200, 200, 200, 200, 200], "/api/occupancy": [200, 200, 200, 200, 200],
};
// null = this role IS allowed, so the write is not attempted.
const DENIED_WRITES = [
  ["POST", "/api/buses", [null, 403, 403, 403, 401]], ["PATCH", "/api/buses/RW-01", [null, 403, 403, 403, 401]],
  ["POST", "/api/stops", [null, 403, 403, 403, 401]], ["POST", "/api/routes", [null, 403, 403, 403, 401]],
  ["PUT", "/api/buses/RW-01/route", [null, 403, 403, 403, 401]], ["PUT", "/api/conductors/nobody/bus", [null, 403, 403, 403, 401]],
  ["PATCH", "/api/users/nobody", [null, 403, 403, 403, 401]], ["POST", "/api/alerts", [null, null, 403, 403, 401]],
  ["POST", "/api/buses/RW-01/occupancy", [403, 403, null, 403, 401]],
];

export async function rolesSuite({ browser, accounts, live }) {
  check("precondition: the existing simulator is reporting live bus positions", live.length > 0, live.map((b) => `${b.id}:${b.source}`).join(", "));

  section("server authorization (API)");
  const cookies = { guest: null };
  for (const r of ROLE_ORDER.slice(0, 4)) cookies[r] = (await api("POST", "/api/login", { body: { username: accounts[r].username, password: accounts[r].password } })).cookie;
  for (const r of ROLE_ORDER.slice(0, 4)) check(`${r}: /api/me reports the correct role`, (await api("GET", "/api/me", { cookie: cookies[r] })).data?.role === r);
  for (const [url, want] of Object.entries(READS)) {
    const got = [];
    for (const r of ROLE_ORDER) got.push((await api("GET", url, { cookie: cookies[r] })).status);
    check(`GET ${url}`, got.join() === want.join(), `admin/dispatcher/conductor/passenger/guest = ${got.join(" ")}`);
  }
  for (const [method, url, want] of DENIED_WRITES) {
    const got = [];
    for (let i = 0; i < ROLE_ORDER.length; i++) got.push(want[i] === null ? null : (await api(method, url, { cookie: cookies[ROLE_ORDER[i]], body: {} })).status);
    check(`${method} ${url} refused for roles without the permission`, got.join() === want.join(), got.map((x) => x ?? "n/a").join(" "));
  }
  const tiers = {};
  for (const r of ROLE_ORDER) { const d = (await api("GET", "/api/dashboard", { cookie: cookies[r] })).data; tiers[r] = ["fleet", "users", "activity"].filter((k) => k in d).join("+") || "public"; }
  check("dashboard data tiers per role", tiers.admin === "fleet+users+activity" && tiers.dispatcher === "fleet" && tiers.conductor === "public" && tiers.passenger === "public" && tiers.guest === "public", JSON.stringify(tiers));
  const list = (await api("GET", "/api/users", { cookie: cookies.admin })).data;
  check("user list exposes no email, password hash or Google id", Array.isArray(list) && list.every((u) => !("email" in u) && !("password_hash" in u) && !("google_sub" in u)));
  for (const r of ROLE_ORDER.slice(0, 4)) await api("POST", "/api/logout", { cookie: cookies[r], body: {} });

  for (const role of ROLE_ORDER) {
    section(`${role} (browser)`);
    const p = await browser.open({ geolocation: role === "passenger" ? "granted" : null });
    if (role === "guest") {
      await p.waitFor("!!document.querySelector('.au-guest')");
      await p.click(".au-guest");
      check("guest: enters without an account", await p.waitFor("document.querySelector('.rail__who')?.innerText.includes('Guest')"));
    } else check(`${role}: signs in through the real form`, await p.signIn(accounts[role]));
    const nav = await p.nav();
    check(`${role}: menu shows exactly the allowed pages`, nav.join() === NAV[role].join(), nav.join(", "));

    for (const label of NAV[role]) {
      const opened = await p.open(label);
      const content = REGION[label]
        ? await p.waitFor(`!!document.querySelector('[role=region][aria-label=${JSON.stringify(REGION[label])}]')`, 8000)
        : label === "Live map" ? await p.waitFor("!!document.querySelector('.leaflet-container')", 15000)
        : label === "Audit log" ? await p.waitFor("document.querySelectorAll('main table tbody tr').length > 0", 8000)
        : await p.waitFor("document.querySelector('.main').innerText.length > 40", 8000);
      const denied = await p.eval("document.body.innerText.includes('Access denied')");
      check(`${role}: "${label}" opens with content`, opened && content && !denied);
    }

    await p.open("Live map");
    check(`${role}: live map shows bus markers`, await p.waitFor("document.querySelectorAll('.bus-pin').length > 0", 12000));
    const features = await p.eval("({ near: !!document.querySelector('#h-near'), locate: !!document.querySelector('.map-locate'), devices: !!document.querySelector('#h-devices'), mybus: !!document.querySelector('#h-mybus') })");
    if (["admin", "dispatcher"].includes(role)) await p.waitFor("!!document.querySelector('#h-devices')", 6000);
    const f2 = await p.eval("({ near: !!document.querySelector('#h-near'), locate: !!document.querySelector('.map-locate'), devices: !!document.querySelector('#h-devices'), mybus: !!document.querySelector('#h-mybus') })");
    check(`${role}: map shows only this role's panels`,
      f2.near === (role === "passenger") && f2.locate === (role === "passenger") && f2.devices === ["admin", "dispatcher"].includes(role) && f2.mybus === (role === "conductor"), JSON.stringify(features.near === f2.near ? f2 : { ...f2, firstRead: features }));
    const before = await p.eval("[...document.querySelectorAll('.leaflet-marker-icon')].filter((m) => m.querySelector('.bus-pin')).map((m) => m.style.transform).join('|')");
    const moved = await p.waitFor(`[...document.querySelectorAll('.leaflet-marker-icon')].filter((m) => m.querySelector('.bus-pin')).map((m) => m.style.transform).join('|') !== ${JSON.stringify(before)}`, 9000);
    check(`${role}: Socket.IO updates move the markers`, moved);
    const io = p.sockets.filter((u) => u.includes("/socket.io/")).length;
    check(`${role}: exactly one Socket.IO connection`, io === 1, `${io} connection(s)`);

    if (role === "passenger") {
      check("passenger: no location request before consent", (await p.eval("window.__geo.watch")) === 0);
      const b = (await api("GET", "/api/tracking/buses")).data.find((x) => x.pos);
      await p.s("Emulation.setGeolocationOverride", { latitude: b.pos[0] + 0.002, longitude: b.pos[1] + 0.001, accuracy: 25 });
      await p.clickText(".near button", "Use my location");
      check("passenger: blue location dot appears after consent", await p.waitFor("!!document.querySelector('.me-dot')", 8000));
      check("passenger: Nearby Buses list shows a bus", await p.waitFor("document.querySelectorAll('.near__item').length > 0", 6000));
      await p.clickText(".near button", "Stop using location");
    }
    if (role !== "passenger") check(`${role}: no location request`, (await p.eval("window.__geo.watch")) === 0);

    if (role !== "guest") {
      await p.reload();
      check(`${role}: session survives a page refresh`, await p.waitFor(`document.querySelector('.rail__who')?.innerText.includes(${JSON.stringify(accounts[role].username)})`));
      await p.click('[aria-label="Log out"]');
      check(`${role}: log out returns to the sign-in screen`, await p.waitFor("!!document.querySelector('#au-id')"));
      await p.reload();
      await sleep(500);
      check(`${role}: still signed out after a refresh`, await p.waitFor("!!document.querySelector('#au-id')"));
    }
    check(`${role}: no JavaScript errors`, p.errors.length === 0, p.errors.slice(0, 2).join(" / "));
    await p.close();
  }
}
