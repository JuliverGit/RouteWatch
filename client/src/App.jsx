import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Polyline, CircleMarker, Circle, Marker, Tooltip, Popup, useMap } from "react-leaflet";
import { RADIUS_OPTIONS, DEFAULT_RADIUS_M, POOR_ACCURACY_M, isLatLng, haversineMeters, formatDistance, formatRadius, hasLivePosition, findNearby, locationProblem } from "./geo.js";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { io } from "socket.io-client";
import AuthScreen from "./Auth.jsx";
import { announceSessionChange, onSessionChange } from "./sessionSync.js";
import { fmt, ago, timeFmt, dateTime, brief, coordText, initials } from "./utils/format.js";
import { TRACK, BUS_STATUS, SEV, ASTATE } from "./utils/status.js";
import { send, post, getJson } from "./services/http.js";

// ONE Socket.IO connection for the whole page, shared by every screen that needs live data. Each screen calls joinSocket(), adds
// its handlers with .on() and releases them with .disconnect() (which removes only ITS handlers). The real connection closes when the
// last screen leaves. The server reads the session cookie when a connection is made, so when the signed-in user changes
// (sign-in, sign-out) the connection is made again to carry the new identity.
let sharedSocket = null, sharedUsers = 0, sharedIdentity = null, sharedCloseTimer = null;
function joinSocket() {
  clearTimeout(sharedCloseTimer);
  if (!sharedSocket) sharedSocket = io();
  else if (!sharedSocket.active) sharedSocket.connect(); // the server ended it (sign-out): connect again with the cookie the browser holds now
  const s = sharedSocket, mine = [];
  let left = false;
  sharedUsers++;
  return {
    on(event, fn) { mine.push([event, fn]); s.on(event, fn); if (event === "connect" && s.connected) fn(); return this; },
    disconnect() {
      if (left) return;
      left = true;
      for (const [event, fn] of mine) s.off(event, fn);
      // Close after a short pause, so moving from one screen to another reuses the same connection.
      if (--sharedUsers === 0) sharedCloseTimer = setTimeout(() => { if (sharedUsers === 0) { s.disconnect(); if (sharedSocket === s) sharedSocket = null; } }, 1500);
    },
  };
}
function setSocketIdentity(name) {
  if (sharedIdentity === name) return;
  const first = sharedIdentity === null;
  sharedIdentity = name;
  if (!first && sharedSocket) { sharedSocket.disconnect(); sharedSocket.connect(); }
}
import { Bus, Map as MapIcon, LayoutDashboard, LogOut, Bell, MapPin, Clock, Users, ScrollText, Radio, Route as RouteIcon, ArrowUp, ArrowDown, Ticket, Plus, Minus, Megaphone, CheckCheck, LocateFixed } from "lucide-react";

