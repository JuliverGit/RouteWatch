// Test stack for the RouteWatch smoke tests. Node.js + Microsoft Edge (DevTools protocol) only: no test dependencies.
//
// Safety: refuses a non-local database or NODE_ENV=production. Runs its OWN API (:5098) and client (:5175), so a dev server you
// have open is not touched. Mail, the route cache and the browser profile live in a temp folder. Google sign-in is switched off.
// It uses temporary rwt-* accounts and deletes them at the end. Their audit rows stay, because audit_logs is append-only.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_DIR = path.resolve(HERE, "..");
export const SERVER_DIR = path.resolve(CLIENT_DIR, "..", "server");
const API_PORT = 5098, APP_PORT = 5175, DEBUG_PORT = 9335;
export const API = `http://localhost:${API_PORT}`, APP = `http://localhost:${APP_PORT}`;
const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverModule = (f) => import(pathToFileURL(path.join(SERVER_DIR, f)).href);

// ---- results ----
export const results = [];
export function check(name, ok, note = "") {
  results.push({ name, status: ok ? "PASS" : "FAIL", note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
}
/** A documented, not-yet-fixed defect: reported separately and never counted as a pass or a failure of the suite. */
export function known(name, reproduced, note = "") {
  results.push({ name, status: reproduced ? "KNOWN" : "NOT-REPRODUCED", note });
  console.log(`${reproduced ? "KNOWN ISSUE (reproduced)" : "KNOWN ISSUE (not reproduced)"}  ${name}${note ? `  (${note})` : ""}`);
}
export const section = (t) => console.log(`\n--- ${t} ---`);

const portFree = (port) => new Promise((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.listen(port, () => s.close(() => res(true))); });
async function waitHttp(url, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ } await sleep(250); }
  return false;
}

