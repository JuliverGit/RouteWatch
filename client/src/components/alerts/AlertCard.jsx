import { Bus, Route as RouteIcon, MapPin } from "lucide-react";
import { brief, dateTime } from "../../utils/format.js";
import { SEV, ASTATE } from "../../utils/status.js";
import { Badge } from "../ui/Badge.jsx";

// ---- Service alerts and notifications (Phase 7) ----
// An alert is written by an administrator or dispatcher; the SERVER decides who is notified and who may read it. These screens
// only show what the server returns for the signed-in user (or visitor) and send the user's actions back.

/** Buttons that jump to the bus, route or stop an alert is about (the map does the rest). */
export function AlertLinks({ alert, onFocus }) {
  if (!onFocus || !(alert.busId || alert.routeId || alert.stopId)) return null;
  return (
    <div className="alertcard__links">
      {alert.busId && <button className="btn btn--sm" onClick={() => onFocus("bus", alert.busId)} aria-label={`Show bus ${alert.busName ?? alert.busId} on the map`}><Bus size={14} aria-hidden /> {alert.busName ?? alert.busId}</button>}
      {alert.routeId && <button className="btn btn--sm" onClick={() => onFocus("route", alert.routeId)} aria-label={`Show route ${alert.routeName ?? alert.routeId} on the map`}><RouteIcon size={14} aria-hidden /> {alert.routeName ?? alert.routeId}</button>}
      {alert.stopId && <button className="btn btn--sm" onClick={() => onFocus("stop", alert.stopId)} aria-label={`Show stop ${alert.stopName ?? alert.stopId} on the map`}><MapPin size={14} aria-hidden /> {alert.stopName ?? alert.stopId}</button>}
    </div>);
}

export function AlertCard({ alert, onFocus, compact = false }) {
  return (
    <article className={`alertcard alertcard--${alert.severity}`}>
      <div className="alertcard__head">
        <Badge tone={SEV[alert.severity]?.tone ?? "off"}>{SEV[alert.severity]?.label ?? alert.severity}</Badge>
        <span className="muted small">{alert.categoryLabel}</span>
        {alert.audience === "staff" && <Badge tone="off">Staff only</Badge>}
        {alert.state !== "active" && <Badge tone={ASTATE[alert.state]?.tone ?? "off"}>{ASTATE[alert.state]?.label ?? alert.state}</Badge>}
      </div>
      <h3 className="alertcard__title">{alert.title}</h3>
      <p className="alertcard__text">{compact ? brief(alert.description) : alert.description}</p>
      <div className="muted small small--tight">{alert.publishedAt ? `Published ${dateTime(alert.publishedAt)}` : ""}{alert.expiresAt ? ` · Until ${dateTime(alert.expiresAt)}` : ""}</div>
      <AlertLinks alert={alert} onFocus={onFocus} />
    </article>);
}
