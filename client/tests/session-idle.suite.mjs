// Idle session expiry: background polling must not keep a session alive; real user activity must.
// Time is simulated by moving the test session's last_seen_at back in PostgreSQL.
import { API, APP, api, check, section, sleep, tokenHash } from "./harness.mjs";

const IDLE_MINUTES = 30;

export async function sessionIdleSuite({ browser, accounts, query }) {
  const setAge = (hash, minutes) => query("UPDATE sessions SET last_seen_at = now() - make_interval(secs => $2) WHERE token_hash = $1", [hash, minutes * 60]);
  const ageOf = async (hash) => Number((await query("SELECT extract(epoch FROM now() - last_seen_at) / 60 AS m FROM sessions WHERE token_hash = $1", [hash])).rows[0]?.m ?? NaN);
  const a = accounts.passenger;
  const signIn = async () => { const cookie = (await api("POST", "/api/login", { body: { username: a.username, password: a.password } })).cookie; return { cookie, hash: tokenHash(cookie) }; };
  const raw = (cookie, headers, body) => fetch(`${API}/api/session/activity`, { method: "POST", headers: { cookie, ...headers }, body });

  section("idle session: API");
  let { cookie, hash } = await signIn();
  await setAge(hash, 29);
  for (const url of ["/api/me", "/api/dashboard", "/api/notifications", "/api/alerts/active", "/api/tracking/buses"]) await api("GET", url, { cookie });
  const polled = await ageOf(hash);
  check("background GET polling does not extend the session", polled >= 28.9, `idle ${polled.toFixed(1)} min after polling`);
  await query("UPDATE sessions SET last_seen_at = last_seen_at - interval '2 minutes' WHERE token_hash = $1", [hash]);
  check(`polling for ${IDLE_MINUTES}+ minutes without user activity ends the session`, (await api("GET", "/api/me", { cookie })).status === 401);

  ({ cookie, hash } = await signIn());
  await setAge(hash, 10);
  const report = await api("POST", "/api/session/activity", { cookie, body: {} });
  check("reported user activity is accepted (204)", report.status === 204, `status ${report.status}`);
  check("reported user activity extends the session", (await ageOf(hash)) < 1);
  await setAge(hash, 0.5);
  await api("POST", "/api/session/activity", { cookie, body: {} });
  check("activity writes to the database at most once a minute", (await ageOf(hash)) >= 0.45);

  await setAge(hash, 10);
  await api("POST", "/api/notifications/read-all", { cookie, body: {} });
  check("a real state-changing request counts as activity", (await ageOf(hash)) < 1);

  await setAge(hash, 10);
  const cross = await raw(cookie, { "Content-Type": "application/json", origin: "https://evil.example" }, "{}");
  check("cross-site activity report is refused and does not extend the session", cross.status === 403 && (await ageOf(hash)) >= 9.9, `status ${cross.status}`);
  const plain = await raw(cookie, { "Content-Type": "text/plain" }, "{}");
  check("non-JSON activity report is refused and does not extend the session", plain.status === 415 && (await ageOf(hash)) >= 9.9, `status ${plain.status}`);

  const before = (await query("SELECT expires_at FROM sessions WHERE token_hash = $1", [hash])).rows[0].expires_at.getTime();
  await api("POST", "/api/session/activity", { cookie, body: {} });
  check("activity never extends the absolute session lifetime", (await query("SELECT expires_at FROM sessions WHERE token_hash = $1", [hash])).rows[0].expires_at.getTime() === before);
  await setAge(hash, IDLE_MINUTES + 1);
  await api("POST", "/api/session/activity", { cookie, body: {} });
  check("an idle-expired session cannot be revived by activity", (await api("GET", "/api/me", { cookie })).status === 401);
  check("an activity report without a session is a harmless 204", (await api("POST", "/api/session/activity", { body: {} })).status === 204);

  section("idle session: browser");
  const browserHash = async (p) => { const { cookies } = await p.s("Network.getCookies", { urls: [APP] }); return tokenHash(`x=${cookies.find((c) => c.name === "rw_session").value}`); };
  const reports = (p) => p.requests.filter((r) => r.method === "POST" && r.url.endsWith("/api/session/activity")).length;

  const p = await browser.open();
  await p.signIn(a);
  await p.waitFor("!!document.querySelector('.panel')");
  const h = await browserHash(p);
  await setAge(h, 10);
  await sleep(6500); // at least one 5-second dashboard poll
  check("open tab, no interaction: polling does not extend the session", (await ageOf(h)) >= 10, `idle ${(await ageOf(h)).toFixed(1)} min`);
  const box = await p.eval("(() => { const r = document.querySelector('.topbar h1').getBoundingClientRect(); return { x: r.x + 10, y: r.y + 10 }; })()");
  await p.realClick(box.x, box.y);
  await p.waitFor("true", 100); await sleep(700);
  check("a real mouse click extends the session", (await ageOf(h)) < 1, `idle ${(await ageOf(h)).toFixed(2)} min`);
  const once = reports(p);
  await p.realClick(box.x, box.y); await p.realClick(box.x, box.y); await sleep(400);
  check("activity reports are throttled in the browser", once === 1 && reports(p) === 1, `${reports(p)} report(s) for 3 clicks`);
  await setAge(h, IDLE_MINUTES + 1);
  check("an idle open tab returns to sign-in with the session-expired message", await p.waitFor("!!document.querySelector('#au-id') && document.body.innerText.includes('Your session has expired')", 9000));
  check("no JavaScript errors", p.errors.length === 0, p.errors.slice(0, 2).join(" / "));
  await p.close();

  const k = await browser.open();
  await k.signIn(a);
  await k.waitFor("!!document.querySelector('.panel')");
  const kh = await browserHash(k);
  await setAge(kh, 10);
  for (const type of ["rawKeyDown", "keyUp"]) await k.s("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await sleep(700);
  check("a real key press extends the session", (await ageOf(kh)) < 1, `idle ${(await ageOf(kh)).toFixed(2)} min`);
  await k.close();

  const g = await browser.open();
  await g.waitFor("!!document.querySelector('.au-guest')");
  await g.click(".au-guest");
  await g.waitFor("document.querySelector('.rail__who')?.innerText.includes('Guest')");
  const gb = await g.eval("(() => { const r = document.querySelector('.topbar h1').getBoundingClientRect(); return { x: r.x + 10, y: r.y + 10 }; })()");
  await g.realClick(gb.x, gb.y); await sleep(500);
  check("guest: interacting causes no error and keeps guest access", g.errors.length === 0 && (await g.eval("document.querySelector('.rail__who').innerText.includes('Guest')")));
  await g.close();
}