// ---- browser ----
class Browser {
  listeners = []; pending = new Map(); seq = 0;
  async start(profile) {
    this.proc = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank"], { stdio: "ignore" });
    let version;
    for (let i = 0; i < 80 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); } catch { await sleep(250); } }
    if (!version) throw new Error("Microsoft Edge did not start (set EDGE_PATH if it is installed elsewhere).");
    this.ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r, x) => { this.ws.addEventListener("open", r, { once: true }); this.ws.addEventListener("error", x, { once: true }); });
    this.ws.addEventListener("message", (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.pending.has(d.id)) { const { res, rej } = this.pending.get(d.id); this.pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); }
      else if (d.method) for (const l of [...this.listeners]) l(d);
    });
  }
  send(method, params = {}, sessionId) { return new Promise((res, rej) => { const id = ++this.seq; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params, sessionId })); }); }
  async stop() { try { this.ws?.close(); } catch { /* closing anyway */ } if (this.proc?.pid) await new Promise((r) => { const k = spawn("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" }); k.on("close", r); k.on("error", r); }); }

  /** A fresh, isolated browser profile (own cookies) with one page. */
  async open({ width = 1366, height = 860, mobile = false, geolocation = null, context = null } = {}) {
    const browserContextId = context ?? (await this.send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId;
    if (geolocation && !context) await this.send("Browser.setPermission", { permission: { name: "geolocation" }, setting: geolocation, origin: APP, browserContextId });
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const p = { errors: [], sockets: [], requests: [] };
    const onEvent = (d) => {
      if (d.sessionId !== sessionId) return;
      if (d.method === "Runtime.exceptionThrown") p.errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
      if (d.method === "Network.webSocketCreated") p.sockets.push(d.params.url.split("?")[0]);
      if (d.method === "Network.requestWillBeSent") p.requests.push({ method: d.params.request.method, url: d.params.request.url });
    };
    this.listeners.push(onEvent);
    p.s = (m, x) => this.send(m, x, sessionId);
    await p.s("Runtime.enable"); await p.s("Page.enable"); await p.s("Network.enable");
    await p.s("Network.setBlockedURLs", { urls: ["*tile.openstreetmap.org*"] }); // tests must not download map tiles
    await p.s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await p.s("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const g = navigator.geolocation; if (!g) return; window.__geo = { watch: 0 }; const w = g.watchPosition.bind(g); g.watchPosition = (...a) => { window.__geo.watch++; return w(...a); }; })();` });
    p.eval = async (expr) => { const r = await p.s("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
    p.waitFor = async (expr, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await p.eval(expr); if (v) return v; } catch { /* page changing */ } await sleep(120); } return null; };
    p.type = async (sel, text) => { await p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select?.(); })()`); await p.s("Input.insertText", { text }); };
    p.click = (sel) => p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
    p.clickText = (sel, text) => p.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim().includes(${JSON.stringify(text)})); if (!e) return false; e.click(); return true; })()`);
    /** A real (trusted) mouse click, as a person would make. */
    p.realClick = async (x, y) => { for (const type of ["mousePressed", "mouseReleased"]) await p.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); };
    p.goto = (url = APP) => p.s("Page.navigate", { url });
    p.reload = () => p.s("Page.reload");
    // A tab opened with p.newTab() shares this profile (cookies, BroadcastChannel). Closing the first page closes all of its tabs.
    p.close = () => (context ? this.send("Target.closeTarget", { targetId }) : this.send("Target.disposeBrowserContext", { browserContextId }));
    p.newTab = (o = {}) => this.open({ width, height, mobile, ...o, context: browserContextId });
    p.targetId = targetId;
    /** Signs in through the real sign-in form. */
    p.signIn = async (a) => {
      await p.waitFor("!!document.querySelector('#au-id')");
      await p.type("#au-id", a.username); await p.type("#au-password", a.password);
      await p.click(".au-btn--primary");
      return p.waitFor(`!!document.querySelector('.rail__who') && document.querySelector('.rail__who').innerText.includes(${JSON.stringify(a.username)})`);
    };
    p.nav = () => p.eval("[...document.querySelectorAll('.rail__link')].map((b) => b.getAttribute('aria-label'))");
    p.open = async (label) => { await p.click(`.rail__link[aria-label=${JSON.stringify(label)}]`); return p.waitFor(`document.querySelector('.topbar h1')?.textContent === ${JSON.stringify(label)}`, 5000); };
    /** The Leaflet zoom level currently on screen, read from the tile URLs (.../{z}/{x}/{y}.png). */
    p.mapZooms = () => p.eval(`[...new Set([...document.querySelectorAll('img.leaflet-tile')].map((i) => Number(i.src.split('/').at(-3))))].sort((a, b) => a - b)`);
    await p.goto();
    return p;
  }
}

