// Service alerts and user notifications (Phase 7).
// Storage (PostgreSQL): service_alerts and notifications (migration 003). This is the only code that changes either table.
//
// Lifecycle:  draft -> published -> resolved   (a draft can also be discarded: draft -> resolved)
//   "expired" is not stored: a published alert whose expiry time has passed is reported as expired when it is read, so it can
//   never look active and no background job is needed. Alerts are never deleted; history stays for audit.
//
// Who is told when an alert is published (decided here, in SQL, from the database; never from anything the browser sends):
//   administrators and dispatchers  every alert except the one they published themselves
//   conductors                      alerts with no bus/route/stop (general) or ones that concern THEIR bus, THEIR bus's route or a stop on it
//   passengers                      public alerts only. There are no passenger subscriptions in RouteWatch, so every public alert reaches
//                                   every active passenger account; visitors without an account see public alerts on the map and dashboard.
import { query, tx } from "./db.js";

export const CATEGORIES = {
  bus_delay: "Bus delay", route_disruption: "Route disruption", route_change: "Route change",
  stop_closure: "Stop closure", service_interruption: "Service interruption", general: "General announcement",
};
export const SEVERITIES = ["info", "warning", "critical"];
export const AUDIENCES = ["public", "staff"];
const STAFF = ["admin", "dispatcher"];

// What an alert must be about. A general announcement and a service interruption need no bus, route or stop.
const NEEDS = {
  bus_delay: { field: "busId", text: "A bus delay must name the bus." },
  route_disruption: { field: "routeId", text: "A route disruption must name the route." },
  route_change: { field: "routeId", text: "A route change must name the route." },
  stop_closure: { field: "stopId", text: "A stop closure must name the bus stop." },
};

const fail = (error, status, code, field) => ({ error, status, code, field });
const ID_RE = /^[A-Z0-9][A-Z0-9-]{1,15}$/;
const MAX_DAYS = 365;

/** Dispatchers manage operational alerts; general announcements are for administrators. */
export const canManage = (role, category) => role === "admin" || (role === "dispatcher" && category !== "general");

// ---- Validation ----
const clean = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : null);

/** Validates ONE field. Returns { value } or an error object. Anything not listed here is never read from the request. */
function checkField(field, raw) {
  switch (field) {
    case "title": {
      const v = clean(raw);
      if (!v || v.length < 3 || v.length > 120) return fail("Title must be 3-120 characters.", 400, "invalid", field);
      if (/[<>]/.test(v) || /[\u0000-\u001f\u007f]/.test(v)) return fail("Title cannot contain < or > or control characters.", 400, "invalid", field);
      return { value: v };
    }
    case "description": {
      const v = clean(raw);
      if (!v || v.length < 5 || v.length > 600) return fail("Description must be 5-600 characters.", 400, "invalid", field);
      if (/[<>]/.test(v) || /[\u0000-\u001f\u007f]/.test(v)) return fail("Description cannot contain < or > or control characters.", 400, "invalid", field);
      return { value: v };
    }
    case "category": return Object.hasOwn(CATEGORIES, raw) ? { value: raw } : fail("Choose a category.", 400, "invalid", field);
    case "severity": return SEVERITIES.includes(raw) ? { value: raw } : fail("Choose a severity.", 400, "invalid", field);
    case "audience": return AUDIENCES.includes(raw) ? { value: raw } : fail("Choose who can see this alert.", 400, "invalid", field);
    case "busId": case "routeId": case "stopId": {
      if (raw === null || raw === "") return { value: null };
      const v = typeof raw === "string" ? raw.trim().toUpperCase() : null;
      return v && ID_RE.test(v) ? { value: v } : fail("Invalid selection.", 400, "invalid", field);
    }
    case "expiresAt": {
      if (raw === null || raw === "") return { value: null };
      const t = typeof raw === "string" ? Date.parse(raw) : NaN;
      if (!Number.isFinite(t)) return fail("Enter a valid expiry date and time.", 400, "invalid", field);
      if (t <= Date.now() + 30_000) return fail("The expiry must be in the future.", 400, "invalid", field);
      if (t > Date.now() + MAX_DAYS * 86_400_000) return fail(`The expiry cannot be more than ${MAX_DAYS} days away.`, 400, "invalid", field);
      return { value: new Date(t).toISOString() };
    }
    default: return fail("Invalid field.", 400, "invalid", field);
  }
}
const COLUMN = { title: "title", description: "description", category: "category", severity: "severity", audience: "audience", busId: "bus_id", routeId: "route_id", stopId: "stop_id", expiresAt: "expires_at" };