const busIcon = (id, status, mine = false, selected = false) => L.divIcon({ className: "", html: `<div class="bus-pin bus-pin--${status}${mine ? " bus-pin--mine" : ""}${selected ? " bus-pin--sel" : ""}">${id.slice(-2)}</div>${mine ? '<span class="bus-tag">MY BUS</span>' : ""}`, iconSize: [32, 32], iconAnchor: [16, 16] });
// The passenger's own position: a blue dot (drawn in CSS), clearly different from the round bus pins.
const meIcon = L.divIcon({ className: "", html: '<div class="me-dot" aria-hidden="true"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
const sourceLabel = (src) => (src === "gps" ? "GPS device" : src === "simulation" ? "Simulated GPS (not real)" : "No tracking device");
const direction = (b) => (b.dir === 1 ? "To CDO" : b.dir === -1 ? "To Villanueva" : "Direction unknown");
const nextStopOf = (b, stops) => {
  let best = null;
  (b.etas || []).forEach((e, i) => { if (e != null && (!best || e < best.eta)) best = { name: stops[i]?.name, eta: e }; });
  return best;
};

// Display names only. What a user may actually do is decided by the server;
// the permission list it returns is used here just to show the right menu items.
const ROLE_LABEL = { admin: "Administrator", dispatcher: "Dispatcher", conductor: "Conductor", passenger: "Passenger", guest: "Guest" };
const ROLES = ["admin", "dispatcher", "conductor", "passenger"];
const VIEWS = [
  { id: "dash", label: "Dashboard", Icon: LayoutDashboard, permission: null, group: "Monitoring" }, // everyone; the server decides which sections they receive
  { id: "counter", label: "Passenger counter", Icon: Ticket, permission: "occupancy:update", group: "Monitoring" }, // conductors only (the server checks the assignment)
  { id: "map", label: "Live map", Icon: MapIcon, permission: null, group: "Monitoring" },
  { id: "notifications", label: "Notifications", Icon: Bell, permission: null, member: true, group: "Monitoring" }, // signed-in users only; each sees only their own
  { id: "alerts", label: "Service alerts", Icon: Megaphone, permission: "alerts:manage", group: "Operations" }, // administrators and dispatchers
  { id: "buses", label: "Buses", Icon: Bus, permission: "buses:read", group: "Fleet" },
  { id: "routes", label: "Routes", Icon: RouteIcon, permission: "routes:read", group: "Fleet" },
  { id: "stops", label: "Bus stops", Icon: MapPin, permission: "stops:read", group: "Fleet" },
  { id: "users", label: "Users", Icon: Users, permission: "users:read", group: "Administration" },
  { id: "audit", label: "Audit log", Icon: ScrollText, permission: "audit:read", group: "Administration" },
];

// Passenger occupancy as the server reports it (real count kept by the bus's conductor). "Not reported" is shown as such, never as 0.
const OccBadge = ({ occ }) => (occ && occ.reported ? <Badge tone={occ.tone}>{occ.count}/{occ.capacity} · {occ.label}</Badge> : <Badge tone="off">Occupancy not reported</Badge>);
const Badge = ({ tone, children }) => <span className={`badge badge--${tone}`}>{children}</span>;
const State = ({ title, text, action }) => (
  <div className="state" role="status"><h2>{title}</h2><p>{text}</p>{action}</div>
);

// Sign-in, registration, email verification and password recovery live in Auth.jsx (same props as before).
const Login = (props) => <AuthScreen {...props} />;

// Zooms the map to the stops of the route the visitor picked.
function Fit({ points }) {
  const map = useMap();
  useEffect(() => { if (points.length) map.fitBounds(points, { padding: [40, 40], maxZoom: 15 }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Moves the map to a point once per request (the "My bus" shortcut). A new `token` asks for another move.
function FlyTo({ pos, token }) {
  const map = useMap();
  const done = useRef(0);
  const key = pos ? `${pos[0]},${pos[1]}` : "";
  useEffect(() => {
    if (token > done.current && pos) { done.current = token; map.flyTo(pos, Math.max(map.getZoom(), 15), { duration: 0.8 }); }
  }, [token, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Flies to the bus a passenger picked in the Nearby list and opens its popup. Once per pick (token), never on every position update.
function FocusBus({ id, pos, token, markers }) {
  const map = useMap();
  const done = useRef(0);
  useEffect(() => {
    if (!token || token <= done.current || !pos) return;
    done.current = token;
    const open = () => markers.current.get(id)?.openPopup();
    map.once("moveend", open);
    const fallback = setTimeout(open, 1000); // in case the map was already there and no move happens
    map.flyTo(pos, Math.max(map.getZoom(), 15), { duration: 0.8 });
    return () => { map.off("moveend", open); clearTimeout(fallback); };
  }, [token, !!pos]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// What the passenger reads before the browser asks for permission.
const LOCATION_CONSENT = "To find buses near you, RouteWatch needs your device's location. It is used only inside this browser to measure distances: it is not sent to the RouteWatch server, not stored, and not shared with conductors, dispatchers or administrators. You can stop at any time.";

/**
 * The passenger's own position, from the browser Geolocation API. Nothing happens until start() is called (after the passenger
 * agreed). watchPosition keeps it current while the map is open; the watch is cleared by stop(), on a permission error, and when
 * the map closes. The position lives only in this component's memory: it is never sent anywhere or saved.
 * phase: "off" | "asking" | "on" | "error"; problem: why the location cannot be used (see locationProblem in geo.js).
 */
function usePassengerLocation(enabled) {
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

function LiveMap({ canFleet, isConductor = false, isPassenger = false, focusToken = 0, alertsTick = 0, mapFocus = null, onFocusUsed }) {
  const [route, setRoute] = useState(null);
  const [myBusId, setMyBusId] = useState(null);   // the bus the SERVER says this conductor is assigned to (never chosen by the browser)
  const [myChecked, setMyChecked] = useState(!isConductor);
  const [localFocus, setLocalFocus] = useState(0);
  const svcAlerts = useActiveAlerts(alertsTick);        // active service alerts meant for this viewer (the server filters them)
  const [focus, setFocus] = useState(null);             // { kind: "bus" | "route" | "stop", id, token }: what an alert asked the map to show
  const seq = useRef(0);
  const [myBusFocus] = useState(focusToken); // a "View my bus" request, kept here because App clears it once this map has it
  // A focus request is one-shot: take it, then tell App to forget it, so coming back to the map later does not replay it.
  useEffect(() => {
    if (mapFocus?.token) setFocus({ kind: mapFocus.kind, id: mapFocus.id, token: ++seq.current });
    if (mapFocus?.token || focusToken) onFocusUsed?.();
  }, [mapFocus?.token, focusToken]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusOn = useCallback((kind, id) => setFocus({ kind, id, token: ++seq.current }), []);
  const [failed, setFailed] = useState(false);
  const [buses, setBuses] = useState(null);
  const [staff, setStaff] = useState(null);
  const [online, setOnline] = useState(false);
  const hasRoute = useRef(false);
  const loadRoute = useCallback(() => {
    fetch("/api/route").then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d) => { hasRoute.current = true; setRoute(d); setFailed(false); })
      .catch(() => { if (!hasRoute.current) setFailed(true); }); // once a route is shown, a failed refresh keeps it
  }, []);
  // The server calculates the road route (OSRM). While it is still loading, or could not be loaded, keep asking.
  const routeStatus = route?.status;
  useEffect(() => {
    if (!routeStatus || routeStatus === "ready") return;
    const t = setInterval(loadRoute, routeStatus === "loading" ? 2000 : 10000);
    return () => clearInterval(t);
  }, [routeStatus, loadRoute]);
  useEffect(() => {
    loadRoute();
    // First paint from the REST snapshot, then live updates over Socket.IO.
    fetch("/api/tracking/buses").then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then((b) => setBuses((prev) => prev ?? b)).catch(() => {});
    const s = joinSocket();
    s.on("connect", () => setOnline(true));
    s.on("disconnect", () => setOnline(false));
    s.on("connect_error", () => setOnline(false));
    s.on("buses", (b) => { if (Array.isArray(b)) setBuses(b); setOnline(true); });
    s.on("tracking:staff", (d) => { if (Array.isArray(d)) setStaff(d); }); // only ever sent to dispatchers and administrators
    // A conductor just changed a count: show it at once instead of waiting for the next 2-second round.
    s.on("occupancy", (o) => { if (o && o.busId) setBuses((prev) => (prev ? prev.map((b) => (b.id === o.busId ? { ...b, occupancy: { ...b.occupancy, ...o } } : b)) : prev)); });
    return () => s.disconnect();
  }, [loadRoute]);

  // Registered routes and bus stops (public, active only), and the line of the route the visitor picked.
  const [net, setNet] = useState(null);
  const [netFailed, setNetFailed] = useState(false);
  const [sel, setSel] = useState("all");
  const [selPath, setSelPath] = useState(null);
  const loadNet = useCallback(() => {
    fetch("/api/network/public").then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d) => { setNet(d); setNetFailed(false); }).catch(() => setNetFailed(true));
  }, []);
  useEffect(() => { loadNet(); const t = setInterval(loadNet, 30000); return () => clearInterval(t); }, [loadNet]);

  // ---- Passenger: own location and nearby buses (client-side only; nothing here is sent to the server) ----
  const me = usePassengerLocation(isPassenger);
  const [radius, setRadius] = useState(() => {
    try { const v = Number(localStorage.getItem("rw.nearbyRadius")); return RADIUS_OPTIONS.includes(v) ? v : DEFAULT_RADIUS_M; } catch { return DEFAULT_RADIUS_M; }
  });
  const pickRadius = (v) => { setRadius(v); try { localStorage.setItem("rw.nearbyRadius", String(v)); } catch { /* preference only */ } };
  const [consent, setConsent] = useState(false);       // the explanation shown over the map before the browser asks
  const [meToken, setMeToken] = useState(0);           // each increase recenters the map on the passenger once
  const centerOnFix = useRef(false);
  const [picked, setPicked] = useState({ id: null, token: 0 }); // the bus chosen in the Nearby list (kept across live updates)
  const markers = useRef(new Map());
  // Recalculated only when the bus positions (Socket.IO "buses", every 2 s), the passenger's position or the radius change.
  const near = useMemo(() => (isPassenger && me.pos ? findNearby(buses, me.pos, radius) : null), [isPassenger, buses, me.pos, radius]);
  useEffect(() => { if (me.pos && centerOnFix.current) { centerOnFix.current = false; setMeToken((n) => n + 1); } }, [me.pos]);
  const useMyLocation = () => { setConsent(false); if (me.pos) setMeToken((n) => n + 1); else { centerOnFix.current = true; me.start(); } };
  const locateMe = () => { if (me.pos) setMeToken((n) => n + 1); else if (me.phase !== "asking") setConsent(true); };
  const pickBus = (id) => setPicked((p) => ({ id, token: p.token + 1 }));
  useEffect(() => {
    if (!isConductor) return;
    let live = true;
    const go = () => fetch("/api/conductor/bus", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d) { setMyBusId(d.bus?.busId ?? null); setMyChecked(true); } }).catch(() => { if (live) setMyChecked(true); });
    go(); const t = setInterval(go, 30000);
    return () => { live = false; clearInterval(t); };
  }, [isConductor]);
  useEffect(() => { if (net && sel !== "all" && !net.routes.some((r) => r.routeId === sel)) setSel("all"); }, [net, sel]); // the picked route was deactivated
  useEffect(() => { if (focus?.kind === "route" && net?.routes.some((r) => r.routeId === focus.id)) setSel(focus.id); }, [focus, net]);
  useEffect(() => {
    setSelPath(null);
    if (sel === "all") return;
    let live = true, timer = null;
    const go = () => fetch(`/api/network/routes/${encodeURIComponent(sel)}/path`).then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d) => { if (live) { setSelPath(d); timer = setTimeout(go, d.status === "loading" ? 1500 : 8000); } })
      .catch(() => { if (live) { setSelPath({ status: "error", kind: "road", path: [] }); timer = setTimeout(go, 8000); } });
    go();
    return () => { live = false; clearTimeout(timer); };
  }, [sel]);

  if (failed) return <State title="Route unavailable" text="The route could not be loaded." action={<button className="btn" onClick={() => { setFailed(false); loadRoute(); }}>Try again</button>} />;
  if (!route) return <State title="Loading map" text="Fetching route and stops…" />;
  if (route.status === "loading") return <State title="Calculating the road route" text="Finding the route along actual roads. This usually takes a few seconds." />;
  const roadRoute = route.status === "ready" && Array.isArray(route.path) && route.path.length > 1;
  const list = buses || [];
  const eta = (i) => { const v = list.map((b) => b.etas[i]).filter((x) => x != null); return v.length ? Math.min(...v) : null; };
  const alerts = [
    ...list.filter((b) => b.occupancy?.level === "full").map((b) => ({ id: `f-${b.id}`, text: `${b.name} is full. Next bus may be a better option.` })),
    ...list.filter((b) => b.status === "stale" || b.status === "unavailable").map((b) => ({ id: `l-${b.id}`, text: b.status === "stale" ? `${b.name}: location is out of date (last known position).` : `${b.name}: location is not available.` })),
  ];
  const anySimulated = list.some((b) => b.source === "simulation");
  const anyGps = list.some((b) => b.source === "gps");
  const onMap = list.filter((b) => b.pos);
  const mine = isConductor && myBusId ? list.find((b) => b.id === myBusId) ?? null : null;
  const pickedBus = isPassenger && picked.id ? list.find((b) => b.id === picked.id) ?? null : null;
  const pickedLive = pickedBus && hasLivePosition(pickedBus) ? pickedBus : null; // a stale or missing position is never "focused" as live
  const meProblem = me.problem != null ? locationProblem(me.problem) : null;
  const canRetry = me.problem !== "unsupported" && me.problem !== "insecure";
  const nearSimulated = !!near?.nearby.some((x) => x.bus.source === "simulation");
  // Where an alert asked the map to look. A position is only ever one the server reported; with none we say so instead of guessing.
  const focusBus = focus?.kind === "bus" ? list.find((b) => b.id === focus.id) ?? null : null;
  const focusStop = focus?.kind === "stop" ? (net?.stops.find((x) => x.stopId === focus.id) ?? null) : null;
  const focusPos = focus?.kind === "bus" ? focusBus?.pos ?? null : focus?.kind === "stop" ? (focusStop ? [focusStop.lat, focusStop.lng] : null) : null;
  const focusMissing = focus?.kind === "bus" && !focusPos ? `Location unavailable for ${focusBus?.name ?? focus.id}. ${focusBus ? (focusBus.updatedAt == null ? "No location has been received from this bus yet." : "Its last location is too old to show.") : "This bus is not in service."}` : "";
  const why = !mine ? "" : mine.status === "unavailable" ? (mine.updatedAt == null ? "No location has been received from this bus yet." : `The last location was received ${ago(mine.ageSeconds)}, which is too old to show.`) : "";

  const netRoutes = net?.routes ?? [];
  const selRoute = sel !== "all" ? netRoutes.find((r) => r.routeId === sel) ?? null : null;
  const selOrder = new Map(selRoute ? selRoute.stops.map((x) => [x.stopId, x.order]) : []);
  const trackedIds = new Set(route.stops.map((x) => x.id));
  const netStop = (id) => net?.stops.find((x) => x.stopId === id);
  const routeNamesOf = (ids) => (ids || []).map((id) => netRoutes.find((r) => r.routeId === id)?.name).filter(Boolean).join(", ");
  const numIcon = (n) => L.divIcon({ className: "", html: `<div class="stop-num">${Number(n)}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  const stopPopup = (id, name, extra) => {
    const ns = netStop(id);
    return (
      <Popup>
        <div className="bus-popup">
          <strong>{name}</strong>
          {ns?.address && <div>{ns.address}</div>}
          <div className="muted">{id}{selOrder.has(id) ? ` · stop ${selOrder.get(id)} of ${selRoute.stops.length}` : ""}</div>
          {ns && <div>Routes: {routeNamesOf(ns.routeIds) || "–"}</div>}
          {extra}
        </div>
      </Popup>);
  };
  const selLine = selRoute && !selRoute.tracked && selPath && Array.isArray(selPath.path) && selPath.path.length > 1 ? selPath : null;
  const straightShown = selLine?.kind === "straight";

  return (
    <div className="live">
      <aside className="side" aria-label="Tracking information" tabIndex={0}>
        <div className="side__status"><span className={`dot ${online ? "dot--on" : ""}`} aria-hidden />{online ? "Live updates connected" : "Connection lost. Reconnecting…"}</div>
        {isPassenger && (
          <section aria-labelledby="h-near" className="near">
            <h2 id="h-near"><LocateFixed size={15} aria-hidden /> Nearby buses</h2>
            {me.phase === "asking" ? <p className="muted" role="status">Finding your location… If your browser asks, choose Allow.</p>
              : me.phase !== "on" ? (
                <>
                  {meProblem ? <div className="alert" role="alert"><strong>{meProblem.title}.</strong> {meProblem.text}</div>
                    : me.permission === "denied" ? <div className="alert" role="status"><strong>{locationProblem("denied").title}.</strong> {locationProblem("denied").text}</div>
                    : <p className="near__consent">{LOCATION_CONSENT}</p>}
                  {canRetry && <button className="btn btn--primary btn--sm" onClick={useMyLocation}>{meProblem || me.permission === "denied" ? "Try again" : "Use my location"}</button>}
                </>)
              : (
                <>
                  <div className="near__me">
                    <div><span className="me-key" aria-hidden /> <strong>Your location</strong> <span className="muted">(from your device)</span></div>
                    <div className="muted small small--tight">
                      {me.accuracy != null ? `Accuracy: within about ${formatDistance(me.accuracy)}` : "Your device did not report the accuracy."}
                      {me.at ? ` · updated ${timeFmt(new Date(me.at).toISOString())}` : ""}
                    </div>
                    {me.accuracy != null && me.accuracy > POOR_ACCURACY_M && <p className="alert">Your location is approximate (within about {formatDistance(me.accuracy)}), so distances may be off by about that much.</p>}
                    {meProblem && <p className="alert" role="status">Location updates paused ({meProblem.title.toLowerCase()}). Showing your last known position.</p>}
                    <div className="near__tools">
                      <label htmlFor="near-radius">Within</label>
                      <select id="near-radius" value={radius} onChange={(e) => pickRadius(Number(e.target.value))}>
                        {RADIUS_OPTIONS.map((r) => <option key={r} value={r}>{formatRadius(r)}</option>)}
                      </select>
                      <button className="btn btn--sm" onClick={() => setMeToken((n) => n + 1)}>Center on me</button>
                      <button className="btn btn--sm" onClick={me.stop}>Stop using location</button>
                    </div>
                  </div>
                  {!buses ? <p className="muted">Waiting for live bus data…</p>
                    : near.nearby.length === 0 ? (
                      <div className="near__empty" role="status">
                        <strong>No live buses within {formatRadius(radius)} of you.</strong>{" "}
                        {near.nearest ? `The nearest live bus, ${near.nearest.bus.name}, is about ${formatDistance(near.nearest.distance)} away.` : "No bus is reporting a live position right now."}
                        {near.nearest && radius < RADIUS_OPTIONS.at(-1) ? " Try a larger distance above." : ""}
                      </div>)
                    : (
                      <ul className="near__list" aria-label={`Buses within ${formatRadius(radius)}, nearest first`}>
                        {near.nearby.map(({ bus: b, distance }) => {
                          const sel = picked.id === b.id, o = b.occupancy;
                          return (
                            <li key={b.id}>
                              <button className={`near__item${sel ? " near__item--sel" : ""}`} aria-pressed={sel} onClick={() => pickBus(b.id)}>
                                <span className="near__top"><strong>{b.name}</strong><span className="near__dist">≈ {formatDistance(distance)}</span></span>
                                <span className="muted">{b.id} · {b.route ?? "No route assigned"}</span>
                                <span className="near__badges"><Badge tone={TRACK[b.status]?.tone ?? "off"}>{TRACK[b.status]?.label ?? b.status}</Badge><OccBadge occ={o} /></span>
                                {o?.reported && <span className="near__seats">{o.available} seat{o.available === 1 ? "" : "s"} available</span>}
                                <span className="muted near__src">{sourceLabel(b.source)}</span>
                              </button>
                            </li>);
                        })}
                      </ul>)}
                  {picked.id && !pickedLive && <p className="alert" role="status">{pickedBus ? `${pickedBus.name} is not reporting a live position right now.` : "The bus you selected is no longer in service."}</p>}
                  <p className="muted small small--tight">
                    Distances are approximate straight-line distances from your location, not road distance or travel time.
                    {near?.notLive ? ` ${near.notLive} bus${near.notLive === 1 ? "" : "es"} without a live position (out of date or not reporting) ${near.notLive === 1 ? "is" : "are"} not included.` : ""}
                  </p>
                  {nearSimulated && <p className="muted small small--tight">Your location comes from your device. Bus positions are simulated, not real GPS.</p>}
                </>)}
          </section>)}
        {isConductor && (
          <section aria-labelledby="h-mybus" className="mybus">
            <h2 id="h-mybus"><Bus size={15} aria-hidden /> My bus</h2>
            {!myChecked || (myBusId && !buses) ? <p className="muted">Loading…</p>
              : !myBusId ? <p className="muted">You are not assigned to a bus, so no bus is highlighted on the map.</p>
              : !mine ? <p className="muted">Your assigned bus is not in service right now.</p>
              : (
                <>
                  <div><strong>{mine.name}</strong> <span className="tag-mine">MY BUS</span></div>
                  <div className="muted">{mine.route ?? "No route assigned"}</div>
                  <div className="mybus__row"><Badge tone={TRACK[mine.status]?.tone ?? "off"}>{TRACK[mine.status]?.label ?? mine.status}</Badge> <OccBadge occ={mine.occupancy} /></div>
                  <div className="muted small small--tight">{mine.source === "gps" ? "GPS device" : mine.source === "simulation" ? "Simulated GPS (not real)" : "No tracking device"}</div>
                  {mine.pos ? <button className="btn btn--sm" onClick={() => setLocalFocus((n) => n + 1)}>Focus on my bus</button>
                    : <p className="alert" role="status">Location unavailable. {why}</p>}
                </>)}
          </section>)}
        <section aria-labelledby="h-svc">
          <h2 id="h-svc"><Megaphone size={15} aria-hidden /> Service alerts</h2>
          {!svcAlerts ? <p className="muted">Loading…</p>
            : svcAlerts.length === 0 ? <p className="muted">No active service alerts.</p>
            : svcAlerts.map((a) => <AlertCard key={a.id} alert={a} compact onFocus={focusOn} />)}
          {focusMissing && <p className="alert" role="status">{focusMissing}</p>}
        </section>
        <section aria-labelledby="h-alerts">
          <h2 id="h-alerts"><Bell size={15} aria-hidden /> Live conditions</h2>
          {alerts.length ? alerts.map((a) => (<p className="alert" key={a.id}>{a.text}</p>)) : <p className="muted">No active alerts.</p>}
        </section>
        <section aria-labelledby="h-buses">
          <h2 id="h-buses"><Bus size={15} aria-hidden /> Buses</h2>
          {!buses ? <p className="muted">Waiting for live data…</p>
            : list.length === 0 ? <p className="muted">No tracked buses are set up yet.</p>
            : list.map((b) => (
              <div className="item" key={b.id}>
                <div><strong>{b.name}</strong><div className="muted">{b.route ?? "No route assigned"} · {direction(b)}</div><div className="muted small small--tight">{b.ageSeconds == null ? "No location received yet" : `Updated ${ago(b.ageSeconds)}`}</div></div>
                <div className="item__end"><Badge tone={TRACK[b.status]?.tone ?? "off"}>{TRACK[b.status]?.label ?? b.status}</Badge><OccBadge occ={b.occupancy} /></div>
              </div>))}
          {buses && list.length > 0 && onMap.length === 0 && <p className="muted">No buses are reporting right now.</p>}
        </section>
        <section aria-labelledby="h-routes-map">
          <h2 id="h-routes-map"><RouteIcon size={15} aria-hidden /> Routes and stops</h2>
          {!net ? (netFailed ? <p className="muted">Route and stop details could not be loaded. <button className="btn btn--sm" onClick={loadNet}>Try again</button></p> : <p className="muted">Loading routes…</p>)
            : netRoutes.length === 0 ? <p className="muted">No routes are published yet.</p> : (
              <>
                <label className="sr-only" htmlFor="route-pick">Show route</label>
                <select id="route-pick" className="route-pick" value={sel} onChange={(e) => setSel(e.target.value)}>
                  <option value="all">All stops</option>
                  {netRoutes.map((r) => <option key={r.routeId} value={r.routeId}>{r.name}</option>)}
                </select>
                {selRoute && (
                  <div className="route-info">
                    <div><strong>{selRoute.startPoint} → {selRoute.destination}</strong></div>
                    {selRoute.description && <div className="muted">{selRoute.description}</div>}
                    {selRoute.stops.length === 0 ? <p className="muted">This route has no stops yet.</p> : (
                      <ol className="ordered ordered--compact">{selRoute.stops.map((x) => <li key={x.stopId}><span className="ordered__n" aria-hidden>{x.order}</span><span className="ordered__name">{x.name}</span></li>)}</ol>)}
                    <div className="muted">{selRoute.buses.length ? `Buses: ${selRoute.buses.map((b) => b.name).join(", ")}` : "No bus is assigned to this route."}</div>
                    <div className="muted small small--tight">
                      {selRoute.tracked ? (roadRoute ? "Route line follows roads (OSRM)." : "Road route not available right now.")
                        : !selPath ? "Loading the route line…"
                        : selPath.kind === "road" && selLine ? "Route line follows roads (OSRM)."
                        : selPath.kind === "straight" && selLine ? "Straight stop-to-stop link. This is NOT a road route and may not follow actual roads."
                        : "No route line is available for this route."}
                    </div>
                  </div>)}
              </>)}
        </section>
        <section aria-labelledby="h-eta">
          <h2 id="h-eta"><Clock size={15} aria-hidden /> Next arrival by stop</h2>
          {route.stops.map((s, i) => (<div className="row" key={s.name}><span><MapPin size={14} aria-hidden /> {s.name}</span><strong>{fmt(eta(i))}</strong></div>))}
          <p className="muted small">Estimates from recent bus movement, not confirmed arrival times.{anySimulated && " Bus movement is simulated, not real GPS."}</p>
        </section>
        {canFleet && staff && (
          <section aria-labelledby="h-devices">
            <h2 id="h-devices"><Radio size={15} aria-hidden /> Tracking devices</h2>
            {staff.length === 0 ? <p className="muted">No buses are registered.</p> : staff.map((d) => (
              <div className="item" key={d.busId}>
                <div><strong>{d.deviceId ?? "No device"}</strong><div className="muted">{d.busId} · {d.source === "gps" ? "GPS" : d.source === "simulation" ? "Simulated" : "No tracking device"}</div>
                  {d.deviceId && <div className="muted small small--tight">{d.accepted} accepted · {d.rejected} rejected{d.lastRejection ? ` (last: ${d.lastRejection.reason.replaceAll("_", " ")})` : ""}</div>}</div>
                <div className="item__end">{d.operation !== "active" ? <Badge tone="off">{BUS_STATUS[d.operation]?.label ?? d.operation}</Badge> : <Badge tone={TRACK[d.status]?.tone ?? "off"}>{TRACK[d.status]?.label ?? d.status}</Badge>}</div>
              </div>))}
          </section>
        )}
      </aside>
      <div className="map-wrap">
        <MapContainer center={[8.53, 124.7]} zoom={11} className="map" scrollWheelZoom>
          <TileLayer attribution="© OpenStreetMap contributors · Routing: OSRM" url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
          {roadRoute && <Polyline positions={route.path} pathOptions={{ color: "#0b5cab", weight: 4, opacity: 0.85 }} />}
          {selLine && <Polyline positions={selLine.path} pathOptions={straightShown ? { color: "#b45309", weight: 3, opacity: 0.9, dashArray: "8 8" } : { color: "#b45309", weight: 5, opacity: 0.85 }} />}
          {selRoute && selRoute.stops.length > 0 && <Fit key={selRoute.routeId} points={selRoute.stops.map((x) => [x.lat, x.lng])} />}
          {mine && <FlyTo pos={mine.pos} token={Math.max(myBusFocus, 0) + localFocus} />}
          {focus && <FlyTo pos={focusPos} token={focus.token} />}
          {isPassenger && <FlyTo pos={me.pos} token={meToken} />}
          {isPassenger && picked.id && <FocusBus id={picked.id} pos={pickedLive?.pos ?? null} token={picked.token} markers={markers} />}
          {isPassenger && me.pos && (
            <>
              {me.accuracy != null && <Circle center={me.pos} radius={me.accuracy} interactive={false} pathOptions={{ color: "#1a73e8", weight: 1, opacity: 0.5, fillColor: "#1a73e8", fillOpacity: 0.1 }} />}
              <Marker position={me.pos} icon={meIcon} zIndexOffset={1200} keyboard={false} title="Your location">
                <Tooltip permanent direction="top" offset={[0, -10]} className="me-label">Your location</Tooltip>
              </Marker>
            </>)}
          {route.stops.map((s, i) => selOrder.has(s.id)
            ? (<Marker key={s.id ?? s.name} position={s.p} icon={numIcon(selOrder.get(s.id))} title={s.name}><Tooltip>{s.name}</Tooltip>{stopPopup(s.id, s.name, <div>Next arrival: {fmt(eta(i))}</div>)}</Marker>)
            : (<CircleMarker key={s.id ?? s.name} center={s.p} radius={7} pathOptions={{ color: "#0b5cab", weight: 2, fillColor: "#fff", fillOpacity: 1 }}><Tooltip>{s.name}</Tooltip>{stopPopup(s.id, s.name, <div>Next arrival: {fmt(eta(i))}</div>)}</CircleMarker>))}
          {(net?.stops ?? []).filter((x) => !trackedIds.has(x.stopId)).map((x) => selOrder.has(x.stopId)
            ? (<Marker key={x.stopId} position={[x.lat, x.lng]} icon={numIcon(selOrder.get(x.stopId))} title={x.name}><Tooltip>{x.name}</Tooltip>{stopPopup(x.stopId, x.name)}</Marker>)
            : (<CircleMarker key={x.stopId} center={[x.lat, x.lng]} radius={6} pathOptions={{ color: "#475569", weight: 2, fillColor: "#fff", fillOpacity: 1 }}><Tooltip>{x.name}</Tooltip>{stopPopup(x.stopId, x.name)}</CircleMarker>))}
          {onMap.map((b) => {
            const next = nextStopOf(b, route.stops);
            const isMine = isConductor && b.id === myBusId;
            const isSel = isPassenger && b.id === picked.id;
            const o = b.occupancy;
            return (
              <Marker key={b.id} position={b.pos} zIndexOffset={isMine ? 1000 : isSel ? 900 : 0} icon={busIcon(b.id, b.status, isMine, isSel)} title={`${isMine ? "My bus: " : ""}${b.name}, ${TRACK[b.status]?.label ?? b.status}`}
                ref={(m) => { if (m) markers.current.set(b.id, m); else markers.current.delete(b.id); }}>
                <Popup>
                  <div className="bus-popup">
                    <strong>{b.name}</strong>{isMine && <> <span className="tag-mine">MY BUS</span></>}
                    {isMine && (
                      <div className="mybus__pop">
                        <div>Route: {b.route ?? "No route assigned"}</div>
                        <div>Passengers: {o?.reported ? `${o.count} / ${o.capacity}` : "Not reported"}</div>
                        {o?.reported && <div>Available seats: {o.available}</div>}
                        {o?.reported && <div>Occupancy: {o.percent}%</div>}
                        <div>Tracking: {TRACK[b.status]?.label ?? b.status} · {b.source === "gps" ? "GPS device" : "Simulated GPS (not real)"}</div>
                      </div>)}
                    <div className="muted">{b.id} · {b.route ?? "No route assigned"}</div>
                    {isPassenger && (
                      <div className="mybus__pop">
                        {me.pos && hasLivePosition(b) && <div>About {formatDistance(haversineMeters(me.pos, b.pos))} from you (straight line)</div>}
                        <div>Passengers: {o?.reported ? `${o.count} / ${o.capacity}` : "Not reported"}</div>
                        {o?.reported && <div>Available seats: {o.available}</div>}
                      </div>)}
                    <div><Badge tone={TRACK[b.status]?.tone ?? "off"}>{TRACK[b.status]?.label ?? b.status}</Badge> <OccBadge occ={b.occupancy} /></div>
                    <div>{direction(b)}</div>
                    <div>{next ? `Next stop: ${next.name} in about ${fmt(next.eta)}` : "No arrival estimate"}</div>
                    <div className="muted">Updated {b.updatedAt ? timeFmt(b.updatedAt) : "–"} ({ago(b.ageSeconds)})</div>
                    <div className="muted">{b.source === "gps" ? "Source: GPS device" : "Source: simulated, not real GPS"}</div>
                    {b.status === "stale" && <div className="muted">Showing the last known position.</div>}
                  </div>
                </Popup>
              </Marker>);
          })}
        </MapContainer>
        {(!online || !roadRoute || straightShown) && (
          <div className="map-notes">
            {straightShown && <div className="conn conn--route" role="status">Showing a straight stop-to-stop link for {selRoute.name}. It is not a road route and may cross areas without roads.</div>}
            {!online && <div className="conn" role="status">Connection lost. Positions may be out of date. Reconnecting…</div>}
            {!roadRoute && (
              <div className="conn conn--route" role="status">
                The road route could not be loaded, so the route line is hidden (stops are still shown). Retrying automatically.{" "}
                <button className="btn btn--sm" onClick={loadRoute}>Try again</button>
              </div>)}
          </div>)}
        {isPassenger && (
          <button className="map-locate" onClick={locateMe} title="My location" aria-label={me.pos ? "Center the map on my location" : "My location: find buses near me"}>
            <LocateFixed size={18} aria-hidden />
          </button>)}
        {isPassenger && consent && me.phase !== "on" && me.phase !== "asking" && (
          <div className="map-consent" role="dialog" aria-labelledby="consent-h">
            <h3 id="consent-h">Use your location?</h3>
            {meProblem ? <p><strong>{meProblem.title}.</strong> {meProblem.text}</p>
              : me.permission === "denied" ? <p><strong>{locationProblem("denied").title}.</strong> {locationProblem("denied").text}</p>
              : <p>{LOCATION_CONSENT}</p>}
            <div className="map-consent__actions">
              {canRetry && <button className="btn btn--primary btn--sm" onClick={useMyLocation}>{meProblem || me.permission === "denied" ? "Try again" : "Allow location"}</button>}
              <button className="btn btn--sm" onClick={() => setConsent(false)}>{canRetry ? "Not now" : "Close"}</button>
            </div>
          </div>)}
        {buses && (anySimulated || anyGps) && <div className="map-badge"><Badge tone={anySimulated ? "warn" : "ok"}>{anySimulated ? "Simulated bus positions – not real GPS" : "Live GPS positions"}</Badge></div>}
        <div className="legend" aria-label="Map legend">
          <span><i className="lg lg--line" />Route</span>{selLine && <span><i className={`lg ${straightShown ? "lg--dash" : "lg--sel"}`} />{straightShown ? "Stop-to-stop link (not a road)" : "Selected route"}</span>}<span><i className="lg lg--stop" />Stop</span><span><i className="lg lg--bus" />Bus</span><span><i className="lg lg--old" />Delayed</span><span><i className="lg lg--stale" />Last known</span>{isPassenger && me.pos && <span><i className="lg lg--me" />You</span>}
        </div>
      </div>
    </div>
  );
}

// A value of null means "not available yet", which is shown differently from a real 0.
function Stat({ label, value, note }) {
  const unavailable = value == null;
  return (
    <div>
      <dt>{label}</dt>
      <dd className={unavailable ? "stat--na" : undefined}>
        {unavailable ? <><span aria-hidden>–</span><span className="sr-only">Not available</span></> : value}
      </dd>
      {note && <dd className="stat__note">{note}</dd>}
    </div>
  );
}

function Panel({ id, title, aside, wide, children }) {
  return (
    <section className={`panel${wide ? " panel--wide" : ""}`} aria-labelledby={id}>
      <div className="panel__head"><h2 id={id}>{title}</h2>{aside}</div>
      {children}
    </section>
  );
}

// Shows only the sections the server sent. The server decides what each role receives
// (see /api/dashboard), so this component never needs to know the role names.
function Dashboard({ member, onUnauthorized, onNavigate, onViewer, onFocus, canManageAlerts = false, alertsTick = 0 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard", { credentials: "same-origin" });
      const d = await r.json().catch(() => null);
      const valid = d && d.route && Array.isArray(d.route.stops) && Array.isArray(d.alerts) && d.tracking;
      if (!r.ok || !valid) return setError((d && d.error) || "The dashboard data could not be read.");
      if (member && !d.viewer) return onUnauthorized(); // our session ended; the server now treats us as a visitor
      if (d.viewer && onViewer) onViewer(d.viewer); // role changed by an administrator? let the menu follow
      setData(d); setError("");
    } catch { setError("Cannot reach the server."); }
  }, [member, onUnauthorized, onViewer]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (alertsTick) load(); }, [alertsTick, load]); // an alert was published or resolved: show it now

  if (!data) return error
    ? <State title="Unable to load dashboard" text={error} action={<button className="btn" onClick={load}>Try again</button>} />
    : (
      <div className="dash" role="status" aria-busy="true" aria-label="Loading dashboard">
        <div className="skel skel--title" /><div className="skel skel--stats" />
        <div className="dash-grid"><div className="skel skel--panel" /><div className="skel skel--panel" /></div>
        <span className="sr-only">Loading dashboard. Fetching the latest information.</span>
      </div>);

  const { route, alerts, tracking, fleet, users, activity } = data;
  const simulated = tracking.source === "simulation";
  const heading = users ? "System overview" : fleet ? "Operations overview" : "Passenger information";
  const sub = users ? "Accounts, fleet status and recent security activity."
    : fleet ? "Bus status and service conditions on your routes." : `Live bus information for ${route.name}.`;
  const stats = users && fleet ? [
    <Stat key="rb" label="Registered buses" value={fleet.registeredBuses} note={`${fleet.operation.active} in service`} />,
    <Stat key="ab" label="Reporting now" value={tracking.activeBuses} note={simulated ? "Simulated" : undefined} />,
    <Stat key="rt" label="Routes" value={fleet.routes.length} note={`${fleet.stops} stops`} />,
    <Stat key="us" label="Registered users" value={users.total} note={`${users.active} active`} />,
  ] : fleet ? [
    <Stat key="ab" label="Active buses" value={tracking.activeBuses} note={simulated ? "Simulated" : undefined} />,
    <Stat key="rt" label="Routes covered" value={fleet.routes.length} />,
    <Stat key="al" label="Open alerts" value={alerts.length} />,
  ] : [
    <Stat key="ab" label="Buses in service" value={tracking.activeBuses} note={simulated ? "Simulated" : undefined} />,
    <Stat key="st" label="Stops on route" value={route.stops.length} />,
    <Stat key="km" label="Route length" value={route.lengthKm == null ? null : `${route.lengthKm} km`} />,
  ];

  return (
    <div className="dash">
      <div className="dash-head">
        <div><h2>{heading}</h2><p className="muted">{sub}</p></div>
        <div className="dash-head__meta">
          {simulated && <Badge tone="warn">Simulated tracking data</Badge>}
          <span className="muted">Updated {timeFmt(data.generatedAt)}</span>
        </div>
      </div>
      {error && <p className="alert" role="alert">{error} Showing the last update.</p>}
      <dl className="stats">{stats}</dl>

      <div className="dash-grid">
        {!fleet && (
          <Panel id="h-track" title="Track buses">
            <p className="muted">See where the buses are on the route right now.</p>
            <button className="btn btn--primary" onClick={() => onNavigate("map")}><MapIcon size={16} aria-hidden /> Open live map</button>
          </Panel>
        )}
        <OccupancyPanel initial={data.occupancy} />
        <Panel id="h-svc" title="Service alerts" aside={canManageAlerts ? <button className="btn btn--sm" onClick={() => onNavigate("alerts")}>{users ? "Manage alerts" : "Create or manage alerts"}</button> : null}>
          {!data.serviceAlerts || data.serviceAlerts.length === 0 ? <p className="muted">No active service alerts.</p>
            : data.serviceAlerts.slice(0, 3).map((a) => <AlertCard key={a.id} alert={a} compact onFocus={onFocus} />)}
          {data.serviceAlerts && data.serviceAlerts.length > 3 && <p className="panel__note">{data.serviceAlerts.length - 3} more on the Live map.</p>}
        </Panel>
        <Panel id="h-alerts" title="Live conditions">
          {alerts.length ? alerts.map((a) => <p className="alert" key={a.id}>{a.text}</p>) : <p className="muted">No automatic warnings (full buses, lost signal).</p>}
        </Panel>
        {fleet && (
          <Panel id="h-fleet" title="Bus status" wide aside={<>{simulated && <Badge tone="warn">Simulated</Badge>} {onNavigate && <button className="btn btn--sm" onClick={() => onNavigate("buses")}>Manage buses</button>}</>}>
            {fleet.buses.length === 0 ? <p className="muted">No buses are registered yet.</p> : (
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Bus status table">
                <table>
                  <thead><tr><th scope="col">Bus</th><th scope="col">Route</th><th scope="col">Operation</th><th scope="col">Direction</th><th scope="col">Next stop</th><th scope="col">Tracking</th><th scope="col">Passengers</th></tr></thead>
                  <tbody>{fleet.buses.map((b) => (
                    <tr key={b.id}><td>{b.name}</td><td>{b.routeName ?? <span className="muted">No route</span>}</td><td><Badge tone={BUS_STATUS[b.operation]?.tone ?? "off"}>{BUS_STATUS[b.operation]?.label ?? b.operation}</Badge></td><td>{b.operation === "active" ? b.direction : "–"}</td><td>{b.nextStop ? `${b.nextStop.name} · ${fmt(b.nextStop.etaSeconds)}` : "–"}</td><td>{b.operation === "active" ? <Badge tone={TRACK[b.tracking]?.tone ?? "off"}>{b.status}</Badge> : <Badge tone="off">Not tracked</Badge>}</td><td><OccBadge occ={b.occupancy} />{b.conductor && <div className="muted small small--tight">Conductor: {b.conductor}</div>}</td></tr>))}
                  </tbody>
                </table>
              </div>)}
            {typeof tracking.unauthorizedAttempts === "number" && <p className="panel__note">Rejected device logins since the server started: {tracking.unauthorizedAttempts}.</p>}
            
          </Panel>
        )}
        <Panel id="h-route" title="Next arrivals" aside={simulated && <Badge tone="warn">Simulated</Badge>}>
          <p className="panel__sub">{route.name}{route.lengthKm != null && ` · ${route.lengthKm} km`}</p>
          {route.stops.map((s) => (
            <div className="row" key={s.name}><span><MapPin size={14} aria-hidden /> {s.name}</span><strong>{fmt(s.etaSeconds)}</strong></div>))}
          <p className="panel__note">Next arrival at each stop. A dash means no bus is currently approaching it.</p>
        </Panel>
        {users && (
          <Panel id="h-accounts" title="Accounts" aside={<button className="btn btn--sm" onClick={() => onNavigate("users")}>Manage users</button>}>
            {ROLES.map((r) => (
              <div className="row" key={r}><span>{ROLE_LABEL[r]}s</span><strong>{users.byRole[r] ?? 0}</strong></div>))}
            <div className="row"><span>Inactive accounts</span><strong>{users.total - users.active}</strong></div>
          </Panel>
        )}
        {activity && (
          <Panel id="h-activity" title="Recent activity" aside={<button className="btn btn--sm" onClick={() => onNavigate("audit")}>View audit log</button>}>
            {activity.length === 0 ? <p className="muted">No activity recorded yet.</p> : (
              <ul className="feed">{activity.map((e, i) => (
                <li key={`${e.ts}-${i}`}>
                  <span>
                    <strong>{e.action.replaceAll("_", " ")}</strong>{" "}
                    <span className="muted">{e.actor && e.target ? `${e.actor} → ${e.target}` : e.actor ?? e.target ?? ""}</span>{" "}
                    {e.outcome !== "success" && <Badge tone={e.outcome === "denied" ? "bad" : "warn"}>{e.outcome}</Badge>}
                  </span>
                  <time dateTime={e.ts}>{timeFmt(e.ts)}</time>
                </li>))}
              </ul>)}
          </Panel>
        )}
      </div>
    </div>
  );
}

// ---- Passenger occupancy ----
// Passengers and visitors only READ it. The numbers come from the server (kept by each bus's conductor); this panel never
// calculates or guesses a count. A bus nobody is counting shows "Not reported". Changes arrive over Socket.IO ("occupancy").
function OccupancyPanel({ initial }) {
  const [rows, setRows] = useState(initial ?? []);
  useEffect(() => { if (Array.isArray(initial)) setRows(initial); }, [initial]);
  useEffect(() => {
    const s = joinSocket();
    s.on("occupancy", (o) => { if (o && o.busId) setRows((prev) => prev.map((r) => (r.busId === o.busId ? { ...r, ...o } : r))); });
    return () => s.disconnect();
  }, []);
  return (
    <Panel id="h-occ" title="Passenger occupancy">
      {rows.length === 0 ? <p className="muted">No buses are in service.</p> : rows.map((r) => (
        <div className="occ" key={r.busId}>
          <div className="occ__head"><strong>{r.name}</strong><OccBadge occ={r} /></div>
          <div className="muted small small--tight">{r.routeName ?? "No route assigned"}</div>
          {r.reported ? (
            <>
              <progress className={`meter meter--${r.level}`} value={r.count} max={r.capacity} aria-label={`${r.name}: ${r.count} of ${r.capacity} seats taken`} />
              <div className="occ__nums"><span>{r.count} of {r.capacity} passengers</span><strong>{r.available} {r.available === 1 ? "seat" : "seats"} available</strong></div>
              <div className="muted small small--tight">Updated {r.updatedAt ? timeFmt(r.updatedAt) : "–"}</div>
            </>
          ) : <p className="muted small small--tight">Not reported. No conductor is counting passengers on this bus right now.</p>}
        </div>))}
      <p className="panel__note">Counts are entered by each bus's conductor and may differ slightly from the real number on board.</p>
    </Panel>
  );
}

// ---- Conductor: passenger counter ----
// Mobile-first. The conductor taps + when a passenger boards and - when one gets off. The screen never sends a number:
// it tells the server what happened, and shows whatever count the server answers with. Taps are sent one after another,
// so a quick series is never lost or applied out of order. Which bus the conductor may count is decided by the server.
function CounterPage({ onUnauthorized }) {
  const [state, setState] = useState(null);   // { bus, occupancy } from the server, or { bus: null }
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [pending, setPending] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const chain = useRef(Promise.resolve());
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/conductor/bus", { credentials: "same-origin" });
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => null);
      if (!r.ok || !d) return setError((d && d.error) || "The counter could not be loaded.");
      setState(d); setError("");
    } catch { setError("Cannot reach the server."); }
  }, [onUnauthorized]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]); // follows an administrator's change of bus or capacity

  const busId = state?.bus?.busId;
  const act = (action) => {
    setMsg(""); setPending((n) => n + 1);
    chain.current = chain.current.then(async () => {
      try {
        const r = await post(`/api/buses/${encodeURIComponent(busId)}/occupancy`, { action });
        if (r.status === 401) return onUnauthorized();
        const d = await r.json().catch(() => ({}));
        if (r.ok) setState((s) => ({ ...s, occupancy: d.occupancy }));
        else { setMsg(d.error || "The count could not be changed."); load(); }
      } catch { setMsg("Cannot reach the server. The count was not changed."); }
      finally { setPending((n) => n - 1); }
    });
  };

  if (error && !state) return <State title="Unable to load the counter" text={error} action={<button className="btn" onClick={load}>Try again</button>} />;
  if (!state) return <State title="Loading" text="Fetching your bus…" />;
  if (!state.bus) return <State title="No bus assigned" text="You are not assigned to a bus yet. Ask an administrator to assign you one." action={<button className="btn" onClick={load}>Check again</button>} />;
  const { bus, occupancy: o } = state;
  const cap = o.capacity;
  const started = o.reported;
  const count = started ? o.count : 0;
  return (
    <div className="dash counter">
      {error && <p className="alert" role="alert">{error} Showing the last known count.</p>}
      <section className="panel counter__card" aria-labelledby="h-counter">
        <div className="panel__head"><h2 id="h-counter">{bus.name}</h2><span className="muted">{bus.busId}</span></div>
        <div className="muted">{bus.routeName ?? "No route assigned"}</div>
        {cap == null ? (
          <p className="form-error" role="alert">This bus has no capacity set, so passengers cannot be counted. Ask an administrator to set it.</p>
        ) : (
          <>
            <div className="counter__num" role="status" aria-live="polite" aria-atomic="true">
              <span className="counter__big">{count}</span>
              <span className="counter__of">of {cap} passengers</span>
              <span className="sr-only">{started ? `${count} passengers on board, ${o.available} seats available, ${o.label}` : "Counting has not started"}</span>
            </div>
            <progress className={`meter meter--${o.level}`} value={count} max={cap} aria-label={`${count} of ${cap} seats taken`} />
            <div className="counter__facts">
              <div><span className="muted">Available seats</span><strong>{started ? o.available : cap}</strong></div>
              <div><span className="muted">Occupancy</span><strong>{started ? `${o.percent}%` : "0%"}</strong></div>
              <div><span className="muted">Status</span>{started ? <Badge tone={o.tone}>{o.label}</Badge> : <Badge tone="off">Not started</Badge>}</div>
            </div>
            <div className="counter__buttons">
              <button className="counter__btn counter__btn--minus" onClick={() => act("alight")} disabled={!started || count <= 0} aria-label="Passenger got off: subtract one"><Minus size={40} aria-hidden /><span>Got off</span></button>
              <button className="counter__btn counter__btn--plus" onClick={() => act("board")} disabled={count >= cap} aria-label="Passenger boarded: add one"><Plus size={40} aria-hidden /><span>Boarded</span></button>
            </div>
            <p className="muted small" aria-live="polite">{pending > 0 ? "Saving…" : started && o.updatedAt ? `Last updated ${timeFmt(o.updatedAt)}` : "Tap Boarded for the first passenger, or start the trip at 0."}</p>
            {msg && <p className="form-error" role="alert">{msg}</p>}
            <div className="counter__more">
              <button className="btn" onClick={() => setConfirm(true)} disabled={pending > 0}>{started ? "Start new trip (reset to 0)" : "Start trip at 0"}</button>
            </div>
          </>)}
      </section>
      {confirm && (
        <Confirm title="Reset the passenger count?" label="Reset to 0" danger={false} busy={false} onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); act("reset"); }}>
          <p>Use this at the start of a trip, when the bus is empty. The count for {bus.name} will be set to 0 and the change is recorded in the audit log.</p>
        </Confirm>)}
    </div>
  );
}

// ---- Service alerts and notifications (Phase 7) ----
// An alert is written by an administrator or dispatcher; the SERVER decides who is notified and who may read it. These screens
// only show what the server returns for the signed-in user (or visitor) and send the user's actions back.

/** Buttons that jump to the bus, route or stop an alert is about (the map does the rest). */
function AlertLinks({ alert, onFocus }) {
  if (!onFocus || !(alert.busId || alert.routeId || alert.stopId)) return null;
  return (
    <div className="alertcard__links">
      {alert.busId && <button className="btn btn--sm" onClick={() => onFocus("bus", alert.busId)} aria-label={`Show bus ${alert.busName ?? alert.busId} on the map`}><Bus size={14} aria-hidden /> {alert.busName ?? alert.busId}</button>}
      {alert.routeId && <button className="btn btn--sm" onClick={() => onFocus("route", alert.routeId)} aria-label={`Show route ${alert.routeName ?? alert.routeId} on the map`}><RouteIcon size={14} aria-hidden /> {alert.routeName ?? alert.routeId}</button>}
      {alert.stopId && <button className="btn btn--sm" onClick={() => onFocus("stop", alert.stopId)} aria-label={`Show stop ${alert.stopName ?? alert.stopId} on the map`}><MapPin size={14} aria-hidden /> {alert.stopName ?? alert.stopId}</button>}
    </div>);
}

function AlertCard({ alert, onFocus, compact = false }) {
  return (
    <article className={`alertcard alertcard--${alert.severity}`}>
      <div className="alertcard__head">
        <Badge tone={SEV[alert.severity]?.tone ?? "off"}>{SEV[alert.severity]?.label ?? alert.severity}</Badge>
        <span className="muted small">{alert.categoryLabel}</span>
        {alert.audience === "staff" && <Badge tone="off">Staff only</Badge>}
        {alert.state !== "active" && <Badge tone={ASTATE[alert.state]?.tone ?? "off"}>{ASTATE[alert.state]?.label ?? alert.state}</Badge>}
      </div>
      <h3 className="alertcard__title">{alert.title}</h3>
      <p className="alertcard__text">{compact ? brief(alert.description) : alert.description}</p>
      <div className="muted small small--tight">{alert.publishedAt ? `Published ${dateTime(alert.publishedAt)}` : ""}{alert.expiresAt ? ` · Until ${dateTime(alert.expiresAt)}` : ""}</div>
      <AlertLinks alert={alert} onFocus={onFocus} />
    </article>);
}

/** Active service alerts for the signed-in user or visitor. Reloads when the server says alerts changed (tick) and once a minute (expiry). */
function useActiveAlerts(tick) {
  const [alerts, setAlerts] = useState(null);
  useEffect(() => {
    let live = true;
    const go = () => fetch("/api/alerts/active", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (live && d && Array.isArray(d.alerts)) setAlerts(d.alerts); }).catch(() => {});
    go(); const t = setInterval(go, 60000);
    return () => { live = false; clearInterval(t); };
  }, [tick]);
  return alerts;
}

// ---- Notification center ----
// The list, the unread count and the read marks all live on the server (PostgreSQL); this page asks for the user's own and shows them.
function NotificationsPage({ notif, onRead, onReadAll, onFocus, onManage, reload }) {
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(() => new Set());
  const items = notif.items;
  if (!items) return notif.error ? <State title="Unable to load notifications" text={notif.error} action={<button className="btn" onClick={reload}>Try again</button>} /> : <State title="Loading" text="Fetching your notifications…" />;
  const shown = items.filter((n) => filter === "all" || !n.read);
  const toggle = (n) => {
    setOpen((p) => { const q = new Set(p); q.has(n.id) ? q.delete(n.id) : q.add(n.id); return q; });
    if (!n.read) onRead(n.id); // opening the details counts as reading it
  };
  return (
    <div className="dash">
      <section className="panel" aria-labelledby="h-notif">
        <div className="panel__head">
          <h2 id="h-notif">Your notifications</h2>
          <span className="muted" role="status">{notif.unread === 0 ? "All read" : `${notif.unread} unread`}</span>
        </div>
        <div className="toolbar">
          <label className="sr-only" htmlFor="notif-filter">Show</label>
          <select id="notif-filter" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All notifications</option><option value="unread">Unread only</option></select>
          <button className="btn" onClick={onReadAll} disabled={notif.unread === 0}><CheckCheck size={16} aria-hidden /> Mark all as read</button>
        </div>
        {notif.error && <p className="alert" role="alert">{notif.error} Showing the last update.</p>}
        {items.length === 0 ? <div className="state"><h2>No notifications yet</h2><p>Service alerts that concern you will appear here.</p></div>
          : shown.length === 0 ? <div className="state"><h2>Nothing unread</h2><p>You have read everything. Choose "All notifications" to see earlier ones.</p></div>
          : (
            <ul className="notiflist">
              {shown.map((n) => {
                const a = n.alert, isOpen = open.has(n.id);
                return (
                  <li key={n.id} className={`notif notif--${a.severity}${n.read ? "" : " notif--unread"}`}>
                    <div className="notif__head">
                      <span className={`notif__dot${n.read ? "" : " notif__dot--on"}`} aria-hidden />
                      <Badge tone={SEV[a.severity]?.tone ?? "off"}>{SEV[a.severity]?.label ?? a.severity}</Badge>
                      <span className="muted small">{a.categoryLabel}</span>
                      {a.state !== "active" && <Badge tone={ASTATE[a.state]?.tone ?? "off"}>{ASTATE[a.state]?.label ?? a.state}</Badge>}
                      <span className="notif__status">{n.read ? "Read" : "Unread"}</span>
                      <time className="muted small notif__time" dateTime={n.receivedAt}>{dateTime(n.receivedAt)}</time>
                    </div>
                    <h3 className="notif__title">{a.title}</h3>
                    <p className="notif__text">{isOpen ? a.description : brief(a.description)}</p>
                    {isOpen && (
                      <dl className="facts notif__more">
                        <div><dt>Status</dt><dd>{ASTATE[a.state]?.label ?? a.state}</dd></div>
                        {a.publishedAt && <div><dt>Published</dt><dd>{dateTime(a.publishedAt)}</dd></div>}
                        {a.expiresAt && <div><dt>{a.state === "expired" ? "Expired" : "Valid until"}</dt><dd>{dateTime(a.expiresAt)}</dd></div>}
                        {a.createdBy && <div><dt>Published by</dt><dd>{a.publishedBy ?? a.createdBy}</dd></div>}
                      </dl>)}
                    <div className="notif__actions">
                      <button className="btn btn--sm" aria-expanded={isOpen} onClick={() => toggle(n)}>{isOpen ? "Hide details" : "View details"}</button>
                      {!n.read && <button className="btn btn--sm" onClick={() => onRead(n.id)}>Mark as read</button>}
                      <AlertLinks alert={a} onFocus={(k, id) => { if (!n.read) onRead(n.id); onFocus(k, id); }} />
                      {onManage && <button className="btn btn--sm" onClick={onManage}>Open in Service alerts</button>}
                    </div>
                  </li>);
              })}
            </ul>)}
      </section>
    </div>);
}

// ---- Service alert management (administrators and dispatchers) ----
const EMPTY_ALERT = { title: "", description: "", category: "general", severity: "info", audience: "public", busId: "", routeId: "", stopId: "", expiresAt: "" };
const NEEDS_LINK = { bus_delay: ["busId", "Choose the bus this delay is about."], route_disruption: ["routeId", "Choose the route."], route_change: ["routeId", "Choose the route."], stop_closure: ["stopId", "Choose the bus stop."] };
const toLocalInput = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");

function AlertForm({ alert, meta, buses, routes, stops, onSaved, onCancel, onUnauthorized }) {
  const editing = !!alert, published = editing && alert.status === "published";
  const [f, setF] = useState(editing ? { ...EMPTY_ALERT, ...alert, busId: alert.busId ?? "", routeId: alert.routeId ?? "", stopId: alert.stopId ?? "", expiresAt: toLocalInput(alert.expiresAt) } : { ...EMPTY_ALERT, category: meta.canGeneral ? "general" : "bus_delay" });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const locked = (k) => published && !["description", "severity", "expiresAt"].includes(k); // what the notifications were about stays fixed
  const cats = Object.entries(meta.categories).filter(([k]) => meta.canGeneral || k !== "general");

  const submit = async (e) => {
    e.preventDefault();
    const local = {};
    if (f.title.trim().length < 3) local.title = "Enter a title of at least 3 characters.";
    if (f.description.trim().length < 5) local.description = "Enter a description of at least 5 characters.";
    const need = NEEDS_LINK[f.category]; if (need && !f[need[0]]) local[need[0]] = need[1];
    if (f.expiresAt && new Date(f.expiresAt).getTime() <= Date.now() + 30000) local.expiresAt = "The expiry must be in the future.";
    setErrors(local); setFormError("");
    if (Object.keys(local).length) return;
    const all = { title: f.title, description: f.description, category: f.category, severity: f.severity, audience: f.audience, busId: f.busId || null, routeId: f.routeId || null, stopId: f.stopId || null, expiresAt: f.expiresAt ? new Date(f.expiresAt).toISOString() : null };
    const body = published ? { description: all.description, severity: all.severity, expiresAt: all.expiresAt } : all;
    setBusy(true);
    try {
      const r = await send(editing ? "PATCH" : "POST", editing ? `/api/alerts/${alert.id}` : "/api/alerts", body);
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { if (d.field && d.field !== "body") setErrors({ [d.field]: d.error }); else setFormError(d.error || "The alert could not be saved."); return; }
      onSaved(d.alert, editing);
    } catch { setFormError("Cannot reach the server."); } finally { setBusy(false); }
  };
  const e = errors;
  return (
    <Modal title={editing ? "Edit service alert" : "New service alert"} onClose={onCancel} labelledBy="h-alertform">
      <form onSubmit={submit} noValidate className="bus-form">
        {published && <p className="panel__note">This alert is published. Only the description, severity and expiry can be corrected; the notifications already sent were about its title, category and links.</p>}
        <Field id="af-title" label="Title" error={e.title}><input id="af-title" value={f.title} onChange={set("title")} maxLength={120} disabled={locked("title")} autoComplete="off" aria-invalid={!!e.title} /></Field>
        <Field id="af-desc" label="Description" error={e.description} hint="What passengers or staff need to know (5-600 characters).">
          <textarea id="af-desc" rows={4} value={f.description} onChange={set("description")} maxLength={600} aria-invalid={!!e.description} />
        </Field>
        <div className="field-row">
          <Field id="af-cat" label="Category"><select id="af-cat" value={f.category} onChange={set("category")} disabled={locked("category")}>{cats.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field id="af-sev" label="Severity"><select id="af-sev" value={f.severity} onChange={set("severity")}>{meta.severities.map((k) => <option key={k} value={k}>{SEV[k].label}</option>)}</select></Field>
        </div>
        <Field id="af-aud" label="Who can see it" hint={f.audience === "public" ? "Everyone: passengers and visitors on the map, and all staff." : "Staff only: administrators, dispatchers and the conductors it concerns."}>
          <select id="af-aud" value={f.audience} onChange={set("audience")} disabled={locked("audience")}><option value="public">Passengers and staff (public)</option><option value="staff">Staff only</option></select>
        </Field>
        <div className="field-row">
          <Field id="af-bus" label={`Bus${f.category === "bus_delay" ? "" : " (optional)"}`} error={e.busId}><select id="af-bus" value={f.busId} onChange={set("busId")} disabled={locked("busId")} aria-invalid={!!e.busId}><option value="">None</option>{buses.map((b) => <option key={b.busId} value={b.busId}>{b.name} ({b.busId})</option>)}</select></Field>
          <Field id="af-route" label={`Route${["route_disruption", "route_change"].includes(f.category) ? "" : " (optional)"}`} error={e.routeId}><select id="af-route" value={f.routeId} onChange={set("routeId")} disabled={locked("routeId")} aria-invalid={!!e.routeId}><option value="">None</option>{routes.map((r) => <option key={r.routeId} value={r.routeId}>{r.name}</option>)}</select></Field>
        </div>
        <Field id="af-stop" label={`Bus stop${f.category === "stop_closure" ? "" : " (optional)"}`} error={e.stopId}><select id="af-stop" value={f.stopId} onChange={set("stopId")} disabled={locked("stopId")} aria-invalid={!!e.stopId}><option value="">None</option>{stops.map((x) => <option key={x.stopId} value={x.stopId}>{x.name}</option>)}</select></Field>
        <Field id="af-exp" label="Expires (optional)" error={e.expiresAt} hint="After this time the alert is no longer shown as active."><input id="af-exp" type="datetime-local" value={f.expiresAt} onChange={set("expiresAt")} aria-invalid={!!e.expiresAt} /></Field>
        {formError && <p className="form-error" role="alert">{formError}</p>}
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Save draft"}</button>
        </div>
      </form>
    </Modal>);
}

function AlertsPage({ onUnauthorized, alertsTick }) {
  const [data, error, reload] = useStaffData(["/api/alerts?status=all", "/api/buses", "/api/routes", "/api/stops"], onUnauthorized);
  const [filter, setFilter] = useState("all");
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: "publish" | "resolve", alert }
  const [feedback, setFeedback] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (alertsTick) reload(); }, [alertsTick, reload]);
  if (!data) return error ? <State title="Unable to load service alerts" text={error} action={<button className="btn" onClick={reload}>Try again</button>} /> : <State title="Loading" text="Fetching service alerts…" />;
  const [al, bs, rt, st] = data;
  const meta = { categories: al.categories, severities: al.severities, canGeneral: al.canGeneral };
  const rows = al.alerts.filter((a) => filter === "all" || a.state === filter);
  const mine = (a) => al.canGeneral || a.category !== "general"; // dispatchers cannot manage general announcements
  const act = async () => {
    const { kind, alert } = confirm; setBusy(true); setFeedback(null);
    try {
      const r = await post(`/api/alerts/${alert.id}/${kind}`, {});
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      setFeedback(r.ok ? { ok: true, text: kind === "publish" ? `Published. ${d.notified} ${d.notified === 1 ? "person was" : "people were"} notified.` : "The alert was resolved." } : { ok: false, text: d.error || "The change could not be saved." });
      if (r.ok) reload();
    } catch { setFeedback({ ok: false, text: "Cannot reach the server." }); } finally { setBusy(false); setConfirm(null); }
  };
  const who = (a) => (a.audience === "public" ? "all staff, the conductors it concerns, and every active passenger account" : "all staff and the conductors it concerns");
  return (
    <div className="dash">
      <section className="panel" aria-labelledby="h-alerts-mgr">
        <div className="panel__head"><h2 id="h-alerts-mgr">Service alerts</h2><span className="muted">{al.alerts.length} total</span></div>
        <div className="toolbar">
          <label className="sr-only" htmlFor="alert-filter">Filter by state</label>
          <select id="alert-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All alerts</option><option value="active">Active</option><option value="draft">Drafts</option><option value="expired">Expired</option><option value="resolved">Resolved</option>
          </select>
          <button className="btn btn--primary" onClick={() => { setFeedback(null); setForm("new"); }}>New alert</button>
        </div>
        {!al.canGeneral && <p className="panel__note">Dispatchers manage operational alerts. General announcements are written by administrators.</p>}
        {feedback && <p role="status" className={feedback.ok ? "ok-note" : "form-error"}>{feedback.text}</p>}
        {error && <p className="alert" role="alert">{error} Showing the last update.</p>}
        {al.alerts.length === 0 ? <div className="state"><h2>No service alerts yet</h2><p>Create one to inform passengers and staff. Nobody is notified until you publish it.</p></div>
          : rows.length === 0 ? <div className="state"><h2>No alerts in this view</h2><p>Choose another filter.</p></div> : (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Service alert list">
              <table>
                <thead><tr><th scope="col">Alert</th><th scope="col">Severity</th><th scope="col">Audience</th><th scope="col">State</th><th scope="col">Dates</th><th scope="col">Actions</th></tr></thead>
                <tbody>{rows.map((a) => (
                  <tr key={a.id}>
                    <td><strong>{a.title}</strong><div className="muted small small--tight">{a.categoryLabel}{a.busName ? ` · ${a.busName}` : ""}{a.routeName ? ` · ${a.routeName}` : ""}{a.stopName ? ` · ${a.stopName}` : ""}</div><div className="muted small small--tight">By {a.createdBy}</div></td>
                    <td><Badge tone={SEV[a.severity]?.tone ?? "off"}>{SEV[a.severity]?.label ?? a.severity}</Badge></td>
                    <td>{a.audience === "public" ? "Public" : "Staff only"}</td>
                    <td><Badge tone={ASTATE[a.state]?.tone ?? "off"}>{ASTATE[a.state]?.label ?? a.state}</Badge></td>
                    <td className="small">Created {dateTime(a.createdAt)}{a.publishedAt && <><br />Published {dateTime(a.publishedAt)}</>}{a.expiresAt && <><br />Expires {dateTime(a.expiresAt)}</>}{a.resolvedAt && <><br />Resolved {dateTime(a.resolvedAt)}</>}</td>
                    <td className="actions">
                      {mine(a) && a.status !== "resolved" ? (
                        <>
                          <button className="btn btn--sm" onClick={() => { setFeedback(null); setForm(a); }} aria-label={`Edit ${a.title}`}>Edit</button>{" "}
                          {a.status === "draft" && <button className="btn btn--sm btn--primary" onClick={() => setConfirm({ kind: "publish", alert: a })} aria-label={`Publish ${a.title}`}>Publish</button>}{" "}
                          <button className="btn btn--sm" onClick={() => setConfirm({ kind: "resolve", alert: a })} aria-label={`${a.status === "draft" ? "Discard" : "Resolve"} ${a.title}`}>{a.status === "draft" ? "Discard" : "Resolve"}</button>
                        </>) : <span className="muted small">{a.status === "resolved" ? "Closed" : "Administrators only"}</span>}
                    </td>
                  </tr>))}
                </tbody>
              </table>
            </div>)}
      </section>
      {form && <AlertForm alert={form === "new" ? null : form} meta={meta} buses={bs.buses} routes={rt.routes} stops={st.stops} onUnauthorized={onUnauthorized} onCancel={() => setForm(null)}
        onSaved={(a, editing) => { setForm(null); setFeedback({ ok: true, text: editing ? "Saved changes." : "Saved as a draft. Publish it when it is ready to notify people." }); reload(); }} />}
      {confirm && (
        <Confirm title={confirm.kind === "publish" ? "Publish this alert?" : confirm.alert.status === "draft" ? "Discard this draft?" : "Resolve this alert?"} danger={confirm.kind !== "publish"} busy={busy}
          label={confirm.kind === "publish" ? "Publish and notify" : confirm.alert.status === "draft" ? "Discard draft" : "Resolve alert"} onCancel={() => setConfirm(null)} onConfirm={act}>
          {confirm.kind === "publish"
            ? <p>"{confirm.alert.title}" will be shown as active and a notification will be sent to {who(confirm.alert)}. You cannot take a notification back, but you can resolve the alert later.</p>
            : <p>"{confirm.alert.title}" will no longer be shown as active. The record and the notifications already sent are kept.</p>}
        </Confirm>)}
    </div>);
}

// ---- Conductor dashboard ----
// What a conductor sees first: the bus the server says is theirs, its route, passengers and tracking. Read-only: the count is
// changed only on the Passenger counter page. Everything comes from /api/conductor/bus (signed-in session + PostgreSQL); the
// Socket.IO "occupancy" and "buses" events keep it current without a refresh.
function ConductorHome({ onUnauthorized, onNavigate, onShowMap, onFocus, alertsTick }) {
  const svc = useActiveAlerts(alertsTick);
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/conductor/bus", { credentials: "same-origin" });
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => null);
      if (!r.ok || !d) return setError((d && d.error) || "The dashboard could not be loaded.");
      setState(d); setError("");
    } catch { setError("Cannot reach the server."); }
  }, [onUnauthorized]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  const myId = state?.bus?.busId ?? null;
  useEffect(() => {
    if (!myId) return;
    const sock = joinSocket();
    sock.on("occupancy", (o) => { if (o && o.busId === myId) setState((p) => (p ? { ...p, occupancy: { ...p.occupancy, ...o } } : p)); });
    sock.on("buses", (list) => {
      const b = Array.isArray(list) ? list.find((x) => x.id === myId) : null;
      if (b) setState((p) => (p ? { ...p, tracking: { status: b.status, source: b.source, updatedAt: b.updatedAt, ageSeconds: b.ageSeconds, hasPosition: b.pos != null } } : p));
    });
    return () => sock.disconnect();
  }, [myId]);

  if (error && !state) return <State title="Unable to load your dashboard" text={error} action={<button className="btn" onClick={load}>Try again</button>} />;
  if (!state) return <State title="Loading" text="Fetching your bus…" />;
  if (!state.bus) return <State title="No bus assigned" text="You do not have an assigned bus yet. Ask an administrator to assign one. No bus or passenger information is shown until then." action={<button className="btn" onClick={load}>Check again</button>} />;
  const { bus, occupancy: o, tracking: t } = state;
  const src = t?.source === "gps" ? "GPS device" : t?.source === "simulation" ? "Simulated GPS (not real)" : "No tracking device";
  return (
    <div className="dash">
      {error && <p className="alert" role="alert">{error} Showing the last known information.</p>}
      <div className="dash-grid">
        <section className="panel" aria-labelledby="h-my">
          <div className="panel__head"><h2 id="h-my">My assigned bus</h2><span className="tag-mine">MY BUS</span></div>
          <dl className="facts">
            <div><dt>Bus</dt><dd>{bus.name} <span className="muted">({bus.busId})</span></dd></div>
            <div><dt>Plate number</dt><dd>{bus.plate ?? <span className="muted">Not set</span>}</dd></div>
            <div><dt>Capacity</dt><dd>{bus.capacity ?? <span className="muted">Not set</span>}</dd></div>
            <div><dt>Route</dt><dd>{bus.routeName ?? <span className="muted">No route assigned</span>}</dd></div>
            <div><dt>Assignment</dt><dd><Badge tone="ok">Assigned</Badge> <span className="muted">Bus is in service</span></dd></div>
          </dl>
        </section>
        <section className="panel" aria-labelledby="h-occ">
          <div className="panel__head"><h2 id="h-occ">Passenger occupancy</h2></div>
          {o.reported ? (
            <>
              <div className="counter__num"><span className="counter__big counter__big--sm">{o.count}</span><span className="counter__of">of {o.capacity} passengers</span></div>
              <progress className={`meter meter--${o.level}`} value={o.count} max={o.capacity} aria-label={`${o.count} of ${o.capacity} seats taken`} />
              <div className="counter__facts">
                <div><span className="muted">Available seats</span><strong>{o.available}</strong></div>
                <div><span className="muted">Occupancy</span><strong>{o.percent}%</strong></div>
                <div><span className="muted">Status</span><Badge tone={o.tone}>{o.label}</Badge></div>
              </div>
              {o.updatedAt && <p className="muted small small--tight">Last counted {timeFmt(o.updatedAt)}</p>}
            </>) : <p className="muted">{bus.capacity == null ? "This bus has no capacity set, so passengers cannot be counted. Ask an administrator." : "Not reported yet. Open the Passenger counter and tap Boarded for the first passenger, or start the trip at 0."}</p>}
        </section>
        <section className="panel" aria-labelledby="h-trk">
          <div className="panel__head"><h2 id="h-trk">Tracking</h2>{t?.source === "simulation" && <Badge tone="warn">Simulated</Badge>}</div>
          <dl className="facts">
            <div><dt>Status</dt><dd>{t ? <Badge tone={TRACK[t.status]?.tone ?? "off"}>{TRACK[t.status]?.label ?? t.status}</Badge> : <Badge tone="off">Unavailable</Badge>}</dd></div>
            <div><dt>Last location update</dt><dd>{t?.updatedAt ? <>{timeFmt(t.updatedAt)} <span className="muted">({ago(t.ageSeconds)})</span></> : <span className="muted">No location received yet</span>}</dd></div>
            <div><dt>Location source</dt><dd>{src}</dd></div>
          </dl>
          {t && !t.hasPosition && <p className="muted small">Location unavailable: {t.updatedAt ? "the last location is too old to show on the map." : "no location has been received from this bus yet."}</p>}
          {t?.status === "stale" && <p className="muted small">Showing the last known position only.</p>}
        </section>
        <section className="panel" aria-labelledby="h-svc-c">
          <div className="panel__head"><h2 id="h-svc-c">Service alerts for you</h2></div>
          {!svc ? <p className="muted">Loading…</p> : svc.length === 0 ? <p className="muted">No active alerts for your bus or route.</p>
            : svc.slice(0, 3).map((a) => <AlertCard key={a.id} alert={a} compact onFocus={onFocus} />)}
          {svc && svc.length > 3 && <p className="panel__note">{svc.length - 3} more in your notifications.</p>}
        </section>
        <section className="panel" aria-labelledby="h-qa">
          <div className="panel__head"><h2 id="h-qa">Quick actions</h2></div>
          <div className="qa">
            <button className="btn btn--primary" onClick={() => onNavigate("counter")}><Ticket size={16} aria-hidden /> Open Passenger Counter</button>
            <button className="btn" onClick={onShowMap}><MapIcon size={16} aria-hidden /> View my bus on Live Map</button>
          </div>
        </section>
      </div>
    </div>
  );
}

// ---- Bus management ----
// Administrators can add, edit and deactivate buses; dispatchers can only look. The server enforces this
// (buses:manage / buses:read); the buttons are hidden for dispatchers only so the screen matches.
const EMPTY_BUS = { busId: "", name: "", plate: "", capacity: "", model: "", status: "active", simulatedGps: true };

function Modal({ title, onClose, children, labelledBy }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    const first = ref.current?.querySelector("input:not([disabled]), textarea:not([disabled]), select, button");
    first?.focus();
    const key = (e) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab") return; // keep keyboard focus inside the dialog
      const f = [...ref.current.querySelectorAll("input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])")];
      if (!f.length) return;
      const a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        <h2 id={labelledBy}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Field({ id, label, error, hint, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error && <span className="muted small small--tight" id={`${id}-hint`}>{hint}</span>}
      {error && <span className="field-error" id={`${id}-err`} role="alert">{error}</span>}
    </div>
  );
}

function BusForm({ bus, routes, onSaved, onCancel, onUnauthorized }) {
  const editing = !!bus;
  const [f, setF] = useState(editing ? { ...EMPTY_BUS, ...bus, plate: bus.plate ?? "", model: bus.model ?? "", capacity: String(bus.capacity ?? ""), simulatedGps: bus.source === "simulation", routeId: bus.routeId ?? "" } : { ...EMPTY_BUS, routeId: "" });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const gpsDevice = editing && bus.source === "gps"; // a real GPS device is managed outside this form

  const submit = async (e) => {
    e.preventDefault();
    const cap = f.capacity.trim() === "" ? NaN : Number(f.capacity);
    const local = {};
    if (!editing && !f.busId.trim()) local.busId = "Enter a bus ID.";
    if (!f.name.trim()) local.name = "Enter a name.";
    if (!Number.isInteger(cap) || cap < 1 || cap > 120) local.capacity = "Capacity must be a whole number from 1 to 120.";
    setErrors(local); setFormError("");
    if (Object.keys(local).length) return;

    const body = { name: f.name, plate: f.plate.trim() === "" ? null : f.plate, capacity: cap, model: f.model.trim() === "" ? null : f.model, status: f.status };
    if (!editing) body.busId = f.busId;
    if (!gpsDevice) body.simulatedGps = f.status === "active" && f.simulatedGps;
    setBusy(true);
    try {
      const r = await send(editing ? "PATCH" : "POST", editing ? `/api/buses/${encodeURIComponent(bus.busId)}` : "/api/buses", body);
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (d.field && d.field !== "body") setErrors({ [d.field]: d.error }); else setFormError(d.error || "The bus could not be saved.");
        return;
      }
      // The route is a separate record (a bus-to-route assignment), saved with its own request after the bus itself.
      const wanted = f.status === "active" ? f.routeId : "";
      let warn = "";
      if (wanted !== (editing ? bus.routeId ?? "" : "") && (wanted !== "" || f.status === "active")) {
        const a = await send("PUT", `/api/buses/${encodeURIComponent(d.busId)}/route`, { routeId: wanted === "" ? null : wanted });
        if (!a.ok) warn = ((await a.json().catch(() => ({}))).error) || "The route could not be changed.";
      }
      onSaved(d, editing, warn);
    } catch { setFormError("Cannot reach the server."); }
    finally { setBusy(false); }
  };

  const e = errors;
  return (
    <Modal title={editing ? `Edit ${bus.busId}` : "Add bus"} onClose={onCancel} labelledBy="h-busform">
      <form onSubmit={submit} noValidate className="bus-form">
        <Field id="bf-id" label="Bus ID" error={e.busId} hint={editing ? "The bus ID cannot be changed." : "For example RW-03. Letters, numbers and hyphens."}>
          <input id="bf-id" value={f.busId} onChange={set("busId")} disabled={editing} maxLength={16} autoComplete="off" aria-invalid={!!e.busId} aria-describedby={e.busId ? "bf-id-err" : "bf-id-hint"} />
        </Field>
        <Field id="bf-name" label="Bus name" error={e.name}>
          <input id="bf-name" value={f.name} onChange={set("name")} maxLength={60} autoComplete="off" aria-invalid={!!e.name} aria-describedby={e.name ? "bf-name-err" : undefined} />
        </Field>
        <div className="field-row">
          <Field id="bf-plate" label="Plate number (optional)" error={e.plate}>
            <input id="bf-plate" value={f.plate} onChange={set("plate")} maxLength={12} autoComplete="off" aria-invalid={!!e.plate} aria-describedby={e.plate ? "bf-plate-err" : undefined} />
          </Field>
          <Field id="bf-cap" label="Capacity (passengers)" error={e.capacity}>
            <input id="bf-cap" type="number" inputMode="numeric" min="1" max="120" value={f.capacity} onChange={set("capacity")} aria-invalid={!!e.capacity} aria-describedby={e.capacity ? "bf-cap-err" : undefined} />
          </Field>
        </div>
        <Field id="bf-model" label="Model or description (optional)" error={e.model}>
          <input id="bf-model" value={f.model} onChange={set("model")} maxLength={60} autoComplete="off" aria-invalid={!!e.model} aria-describedby={e.model ? "bf-model-err" : undefined} />
        </Field>
        <Field id="bf-status" label="Operational status" error={e.status}>
          <select id="bf-status" value={f.status} onChange={set("status")}>
            <option value="active">Active</option><option value="maintenance">Under maintenance</option><option value="inactive">Inactive</option>
          </select>
        </Field>
        <Field id="bf-route" label="Route" hint="Only Active buses can run a route. Simulated GPS buses can only run the live tracking route.">
          <select id="bf-route" value={f.status === "active" ? f.routeId : ""} onChange={set("routeId")} disabled={f.status !== "active"} aria-describedby="bf-route-hint">
            <option value="">No route</option>
            {(routes || []).filter((r) => r.status === "active" || r.routeId === bus?.routeId).map((r) => <option key={r.routeId} value={r.routeId}>{r.name} ({r.routeId})</option>)}
          </select>
        </Field>
        {gpsDevice
          ? <p className="muted small small--tight">This bus reports from a real GPS device. Its tracking device is managed separately.</p>
          : (
            <label className="check">
              <input type="checkbox" checked={f.simulatedGps && f.status === "active"} disabled={f.status !== "active"} onChange={set("simulatedGps")} />
              <span>Use simulated GPS (demo data, not real GPS)<span className="muted small small--tight block">Only Active buses are tracked and shown to passengers.</span></span>
            </label>)}
        {formError && <p className="form-error" role="alert">{formError}</p>}
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Add bus"}</button>
        </div>
      </form>
    </Modal>
  );
}

function BusesPage({ onUnauthorized }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState(null); // { ok, text }
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [form, setForm] = useState(null);     // null | "new" | bus being edited
  const [confirm, setConfirm] = useState(null); // bus about to be deactivated
  const [busy, setBusy] = useState(false);

  const [routes, setRoutes] = useState([]);
  const load = useCallback(() => Promise.all([fetch("/api/buses", { credentials: "same-origin" }), fetch("/api/routes", { credentials: "same-origin" })])
    .then(async ([r, rr]) => {
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || !Array.isArray(d.buses)) return setError((d && d.error) || "The bus list could not be read.");
      setData(d); setError("");
      const rd = rr.ok ? await rr.json().catch(() => null) : null;
      if (rd && Array.isArray(rd.routes)) setRoutes(rd.routes);
    })
    .catch(() => setError("Cannot reach the server.")), [onUnauthorized]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const change = async (bus, body, okText) => {
    setBusy(true); setFeedback(null);
    try {
      const r = await send("PATCH", `/api/buses/${encodeURIComponent(bus.busId)}`, body);
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      setFeedback(r.ok ? { ok: true, text: okText } : { ok: false, text: d.error || "The change could not be saved." });
      if (r.ok) load();
    } catch { setFeedback({ ok: false, text: "Cannot reach the server." }); }
    finally { setBusy(false); setConfirm(null); }
  };

  if (!data) return error
    ? <State title="Unable to load buses" text={error} action={<button className="btn" onClick={load}>Try again</button>} />
    : <State title="Loading buses" text="Fetching the bus list…" />;

  const needle = q.trim().toLowerCase();
  const rows = data.buses.filter((b) => (filter === "all" || b.status === filter)
    && (!needle || [b.busId, b.name, b.plate, b.model].some((v) => v && String(v).toLowerCase().includes(needle))));
  const trackingOf = (b) => b.status !== "active" ? <Badge tone="off">Not tracked</Badge>
    : !b.source ? <Badge tone="off">No tracking device</Badge>
    : <Badge tone={TRACK[b.tracking]?.tone ?? "off"}>{TRACK[b.tracking]?.label ?? b.tracking}</Badge>;

  return (
    <div className="dash">
      <section className="panel" aria-labelledby="h-buses">
        <div className="panel__head">
          <h2 id="h-buses">Registered buses</h2>
          <span className="muted">{data.buses.length} total</span>
        </div>
        <div className="toolbar">
          <div className="toolbar__search">
            <label className="sr-only" htmlFor="bus-search">Search buses</label>
            <input id="bus-search" type="search" placeholder="Search by ID, name, plate or model" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <label className="sr-only" htmlFor="bus-filter">Filter by status</label>
          <select id="bus-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All statuses</option><option value="active">Active</option><option value="maintenance">Under maintenance</option><option value="inactive">Inactive</option>
          </select>
          {data.canManage && <button className="btn btn--primary" onClick={() => { setFeedback(null); setForm("new"); }}>Add bus</button>}
        </div>
        {!data.canManage && <p className="panel__note">View only. Administrators manage bus records.</p>}
        {feedback && <p role="status" className={feedback.ok ? "ok-note" : "form-error"}>{feedback.text}</p>}
        {error && <p className="alert" role="alert">{error} Showing the last update.</p>}
        {data.buses.length === 0 ? (
          <div className="state"><h2>No buses registered yet</h2><p>{data.canManage ? "Add the first bus to start tracking it." : "An administrator has not registered any buses yet."}</p></div>
        ) : rows.length === 0 ? (
          <div className="state"><h2>No buses match</h2><p>Try a different search or status filter.</p></div>
        ) : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Bus list">
            <table>
              <thead><tr><th scope="col">Bus</th><th scope="col">Plate</th><th scope="col">Capacity</th><th scope="col">Route</th><th scope="col">Status</th><th scope="col">Tracking</th>{data.canManage && <th scope="col">Actions</th>}</tr></thead>
              <tbody>{rows.map((b) => (
                <tr key={b.busId}>
                  <td><strong>{b.name}</strong><div className="muted small small--tight">{b.busId}{b.model ? ` · ${b.model}` : ""}</div></td>
                  <td>{b.plate ?? <span className="muted">Not set</span>}</td>
                  <td>{b.capacity ?? <span className="muted">Not set</span>}</td>
                  <td>{b.routeName ?? <span className="muted">No route</span>}</td>
                  <td><Badge tone={BUS_STATUS[b.status]?.tone ?? "off"}>{BUS_STATUS[b.status]?.label ?? b.status}</Badge></td>
                  <td>{trackingOf(b)}</td>
                  {data.canManage && (
                    <td className="actions">
                      <button className="btn btn--sm" onClick={() => { setFeedback(null); setForm(b); }} aria-label={`Edit ${b.busId}`}>Edit</button>{" "}
                      {b.status === "active"
                        ? <button className="btn btn--sm" onClick={() => setConfirm(b)} aria-label={`Deactivate ${b.busId}`}>Deactivate</button>
                        : <button className="btn btn--sm" disabled={busy} onClick={() => change(b, { status: "active" }, `${b.busId} is active again.`)} aria-label={`Set active ${b.busId}`}>Set active</button>}
                    </td>)}
                </tr>))}
              </tbody>
            </table>
          </div>)}
      </section>

      {form && (
        <BusForm bus={form === "new" ? null : form} routes={routes} onUnauthorized={onUnauthorized} onCancel={() => setForm(null)}
          onSaved={(b, editing, warn) => { setForm(null); setFeedback(warn ? { ok: false, text: `${editing ? `Saved changes to ${b.busId}` : `Registered ${b.busId}`}, but its route was not changed: ${warn}` } : { ok: true, text: editing ? `Saved changes to ${b.busId}.` : `Registered ${b.busId}.` }); load(); }} />)}
      {confirm && (
        <Modal title={`Deactivate ${confirm.busId}?`} onClose={() => setConfirm(null)} labelledBy="h-deact">
          <p>{confirm.name} will no longer be tracked or shown to passengers, and it will stop accepting location updates. The record is kept, and you can set it active again later.</p>
          <div className="modal__actions">
            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn--danger" disabled={busy} onClick={() => change(confirm, { status: "inactive" }, `${confirm.busId} was deactivated.`)}>{busy ? "Working…" : "Deactivate bus"}</button>
          </div>
        </Modal>)}
    </div>
  );
}

// ---- Routes and bus stops ----
// Same rules as Bus Management: administrators change records, dispatchers only look, passengers see only the map.
// The server enforces it (routes:manage / stops:manage); hidden buttons just keep the screen consistent.

function Confirm({ title, children, label, busy, onCancel, onConfirm, danger = true }) {
  return (
    <Modal title={title} onClose={onCancel} labelledBy="h-confirm">
      {children}
      <div className="modal__actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className={`btn ${danger ? "btn--danger" : "btn--primary"}`} disabled={busy} onClick={onConfirm}>{busy ? "Working…" : label}</button>
      </div>
    </Modal>
  );
}

/** Loads several staff endpoints together and polls them. Returns [data, error, reload]. */
function useStaffData(urls, onUnauthorized, every = 8000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const key = urls.join("|");
  const load = useCallback(async () => {
    try {
      const rs = await Promise.all(key.split("|").map(getJson));
      if (rs.some((r) => r.status === 401)) return onUnauthorized();
      const bad = rs.find((r) => !r.ok || !r.body);
      if (bad) return setError((bad.body && bad.body.error) || "The data could not be read.");
      setData(rs.map((r) => r.body)); setError("");
    } catch { setError("Cannot reach the server."); }
  }, [key, onUnauthorized]);
  useEffect(() => { load(); const t = setInterval(load, every); return () => clearInterval(t); }, [load, every]);
  return [data, error, load];
}

/** Sends a change, then reports success or the server's message. Returns the parsed body on success, otherwise null. */
async function change(method, url, body, onUnauthorized, setFeedback, okText) {
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

function StopForm({ stop, onSaved, onCancel, onUnauthorized }) {
  const editing = !!stop;
  const [f, setF] = useState(editing ? { stopId: stop.stopId, name: stop.name, address: stop.address ?? "", lat: String(stop.lat), lng: String(stop.lng), status: stop.status } : { stopId: "", name: "", address: "", lat: "", lng: "", status: "active" });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const num = (v) => (v.trim() === "" ? NaN : Number(v));

  const submit = async (e) => {
    e.preventDefault();
    const lat = num(f.lat), lng = num(f.lng), local = {};
    if (!editing && !f.stopId.trim()) local.stopId = "Enter a stop ID.";
    if (!f.name.trim()) local.name = "Enter a name.";
    if (!Number.isFinite(lat)) local.lat = "Enter the latitude as a number."; else if (lat < -90 || lat > 90) local.lat = "Latitude must be between -90 and 90.";
    if (!Number.isFinite(lng)) local.lng = "Enter the longitude as a number."; else if (lng < -180 || lng > 180) local.lng = "Longitude must be between -180 and 180.";
    setErrors(local); setFormError("");
    if (Object.keys(local).length) return;
    const body = { name: f.name, address: f.address.trim() === "" ? null : f.address, lat, lng, status: f.status };
    if (!editing) body.stopId = f.stopId;
    setBusy(true);
    try {
      const r = await send(editing ? "PATCH" : "POST", editing ? `/api/stops/${encodeURIComponent(stop.stopId)}` : "/api/stops", body);
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { if (d.field && d.field !== "body") setErrors({ [d.field]: d.error }); else setFormError(d.error || "The bus stop could not be saved."); return; }
      onSaved(d, editing);
    } catch { setFormError("Cannot reach the server."); }
    finally { setBusy(false); }
  };
  const e = errors;
  return (
    <Modal title={editing ? `Edit ${stop.stopId}` : "Add bus stop"} onClose={onCancel} labelledBy="h-stopform">
      <form onSubmit={submit} noValidate className="bus-form">
        <Field id="sf-id" label="Stop ID" error={e.stopId} hint={editing ? "The stop ID cannot be changed." : "For example S-06. Letters, numbers and hyphens."}>
          <input id="sf-id" value={f.stopId} onChange={set("stopId")} disabled={editing} maxLength={16} autoComplete="off" aria-invalid={!!e.stopId} aria-describedby={e.stopId ? "sf-id-err" : "sf-id-hint"} />
        </Field>
        <Field id="sf-name" label="Stop name" error={e.name}>
          <input id="sf-name" value={f.name} onChange={set("name")} maxLength={80} autoComplete="off" aria-invalid={!!e.name} aria-describedby={e.name ? "sf-name-err" : undefined} />
        </Field>
        <Field id="sf-addr" label="Address or location description (optional)" error={e.address}>
          <input id="sf-addr" value={f.address} onChange={set("address")} maxLength={200} autoComplete="off" aria-invalid={!!e.address} aria-describedby={e.address ? "sf-addr-err" : undefined} />
        </Field>
        <div className="field-row">
          <Field id="sf-lat" label="Latitude" error={e.lat} hint="Between -90 and 90">
            <input id="sf-lat" inputMode="decimal" value={f.lat} onChange={set("lat")} autoComplete="off" aria-invalid={!!e.lat} aria-describedby={e.lat ? "sf-lat-err" : "sf-lat-hint"} />
          </Field>
          <Field id="sf-lng" label="Longitude" error={e.lng} hint="Between -180 and 180">
            <input id="sf-lng" inputMode="decimal" value={f.lng} onChange={set("lng")} autoComplete="off" aria-invalid={!!e.lng} aria-describedby={e.lng ? "sf-lng-err" : "sf-lng-hint"} />
          </Field>
        </div>
        <p className="muted small small--tight">Use the real coordinates of the stop (in Google Maps, right-click the spot and click the coordinates to copy them). The map shows the stop exactly where you enter it, so check that it is on land and near a road.</p>
        <Field id="sf-status" label="Status" error={e.status}>
          <select id="sf-status" value={f.status} onChange={set("status")}><option value="active">Active</option><option value="inactive">Inactive</option></select>
        </Field>
        {formError && <p className="form-error" role="alert">{formError}</p>}
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Add stop"}</button>
        </div>
      </form>
    </Modal>
  );
}

function StopsPage({ onUnauthorized }) {
  const [data, error, load] = useStaffData(["/api/stops", "/api/routes"], onUnauthorized);
  const [feedback, setFeedback] = useState(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!data) return error
    ? <State title="Unable to load bus stops" text={error} action={<button className="btn" onClick={load}>Try again</button>} />
    : <State title="Loading bus stops" text="Fetching the bus stops…" />;
  const [{ stops, canManage }, { routes }] = data;
  const routeName = (id) => routes.find((r) => r.routeId === id)?.name ?? id;
  const needle = q.trim().toLowerCase();
  const rows = stops.filter((s) => (filter === "all" || s.status === filter) && (!needle || [s.stopId, s.name, s.address].some((v) => v && String(v).toLowerCase().includes(needle))));
  const setStatus = async (stop, status, text) => {
    setBusy(true);
    const d = await change("PATCH", `/api/stops/${encodeURIComponent(stop.stopId)}`, { status }, onUnauthorized, setFeedback, text);
    setBusy(false); setConfirm(null); if (d) load();
  };

  return (
    <div className="dash">
      <section className="panel" aria-labelledby="h-stops">
        <div className="panel__head"><h2 id="h-stops">Bus stops</h2><span className="muted">{stops.length} total</span></div>
        <div className="toolbar">
          <div className="toolbar__search">
            <label className="sr-only" htmlFor="stop-search">Search bus stops</label>
            <input id="stop-search" type="search" placeholder="Search by ID, name or address" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <label className="sr-only" htmlFor="stop-filter">Filter by status</label>
          <select id="stop-filter" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
          {canManage && <button className="btn btn--primary" onClick={() => { setFeedback(null); setForm("new"); }}>Add stop</button>}
        </div>
        {!canManage && <p className="panel__note">View only. Administrators manage bus stops.</p>}
        {feedback && <p role="status" className={feedback.ok ? "ok-note" : "form-error"}>{feedback.text}</p>}
        {error && <p className="alert" role="alert">{error} Showing the last update.</p>}
        {stops.length === 0 ? <div className="state"><h2>No bus stops yet</h2><p>{canManage ? "Add the first bus stop." : "An administrator has not added any bus stops yet."}</p></div>
          : rows.length === 0 ? <div className="state"><h2>No bus stops match</h2><p>Try a different search or status filter.</p></div>
          : (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Bus stop list">
              <table>
                <thead><tr><th scope="col">Stop</th><th scope="col">Address</th><th scope="col">Coordinates</th><th scope="col">Routes</th><th scope="col">Status</th>{canManage && <th scope="col">Actions</th>}</tr></thead>
                <tbody>{rows.map((s) => (
                  <tr key={s.stopId}>
                    <td><strong>{s.name}</strong><div className="muted small small--tight">{s.stopId}</div></td>
                    <td>{s.address ?? <span className="muted">Not set</span>}</td>
                    <td className="nowrap">{coordText(s.lat)}, {coordText(s.lng)}</td>
                    <td>{s.routeIds.length ? s.routeIds.map(routeName).join(", ") : <span className="muted">None</span>}</td>
                    <td><Badge tone={BUS_STATUS[s.status]?.tone ?? "off"}>{BUS_STATUS[s.status]?.label ?? s.status}</Badge></td>
                    {canManage && (
                      <td className="actions">
                        <button className="btn btn--sm" onClick={() => { setFeedback(null); setForm(s); }} aria-label={`Edit ${s.stopId}`}>Edit</button>{" "}
                        {s.status === "active"
                          ? <button className="btn btn--sm" onClick={() => setConfirm(s)} aria-label={`Deactivate ${s.stopId}`}>Deactivate</button>
                          : <button className="btn btn--sm" disabled={busy} onClick={() => setStatus(s, "active", `${s.stopId} is active again.`)} aria-label={`Set active ${s.stopId}`}>Set active</button>}
                      </td>)}
                  </tr>))}
                </tbody>
              </table>
            </div>)}
      </section>
      {form && <StopForm stop={form === "new" ? null : form} onUnauthorized={onUnauthorized} onCancel={() => setForm(null)}
        onSaved={(s, editing) => { setForm(null); setFeedback({ ok: true, text: editing ? `Saved changes to ${s.stopId}.` : `Added ${s.stopId}.` }); load(); }} />}
      {confirm && (
        <Confirm title={`Deactivate ${confirm.stopId}?`} label="Deactivate stop" busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => setStatus(confirm, "inactive", `${confirm.stopId} was deactivated.`)}>
          <p>{confirm.name} will no longer be shown to passengers or used for arrival estimates.{confirm.routeIds.length ? ` It stays in ${confirm.routeIds.map(routeName).join(", ")}, so you can activate it again later.` : ""}</p>
        </Confirm>)}
    </div>
  );
}

function RouteForm({ route, onSaved, onCancel, onUnauthorized }) {
  const editing = !!route;
  const [f, setF] = useState(editing ? { routeId: route.routeId, name: route.name, startPoint: route.startPoint, destination: route.destination, description: route.description ?? "", status: route.status } : { routeId: "", name: "", startPoint: "", destination: "", description: "", status: "active" });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    const local = {};
    if (!editing && !f.routeId.trim()) local.routeId = "Enter a route ID.";
    for (const [k, label] of [["name", "a name"], ["startPoint", "the starting point"], ["destination", "the destination"]]) if (!f[k].trim()) local[k] = `Enter ${label}.`;
    setErrors(local); setFormError("");
    if (Object.keys(local).length) return;
    const body = { name: f.name, startPoint: f.startPoint, destination: f.destination, description: f.description.trim() === "" ? null : f.description, status: f.status };
    if (!editing) body.routeId = f.routeId;
    setBusy(true);
    try {
      const r = await send(editing ? "PATCH" : "POST", editing ? `/api/routes/${encodeURIComponent(route.routeId)}` : "/api/routes", body);
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { if (d.field && d.field !== "body") setErrors({ [d.field]: d.error }); else setFormError(d.error || "The route could not be saved."); return; }
      onSaved(d, editing);
    } catch { setFormError("Cannot reach the server."); }
    finally { setBusy(false); }
  };
  const e = errors;
  const text = (id, key, label, max, hint) => (
    <Field id={id} label={label} error={e[key]} hint={hint}>
      <input id={id} value={f[key]} onChange={set(key)} maxLength={max} autoComplete="off" aria-invalid={!!e[key]} aria-describedby={e[key] ? `${id}-err` : hint ? `${id}-hint` : undefined} />
    </Field>);
  return (
    <Modal title={editing ? `Edit ${route.routeId}` : "Create route"} onClose={onCancel} labelledBy="h-routeform">
      <form onSubmit={submit} noValidate className="bus-form">
        {text("rf-id", "routeId", "Route ID", 16, editing ? "The route ID cannot be changed." : "For example R-02. Letters, numbers and hyphens.")}
        {text("rf-name", "name", "Route name", 80)}
        <div className="field-row">{text("rf-start", "startPoint", "Starting point", 80)}{text("rf-dest", "destination", "Destination", 80)}</div>
        {text("rf-desc", "description", "Description (optional)", 200)}
        <Field id="rf-status" label="Status" error={e.status}>
          <select id="rf-status" value={f.status} onChange={set("status")}><option value="active">Active</option><option value="inactive">Inactive</option></select>
        </Field>
        <p className="muted small small--tight">Stops and buses are added from the route's Details page after it is created.</p>
        {formError && <p className="form-error" role="alert">{formError}</p>}
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Create route"}</button>
        </div>
      </form>
    </Modal>
  );
}

function RouteDetail({ route, stops, buses, canManage, onBack, onEdit, reload, onUnauthorized, setFeedback, askConfirm }) {
  const [addStop, setAddStop] = useState("");
  const [addBus, setAddBus] = useState("");
  const [busy, setBusy] = useState(false);
  const onRoute = new Set(route.stops.map((s) => s.stopId));
  const stopChoices = stops.filter((s) => s.status === "active" && !onRoute.has(s.stopId));
  const busChoices = buses.filter((b) => b.status === "active" && b.routeId !== route.routeId);
  const run = async (method, url, body, okText) => { setBusy(true); const d = await change(method, url, body, onUnauthorized, setFeedback, okText); setBusy(false); if (d) reload(); return d; };
  const move = (i, dir) => {
    const ids = route.stops.map((s) => s.stopId); const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    run("PUT", `/api/routes/${encodeURIComponent(route.routeId)}/stops`, { stopIds: ids }, `Moved ${route.stops[i].name} ${dir < 0 ? "up" : "down"}.`);
  };
  const assign = (b) => {
    const go = () => run("PUT", `/api/buses/${encodeURIComponent(b.busId)}/route`, { routeId: route.routeId }, `${b.name} is now on ${route.name}.`);
    if (!b.routeId) return go();
    askConfirm({ title: `Move ${b.busId} to ${route.routeId}?`, label: "Move bus", danger: false, text: `${b.name} is currently on ${b.routeName}. A bus can run only one route at a time, so it will be taken off that route.`, run: go });
  };
  return (
    <div className="dash">
      <section className="panel" aria-labelledby="h-rd">
        <div className="panel__head">
          <div><button className="btn btn--sm" onClick={onBack}>← All routes</button></div>
          {canManage && <button className="btn btn--sm" onClick={() => onEdit(route)}>Edit route</button>}
        </div>
        <h2 id="h-rd" className="route-title">{route.name} <Badge tone={BUS_STATUS[route.status]?.tone ?? "off"}>{BUS_STATUS[route.status]?.label ?? route.status}</Badge>{route.tracked && <> <Badge tone="info">Live tracking route</Badge></>}</h2>
        <p className="muted">{route.routeId} · {route.startPoint} → {route.destination}{route.description ? ` · ${route.description}` : ""}</p>
        {route.tracked && <p className="panel__note">This route has road geometry and arrival estimates. It must stay active with at least 2 active stops. Changing its stops reloads the road route.</p>}
        {!route.tracked && <p className="panel__note">Arrival estimates and simulated GPS are only available on the live tracking route. On the map this route is drawn along roads when the routing service answers, otherwise as a labelled straight stop-to-stop link.</p>}
      </section>

      <div className="dash-grid">
        <section className="panel" aria-labelledby="h-rd-stops">
          <div className="panel__head"><h2 id="h-rd-stops">Stops in order</h2><span className="muted">{route.stops.length}</span></div>
          {route.stops.length === 0 ? <p className="muted">No stops yet.{canManage ? " Add the first stop below." : ""}</p> : (
            <ol className="ordered">{route.stops.map((s, i) => (
              <li key={s.stopId}>
                <span className="ordered__n" aria-hidden>{s.order}</span>
                <span className="ordered__name"><strong>{s.name}</strong> <span className="muted">{s.stopId}</span>{s.status !== "active" && <> <Badge tone="off">Inactive stop</Badge></>}</span>
                {canManage && (
                  <span className="ordered__btns">
                    <button className="btn btn--sm" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move up ${s.name}`}><ArrowUp size={14} aria-hidden /> Move up</button>
                    <button className="btn btn--sm" disabled={busy || i === route.stops.length - 1} onClick={() => move(i, 1)} aria-label={`Move down ${s.name}`}><ArrowDown size={14} aria-hidden /> Move down</button>
                    <button className="btn btn--sm" disabled={busy} aria-label={`Remove ${s.name}`}
                      onClick={() => askConfirm({ title: `Remove ${s.name}?`, label: "Remove stop", text: `${s.name} will be taken off ${route.name}. The stop itself is kept and can be added again.`, run: () => run("DELETE", `/api/routes/${encodeURIComponent(route.routeId)}/stops/${encodeURIComponent(s.stopId)}`, {}, `Removed ${s.name} from the route.`) })}>Remove</button>
                  </span>)}
              </li>))}
            </ol>)}
          {canManage && (
            <div className="inline-form">
              <label className="sr-only" htmlFor="add-stop">Stop to add</label>
              <select id="add-stop" value={addStop} onChange={(e) => setAddStop(e.target.value)} disabled={!stopChoices.length}>
                <option value="">{stopChoices.length ? "Choose a stop to add…" : "No other active stops"}</option>
                {stopChoices.map((s) => <option key={s.stopId} value={s.stopId}>{s.name} ({s.stopId})</option>)}
              </select>
              <button className="btn btn--primary" disabled={busy || !addStop} onClick={async () => { const d = await run("POST", `/api/routes/${encodeURIComponent(route.routeId)}/stops`, { stopId: addStop }, "Stop added at the end of the route."); if (d) setAddStop(""); }}>Add stop</button>
            </div>)}
        </section>

        <section className="panel" aria-labelledby="h-rd-buses">
          <div className="panel__head"><h2 id="h-rd-buses">Assigned buses</h2><span className="muted">{route.buses.length}</span></div>
          {route.buses.length === 0 ? <p className="muted">No buses are assigned to this route.</p> : route.buses.map((b) => (
            <div className="row" key={b.busId}>
              <span>{b.name} <span className="muted">{b.busId}</span></span>
              {canManage && <button className="btn btn--sm" disabled={busy} aria-label={`Unassign ${b.busId}`}
                onClick={() => askConfirm({ title: `Unassign ${b.busId}?`, label: "Unassign bus", text: `${b.name} will be taken off ${route.name}. The bus record is kept.`, run: () => run("PUT", `/api/buses/${encodeURIComponent(b.busId)}/route`, { routeId: null }, `${b.name} was taken off the route.`) })}>Unassign</button>}
            </div>))}
          {canManage && route.status === "active" && (
            <div className="inline-form">
              <label className="sr-only" htmlFor="add-bus">Bus to assign</label>
              <select id="add-bus" value={addBus} onChange={(e) => setAddBus(e.target.value)} disabled={!busChoices.length}>
                <option value="">{busChoices.length ? "Choose a bus to assign…" : "No other active buses"}</option>
                {busChoices.map((b) => <option key={b.busId} value={b.busId}>{b.name} ({b.busId}){b.routeName ? ` – now on ${b.routeName}` : ""}</option>)}
              </select>
              <button className="btn btn--primary" disabled={busy || !addBus} onClick={() => { const b = buses.find((x) => x.busId === addBus); if (b) { assign(b); setAddBus(""); } }}>Assign bus</button>
            </div>)}
          {canManage && route.status !== "active" && <p className="panel__note">Buses cannot be assigned to an inactive route.</p>}
          {canManage && <p className="panel__note">Only Active buses can be assigned, and a bus runs one route at a time. Buses with simulated GPS can only run the live tracking route.</p>}
        </section>
      </div>
    </div>
  );
}

