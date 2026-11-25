import { useCallback, useEffect, useRef, useState } from "react";
import { isLatLng } from "../../geo.js";

// What the passenger reads before the browser asks for permission.
export const LOCATION_CONSENT = "To find buses near you, RouteWatch needs your device's location. It is used only inside this browser to measure distances: it is not sent to the RouteWatch server, not stored, and not shared with conductors, dispatchers or administrators. You can stop at any time.";

/**
 * The passenger's own position, from the browser Geolocation API. Nothing happens until start() is called (after the passenger
 * agreed). watchPosition keeps it current while the map is open; the watch is cleared by stop(), on a permission error, and when
 * the map closes. The position lives only in this component's memory: it is never sent anywhere or saved.
 * phase: "off" | "asking" | "on" | "error"; problem: why the location cannot be used (see locationProblem in geo.js).
 */
export function usePassengerLocation(enabled) {
  const empty = { phase: "off", pos: null, accuracy: null, at: null, problem: null };
  const [loc, setLoc] = useState(empty);
  const [permission, setPermission] = useState(null); // "granted" | "denied" | "prompt" | null (browser does not say)
  const watch = useRef(null);
  const hasFix = useRef(false);
  const clear = useCallback(() => {
    if (watch.current != null) navigator.geolocation?.clearWatch(watch.current);
    watch.current = null;
  }, []);
  const start = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) { setLoc({ ...empty, phase: "error", problem: "unsupported" }); return; }
    if (window.isSecureContext === false) { setLoc({ ...empty, phase: "error", problem: "insecure" }); return; }
    if (watch.current != null) return; // already watching: never a second request
    hasFix.current = false;
    setLoc({ ...empty, phase: "asking" });
    watch.current = navigator.geolocation.watchPosition(
      (p) => {
        const pos = [p.coords.latitude, p.coords.longitude];
        if (!isLatLng(pos)) return; // never show a position the device did not really give
        hasFix.current = true;
        setLoc({ phase: "on", pos, accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null, at: p.timestamp || Date.now(), problem: null });
      },
      (e) => {
        // Permission refused, or no position at all yet: stop asking (no repeated requests) and explain.
        if (e.code === 1 || !hasFix.current) { clear(); hasFix.current = false; setLoc({ ...empty, phase: "error", problem: e.code }); }
        else setLoc((l) => ({ ...l, problem: e.code })); // a later update failed: keep the last position, the watch keeps trying
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 });
  }, [clear]); // eslint-disable-line react-hooks/exhaustive-deps
  const stop = useCallback(() => { clear(); hasFix.current = false; setLoc(empty); }, [clear]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => clear, [clear]); // leaving the map ends the watch
  // Read (never request) the permission state, so a passenger who blocked location gets the instructions straight away.
  useEffect(() => {
    if (!enabled || !navigator.permissions?.query) return;
    let status = null, live = true;
    navigator.permissions.query({ name: "geolocation" }).then((s) => {
      if (!live) return;
      status = s; setPermission(s.state);
      s.onchange = () => setPermission(s.state);
    }).catch(() => {});
    return () => { live = false; if (status) status.onchange = null; };
  }, [enabled]);
  // Permission withdrawn in the browser settings while the map is open: stop using the location at once.
  useEffect(() => {
    if (permission === "denied" && watch.current != null) { clear(); hasFix.current = false; setLoc({ ...empty, phase: "error", problem: "denied" }); }
  }, [permission, clear]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...loc, permission, start, stop };
}
