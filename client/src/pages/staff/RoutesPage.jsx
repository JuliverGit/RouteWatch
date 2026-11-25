import { useState } from "react";
import { BUS_STATUS } from "../../utils/status.js";
import { send } from "../../services/http.js";
import { Badge } from "../../components/ui/Badge.jsx";
import { State } from "../../components/ui/State.jsx";
import { Modal, Confirm } from "../../components/ui/Modal.jsx";
import { Field } from "../../components/ui/Field.jsx";
import { useStaffData } from "../../hooks/useStaffData.js";
import { change } from "./change.js";
import { RouteDetail } from "./RouteDetailPage.jsx";

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

export function RoutesPage({ onUnauthorized }) {
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