/** The bus, route or stop an alert names must exist (a clear message instead of a database error). */
async function linksExist(c, v) {
  const probes = [["busId", "SELECT 1 FROM buses WHERE bus_id = $1", "That bus does not exist."], ["routeId", "SELECT 1 FROM routes WHERE route_id = $1", "That route does not exist."], ["stopId", "SELECT 1 FROM stops WHERE stop_id = $1", "That bus stop does not exist."]];
  for (const [f, sql, text] of probes) if (v[f] && !(await c.query(sql, [v[f]])).rowCount) return fail(text, 400, "invalid", f);
  return null;
}

// ---- Reading ----
const SELECT = `
  SELECT a.*, CASE WHEN a.status = 'published' AND a.expires_at IS NOT NULL AND a.expires_at <= now() THEN 'expired'
                   WHEN a.status = 'published' THEN 'active' ELSE a.status END AS state,
         b.name AS bus_name, r.name AS route_name, s.name AS stop_name
    FROM service_alerts a
    LEFT JOIN buses b ON b.bus_id = a.bus_id LEFT JOIN routes r ON r.route_id = a.route_id LEFT JOIN stops s ON s.stop_id = a.stop_id`;
const ACTIVE = `a.status = 'published' AND (a.expires_at IS NULL OR a.expires_at > now())`;
const iso = (d) => (d ? d.toISOString() : null);

/** How an alert looks to a viewer. Who created or published it is shown to staff only. */
export function alertView(r, staff = false) {
  return {
    id: Number(r.alert_id), title: r.title, description: r.description, category: r.category, categoryLabel: CATEGORIES[r.category],
    severity: r.severity, audience: r.audience, status: r.status, state: r.state,
    busId: r.bus_id ?? null, busName: r.bus_name ?? null, routeId: r.route_id ?? null, routeName: r.route_name ?? null, stopId: r.stop_id ?? null, stopName: r.stop_name ?? null,
    createdAt: iso(r.created_at), publishedAt: iso(r.published_at), expiresAt: iso(r.expires_at), resolvedAt: iso(r.resolved_at),
    ...(staff ? { createdBy: r.created_by, publishedBy: r.published_by ?? null, resolvedBy: r.resolved_by ?? null } : {}),
  };
}

// Conductors only see alerts about their own bus, their bus's route, or a stop on that route (plus general ones).
const CONDUCTOR_RELEVANT = (p) => `(
  (a.bus_id IS NULL AND a.route_id IS NULL AND a.stop_id IS NULL) OR EXISTS (
    SELECT 1 FROM conductor_assignments ca LEFT JOIN bus_route_assignments bra ON bra.bus_id = ca.bus_id
     WHERE ca.conductor = ${p} AND (ca.bus_id = a.bus_id OR bra.route_id = a.route_id
           OR EXISTS (SELECT 1 FROM route_stops rs WHERE rs.route_id = bra.route_id AND rs.stop_id = a.stop_id))))`;

/**
 * Alerts that are active right now AND meant for this viewer: administrators and dispatchers see all, a conductor the relevant
 * ones, everyone else (passengers, visitors) the public ones. `user` is null for a visitor. Most severe and newest first.
 */
export async function listActive(user) {
  const role = user?.role ?? null;
  const staff = STAFF.includes(role);
  let where = `${ACTIVE} AND a.audience = 'public'`, params = [];
  if (staff) where = ACTIVE;
  else if (role === "conductor") { where = `${ACTIVE} AND ${CONDUCTOR_RELEVANT("$1")}`; params = [user.username]; }
  const r = await query(`${SELECT} WHERE ${where}
    ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.published_at DESC, a.alert_id DESC LIMIT 50`, params);
  return r.rows.map((x) => alertView(x, staff));
}

/** All alerts for the management page (administrators and dispatchers). */
export async function listManage(filter) {
  const where = { active: ACTIVE, draft: "a.status = 'draft'", resolved: "a.status = 'resolved'", expired: "a.status = 'published' AND a.expires_at IS NOT NULL AND a.expires_at <= now()" }[filter] ?? "TRUE";
  const r = await query(`${SELECT} WHERE ${where} ORDER BY a.created_at DESC, a.alert_id DESC LIMIT 200`);
  return r.rows.map((x) => alertView(x, true));
}

async function getRow(c, id) { return (await c.query(`${SELECT} WHERE a.alert_id = $1`, [id])).rows[0] ?? null; }