// ---- API helper ----
export async function api(method, url, { cookie, body } = {}) {
  const r = await fetch(API + url, { method, redirect: "manual", headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const session = (r.headers.getSetCookie?.() ?? []).map((c) => /^rw_session=([^;]+)/.exec(c)?.[1]).find(Boolean);
  return { status: r.status, data: await r.json().catch(() => null), cookie: session ? `rw_session=${session}` : null };
}
export const tokenHash = (cookie) => crypto.createHash("sha256").update(cookie.split("=")[1]).digest("hex");

/** Starts everything, runs fn(stack), always cleans up. */
export async function withStack(fn) {
  await serverModule("env.js");
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to run with NODE_ENV=production.");
  if (!["localhost", "127.0.0.1", "::1"].includes(process.env.DB_HOST || "localhost") || process.env.DATABASE_URL) throw new Error("Refusing to run: the smoke tests only run against a local database (DB_HOST).");
  for (const port of [API_PORT, APP_PORT, DEBUG_PORT]) if (!(await portFree(port))) throw new Error(`Port ${port} is in use. Stop whatever is using it and run the tests again.`);
  const { query, close, createOwnerPool } = await serverModule("db.js");
  const { createUser } = await serverModule("users.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routewatch-smoke-"));
  const run = crypto.randomBytes(3).toString("hex"), accounts = {};
  const cache = path.join(SERVER_DIR, "data", "route-cache.json"), tmpCache = path.join(tmp, "route-cache.json");
  if (fs.existsSync(cache)) fs.copyFileSync(cache, tmpCache);
  const apiLog = fs.openSync(path.join(tmp, "api.log"), "a");
  const apiProc = spawn(process.execPath, ["index.js"], { cwd: SERVER_DIR, stdio: ["ignore", apiLog, apiLog], env: {
    ...process.env, PORT: String(API_PORT), CLIENT_ORIGIN: APP, MAIL_TRANSPORT: "dev-outbox", MAIL_OUTBOX_DIR: path.join(tmp, "outbox"), ROUTE_CACHE_FILE: tmpCache,
    GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", GOOGLE_REDIRECT_URI: "", SESSION_MINUTES: "120", SESSION_IDLE_MINUTES: "30",
  } });
  let vite = null;
  const browser = new Browser();
  try {
    if (!(await waitHttp(`${API}/api/auth/options`))) throw new Error(`The test API did not start. See ${path.join(tmp, "api.log")}`);
    const viteMod = await import(pathToFileURL(path.join(CLIENT_DIR, "node_modules/vite/dist/node/index.js")).href);
    const reactMod = await import(pathToFileURL(path.join(CLIENT_DIR, "node_modules/@vitejs/plugin-react/dist/index.js")).href);
    vite = await viteMod.createServer({
      root: CLIENT_DIR, configFile: false, cacheDir: path.join(tmp, "vite-cache"), plugins: [reactMod.default()], logLevel: "error", clearScreen: false,
      server: { port: APP_PORT, strictPort: true, watch: null, hmr: false, proxy: { "/api": API, "/socket.io": { target: API, ws: true } } },
    });
    await vite.listen();
    await browser.start(path.join(tmp, "edge"));
    for (const role of ["admin", "dispatcher", "conductor", "passenger"]) {
      const a = { username: `rwt-${role.slice(0, 4)}-${run}`, password: `Pw-${crypto.randomBytes(12).toString("base64url")}`, role };
      await createUser(a.username, a.password, role);
      accounts[role] = a;
    }
    // A second account of the same role, for account switches where the open page stays allowed.
    for (const [key, prefix, role] of [["passenger2", "pax2", "passenger"], ["admin2", "adm2", "admin"], ["conductor2", "con2", "conductor"]]) {
      const a = { username: `rwt-${prefix}-${run}`, password: `Pw-${crypto.randomBytes(12).toString("base64url")}`, role };
      await createUser(a.username, a.password, role);
      accounts[key] = a;
    }
    let live = [];
    for (let i = 0; i < 40 && !live.length; i++) { live = (await api("GET", "/api/tracking/buses")).data.filter((b) => b.pos && ["current", "delayed"].includes(b.status)); if (!live.length) await sleep(500); }
    await fn({ browser, accounts, query, live });
  } finally {
    await browser.stop();
    if (vite) await vite.close().catch(() => {});
    apiProc.kill();
    await sleep(400);
    const owner = createOwnerPool();
    const names = Object.values(accounts).map((a) => a.username);
    const d = await owner.query("DELETE FROM users WHERE username = ANY($1) AND username LIKE 'rwt-%'", [names]); // their sessions cascade
    const left = Number((await owner.query("SELECT count(*) n FROM users WHERE username LIKE 'rwt-%'")).rows[0].n);
    await owner.end(); await close();
    fs.closeSync(apiLog);
    console.log(`\ncleanup: deleted ${d.rowCount} temporary account(s); rwt-* accounts remaining: ${left}`);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { console.log(`note: could not remove temp folder ${tmp}`); }
  }
}
