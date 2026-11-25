import { useCallback, useEffect, useState } from "react";
import { Map as MapIcon, Ticket } from "lucide-react";
import { ago, timeFmt } from "../../utils/format.js";
import { TRACK } from "../../utils/status.js";
import { joinSocket } from "../../services/socket.js"; // the one shared Socket.IO connection
import { Badge } from "../../components/ui/Badge.jsx";
import { State } from "../../components/ui/State.jsx";
import { AlertCard } from "../../components/alerts/AlertCard.jsx";
import { useActiveAlerts } from "../../hooks/useActiveAlerts.js";

// ---- Conductor dashboard ----
// What a conductor sees first: the bus the server says is theirs, its route, passengers and tracking. Read-only: the count is
// changed only on the Passenger counter page. Everything comes from /api/conductor/bus (signed-in session + PostgreSQL); the
// Socket.IO "occupancy" and "buses" events keep it current without a refresh.
export function ConductorHome({ onUnauthorized, onNavigate, onShowMap, onFocus, alertsTick }) {
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
