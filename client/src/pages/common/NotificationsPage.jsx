import { useState } from "react";
import { CheckCheck } from "lucide-react";
import { brief, dateTime } from "../../utils/format.js";
import { SEV, ASTATE } from "../../utils/status.js";
import { Badge } from "../../components/ui/Badge.jsx";
import { State } from "../../components/ui/State.jsx";
import { AlertLinks } from "../../components/alerts/AlertCard.jsx";

// ---- Notification center ----
// The list, the unread count and the read marks all live on the server (PostgreSQL); this page asks for the user's own and shows them.
export function NotificationsPage({ notif, onRead, onReadAll, onFocus, onManage, reload }) {
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
