// Several tabs of one browser share one session cookie. When it changes in one tab, the others must follow the server promptly.
// The observing tab can drop or hold messages from other tabs (to simulate a missed or late message) and counts its staff socket frames.
import { check, section, sleep } from "./harness.mjs";

const script = `(() => {
  window.__who = () => document.querySelector(".rail__who strong")?.textContent ?? null;
  window.__role = () => document.querySelector(".rail__who .muted")?.textContent ?? null;
  window.__meCalls = 0; window.__staffFrames = 0; window.__busFrames = 0; window.__leaks = []; window.__guard = null;
  const realFetch = window.fetch.bind(window);
  window.__holdMe = false; window.__heldMe = [];
  window.fetch = (url, options) => {
    if (String(url) !== "/api/me") return realFetch(url, options);
    window.__meCalls++;
    if (!window.__holdMe) return realFetch(url, options);
    return new Promise((resolve) => window.__heldMe.push(() => resolve(realFetch(url, options)))); // sent when released: the server answers for that moment
  };
  window.__releaseMe = () => { window.__holdMe = false; const q = window.__heldMe.splice(0); q.forEach((go) => go()); return q.length; };
  const NativeWS = window.WebSocket;
  window.WebSocket = class extends NativeWS {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (e) => {
        if (typeof e.data !== "string") return;
        if (e.data.startsWith('42["tracking:staff"')) window.__staffFrames++;
        if (e.data.startsWith('42["buses"')) window.__busFrames++;
      });
    }
  };
  const NativeBC = window.BroadcastChannel, channels = [];
  window.__bc = "pass"; window.__bcQueue = [];
  window.BroadcastChannel = class extends NativeBC {
    constructor(name) {
      super(name); channels.push(this);
      super.onmessage = (e) => { if (window.__bc === "drop") return; if (window.__bc === "hold") { window.__bcQueue.push(e.data); return; } if (this.__fn) this.__fn(e); };
    }
    set onmessage(fn) { this.__fn = fn; }
    get onmessage() { return this.__fn; }
  };
  window.__deliver = () => { const q = window.__bcQueue.splice(0); for (const d of q) for (const c of channels) if (c.__fn) c.__fn(new MessageEvent("message", { data: d })); return q.length; };
  new MutationObserver(() => {
    const g = window.__guard;
    if (g && document.body.textContent.includes(g.text) && window.__role() === g.role && window.__leaks.length < 10) window.__leaks.push(g.text);
  }).observe(document, { subtree: true, childList: true, characterData: true });
})();`;

const js = (v) => JSON.stringify(v);
const PROMPT_MS = 3000; // "promptly": well under the 60-second session check
const inject = async (p) => { await p.s("Page.addScriptToEvaluateOnNewDocument", { source: script }); await p.reload(); await p.waitFor("document.readyState === 'complete'"); return p; };
const within = async (p, expr, ms = PROMPT_MS) => { const t0 = Date.now(); const ok = !!(await p.waitFor(expr, ms)); return { ok, note: ok ? `${Date.now() - t0} ms` : `not within ${ms} ms` }; };
const isUser = (u) => `window.__who() === ${js(u.username)}`;
const atSignIn = "!!document.querySelector('#au-id')";
const logOut = async (p) => { await p.click('[aria-label="Log out"]'); return p.waitFor(atSignIn); };
/** The tab becomes the active one again (as when the user comes back to it from another tab). */
const activate = async (p, from = null) => { if (from) { await from.s("Page.bringToFront"); await sleep(300); } await p.s("Page.bringToFront"); };
const rawLogin = (p, a) => p.eval(`fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(${js({ username: a.username, password: a.password })}) }).then((r) => r.ok)`);

