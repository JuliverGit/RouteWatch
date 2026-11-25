import { useState } from "react";
import { coordText } from "../../utils/format.js";
import { BUS_STATUS } from "../../utils/status.js";
import { send } from "../../services/http.js";
import { Badge } from "../../components/ui/Badge.jsx";
import { State } from "../../components/ui/State.jsx";
import { Modal, Confirm } from "../../components/ui/Modal.jsx";
import { Field } from "../../components/ui/Field.jsx";
import { useStaffData } from "../../hooks/useStaffData.js";
import { change } from "./change.js";

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

export function StopsPage({ onUnauthorized }) {
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