function RoutesPage({ onUnauthorized }) {
  const [data, error, load] = useStaffData(["/api/routes", "/api/stops", "/api/buses"], onUnauthorized);
  const [feedback, setFeedback] = useState(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(null); // { title, text, label, danger, run }
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState(null);

  if (!data) return error
    ? <State title="Unable to load routes" text={error} action={<button className="btn" onClick={load}>Try again</button>} />
    : <State title="Loading routes" text="Fetching the routes…" />;
  const [{ routes, canManage }, { stops }, { buses }] = data;
  const open = openId ? routes.find((r) => r.routeId === openId) : null;
  const askConfirm = (c) => setConfirm(c);
  const doConfirm = async () => { setBusy(true); try { await confirm.run(); } finally { setBusy(false); setConfirm(null); } };
  const setStatus = (r, status) => async () => { const d = await change("PATCH", `/api/routes/${encodeURIComponent(r.routeId)}`, { status }, onUnauthorized, setFeedback, status === "active" ? `${r.routeId} is active again.` : `${r.routeId} was deactivated.`); if (d) load(); };
  const deactivate = (r) => askConfirm({ title: `Deactivate ${r.routeId}?`, label: "Deactivate route", run: setStatus(r, "inactive"),
    text: `${r.name} will no longer be shown to passengers.${r.buses.length ? ` ${r.buses.length} assigned bus${r.buses.length > 1 ? "es" : ""} (${r.buses.map((b) => b.name).join(", ")}) will be taken off the route.` : ""} The route and its stops are kept, and you can activate it again.` });

  const rows = (() => { const n = q.trim().toLowerCase(); return routes.filter((r) => (filter === "all" || r.status === filter) && (!n || [r.routeId, r.name, r.startPoint, r.destination].some((v) => v && v.toLowerCase().includes(n)))); })();
  const modals = (
    <>
      {form && <RouteForm route={form === "new" ? null : form} onUnauthorized={onUnauthorized} onCancel={() => setForm(null)}
        onSaved={(r, editing) => { setForm(null); setFeedback({ ok: true, text: editing ? `Saved changes to ${r.routeId}.` : `Created ${r.routeId}. Open Details to add stops.` }); load(); }} />}
      {confirm && <Confirm title={confirm.title} label={confirm.label} danger={confirm.danger !== false} busy={busy} onCancel={() => setConfirm(null)} onConfirm={doConfirm}><p>{confirm.text}</p></Confirm>}
    </>);

  if (open) return (
    <>
      {feedback && <div className="dash"><p role="status" className={feedback.ok ? "ok-note" : "form-error"}>{feedback.text}</p></div>}
      <RouteDetail route={open} stops={stops} buses={buses} canManage={canManage} onBack={() => setOpenId(null)} onEdit={(r) => { setFeedback(null); setForm(r); }} reload={load} onUnauthorized={onUnauthorized} setFeedback={setFeedback} askConfirm={askConfirm} />
      {modals}
    </>);
  if (openId && !open) setOpenId(null);

  return (
    <div className="dash">
      <section className="panel" aria-labelledby="h-routes">
        <div className="panel__head"><h2 id="h-routes">Routes</h2><span className="muted">{routes.length} total</span></div>
        <div className="toolbar">
          <div className="toolbar__search">
            <label className="sr-only" htmlFor="route-search">Search routes</label>
            <input id="route-search" type="search" placeholder="Search by ID, name, start or destination" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <label className="sr-only" htmlFor="route-filter">Filter by status</label>
          <select id="route-filter" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
          {canManage && <button className="btn btn--primary" onClick={() => { setFeedback(null); setForm("new"); }}>Create route</button>}
        </div>
        {!canManage && <p className="panel__note">View only. Administrators manage routes, stops and bus assignments.</p>}
        {feedback && <p role="status" className={feedback.ok ? "ok-note" : "form-error"}>{feedback.text}</p>}
        {error && <p className="alert" role="alert">{error} Showing the last update.</p>}
        {routes.length === 0 ? <div className="state"><h2>No routes yet</h2><p>{canManage ? "Create the first route." : "An administrator has not created any routes yet."}</p></div>
          : rows.length === 0 ? <div className="state"><h2>No routes match</h2><p>Try a different search or status filter.</p></div>
          : (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Route list">
              <table>
                <thead><tr><th scope="col">Route</th><th scope="col">From → to</th><th scope="col">Stops</th><th scope="col">Buses</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.routeId}>
                    <td><strong>{r.name}</strong><div className="muted small small--tight">{r.routeId}{r.tracked ? " · live tracking route" : ""}</div></td>
                    <td>{r.startPoint} → {r.destination}</td>
                    <td>{r.stops.length}</td>
                    <td>{r.buses.length ? r.buses.map((b) => b.name).join(", ") : <span className="muted">None</span>}</td>
                    <td><Badge tone={BUS_STATUS[r.status]?.tone ?? "off"}>{BUS_STATUS[r.status]?.label ?? r.status}</Badge></td>
                    <td className="actions">
                      <button className="btn btn--sm" onClick={() => { setFeedback(null); setOpenId(r.routeId); }} aria-label={`Details ${r.routeId}`}>Details</button>
                      {canManage && <>{" "}
                        <button className="btn btn--sm" onClick={() => { setFeedback(null); setForm(r); }} aria-label={`Edit ${r.routeId}`}>Edit</button>{" "}
                        {r.status === "active"
                          ? <button className="btn btn--sm" disabled={r.tracked} title={r.tracked ? "The live tracking route cannot be deactivated" : undefined} onClick={() => deactivate(r)} aria-label={`Deactivate ${r.routeId}`}>Deactivate</button>
                          : <button className="btn btn--sm" onClick={setStatus(r, "active")} aria-label={`Set active ${r.routeId}`}>Set active</button>}</>}
                    </td>
                  </tr>))}
                </tbody>
              </table>
            </div>)}
      </section>
      {modals}
    </div>
  );
}