// ---- Changing alerts ----
const gone = () => fail("Alert not found.", 404, "not_found");
const forbidden = () => fail("Only an administrator can manage general announcements.", 403, "category_forbidden");

/** Creates a DRAFT. Nobody is notified until it is published. Returns { alert } or an error object. */
export async function createAlert(actor, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("Invalid request.", 400, "invalid", "body");
  const v = { busId: null, routeId: null, stopId: null, expiresAt: null, audience: "public" };
  for (const f of ["title", "description", "category", "severity"]) { const r = checkField(f, input[f]); if (r.error) return r; v[f] = r.value; }
  for (const f of ["audience", "busId", "routeId", "stopId", "expiresAt"]) if (input[f] !== undefined) { const r = checkField(f, input[f]); if (r.error) return r; v[f] = r.value; }
  if (!canManage(actor.role, v.category)) return forbidden();
  const need = NEEDS[v.category]; if (need && !v[need.field]) return fail(need.text, 400, "invalid", need.field);
  return tx(async (c) => {
    const bad = await linksExist(c, v); if (bad) return bad;
    const id = (await c.query(
      `INSERT INTO service_alerts (title, description, category, severity, audience, bus_id, route_id, stop_id, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING alert_id`,
      [v.title, v.description, v.category, v.severity, v.audience, v.busId, v.routeId, v.stopId, v.expiresAt, actor.username])).rows[0].alert_id;
    return { alert: alertView(await getRow(c, id), true) };
  });
}

/**
 * Edits an alert. A draft can change anything. A published alert can only have its description, severity and expiry corrected
 * (the notifications already sent were about its title, category, audience and links, so those stay fixed). Resolved: read-only.
 */
export async function updateAlert(actor, id, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("Invalid request.", 400, "invalid", "body");
  const changes = {};
  for (const f of Object.keys(COLUMN)) if (f in input) { const r = checkField(f, input[f]); if (r.error) return r; changes[f] = r.value; }
  if (!Object.keys(changes).length) return fail("Nothing to update.", 400, "invalid", "body");
  return tx(async (c) => {
    if (!(await c.query("SELECT 1 FROM service_alerts WHERE alert_id = $1 FOR UPDATE", [id])).rowCount) return gone();
    const cur = await getRow(c, id);
    if (!canManage(actor.role, cur.category) || (changes.category && !canManage(actor.role, changes.category))) return forbidden();
    if (cur.status === "resolved") return fail("A resolved alert cannot be changed. Create a new alert instead.", 409, "resolved");
    if (cur.status === "published") {
      const locked = Object.keys(changes).filter((f) => !["description", "severity", "expiresAt"].includes(f) && changes[f] !== (cur[COLUMN[f]] ?? null));
      if (locked.length) return fail("A published alert can only change its description, severity and expiry.", 409, "published_locked", locked[0]);
      for (const f of Object.keys(changes)) if (!["description", "severity", "expiresAt"].includes(f)) delete changes[f];
      if (!Object.keys(changes).length) return fail("Nothing to update.", 400, "invalid", "body");
    }
    const merged = { category: cur.category, busId: cur.bus_id, routeId: cur.route_id, stopId: cur.stop_id, ...changes };
    const need = NEEDS[merged.category]; if (need && !merged[need.field]) return fail(need.text, 400, "invalid", need.field);
    const bad = await linksExist(c, changes); if (bad) return bad;
    const sets = Object.keys(changes).map((f, i) => `${COLUMN[f]} = $${i + 2}`); // column names come from the fixed list above, never from the request
    await c.query(`UPDATE service_alerts SET ${sets.join(", ")} WHERE alert_id = $1`, [id, ...Object.keys(changes).map((f) => changes[f])]);
    return { alert: alertView(await getRow(c, id), true), changed: Object.keys(changes), before: cur.status };
  });
}

/**
 * Publishes a draft. In ONE transaction: lock the alert, check it, mark it published and create a notification for every
 * recipient. If anything fails nothing is kept, and two simultaneous publishes cannot both succeed.
 * Returns { alert, recipients: [{ username, role, notificationId, createdAt }] } or an error object.
 */
