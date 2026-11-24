// Small request helpers for the signed-in app. Every request goes to this site's own /api (same origin), with the session cookie.
// They add nothing else: no retries, no error handling, no session logic. Each caller decides what a status means.
// The sign-in screens (Auth.jsx) keep their own `post`, which has a different contract (it catches network errors).

/** Sends a JSON body (an empty object by default) and returns the raw Response. A network failure rejects. */
export const send = (method, url, body = {}) =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
/** send() with POST. */
export const post = (url, body) => send("POST", url, body);

/** GET, returning { status, ok, body }; body is null when the response is not JSON. A network failure rejects. */
export const getJson = async (url) => { const r = await fetch(url, { credentials: "same-origin" }); return { status: r.status, ok: r.ok, body: await r.json().catch(() => null) }; };
