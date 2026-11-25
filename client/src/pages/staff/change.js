import { send } from "../../services/http.js";

// ---- Routes and bus stops ----
// Same rules as Bus Management: administrators change records, dispatchers only look, passengers see only the map.
// The server enforces it (routes:manage / stops:manage); hidden buttons just keep the screen consistent.

/** Sends a change, then reports success or the server's message. Returns the parsed body on success, otherwise null. */
export async function change(method, url, body, onUnauthorized, setFeedback, okText) {
  setFeedback(null);
  try {
    const r = await send(method, url, body);
    if (r.status === 401) { onUnauthorized(); return null; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setFeedback({ ok: false, text: d.error || "The change could not be saved." }); return null; }
    if (okText) setFeedback({ ok: true, text: okText });
    return d;
  } catch { setFeedback({ ok: false, text: "Cannot reach the server." }); return null; }
}
