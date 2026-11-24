// Tells the server that a person is using the page, so an attended session does not go idle.
// The pages poll the API automatically, and that polling deliberately does NOT count as activity on the server.
// Sends no content: no position, no input and nothing about what was clicked. At most one report a minute.
const EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"];
const EVERY_MS = 60_000, RETRY_MS = 10_000;
let lastSent = 0, sending = false;

function report(event) {
  if (!event.isTrusted || sending || Date.now() - lastSent < EVERY_MS) return;
  sending = true;
  lastSent = Date.now();
  const retrySoon = () => { lastSent = Date.now() - EVERY_MS + RETRY_MS; };
  fetch("/api/session/activity", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: "{}" })
    .then((r) => { if (!r.ok) retrySoon(); }, retrySoon)
    .finally(() => { sending = false; });
}
for (const name of EVENTS) window.addEventListener(name, report, { capture: true, passive: true });
