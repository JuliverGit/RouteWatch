import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Polyline, CircleMarker, Circle, Marker, Tooltip, Popup, useMap } from "react-leaflet";
import { RADIUS_OPTIONS, DEFAULT_RADIUS_M, POOR_ACCURACY_M, isLatLng, haversineMeters, formatDistance, formatRadius, hasLivePosition, findNearby, locationProblem } from "./geo.js";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import AuthScreen from "./Auth.jsx";
import { announceSessionChange, onSessionChange } from "./sessionSync.js";
import { fmt, ago, timeFmt, initials } from "./utils/format.js";
import { TRACK, BUS_STATUS } from "./utils/status.js";
import { ROLE_LABEL } from "./utils/roles.js";
import { send, post } from "./services/http.js";
import { joinSocket, setSocketIdentity, reconnectIfDropped } from "./services/socket.js"; // the one shared Socket.IO connection
import { Badge, OccBadge } from "./components/ui/Badge.jsx";
import { State } from "./components/ui/State.jsx";
import { useActiveAlerts } from "./hooks/useActiveAlerts.js";
import { AlertCard } from "./components/alerts/AlertCard.jsx";
import { Dashboard } from "./pages/common/DashboardPage.jsx";
import { NotificationsPage } from "./pages/common/NotificationsPage.jsx";
import { AlertsPage } from "./pages/staff/AlertsPage.jsx";
import { BusesPage } from "./pages/staff/BusesPage.jsx";
import { StopsPage } from "./pages/staff/StopsPage.jsx";
import { RoutesPage } from "./pages/staff/RoutesPage.jsx";
import { UsersPage } from "./pages/admin/UsersPage.jsx";
import { AuditPage } from "./pages/admin/AuditPage.jsx";
import { CounterPage } from "./pages/conductor/CounterPage.jsx";
import { ConductorHome } from "./pages/conductor/ConductorHome.jsx";
import { Bus, Map as MapIcon, LayoutDashboard, LogOut, Bell, MapPin, Clock, Users, ScrollText, Radio, Route as RouteIcon, Ticket, Megaphone, LocateFixed } from "lucide-react";

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
        if (shown && shown.username === u.username && shown.role === u.role) reconnectIfDropped();
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
