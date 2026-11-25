import { useState } from "react";
import { ArrowUp, ArrowDown } from "lucide-react";
import { BUS_STATUS } from "../../utils/status.js";
import { Badge } from "../../components/ui/Badge.jsx";
import { change } from "./change.js";

export function RouteDetail({ route, stops, buses, canManage, onBack, onEdit, reload, onUnauthorized, setFeedback, askConfirm }) {
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
