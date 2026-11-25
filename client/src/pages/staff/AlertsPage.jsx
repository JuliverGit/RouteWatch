import { useEffect, useState } from "react";
import { dateTime } from "../../utils/format.js";
import { SEV, ASTATE } from "../../utils/status.js";
import { send, post } from "../../services/http.js";
import { Badge } from "../../components/ui/Badge.jsx";
import { State } from "../../components/ui/State.jsx";
import { Modal, Confirm } from "../../components/ui/Modal.jsx";
import { Field } from "../../components/ui/Field.jsx";
import { useStaffData } from "../../hooks/useStaffData.js";

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

export function AlertsPage({ onUnauthorized, alertsTick }) {
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