export async function crossTabSuite({ browser, accounts }) {
  const X = accounts.admin, P = accounts.passenger, P2 = accounts.passenger2;

  section("cross-tab: sign-in and sign-out in another tab");
  const t1 = await inject(await browser.open());
  const t2 = await inject(await t1.newTab());
  await t1.waitFor(atSignIn); await t2.waitFor(atSignIn);
  await t2.signIn(X);
  let r = await within(t1, isUser(X));
  check("a tab at the sign-in screen follows a sign-in made in another tab", r.ok, r.note);
  await t1.open("Users");
  await t1.waitFor("document.body.textContent.includes('User accounts')", 6000);

  await logOut(t2);
  r = await within(t1, `${atSignIn} && document.body.innerText.includes('You were signed out')`);
  check("admin signs out in another tab: this tab returns to sign-in promptly", r.ok, r.note);
  check("... and no longer shows the admin's page", !(await t1.eval("document.body.textContent.includes('User accounts')")));

  await t2.signIn(P);
  r = await within(t1, isUser(P));
  check("admin switches to passenger in another tab: this tab follows the passenger promptly", r.ok, r.note);
  const menu = await t1.nav();
  check("... with the passenger's menu only", !menu.includes("Users") && !menu.includes("Audit log") && !(await t1.eval("document.body.textContent.includes('User accounts')")), menu.join(", "));

  await logOut(t2); await t1.waitFor(atSignIn, 4000);
  await t2.signIn(P2);
  r = await within(t1, isUser(P2));
  check("passenger switches to another account: this tab follows promptly", r.ok, r.note);

  section("cross-tab: suspended tab, missed and late messages");
  await t1.eval("window.__bc = 'drop'; true");
  await t1.s("Page.setWebLifecycleState", { state: "frozen" });
  await logOut(t2); await t2.signIn(P);
  await sleep(3500);
  await t1.s("Page.setWebLifecycleState", { state: "active" });
  r = await within(t1, isUser(P));
  check("a tab suspended during the switch follows the new account when it resumes", r.ok, r.note);

  // A switch between two passengers without a sign-out: the server keeps the old session and the role does not change, so nothing but
  // the message (dropped or held here) and the tab's own checks can reveal it.
  await sleep(3500);
  const changed = await rawLogin(t2, P2); // nobody announces this sign-in: the other tabs get no message at all
  await sleep(2000);
  const before = await t1.eval("window.__who()");
  check("missed message: setup - the tab has not been told yet", changed && before === P.username, `on screen: ${before}`);
  await activate(t1, t2);
  r = await within(t1, isUser(P2));
  check("missed message: the tab follows the server when it becomes active again", r.ok, r.note);

  await t1.eval("window.__bc = 'hold'; true");
  await sleep(3500);
  await rawLogin(t2, P);
  await t2.eval(`new BroadcastChannel("routewatch-session").postMessage("changed"); true`); // the app's own message: it has no content
  await sleep(500);
  const queued = await t1.eval("window.__bcQueue.length"), still = await t1.eval("window.__who()");
  check("late message: setup - the message is held and the tab has not changed", queued >= 1 && still === P2.username, `${queued} held, on screen: ${still}`);
  await activate(t1, t2);
  r = await within(t1, isUser(P));
  check("late message: the tab follows the server before the message arrives", r.ok, r.note);
  await t1.eval("window.__bc = 'pass'; window.__meCalls = 0; true");
  const delivered = await t1.eval("window.__deliver()");
  await sleep(1500);
  const after = await t1.eval("({ who: window.__who(), signIn: !!document.querySelector('#au-id'), calls: window.__meCalls })");
  check("late message: arriving afterwards only re-checks, and changes nothing", delivered >= 1 && after.who === P.username && !after.signIn && after.calls >= 1, `${delivered} late message(s), ${after.calls} check(s), on screen: ${after.who}`);
  check("no JavaScript errors in either tab", t1.errors.length === 0 && t2.errors.length === 0, [...t1.errors, ...t2.errors].slice(0, 2).join(" / "));
  await logOut(t2); await t1.waitFor(atSignIn, 4000);
  await t2.close(); await t1.close();

  section("cross-tab: a message cannot sign anybody in");
  const f1 = await inject(await browser.open());
  const f2 = await inject(await f1.newTab());
  await f1.waitFor(atSignIn);
  await f1.eval("window.__meCalls = 0; true");
  const forged = js({ username: X.username, role: "admin", permissions: ["users:manage"], token: "forged" });
  await f2.eval(`new BroadcastChannel("routewatch-session").postMessage(${forged}); true`);
  await sleep(1500);
  const f = await f1.eval("({ signIn: !!document.querySelector('#au-id'), who: window.__who(), calls: window.__meCalls })");
  check("a forged message with an identity does not sign a signed-out tab in", f.signIn && f.who === null);
  check("... the tab asked the server instead of trusting the message", f.calls === 1, `${f.calls} check(s)`);
  await f1.signIn(P);
  await f2.waitFor(isUser(P), 4000);
  await f2.eval(`new BroadcastChannel("routewatch-session").postMessage(${forged}); true`);
  await sleep(1500);
  const f1Role = await f1.eval("window.__role()");
  check("a forged message does not change a signed-in tab's account or role", (await f1.eval("window.__who()")) === P.username && f1Role === "Passenger", `${await f1.eval("window.__who()")}, ${f1Role}`);
  await logOut(f1); await f2.close(); await f1.close();

  section("cross-tab: the current session keeps working");
  const n = await inject(await browser.open());
  await n.signIn(P);
  await n.waitFor("document.body.textContent.includes('Service alerts')", 8000);
  await n.eval("window.__meCalls = 0; true");
  for (let i = 0; i < 5; i++) { await activate(n); await n.eval("window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); true"); await sleep(200); }
  const calls = await n.eval("window.__meCalls");
  check("returning to the tab repeatedly checks the session at most once every 3 seconds", calls <= 1, `${calls} check(s) in about 1 s`);
  await n.open("Live map"); await n.open("Dashboard");
  check("the signed-in user stays signed in and the pages still load", (await n.eval("window.__who()")) === P.username && !!(await n.waitFor("document.body.textContent.includes('Service alerts')", 8000)));
  check("no JavaScript errors", n.errors.length === 0, n.errors.slice(0, 2).join(" / "));
  await logOut(n); await n.close();

  section("role change for the same account");
  const admin = await browser.open();
  await admin.signIn(X);
  const setRole = (role) => admin.eval(`fetch(${js(`/api/users/${encodeURIComponent(P2.username)}`)}, { method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ role: ${js(role)} }) }).then((r) => r.ok)`);
  const u = await inject(await browser.open());
  try {
    await u.signIn(P2);
    await u.waitFor("document.body.textContent.includes('Passenger information')", 8000);
    const promoted = await setRole("dispatcher");
    r = await within(u, "window.__role() === 'Dispatcher'");
    check("promotion: the open tab follows the new role promptly", promoted && r.ok, r.note);
    check("... the menu and dashboard follow the new role", !!(await u.waitFor("document.body.textContent.includes('Operations overview')", 8000)) && (await u.nav()).includes("Buses"));
    check("... and the live connection joins the staff room", !!(await u.waitFor("window.__staffFrames > 0", 8000)));

    await u.eval("window.__guard = { text: 'Operations overview', role: 'Passenger' }; true");
    const demoted = await setRole("passenger");
    r = await within(u, "window.__role() === 'Passenger'");
    check("demotion: the open tab follows the new role promptly", demoted && r.ok, r.note);
    await u.waitFor("document.body.textContent.includes('Passenger information')", 8000);
    check("... the staff dashboard is never shown under the new role", (await u.eval("window.__leaks.length")) === 0, (await u.eval("window.__leaks")).join(", "));
    await sleep(1500);
    await u.eval("window.__staffFrames = 0; true");
    await sleep(8000);
    const frames = await u.eval("window.__staffFrames");
    check("... and the live connection no longer receives staff tracking", frames === 0, `${frames} staff frame(s) in 8 s`);
    check("... and the menu has no staff pages", !(await u.nav()).includes("Buses"));

    // Changed and changed back before the tab's check is answered: the check finds the same account and role, so nothing on screen
    // changes, but the server has ended the live connection.
    await sleep(3500);
    await u.eval("window.__holdMe = true; true");
    const flipped = await setRole("dispatcher") && await setRole("passenger");
    const checks = await u.waitFor("window.__heldMe.length > 0", 5000);
    await u.eval("window.__releaseMe()");
    await sleep(2000);
    await u.eval("window.__busFrames = 0; true");
    const liveAgain = await u.waitFor("window.__busFrames > 0", 15000);
    check("role changed and changed back: the tab stays a passenger and its live updates continue", flipped && !!checks && (await u.eval("window.__role()")) === "Passenger" && !!liveAgain, !checks ? "the tab did not check" : liveAgain ? "" : "no live bus update in 15 s");
    check("no JavaScript errors during role changes", u.errors.length === 0, u.errors.slice(0, 2).join(" / "));
  } finally {
    await setRole("passenger"); // leave the account as it was, whatever happened
    await u.close(); await logOut(admin); await admin.close();
  }
}