export async function publishAlert(actor, id) {
  return tx(async (c) => {
    const a = (await c.query("SELECT * FROM service_alerts WHERE alert_id = $1 FOR UPDATE", [id])).rows[0];
    if (!a) return gone();
    if (!canManage(actor.role, a.category)) return forbidden();
    if (a.status !== "draft") return fail(a.status === "published" ? "This alert is already published." : "A resolved alert cannot be published.", 409, a.status === "published" ? "already_published" : "resolved");
    if (a.expires_at && a.expires_at <= new Date()) return fail("The expiry time has already passed. Change it before publishing.", 409, "expired", "expiresAt");
    await c.query("UPDATE service_alerts SET status = 'published', published_at = now(), published_by = $2 WHERE alert_id = $1", [id, actor.username]);
    const ins = await c.query(
      `WITH ins AS (
         INSERT INTO notifications (username, alert_id)
         SELECT u.username, $1 FROM users u
          WHERE u.active AND u.username <> $2 AND (
                u.role IN ('admin', 'dispatcher')
             OR (u.role = 'passenger' AND $3 = 'public')
             OR (u.role = 'conductor' AND (
                   ($4::text IS NULL AND $5::text IS NULL AND $6::text IS NULL) OR EXISTS (
                     SELECT 1 FROM conductor_assignments ca LEFT JOIN bus_route_assignments bra ON bra.bus_id = ca.bus_id
                      WHERE ca.conductor = u.username AND (ca.bus_id = $4 OR bra.route_id = $5
                            OR EXISTS (SELECT 1 FROM route_stops rs WHERE rs.route_id = bra.route_id AND rs.stop_id = $6))))))
         ON CONFLICT (username, alert_id) DO NOTHING
         RETURNING notification_id, username, created_at)
       SELECT ins.notification_id, ins.username, ins.created_at, u.role FROM ins JOIN users u ON u.username = ins.username`,
      [id, actor.username, a.audience, a.bus_id, a.route_id, a.stop_id]);
    return {
      alert: alertView(await getRow(c, id), true),
      recipients: ins.rows.map((x) => ({ username: x.username, role: x.role, notificationId: Number(x.notification_id), createdAt: x.created_at.toISOString() })),
    };
  });
}

/** Ends an alert (published, or a draft that is being discarded). The record stays. */
export async function resolveAlert(actor, id) {
  return tx(async (c) => {
    const a = (await c.query("SELECT * FROM service_alerts WHERE alert_id = $1 FOR UPDATE", [id])).rows[0];
    if (!a) return gone();
    if (!canManage(actor.role, a.category)) return forbidden();
    if (a.status === "resolved") return fail("This alert is already resolved.", 409, "resolved");
    await c.query("UPDATE service_alerts SET status = 'resolved', resolved_at = now(), resolved_by = $2 WHERE alert_id = $1", [id, actor.username]);
    return { alert: alertView(await getRow(c, id), true), before: a.status };
  });
}

// ---- Notifications (a user can only ever reach their own rows: every query filters on the session's username) ----
const notifView = (r, staff) => ({ id: Number(r.notification_id), receivedAt: iso(r.n_created), read: r.read_at !== null, readAt: iso(r.read_at), alert: alertView(r, staff) });

export async function listNotifications(user, limit = 50) {
  const staff = STAFF.includes(user.role);
  const rows = (await query(
    `SELECT n.notification_id, n.created_at AS n_created, n.read_at, x.*
       FROM notifications n JOIN LATERAL (${SELECT} WHERE a.alert_id = n.alert_id) x ON TRUE
      WHERE n.username = $1 ORDER BY n.created_at DESC, n.notification_id DESC LIMIT $2`, [user.username, limit])).rows;
  const unread = (await query("SELECT count(*)::int AS n FROM notifications WHERE username = $1 AND read_at IS NULL", [user.username])).rows[0].n;
  return { unread, notifications: rows.map((r) => notifView(r, staff)) };
}

export const unreadCount = async (username) => (await query("SELECT count(*)::int AS n FROM notifications WHERE username = $1 AND read_at IS NULL", [username])).rows[0].n;

/** Marks ONE of the user's own notifications as read. Someone else's id looks exactly like a missing one. */
export async function markRead(username, id) {
  const r = await query("UPDATE notifications SET read_at = now() WHERE notification_id = $1 AND username = $2 AND read_at IS NULL RETURNING notification_id", [id, username]);
  if (!r.rowCount && !(await query("SELECT 1 FROM notifications WHERE notification_id = $1 AND username = $2", [id, username])).rowCount) return fail("Notification not found.", 404, "not_found");
  return { id, unread: await unreadCount(username), changed: r.rowCount === 1 };
}

export async function markAllRead(username) {
  const r = await query("UPDATE notifications SET read_at = now() WHERE username = $1 AND read_at IS NULL", [username]);
  return { marked: r.rowCount, unread: await unreadCount(username) };
}

