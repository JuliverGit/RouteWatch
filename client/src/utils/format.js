// Display formatting shared by several screens. Pure functions: no state, no requests, no React.

/** A duration in seconds as "45 sec" or "3 min 20 sec"; null or undefined as "–". */
export const fmt = (s) => (s == null ? "–" : s < 60 ? `${s} sec` : `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} sec` : ""}`);

/** An age in seconds as "45 sec ago" or "3 min ago"; null or undefined as "No data yet". */
export const ago = (s) => (s == null ? "No data yet" : s < 60 ? `${s} sec ago` : `${Math.floor(s / 60)} min ago`);

/** A timestamp as a local time of day with seconds. */
export const timeFmt = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** A timestamp as a local date and time (medium date, short time). */
export const dateTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** Text shortened to at most n characters, ending in "…" when it was cut. */
export const brief = (t, n = 120) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** A coordinate with 5 decimals; null or undefined as "–". */
export const coordText = (n) => (n == null ? "–" : Number(n).toFixed(5));

/** Up to two letters or digits of a name, upper case, for an avatar ("?" when there are none). */
export const initials = (name) => (String(name).match(/[a-z0-9]/gi) || ["?"]).slice(0, 2).join("").toUpperCase();
