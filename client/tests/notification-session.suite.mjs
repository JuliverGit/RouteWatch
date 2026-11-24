// A notification belongs to the signed-in user: its title must never appear in another user's session.
// Nothing is written to the database and no real alert is published. Notifications enter through the app's real Socket.IO client,
// as frames delivered to its live WebSocket inside this page, and /api/notifications is answered per user inside this page.
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
  window.__who = who;
  window.__pushIfUser = (name, event, data) => (who() === name ? window.__push(event, data) : false);
  window.__notifsBy = {};
  window.__notifDelay = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, options) => {
    if (String(url) !== "/api/notifications") return realFetch(url, options);
    const list = window.__notifsBy[who()] ?? [], delay = window.__notifDelay;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return new Response(JSON.stringify({ unread: list.filter((n) => !n.read).length, notifications: list }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  // Every toast that was ever on screen, with the user shown at that moment (catches a toast visible for a single frame).
  window.__toastLog = [];
  new MutationObserver(() => {
    const t = document.querySelector(".toast");
    if (!t) return;
    const e = { who: who(), text: t.textContent }, last = window.__toastLog.at(-1);
    if (!last || last.who !== e.who || last.text !== e.text) window.__toastLog.push(e);
  }).observe(document, { subtree: true, childList: true, characterData: true });
})();`;

let nextId = 880001;
const note = (title) => ({ id: nextId++, receivedAt: new Date().toISOString(), read: false, alert: { id: nextId, title, description: "Injected by the smoke test.", category: "general", categoryLabel: "General announcement", severity: "info", audience: "public", status: "published", state: "active", busId: null, busName: null, routeId: null, routeName: null, stopId: null, stopName: null, publishedAt: new Date().toISOString(), expiresAt: null } });
const js = (v) => JSON.stringify(v);

async function openWithFrames(browser) {
  const p = await browser.open();
  await p.s("Page.addScriptToEvaluateOnNewDocument", { source: page });
  await p.reload();
  return p;
}
const socketReady = (p) => p.waitFor("window.__push('test:noop', {})", 12000);
const setList = (p, username, list) => p.eval(`window.__notifsBy[${js(username)}] = ${js(list)}; true`);
const toastHas = (p, title) => p.waitFor(`document.querySelector('.toast')?.textContent.includes(${js(title)})`, 4000);
const pushNote = async (p, username, n) => { await setList(p, username, [n]); return p.eval(`window.__pushIfUser(${js(username)}, "notification", ${js(n)})`); };
const logOut = async (p) => { await p.click('[aria-label="Log out"]'); return p.waitFor("!!document.querySelector('#au-id')"); };
const leakedToasts = (p, title, owner) => p.eval(`window.__toastLog.filter((e) => e.text.includes(${js(title)}) && e.who !== ${js(owner)}).length`);
const bodyHas = (p, text) => p.eval(`document.body.innerText.includes(${js(text)})`);

export async function notificationSessionSuite({ browser, accounts, query }) {
  const A = accounts.passenger, B = accounts.passenger2, C = accounts.dispatcher;

  section("notifications: normal behavior");
  const p = await openWithFrames(browser);
  await p.signIn(A); await socketReady(p);
  const first = note("Own notification one");
  await pushNote(p, A.username, first);
  check("a user's own notification shows a toast", await toastHas(p, first.alert.title));
  check("the bell shows it as unread", await p.waitFor(`document.querySelector('.bell')?.getAttribute('aria-label') === 'Notifications, 1 unread'`, 3000));
  await p.click(".toast__btn");
  check("clicking the toast opens Notifications and closes the toast", await p.waitFor(`document.querySelector('.topbar h1')?.textContent === 'Notifications' && !document.querySelector('.toast')`, 3000));
  check("the notification is in the user's list", await p.waitFor(`document.querySelector('.notiflist')?.textContent.includes(${js(first.alert.title)})`, 3000));
  const timed = note("Own notification two");
  await pushNote(p, A.username, timed);
  await toastHas(p, timed.alert.title);
  await sleep(4000);
  check("the toast stays visible for its normal time", await p.eval(`document.querySelector('.toast')?.textContent.includes(${js(timed.alert.title)}) === true`));
  check("the toast dismisses itself after about 6 seconds", await p.waitFor("!document.querySelector('.toast')", 3500));
  await logOut(p);

  section("notifications: log out with a toast visible");
  await p.signIn(A); await socketReady(p);
  const secret = note(`Private to A ${nextId}`);
  await pushNote(p, A.username, secret);
  check("user A has a visible toast", await toastHas(p, secret.alert.title));
  await logOut(p);
  await setList(p, B.username, []);
  await p.signIn(B);
  check("next user: no toast right after sign-in", !(await p.eval("!!document.querySelector('.toast')")));
  await sleep(600);
  check("next user never saw the previous user's toast, even briefly", (await leakedToasts(p, secret.alert.title, A.username)) === 0);
  await p.open("Notifications");
  await p.waitFor("!!document.querySelector('#h-notif')", 4000);
  check("next user's list has none of the previous user's notifications", !(await bodyHas(p, secret.alert.title)));

  section("notifications: new user's own");
  await socketReady(p);
  const own = note("Own notification of user B");
  await pushNote(p, B.username, own);
  check("the new user's own notification shows a toast", await toastHas(p, own.alert.title));
  check("the new user's own notification is in their list", await p.waitFor(`document.querySelector('.notiflist')?.textContent.includes(${js(own.alert.title)})`, 3000));
  check("the bell counts it", await p.waitFor(`document.querySelector('.bell')?.getAttribute('aria-label') === 'Notifications, 1 unread'`, 3000));
  await sleep(6300);
  await logOut(p);

  section("notifications: dismissal timer");
  await p.signIn(A); await socketReady(p);
  const same = "Same title for both users", n1 = note(same);
  await pushNote(p, A.username, n1);
  await toastHas(p, same);
  const t0 = Date.now();
  await logOut(p);
  await setList(p, B.username, []);
  await p.signIn(B); await socketReady(p);
  await sleep(Math.max(0, 4200 - (Date.now() - t0)));
  await pushNote(p, B.username, note(same));
  const shownAt = Date.now();
  check("the new user's toast appears", await toastHas(p, same));
  await sleep(Math.max(0, 6900 - (Date.now() - t0)));
  check("the previous user's pending timer does not dismiss the new user's toast", await p.eval("!!document.querySelector('.toast')"), `checked ${Date.now() - t0} ms after A's toast, ${Date.now() - shownAt} ms after B's`);
  check("the new user's toast still dismisses on its own timer", await p.waitFor("!document.querySelector('.toast')", 5000));
  await logOut(p);

  section("notifications: slow response from the previous session");
  await p.signIn(A); await socketReady(p);
  const slow = note(`Slow private to A ${nextId}`);
  await setList(p, A.username, [slow]);
  await p.eval("window.__notifDelay = 3500; true");
  await p.eval(`window.__push("notification:read", {})`); // starts a notification load for user A
  await sleep(150);
  await p.eval("window.__notifDelay = 0; true");
  await logOut(p);
  await setList(p, B.username, []);
  await p.signIn(B);
  await p.open("Notifications");
  await sleep(4200);
  check("a late response for the previous user is ignored", !(await bodyHas(p, slow.alert.title)));
  check("the bell does not count the previous user's notification", (await p.eval("document.querySelector('.bell')?.getAttribute('aria-label')")) === "Notifications, none unread");
  await logOut(p);
  check("no JavaScript errors in the notification flows", p.errors.length === 0, p.errors.slice(0, 2).join(" / "));
  await p.close();

  section("notifications: account switch with a toast visible");
  const s = await openWithFrames(browser);
  await s.signIn(A); await socketReady(s);
  const switched = note(`Switch private to A ${nextId}`);
  await setList(s, A.username, [switched]);
  await setList(s, C.username, []);
  await s.eval(`window.__push("notification:read", {})`);
  await s.waitFor(`document.querySelector('.bell')?.getAttribute('aria-label') === 'Notifications, 1 unread'`, 3000);
  check("another sign-in replaces the session", await s.eval(`fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(${js({ username: C.username, password: C.password })}) }).then((r) => r.ok)`));
  // Keep A's toast on screen until the page notices the new account (the dashboard poll, at most 5 seconds).
  let visibleWhenSwitched = false;
  for (let i = 0; i < 40; i++) {
    const shown = await s.eval(`(() => { const sent = window.__pushIfUser(${js(A.username)}, "notification", ${js(switched)}); return sent; })()`);
    if (!shown) break;
    visibleWhenSwitched = true;
    await sleep(350);
  }
  check("user A's toast was visible when the account changed", visibleWhenSwitched);
  check("the page follows the new account", await s.waitFor(`window.__who() === ${js(C.username)}`, 8000));
  check("no toast after the account switch", await s.waitFor("!document.querySelector('.toast')", 500));
  await sleep(500);
  check("the new account never saw the previous account's toast, even briefly", (await leakedToasts(s, switched.alert.title, A.username)) === 0, `${await leakedToasts(s, switched.alert.title, A.username)} leaked`);
  check("the bell no longer counts the previous account's notification", await s.waitFor(`document.querySelector('.bell')?.getAttribute('aria-label') === 'Notifications, none unread'`, 1500));
  await s.open("Notifications");
  await s.waitFor("!!document.querySelector('#h-notif')", 4000);
  check("the new account's list has none of the previous account's notifications", !(await bodyHas(s, switched.alert.title)));
  await socketReady(s);
  const cOwn = note("Own notification after the switch");
  await pushNote(s, C.username, cOwn);
  check("the new account's own notification shows", await toastHas(s, cOwn.alert.title));
  check("no JavaScript errors during the account switch", s.errors.length === 0, s.errors.slice(0, 2).join(" / "));
  await sleep(6300);
  await logOut(s); await s.close();

  section("notifications: session expiry and guest exit");
  const e = await openWithFrames(browser);
  await e.signIn(A); await socketReady(e);
  const expiring = note(`Expiry private to A ${nextId}`);
  const { cookies } = await e.s("Network.getCookies", { urls: [APP] });
  await query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(`x=${cookies.find((c) => c.name === "rw_session").value}`)]);
  let pushed = false;
  for (let i = 0; i < 40; i++) {
    if (!(await e.eval(`window.__pushIfUser(${js(A.username)}, "notification", ${js(expiring)})`))) break;
    pushed = true;
    await sleep(350);
  }
  check("user A's toast was visible when the session expired", pushed);
  check("the expired session returns to sign-in", await e.waitFor("!!document.querySelector('#au-id') && document.body.innerText.includes('Your session has expired')", 9000));
  await setList(e, B.username, []);
  await e.signIn(B);
  await sleep(500);
  check("after expiry the next user sees no toast", !(await e.eval("!!document.querySelector('.toast')")) && (await leakedToasts(e, expiring.alert.title, A.username)) === 0);
  await logOut(e);
  await e.click(".au-guest");
  await e.waitFor("window.__who() === 'Guest'");
  await socketReady(e);
  const guestNote = note(`Guest toast ${nextId}`);
  await e.eval(`window.__push("notification", ${js(guestNote)})`);
  check("guest has a visible toast", await toastHas(e, guestNote.alert.title));
  await e.click('[aria-label="Back to sign in"]');
  await e.waitFor("!!document.querySelector('#au-id')");
  await e.signIn(B);
  await sleep(500);
  check("after guest exit the next user sees no toast", !(await e.eval("!!document.querySelector('.toast')")) && (await leakedToasts(e, guestNote.alert.title, "Guest")) === 0);
  check("no JavaScript errors in expiry and guest exit", e.errors.length === 0, e.errors.slice(0, 2).join(" / "));
  await logOut(e); await e.close();
}
