import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Polyline, CircleMarker, Circle, Marker, Tooltip, Popup } from "react-leaflet";
import L from "leaflet";
import { RADIUS_OPTIONS, DEFAULT_RADIUS_M, POOR_ACCURACY_M, haversineMeters, formatDistance, formatRadius, hasLivePosition, findNearby, locationProblem } from "../../geo.js";
import { fmt, ago, timeFmt } from "../../utils/format.js";
import { TRACK, BUS_STATUS } from "../../utils/status.js";
import { joinSocket } from "../../services/socket.js"; // the one shared Socket.IO connection
import { Badge, OccBadge } from "../../components/ui/Badge.jsx";
import { State } from "../../components/ui/State.jsx";
import { AlertCard } from "../../components/alerts/AlertCard.jsx";
import { useActiveAlerts } from "../../hooks/useActiveAlerts.js";
import { Bus, Bell, MapPin, Clock, Radio, Route as RouteIcon, Megaphone, LocateFixed } from "lucide-react";
import { busIcon, meIcon, sourceLabel, direction, nextStopOf } from "./mapHelpers.js";
import { Fit, FlyTo, FocusBus } from "./MapFocus.jsx";
import { usePassengerLocation, LOCATION_CONSENT } from "./usePassengerLocation.js";

export function LiveMap({ canFleet, isConductor = false, isPassenger = false, focusToken = 0, alertsTick = 0, mapFocus = null, onFocusUsed }) {
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