function UsersPage({ me, onUnauthorized }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState(null); // { ok, text }
  const [conductors, setConductors] = useState({}); // username -> assigned busId
  const [busList, setBusList] = useState([]);          // active buses a conductor can be assigned to
  const loadAssign = useCallback(() => Promise.all([fetch("/api/conductors", { credentials: "same-origin" }), fetch("/api/buses", { credentials: "same-origin" })])
    .then(async ([c, b]) => {
      if (c.ok) setConductors(Object.fromEntries((await c.json()).conductors.map((x) => [x.username, x.busId])));
      if (b.ok) setBusList(((await b.json()).buses || []).filter((x) => x.status === "active"));
    }).catch(() => {}), []);
  const load = useCallback(() => fetch("/api/users", { credentials: "same-origin" })
    .then(async (r) => {
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      r.ok ? (setUsers(d), setError("")) : setError(d.error || "Request failed");
      loadAssign();
    })
    .catch(() => setError("Cannot reach the server.")), [onUnauthorized, loadAssign]);
  useEffect(() => { load(); }, [load]);

  const assign = async (username, busId) => {
    setFeedback(null);
    try {
      const r = await send("PUT", `/api/conductors/${encodeURIComponent(username)}/bus`, { busId: busId || null });
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setFeedback({ ok: false, text: d.error || "Assignment failed." });
      else setFeedback({ ok: true, text: busId ? `${username} now counts ${busId}.` : `Removed the bus assignment of ${username}.` });
      loadAssign();
    } catch { setFeedback({ ok: false, text: "Cannot reach the server." }); }
  };

  const update = async (username, change) => {
    setFeedback(null);
    try {
      const r = await send("PATCH", `/api/users/${encodeURIComponent(username)}`, change);
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setFeedback({ ok: false, text: d.error || "Update failed." });
      setFeedback({ ok: true, text: `Updated ${username}.` });
      load();
    } catch { setFeedback({ ok: false, text: "Cannot reach the server." }); }
  };

  if (error) return <State title="Unable to load users" text={error} />;
  if (!users) return <State title="Loading users" text="Fetching accounts…" />;
  return (
    <div className="dash">
      <section className="panel" aria-labelledby="h-users">
        <div className="panel__head"><h2 id="h-users">User accounts</h2><span className="muted">{users.length} total</span></div>
        {feedback && <p role="status" className={feedback.ok ? "muted" : "form-error"}>{feedback.text}</p>}
        <div className="table-wrap" tabIndex={0} role="region" aria-label="User accounts table">
          <table>
            <thead><tr><th scope="col">Username</th><th scope="col">Role</th><th scope="col">Assigned bus</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
            <tbody>{users.map((u) => {
              const self = u.username === me.username;
              return (
                <tr key={u.username}>
                  <td>{u.username}{self && <span className="muted"> (you)</span>}</td>
                  <td>
                    <select aria-label={`Role for ${u.username}`} value={u.role} disabled={self} onChange={(e) => update(u.username, { role: e.target.value })}>
                      {!ROLE_LABEL[u.role] && <option value={u.role}>{u.role} (invalid)</option>}
                      {ROLES.map((r) => (<option key={r} value={r}>{ROLE_LABEL[r]}</option>))}
                    </select>
                  </td>
                  <td>
                    {u.role === "conductor" ? (
                      <select aria-label={`Assigned bus for ${u.username}`} value={conductors[u.username] ?? ""} disabled={!u.active} onChange={(e) => assign(u.username, e.target.value)}>
                        <option value="">No bus</option>
                        {busList.map((b) => (<option key={b.busId} value={b.busId}>{b.name} ({b.busId})</option>))}
                      </select>
                    ) : <span className="muted">–</span>}
                  </td>
                  <td><Badge tone={u.active ? "ok" : "off"}>{u.active ? "Active" : "Inactive"}</Badge></td>
                  <td><button className="btn btn--sm" disabled={self} onClick={() => update(u.username, { active: !u.active })}>{u.active ? "Deactivate" : "Activate"}</button></td>
                </tr>);
            })}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function AuditPage({ onUnauthorized }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(() => fetch("/api/audit?limit=100", { credentials: "same-origin" })
    .then(async (r) => {
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      r.ok ? (setRows(d), setError("")) : setError(d.error || "Request failed");
    })
    .catch(() => setError("Cannot reach the server.")), [onUnauthorized]);
  useEffect(() => { load(); }, [load]);
  const tone = { success: "ok", denied: "bad", failure: "warn" };

  if (error) return <State title="Unable to load audit log" text={error} />;
  if (!rows) return <State title="Loading audit log" text="Fetching recent activity…" />;
  return (
    <div className="dash">
      <section className="panel" aria-labelledby="h-audit">
        <div className="panel__head"><h2 id="h-audit">Recent security activity</h2><button className="btn btn--sm" onClick={load}>Refresh</button></div>
        {rows.length === 0 ? <p className="muted">No activity recorded yet.</p> : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Audit log table">
            <table>
              <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">User</th><th scope="col">Target</th><th scope="col">Result</th><th scope="col">IP</th><th scope="col">Details</th></tr></thead>
              <tbody>{rows.map((e, i) => (
                <tr key={`${e.ts}-${i}`}>
                  <td>{new Date(e.ts).toLocaleString()}</td><td>{e.action.replaceAll("_", " ")}</td><td>{e.actor ?? "–"}</td><td>{e.target ?? "–"}</td>
                  <td><Badge tone={tone[e.outcome] || "info"}>{e.outcome}</Badge></td><td>{e.ip ?? "–"}</td>
                  <td>{e.detail ? Object.entries(e.detail).map(([k, v]) => `${k}: ${v}`).join(", ") : "–"}</td>
                </tr>))}</tbody>
            </table>
          </div>)}
      </section>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  setSocketIdentity(user && user.role !== "guest" ? `${user.username}\u0000${user.role}` : ""); // the live connection must carry the identity of whoever is signed in now (guests and signed-out are the same: no session); a new role reconnects too, because the server decides the rooms when connecting
  const [view, setView] = useState("dash");
  const [notif, setNotif] = useState({ unread: 0, items: null, error: "" }); // the signed-in user's own notifications (kept in PostgreSQL by the server)
  const [alertsTick, setAlertsTick] = useState(0);  // bumped when the server says the alerts changed, so lists reload
  const [mapFocus, setMapFocus] = useState(null);   // an alert's bus / route / stop the map should show
  const [toast, setToast] = useState("");
  const [focusToken, setFocusToken] = useState(0); // bumped by "View my bus on Live Map" so the map centres on the conductor's bus
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState("");
  const isMember = !!user && user.role !== "guest"; // guests are unauthenticated, public-map-only visitors
  // Notifications belong to one identity. Reset while rendering (not in an effect), so a frame with the previous user's content is never painted.
  // Clearing the toast also cancels its dismissal timer (the cleanup of the toast effect below).
  // `epoch` numbers each identity on screen, so a response can be tied to the one that asked for it, even when the same user signs in again.
  // The role is part of the identity: data loaded under a previous role (for example staff data after a demotion) is dropped too.
  const identity = user ? `${user.username}\u0000${user.role}` : null;
  const [session, setSession] = useState({ identity, epoch: 0 });
  const epoch = session.identity === identity ? session.epoch : session.epoch + 1;
  const epochRef = useRef(epoch);
  epochRef.current = epoch;
  if (session.identity !== identity) { setSession({ identity, epoch }); setToast(""); setNotif({ unread: 0, items: null, error: "" }); }
  const clearMapFocus = useCallback(() => { setMapFocus(null); setFocusToken(0); }, []);
  useEffect(() => { clearMapFocus(); }, [user?.username, clearMapFocus]); // a map focus belongs to one user: log out, expiry and account changes drop it

  const endSession = useCallback((message = "") => { setUser(null); setView("dash"); setNotice(message); }, []);
  // Every page reports a 401 through the `expire` of the identity that made the request. A report from an earlier identity is ignored.
  // Otherwise the server decides: the cookie may already belong to a newer session (a sign-in in another tab), so only a 401 from /api/me ends this one.
  const confirmingExpiry = useRef(null);
  const expire = useCallback(() => {
    if (epochRef.current !== epoch || confirmingExpiry.current === epoch) return;
    confirmingExpiry.current = epoch;
    fetch("/api/me", { credentials: "same-origin" })
      .then(async (r) => {
        if (epochRef.current !== epoch) return;
        if (r.status === 401) return endSession("Your session has expired. Please sign in again.");
        if (!r.ok) return;
        const u = await r.json();
        if (epochRef.current === epoch) setUser((prev) => (JSON.stringify(prev) === JSON.stringify(u) ? prev : u));
      })
      .catch(() => {}) // server unreachable: not proof the session ended; the next request or session check decides
      .finally(() => { if (confirmingExpiry.current === epoch) confirmingExpiry.current = null; });
  }, [epoch, endSession]);

  // Asks the server who this tab is signed in as, and follows the answer: another account, another role, signed out, or a sign-in made in
  // another tab. Only the server's answer counts; whatever prompted the check carries no identity. One check at a time; a prompt that
  // arrives meanwhile runs one more afterwards, so a change made after the request was sent is not missed.
  const userRef = useRef(user);
  userRef.current = user;
  const sessionCheck = useRef({ busy: false, again: false, last: 0 });
  const checkSession = useCallback(function run() {
    const c = sessionCheck.current;
    if (c.busy) { c.again = true; return; }
    c.busy = true; c.again = false; c.last = Date.now();
    const asked = epochRef.current;
    fetch("/api/me", { credentials: "same-origin" })
      .then(async (r) => {
        if (epochRef.current !== asked) return; // this tab changed account itself in the meantime
        const shown = userRef.current, member = !!shown && shown.role !== "guest";
        if (r.status === 401) { if (member) endSession("You were signed out. Please sign in again."); return; }
        if (!r.ok) return;
        const u = await r.json();
        if (epochRef.current !== asked) return;
        // The server may have ended our live connection although nothing changed in the end (a role changed and changed back): connect again.
        // When the account or role did change, the new identity reconnects it anyway (setSocketIdentity).
        if (shown && shown.username === u.username && shown.role === u.role && sharedSocket && !sharedSocket.active && sharedUsers > 0) sharedSocket.connect();
        setUser((prev) => (prev && JSON.stringify(prev) === JSON.stringify(u) ? prev : u));
        if (!member) { setNotice(""); setView("dash"); } // a sign-in made in another tab
      })
      .catch(() => {}) // server unreachable: change nothing; the next prompt or the minute check decides
      .finally(() => { c.busy = false; if (c.again) run(); });
  }, [endSession]);

  // Prompts: another tab signed in or out; this tab is shown, focused, resumed after being suspended, restored from the back/forward
  // cache, or back online. Tab activity is limited to one check every 3 seconds; messages from other tabs are always checked.
  useEffect(() => {
    const wake = () => { if (document.visibilityState === "visible" && Date.now() - sessionCheck.current.last > 3000) checkSession(); };
    const shown = (e) => { if (e.persisted) checkSession(); };
    document.addEventListener("visibilitychange", wake);
    document.addEventListener("resume", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", shown);
    const stop = onSessionChange(checkSession);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      document.removeEventListener("resume", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", shown);
      stop();
    };
  }, [checkSession]);

  // Restore an existing server session (e.g. after a page refresh).
  useEffect(() => {
    let live = true;
    fetch("/api/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => { if (live && u) { setUser(u); announceSessionChange(); } }) // a tab opened after a sign-in elsewhere (or a Google sign-in) lets the others check
      .catch(() => {})
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, []);

  // Notice an expired session, or a role change made by an administrator, even while only the map is open.
  useEffect(() => {
    if (!isMember) return;
    const t = setInterval(() => {
      fetch("/api/me", { credentials: "same-origin" })
        .then(async (r) => {
          if (epochRef.current !== epoch) return; // answer for an earlier identity
          if (r.status === 401) return expire();
          if (r.ok) { const u = await r.json(); if (epochRef.current === epoch) setUser((prev) => (JSON.stringify(prev) === JSON.stringify(u) ? prev : u)); }
        })
        .catch(() => {});
    }, 60000);
    return () => clearInterval(t);
  }, [isMember, epoch, expire]);

  // The dashboard response says who the server thinks we are; if our role changed, reload the account.
  const syncViewer = useCallback((v) => {
    if (user && v.role !== user.role) {
      fetch("/api/me", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((u) => { if (u && epochRef.current === epoch) setUser(u); }).catch(() => {});
    }
  }, [user, epoch]);

  const logout = async () => {
    if (isMember) { try { await post("/api/logout"); } catch { /* the cookie also expires on its own */ } announceSessionChange(); }
    endSession();
  };

  const loadNotif = useCallback(async () => {
    if (!isMember) return;
    const askedFor = epochRef.current, stale = () => epochRef.current !== askedFor; // a late answer for a previous session is dropped
    try {
      const r = await fetch("/api/notifications", { credentials: "same-origin" });
      if (stale()) return;
      if (r.status === 401) return expire();
      const d = await r.json().catch(() => null);
      if (stale()) return;
      if (!r.ok || !d || !Array.isArray(d.notifications)) return setNotif((p) => ({ ...p, error: "Notifications could not be loaded." }));
      setNotif({ unread: d.unread, items: d.notifications, error: "" });
    } catch { if (!stale()) setNotif((p) => ({ ...p, error: "Cannot reach the server." })); }
  }, [isMember, expire]);
  useEffect(() => { if (!isMember) { setNotif({ unread: 0, items: null, error: "" }); return; } loadNotif(); const t = setInterval(loadNotif, 60000); return () => clearInterval(t); }, [isMember, identity, loadNotif]);
  // One Socket.IO connection for the app. The server sends "notification" only to this user's own room; "alerts:changed" carries no content.
  useEffect(() => {
    if (!user) return;
    const sock = joinSocket();
    sock.on("notification", (n) => {
      if (!n || !n.alert) return;
      setNotif((p) => ({ ...p, unread: p.unread + 1, items: p.items ? [n, ...p.items.filter((x) => x.id !== n.id)] : p.items }));
      setToast(`New notification: ${n.alert.title}`); loadNotif();
    });
    sock.on("notification:read", () => loadNotif()); // another tab of this user read something
    sock.on("alerts:changed", () => { setAlertsTick((n) => n + 1); loadNotif(); }); // an alert was published, edited or resolved: lists and the notification states refresh
    sock.on("disconnect", (reason) => { if (reason === "io server disconnect") checkSession(); }); // the server ended our connection (sign-out, deactivation, role change): ask who we are now
    return () => sock.disconnect();
  }, [user?.username, loadNotif, checkSession]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 6000); return () => clearTimeout(t); }, [toast]);
  const readOne = async (id) => {
    setNotif((p) => ({ ...p, items: p.items && p.items.map((n) => (n.id === id ? { ...n, read: true } : n)), unread: p.items && p.items.some((n) => n.id === id && !n.read) ? Math.max(0, p.unread - 1) : p.unread }));
    try { const r = await send("PATCH", `/api/notifications/${id}/read`); if (r.status === 401) return expire(); } catch { /* the next refresh corrects the screen */ }
    loadNotif();
  };
  const readAll = async () => {
    setNotif((p) => ({ ...p, unread: 0, items: p.items && p.items.map((n) => ({ ...n, read: true })) }));
    try { const r = await post("/api/notifications/read-all", {}); if (r.status === 401) return expire(); } catch { /* corrected on the next refresh */ }
    loadNotif();
  };
  const showOnMap = (kind, id) => { setMapFocus({ kind, id, token: Date.now() }); setView("map"); };

  if (checking) return <main className="auth"><State title="Loading" text="Checking your session…" /></main>;
  if (!user) return <Login notice={notice} onLogin={(u) => { setUser(u); setNotice(""); setView("dash"); announceSessionChange(); }} onGuest={() => setUser({ username: "Guest", role: "guest", permissions: [] })} />;

  const isConductor = (user.permissions ?? []).includes("occupancy:update");
  const allowed = (v) => (!v.permission || (user.permissions ?? []).includes(v.permission)) && (!v.member || isMember);
  const canAlerts = (user.permissions ?? []).includes("alerts:manage");
  const nav = VIEWS.filter(allowed);
  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0];
  // The server enforces every permission; this only keeps the screen consistent with it.
  const page = !allowed(current) ? (
    <State title="Access denied" text={`Your role (${ROLE_LABEL[user.role] ?? "unknown"}) does not have permission to view this page.`}
      action={<button className="btn" onClick={() => setView("dash")}>Back to dashboard</button>} />
  ) : current.id === "map" ? <LiveMap key={user.username} canFleet={(user.permissions ?? []).includes("fleet:view")} isConductor={isConductor} isPassenger={user.role === "passenger"} focusToken={focusToken} alertsTick={alertsTick} mapFocus={mapFocus} onFocusUsed={clearMapFocus} />
    : current.id === "notifications" ? <NotificationsPage notif={notif} onRead={readOne} onReadAll={readAll} onFocus={showOnMap} onManage={canAlerts ? () => setView("alerts") : null} reload={loadNotif} />
    : current.id === "alerts" ? <AlertsPage onUnauthorized={expire} alertsTick={alertsTick} />
    : current.id === "counter" ? <CounterPage onUnauthorized={expire} />
    : current.id === "dash" && isConductor ? <ConductorHome onUnauthorized={expire} onNavigate={setView} onShowMap={() => { setFocusToken((n) => n + 1); setView("map"); }} onFocus={showOnMap} alertsTick={alertsTick} />
    : current.id === "dash" ? <Dashboard member={isMember} onUnauthorized={expire} onNavigate={setView} onViewer={syncViewer} onFocus={showOnMap} canManageAlerts={canAlerts} alertsTick={alertsTick} />
    : current.id === "buses" ? <BusesPage onUnauthorized={expire} />
    : current.id === "routes" ? <RoutesPage onUnauthorized={expire} />
    : current.id === "stops" ? <StopsPage onUnauthorized={expire} />
    : current.id === "users" ? <UsersPage me={user} onUnauthorized={expire} />
    : <AuditPage onUnauthorized={expire} />;
  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand"><span className="brand__mark"><Bus size={20} aria-hidden /></span>RouteWatch</div>
        <div className="rail__links">
          {[...new Set(nav.map((v) => v.group))].map((g) => (
            <div className="rail__group" key={g} role="group" aria-label={g}>
              <span className="rail__heading" aria-hidden>{g}</span>
              {nav.filter((v) => v.group === g).map(({ id, label, Icon }) => (
                <button key={id} className="rail__link" aria-current={view === id ? "page" : undefined} onClick={() => setView(id)} aria-label={label} title={label}><Icon size={18} aria-hidden /><span className="rail__text">{label}</span></button>))}
            </div>))}
        </div>
        <div className="rail__user"><span className="avatar" aria-hidden>{initials(user.username)}</span><span className="rail__who"><strong>{user.username}</strong><br /><span className="muted">{ROLE_LABEL[user.role] ?? user.role}</span></span>
          <button className="btn btn--icon" onClick={logout} aria-label={isMember ? "Log out" : "Back to sign in"}><LogOut size={18} aria-hidden /></button></div>
      </nav>
      <main className="main">
        <header className="topbar"><h1>{current.label}</h1>
          <span className="topbar__end"><span className="muted">Villanueva – CDO route</span>
            {isMember && (
              <button className="bell" onClick={() => setView("notifications")} aria-label={notif.unread > 0 ? `Notifications, ${notif.unread} unread` : "Notifications, none unread"} title="Notifications">
                <Bell size={18} aria-hidden />{notif.unread > 0 && <span className="bell__count" aria-hidden>{notif.unread > 99 ? "99+" : notif.unread}</span>}
              </button>)}
          </span></header>
        {toast && <div className="toast" role="status"><button className="toast__btn" onClick={() => { setToast(""); setView("notifications"); }}>{toast}</button></div>}
        {/* Page data belongs to one identity: a new `epoch` replaces the page in the same render that shows the new account,
            so the previous account's data is never painted and its late responses reach an unmounted page (React drops them). */}
        <Fragment key={epoch}>{page}</Fragment>
      </main>
    </div>
  );
}
