// Tells the other open RouteWatch tabs of this browser that the sign-in may have changed (sign-in or sign-out here).
// The message carries nothing: no token, no username, no role. A tab that receives it only asks the server who it is (/api/me),
// so a message, even a forged or late one, can never sign anybody in or change what the server allows.
const NAME = "routewatch-session";
const KEY = "rw.sessionChanged"; // fallback for browsers without BroadcastChannel: a random value, never anything about the session

let channel = null;
try { if (typeof BroadcastChannel === "function") channel = new BroadcastChannel(NAME); } catch { channel = null; }

export function announceSessionChange() {
  try {
    if (channel) channel.postMessage("changed");
    else localStorage.setItem(KEY, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  } catch { /* the other tabs still check on focus and every minute */ }
}

/** Calls fn when another tab reports a change. Returns the function that stops listening. */
export function onSessionChange(fn) {
  if (channel) {
    channel.onmessage = () => fn(); // the content is never read
    return () => { channel.onmessage = null; };
  }
  const listener = (e) => { if (e.key === KEY) fn(); };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
