import { useCallback, useEffect, useState } from "react";
import { TRACK, BUS_STATUS } from "../../utils/status.js";
import { send } from "../../services/http.js";
import { Badge } from "../../components/ui/Badge.jsx";
import { State } from "../../components/ui/State.jsx";
import { Modal } from "../../components/ui/Modal.jsx";
import { Field } from "../../components/ui/Field.jsx";

// ---- Bus management ----
// Administrators can add, edit and deactivate buses; dispatchers can only look. The server enforces this
// (buses:manage / buses:read); the buttons are hidden for dispatchers only so the screen matches.
const EMPTY_BUS = { busId: "", name: "", plate: "", capacity: "", model: "", status: "active", simulatedGps: true };

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

export function BusesPage({ onUnauthorized }) {
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
