import { useCallback, useEffect, useState } from "react";
import { Map as MapIcon, MapPin } from "lucide-react";
import { fmt, timeFmt } from "../../utils/format.js";
import { TRACK, BUS_STATUS } from "../../utils/status.js";
import { ROLE_LABEL, ROLES } from "../../utils/roles.js";
import { joinSocket } from "../../services/socket.js"; // the one shared Socket.IO connection
import { Badge, OccBadge } from "../../components/ui/Badge.jsx";
import { State } from "../../components/ui/State.jsx";
import { AlertCard } from "../../components/alerts/AlertCard.jsx";

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
export function Dashboard({ member, onUnauthorized, onNavigate, onViewer, onFocus, canManageAlerts = false, alertsTick = 0 }) {
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
