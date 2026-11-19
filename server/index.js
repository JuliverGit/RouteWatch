import "./env.js"; // reads server/.env (database settings and the other options); real environment variables win
import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { verifyCredentials, countUsers, findUser, findUserByLogin, listUsers, updateUser, USERNAME_RE, EMAIL_MAX } from "./users.js";
import { registerAuthRoutes } from "./auth-routes.js";
import {
  ALLOWED_ORIGIN, attachUser, requireAuth, requirePermission, forbid, csrfGuard, securityHeaders,
  createSession, destroySession, destroyUserSessions, setSessionCookie, clearSessionCookie, createLimiter, loadUser,
} from "./auth.js";
import { ROLES, can, isRole, permissionsFor } from "./permissions.js";
import { audit, readAudit, flushAudit } from "./audit.js";
import { ping, close as closeDb } from "./db.js";
import { latestVersion } from "./migrate.js";

import { STOPS, W, TOTAL, ROUTE_NAME, isReady, SEED_STOPS, configureStops, renameStops } from "./route.js";
import { routing, startRouting, requestRetry, reloadRouting } from "./routing.js";
import { roadGeometry } from "./roadgeo.js";
import { ingest, snapshot, staffSnapshot, trackingSource, trackingStats, watchConnections, forget, forgetAll, fleetContext } from "./tracking.js";
import { fork } from "node:child_process";
import { deviceForBus, setSimulation } from "./devices.js";
import { createAlert, updateAlert, publishAlert, resolveAlert, listActive, listManage, listNotifications, markRead, markAllRead, CATEGORIES, SEVERITIES, AUDIENCES, canManage } from "./alerts.js";
import { listBuses, getBus, createBus, updateBus, STATUSES } from "./buses.js";
import { ACTIONS, occupancyView, assignedBus, listConductors, assignConductor, changeCount } from "./occupancy.js";

import {
  TRACKED_ROUTE_ID, ID_PATTERN, STOP_STATUSES, ROUTE_STATUSES, listStops, listRoutes, getRoute, publicNetwork, trackedSpec, assignmentMap,
  createStop, updateStop, createRoute, updateRoute, addRouteStop, removeRouteStop, reorderRouteStops, assignBus, bootstrapNetwork,
} from "./network.js";

// ---- Database ----
// The server will not start against a database it cannot reach or whose tables are missing or out of date.
try {
  const info = await ping(), need = latestVersion();
  if (info.schema < need) throw new Error(`the database schema is out of date (version ${info.schema}, needs ${need}). Run: npm run db:migrate`);
  console.log(`[db] connected to PostgreSQL ${info.version} as "${info.user}", schema version ${info.schema}`);
} catch (e) {
  console.error(`[db] cannot start: ${e.message}`);
  process.exit(1);
}

// Express 4 does not catch a rejected promise from an async handler. This wrapper sends it to the error handler below.
const A = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const PORT = Number(process.env.PORT || 5000);

const app = express();
app.disable("x-powered-by");
app.use(securityHeaders);
// A response is sent only after the audit entries logged so far have been written to the database. So when a user (or a
// test) sees the answer to a login, a denial or a change, its audit record already exists. Normally this adds no delay.
app.use((req, res, next) => {
  const end = res.end;
  res.end = function (...args) { flushAudit().then(() => end.apply(this, args)); return this; };
  next();
});
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json({ limit: "2kb" }));
app.use(attachUser);
app.use(csrfGuard);
const server = http.createServer(app);
// Live bus positions are public and read-only (passengers can view the map without an account).
// Operational detail goes only to the "staff" room, which a socket can join only through its
// own server-side session, and the browser can send no events that change anything.
const io = new Server(server, { cors: { origin: ALLOWED_ORIGIN } });
io.use(async (socket, next) => {
  const origin = socket.handshake.headers.origin;
  if (origin && origin !== ALLOWED_ORIGIN) return next(new Error("Forbidden")); // blocks cross-site WebSocket hijacking
  try { await loadUser(socket.request); next(); } // same session check as the HTTP API
  catch { next(new Error("Unavailable")); }
});
const isStaff = (u) => !!u && can(u.role, "fleet:view");
io.on("connection", async (socket) => {
  try {
    if (isStaff(socket.request.user)) socket.join("staff");
    // A signed-in user also joins a private room of their own. Notifications are sent ONLY to that room, so nobody can receive another user's.
    // The room name comes from the server-side session, never from anything the browser sends.
    if (socket.request.user) { socket.data.user = socket.request.user.username; socket.join(`user:${socket.data.user}`); }
    const ctx = await fleetContext();
    socket.emit("buses", await snapshot(ctx));
    if (isStaff(socket.request.user)) socket.emit("tracking:staff", await staffSnapshot(ctx));
  } catch (e) { console.error(`[socket] initial data failed (${e.code || e.message})`); }
  // Deliberately no handlers for client events: a socket cannot submit or change locations.
});

// Closes the live connections of a session that has ended (logout), or of every session of a user (deactivated). A connection
// whose session expires on its own is closed by the periodic check below, so a stale socket cannot keep receiving notifications.
const dropSockets = async (match) => { try { for (const s of await io.fetchSockets()) if (match(s)) s.disconnect(true); } catch { /* best effort */ } };
const RECHECK_MS = Number(process.env.SOCKET_RECHECK_SECONDS || 60) * 1000;
setInterval(async () => {
  try {
    for (const s of await io.fetchSockets()) {
      if (!s.data.user) continue;
      const probe = { headers: s.handshake.headers };
      await loadUser(probe);
      if (!probe.user || probe.user.username !== s.data.user) s.disconnect(true);
    }
  } catch { /* the database may be briefly unreachable; try again next round */ }
}, RECHECK_MS).unref();

// ---- Authentication ----
const LOGIN_MAX = Number(process.env.LOGIN_MAX_ATTEMPTS || 5); // failed attempts per username, per IP
const LOGIN_WINDOW_MS = Number(process.env.LOGIN_WINDOW_MINUTES || 15) * 60_000;
const accountLimiter = createLimiter({ max: LOGIN_MAX, windowMs: LOGIN_WINDOW_MS });
const ipLimiter = createLimiter({ max: LOGIN_MAX * 4, windowMs: LOGIN_WINDOW_MS });

app.post("/api/login", A(async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password)
      return res.status(400).json({ error: "Enter your username and password." });

    const ipKey = req.ip;
    const accountKey = `${req.ip}|${username.trim().toLowerCase()}`;
    const wait = Math.max(ipLimiter.blockedFor(ipKey), accountLimiter.blockedFor(accountKey));
    // The account name is only written to the audit log when it exists, so a password
    // typed into the username box by mistake is never recorded. "username" may also be the account's email address.
    const known = await findUserByLogin(username);
    if (wait) {
      audit({ action: "login_locked", target: known, outcome: "denied", ip: req.ip });
      res.set("Retry-After", String(wait));
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
    }

    const user = username.length <= EMAIL_MAX && password.length <= 72 ? await verifyCredentials(username, password) : null;
    if (!user) {
      ipLimiter.fail(ipKey); accountLimiter.fail(accountKey);
      audit({ action: "login_failed", target: known, outcome: "failure", ip: req.ip });
      return res.status(401).json({ error: "Invalid username or password." });
    }
    if (!isRole(user.role)) { // authenticated, but holds no valid role: default deny
      audit({ action: "login_refused", actor: user.username, outcome: "denied", ip: req.ip, detail: { reason: "invalid role" } });
      return res.status(403).json({ error: "Your account has no valid role. Contact an administrator." });
    }

    accountLimiter.reset(accountKey);
    await destroySession(req.sessionToken); // always issue a fresh session id on login
    setSessionCookie(res, await createSession(user));
    audit({ action: "login", actor: user.username, role: user.role, ip: req.ip });
    res.json({ ...user, permissions: permissionsFor(user.role) });
  } catch (e) { next(e); }
}));

app.post("/api/logout", A(async (req, res) => {
  if (req.user) audit({ action: "logout", actor: req.user.username, role: req.user.role, ip: req.ip });
  await destroySession(req.sessionToken);
  const tok = req.sessionToken; await dropSockets((s) => tok && s.handshake.headers.cookie?.includes(tok));
  clearSessionCookie(res);
  res.status(204).end();
}));

// Registration, email verification, password recovery and Google sign-in (auth-routes.js). Every account they create is a passenger.
registerAuthRoutes(app, { A, dropSockets });

// Identity and role come from the server session, never from anything the client sends.
app.get("/api/me", requireAuth(), (req, res) => res.json({ ...req.user, permissions: permissionsFor(req.user.role) }));

// ---- Data ----
// The route line follows real roads (calculated by OSRM, see routing.js). status is "ready", "loading" or
// "unavailable"; unless it is "ready" the path is empty and the client shows the stops only.
app.get("/api/route", A(async (req, res) => {
  if (routing.status !== "ready") requestRetry();
  res.json({
    status: routing.status,
    path: isReady() ? W : [],
    routeId: TRACKED_ROUTE_ID, name: ROUTE_NAME,
    stops: STOPS.map(({ id, name, p }) => ({ id, name, p })),
    tracking: { source: await trackingSource() },
    routing: { source: routing.source, updatedAt: routing.updatedAt },
  });
}));

// ---- Tracking ----
// Devices (not browsers) submit locations. They authenticate with a bearer token, not a session cookie.
app.post("/api/tracking/location", A(ingest));
// Latest known positions: public and read-only, the same data the Socket.IO "buses" event carries.
app.get("/api/tracking/buses", A(async (req, res) => res.json(await snapshot())));
// Device ids and submission counters: dispatchers and administrators only.
app.get("/api/tracking/devices", requirePermission("fleet:view"), A(async (req, res) => res.json(await staffSnapshot())));

// ---- Bus management ----
// Read: administrators and dispatchers. Write: administrators only. Buses are deactivated, never deleted.
// The browser can never choose a device source or credentials: "simulatedGps" only switches the demo simulator on or off.
const BUS_ID_RE = /^[A-Za-z0-9-]{2,16}$/;
const busView = (b, ctx, staff) => {
  const dev = ctx.devices.find((d) => d.busId === b.busId);
  const t = staff.find((x) => x.busId === b.busId);
  const a = ctx.assigned.get(b.busId);
  return { ...b, routeId: a?.routeId ?? null, routeName: a?.routeName ?? null, source: dev?.source ?? null, tracking: b.status === "active" && dev ? (t?.status ?? "unavailable") : "unavailable", lastSeenAt: t?.lastAcceptedAt ?? null };
};
// One bus, with its device, route and tracking state, read together.
async function busViewById(busId) {
  const ctx = await fleetContext();
  const b = ctx.buses.find((x) => x.busId === busId);
  return b ? busView(b, ctx, await staffSnapshot(ctx)) : null;
}
const busError = (res, r) => res.status(r.status).json({ error: r.error, field: r.field });
const busAudit = (req, action, target, detail, outcome = "success") =>
  audit({ action, actor: req.user.username, role: req.user.role, target, outcome, ip: req.ip, detail });
// Applies the consequences of a status change: a bus leaving service forgets its old position.
const afterStatus = (bus) => { if (bus.status !== "active") forget(bus.busId); };

app.get("/api/buses", requirePermission("buses:read"), A(async (req, res) => {
  const ctx = await fleetContext(), staff = await staffSnapshot(ctx);
  res.json({ canManage: can(req.user.role, "buses:manage"), statuses: STATUSES, buses: ctx.buses.map((b) => busView(b, ctx, staff)) });
}));

app.post("/api/buses", requirePermission("buses:manage"), async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const r = await createBus(body); // whitelists and validates every field itself
    if (r.error) { busAudit(req, "bus_create_rejected", String(body.busId ?? "").slice(0, 16).replace(/[^\w-]/g, ""), { reason: r.field }, "failure"); return busError(res, r); }
    busAudit(req, "bus_registered", r.bus.busId, { status: r.bus.status });
    if (body.simulatedGps === true && r.bus.status === "active") {
      if (await setSimulation(r.bus.busId, r.bus.name, true)) busAudit(req, "bus_simulation_enabled", r.bus.busId);
    }
    res.status(201).json(await busViewById(r.bus.busId));
  } catch (e) { next(e); }
});

app.patch("/api/buses/:busId", requirePermission("buses:manage"), async (req, res, next) => {
  try {
    if (!BUS_ID_RE.test(req.params.busId)) return res.status(400).json({ error: "Invalid bus ID." });
    const busId = req.params.busId.toUpperCase();
    const body = req.body ?? {};
    const hasFields = ["name", "plate", "capacity", "model", "status"].some((f) => f in body);
    const current = await getBus(busId);
    // A request that only switches simulated GPS on or off has no record fields to update.
    const r = hasFields || !current || typeof body.simulatedGps !== "boolean" ? await updateBus(busId, body) : { bus: current, before: current, changed: [], unassigned: null, unassignedConductor: null };
    if (r.error) { busAudit(req, "bus_update_rejected", busId, { reason: r.field }, "failure"); return busError(res, r); }
    const fields = r.changed.filter((f) => f !== "status");
    if (fields.length) busAudit(req, "bus_updated", busId, { fields: fields.join(",") });
    if (r.changed.includes("status")) {
      const action = r.bus.status === "inactive" ? "bus_deactivated" : "bus_status_changed";
      busAudit(req, action, busId, { from: r.before.status, to: r.bus.status });
      afterStatus(r.bus);
      // A bus that is not in service cannot be on a route. updateBus removed the assignment in the same transaction as the status change.
      if (r.unassigned) busAudit(req, "bus_route_unassigned", busId, { route: r.unassigned, reason: `bus_${r.bus.status}` });
      if (r.unassignedConductor) busAudit(req, "conductor_unassigned", r.unassignedConductor, { bus: busId, reason: `bus_${r.bus.status}` });
    }
    if (typeof body.simulatedGps === "boolean" && (r.bus.status === "active" || !body.simulatedGps)) {
      if (await setSimulation(busId, r.bus.name, body.simulatedGps)) busAudit(req, body.simulatedGps ? "bus_simulation_enabled" : "bus_simulation_disabled", busId);
    }
    res.json(await busViewById(busId));
  } catch (e) { next(e); }
});

// ---- Passenger occupancy ----
// Passengers and visitors can READ the count (it is shown beside the bus on the map, like the bus position). Only the conductor
// assigned to a bus can change it. The browser sends what happened ("board", "alight", "reset"), never a number, and the
// server checks the assignment, the capacity and the bus status inside one database transaction (see occupancy.js).
const publicOcc = (b, ctx) => ({ busId: b.busId, name: b.name, routeName: ctx.assigned.get(b.busId)?.routeName ?? null, ...occupancyView(b, ctx.conductors.has(b.busId)) });
const countLimiter = createLimiter({ max: Number(process.env.OCCUPANCY_MAX_PER_MINUTE || 120), windowMs: 60_000 }); // per conductor; a person cannot tap faster than this

app.get("/api/occupancy", A(async (req, res) => {
  const ctx = await fleetContext();
  res.json(ctx.buses.filter((b) => b.status === "active").map((b) => publicOcc(b, ctx)));
}));

// The bus this conductor is assigned to (or { bus: null }). The assignment comes from the server, never from the request.
app.get("/api/conductor/bus", requirePermission("occupancy:update"), A(async (req, res) => {
  const b = await assignedBus(req.user.username);
  if (!b) return res.json({ bus: null });
  const route = (await assignmentMap()).get(b.busId);
  // Everything here comes from the signed-in session and PostgreSQL. The browser never says which conductor or bus it means.
  const full = await getBus(b.busId);
  const t = (await snapshot(await fleetContext())).find((x) => x.id === b.busId) ?? null;
  res.json({
    bus: { busId: b.busId, name: b.name, plate: full?.plate ?? null, capacity: b.capacity, routeName: route?.routeName ?? null, status: b.status },
    occupancy: occupancyView(b, true),
    // Where the bus is: a registered tracking source reports it; "simulation" is NOT real GPS and is labelled so on screen.
    tracking: t ? { status: t.status, source: t.source, updatedAt: t.updatedAt, ageSeconds: t.ageSeconds, hasPosition: t.pos != null } : null,
  });
}));

app.post("/api/buses/:busId/occupancy", requirePermission("occupancy:update"), async (req, res, next) => {
  try {
    if (!BUS_ID_RE.test(req.params.busId)) return res.status(400).json({ error: "Invalid bus ID." });
    const busId = req.params.busId.toUpperCase();
    const action = req.body?.action;
    if (typeof action !== "string" || !ACTIONS.includes(action)) {
      busAudit(req, "occupancy_rejected", busId, { reason: "invalid_action" }, "failure");
      return res.status(400).json({ error: "Invalid action.", code: "invalid_action" });
    }
    const who = req.user.username;
    const wait = countLimiter.blockedFor(who);
    if (wait) { res.set("Retry-After", String(wait)); return res.status(429).json({ error: "Too many updates. Wait a moment.", code: "rate_limited" }); }
    countLimiter.fail(who); // counts this request
    const r = await changeCount(who, busId, action);
    if (r.error) {
      busAudit(req, "occupancy_rejected", busId, { action, reason: r.code }, r.status === 403 ? "denied" : "failure");
      return res.status(r.status).json({ error: r.error, code: r.code });
    }
    busAudit(req, `occupancy_${action}`, busId, { from: r.from ?? "not reported", to: r.to });
    const occ = occupancyView(r.bus, true);
    io.emit("occupancy", { busId, name: r.bus.name, ...occ }); // everyone watching the map or dashboard sees it without refreshing
    res.json({ bus: { busId, name: r.bus.name }, occupancy: occ });
  } catch (e) { next(e); }
});

// ---- Service alerts and notifications (Phase 7) ----
// Management (create, edit, publish, resolve): administrators and dispatchers (alerts:manage; dispatchers cannot touch general
// announcements, alerts.js decides). Everyone else only READS the active alerts meant for them. Who is notified is decided by the
// server from the database; the browser never names a recipient. The Socket.IO "notification" event goes only to the recipient's own room.
const alertLimiter = createLimiter({ max: Number(process.env.ALERT_MAX_PER_MINUTE || 30), windowMs: 60_000 });
const NUM_ID_RE = /^[1-9][0-9]{0,11}$/;
const alertAudit = (req, action, target, detail, outcome = "success") =>
  audit({ action, actor: req.user.username, role: req.user.role, target: target == null ? null : String(target), outcome, ip: req.ip, detail });
const asPublic = (a) => { const { createdBy, publishedBy, resolvedBy, ...rest } = a; return rest; }; // who wrote it is for staff only
const alertsChanged = (id) => io.emit("alerts:changed", { id }); // carries no content: each client asks the server for what IT may see

app.get("/api/alerts/active", A(async (req, res) => res.json({ alerts: await listActive(req.user) })));

app.get("/api/alerts", requirePermission("alerts:manage"), A(async (req, res) => {
  const filter = ["active", "draft", "resolved", "expired", "all"].includes(req.query.status) ? req.query.status : "all";
  res.json({ categories: CATEGORIES, severities: SEVERITIES, audiences: AUDIENCES, canGeneral: canManage(req.user.role, "general"), alerts: await listManage(filter) });
}));

// Runs one alert action with the shared rate limit, error answer and audit entry.
const alertAction = (name, perform) => async (req, res, next) => {
  try {
    let id = null;
    if (req.params.alertId !== undefined) {
      if (!NUM_ID_RE.test(req.params.alertId)) return res.status(400).json({ error: "Invalid alert ID." });
      id = Number(req.params.alertId);
    }
    const wait = alertLimiter.blockedFor(req.user.username);
    if (wait) { res.set("Retry-After", String(wait)); return res.status(429).json({ error: "Too many changes. Wait a moment.", code: "rate_limited" }); }
    alertLimiter.fail(req.user.username);
    const r = await perform(req, id);
    if (r.error) {
      alertAudit(req, "alert_rejected", id, { attempt: name, reason: r.code }, r.status === 403 ? "denied" : "failure");
      return res.status(r.status).json({ error: r.error, field: r.field, code: r.code });
    }
    res.json(r.body);
  } catch (e) { next(e); }
};

app.post("/api/alerts", requirePermission("alerts:manage"), alertAction("create", async (req) => {
  const r = await createAlert(req.user, req.body); if (r.error) return r;
  alertAudit(req, "alert_created", r.alert.id, { category: r.alert.category, severity: r.alert.severity, audience: r.alert.audience });
  return { body: { alert: r.alert } };
}));

app.patch("/api/alerts/:alertId", requirePermission("alerts:manage"), alertAction("update", async (req, id) => {
  const r = await updateAlert(req.user, id, req.body); if (r.error) return r;
  alertAudit(req, "alert_updated", id, { fields: r.changed.join(","), status: r.before });
  if (r.alert.state === "active") alertsChanged(id);
  return { body: { alert: r.alert } };
}));

app.post("/api/alerts/:alertId/publish", requirePermission("alerts:manage"), alertAction("publish", async (req, id) => {
  const r = await publishAlert(req.user, id); if (r.error) return r;
  alertAudit(req, "alert_published", id, { category: r.alert.category, severity: r.alert.severity, audience: r.alert.audience, notified: r.recipients.length });
  // After the commit: tell each recipient, and only that recipient, in their own room. Offline users simply read it from the database at their next sign-in.
  const staffCopy = r.alert, publicCopy = asPublic(r.alert);
  for (const x of r.recipients) io.to(`user:${x.username}`).emit("notification", { id: x.notificationId, receivedAt: x.createdAt, read: false, alert: ["admin", "dispatcher"].includes(x.role) ? staffCopy : publicCopy });
  alertsChanged(id);
  return { body: { alert: r.alert, notified: r.recipients.length } };
}));

app.post("/api/alerts/:alertId/resolve", requirePermission("alerts:manage"), alertAction("resolve", async (req, id) => {
  const r = await resolveAlert(req.user, id); if (r.error) return r;
  alertAudit(req, "alert_resolved", id, { was: r.before });
  alertsChanged(id);
  return { body: { alert: r.alert } };
}));

// A user's own notifications. Every query filters on the signed-in username; an id that belongs to someone else answers 404, same as a missing one.
app.get("/api/notifications", requireAuth(), A(async (req, res) => res.json(await listNotifications(req.user))));

app.patch("/api/notifications/:notificationId/read", requireAuth(), A(async (req, res) => {
  if (!NUM_ID_RE.test(req.params.notificationId)) return res.status(400).json({ error: "Invalid notification ID." });
  const r = await markRead(req.user.username, Number(req.params.notificationId));
  if (r.error) return res.status(r.status).json({ error: r.error, code: r.code });
  io.to(`user:${req.user.username}`).emit("notification:read", { unread: r.unread }); // keeps the user's other open tabs in step
  res.json({ unread: r.unread });
}));

app.post("/api/notifications/read-all", requireAuth(), A(async (req, res) => {
  const r = await markAllRead(req.user.username);
  io.to(`user:${req.user.username}`).emit("notification:read", { unread: r.unread });
  res.json(r);
}));

// Which conductor counts which bus. Read: administrators and dispatchers. Write: administrators only.
app.get("/api/conductors", requirePermission("conductors:read"), A(async (req, res) =>
  res.json({ canManage: can(req.user.role, "conductors:manage"), conductors: await listConductors() })));

app.put("/api/conductors/:username/bus", requirePermission("conductors:manage"), async (req, res, next) => {
  try {
    const name = validName(req, res); if (!name) return;
    const raw = req.body?.busId;
    if (raw !== null && (typeof raw !== "string" || !BUS_ID_RE.test(raw.trim()))) {
      busAudit(req, "conductor_assign_rejected", name, { reason: "invalid_bus" }, "failure");
      return res.status(400).json({ error: "Choose a bus or none.", field: "busId" });
    }
    const busId = raw === null ? null : raw.trim().toUpperCase();
    const r = await assignConductor(name, busId);
    if (r.error) {
      busAudit(req, "conductor_assign_rejected", name, { reason: r.code, bus: busId ?? "none" }, "failure");
      return res.status(r.status).json({ error: r.error, field: r.field });
    }
    if (r.changed) busAudit(req, r.to === null ? "conductor_unassigned" : r.from === null ? "conductor_assigned" : "conductor_reassigned", name, { from: r.from ?? "none", to: r.to ?? "none" });
    res.json({ username: name, busId: r.to });
  } catch (e) { next(e); }
});

// ---- Routes, bus stops and bus assignments ----
// Staff read with routes:read / stops:read (admin, dispatcher); only administrators write. Passengers and visitors get
// a trimmed public view of ACTIVE routes and stops. Nothing is deleted: routes and stops are deactivated.
const upId = (req, res, name) => {
  const v = String(req.params[name] ?? "").toUpperCase();
  if (ID_PATTERN.test(v)) return v;
  res.status(400).json({ error: "Invalid ID." });
  return null;
};
const netAudit = busAudit; // same actor/role/ip fields as the bus module
const reject = (req, res, action, target, r) => { netAudit(req, action, target, { reason: r.field }, "failure"); return busError(res, r); };
const idOf = (v) => String(v ?? "").slice(0, 16).replace(/[^\w-]/g, "");

app.get("/api/network/public", A(async (req, res) => {
  const [net, buses] = await Promise.all([publicNetwork(), listBuses()]);
  const names = new Map(buses.filter((b) => b.status === "active").map((b) => [b.busId, b.name]));
  res.json({
    trackedRouteId: TRACKED_ROUTE_ID,
    routes: net.routes.map(({ busIds, ...r }) => ({ ...r, buses: busIds.filter((id) => names.has(id)).map((id) => ({ busId: id, name: names.get(id) })) })),
    stops: net.stops,
  });
}));

// The line to draw for a route. kind "road" = follows roads (OSRM); kind "straight" = a plain stop-to-stop link, NOT a road route.
app.get("/api/network/routes/:routeId/path", A(async (req, res) => {
  const id = upId(req, res, "routeId"); if (!id) return;
  const r = (await publicNetwork()).routes.find((x) => x.routeId === id);
  if (!r) return res.status(404).json({ error: "Route not found." });
  const points = r.stops.map((s) => [s.lat, s.lng]);
  if (id === TRACKED_ROUTE_ID) {
    if (routing.status !== "ready") requestRetry();
    return res.json({ routeId: id, kind: "road", status: routing.status, path: isReady() ? W : [] }); // never a straight line for the tracked route
  }
  const g = roadGeometry(id, points);
  if (g.status === "ready") return res.json({ routeId: id, kind: "road", status: "ready", path: g.path });
  res.json({ routeId: id, kind: "straight", status: g.status === "loading" ? "loading" : points.length >= 2 ? "ready" : "none", path: points.length >= 2 ? points : [] });
}));

app.get("/api/routes", requirePermission("routes:read"), A(async (req, res) => {
  const [buses, routes] = await Promise.all([listBuses(), listRoutes()]);
  const names = new Map(buses.map((b) => [b.busId, b.name]));
  res.json({ canManage: can(req.user.role, "routes:manage"), statuses: ROUTE_STATUSES, routes: routes.map((r) => ({ ...r, buses: r.buses.map((id) => ({ busId: id, name: names.get(id) ?? id })) })) });
}));
app.get("/api/stops", requirePermission("stops:read"), A(async (req, res) => res.json({ canManage: can(req.user.role, "stops:manage"), statuses: STOP_STATUSES, stops: await listStops() })));

app.post("/api/stops", requirePermission("stops:manage"), async (req, res, next) => {
  try {
    const r = await createStop(req.body);
    if (r.error) return reject(req, res, "stop_create_rejected", idOf(req.body?.stopId), r);
    netAudit(req, "stop_created", r.stop.stopId, { name: r.stop.name });
    res.status(201).json(r.stop);
  } catch (e) { next(e); }
});
app.patch("/api/stops/:stopId", requirePermission("stops:manage"), async (req, res, next) => {
  try {
    const id = upId(req, res, "stopId"); if (!id) return;
    const r = await updateStop(id, req.body);
    if (r.error) return reject(req, res, "stop_update_rejected", id, r);
    const fields = r.changed.filter((f) => f !== "status");
    if (fields.length) netAudit(req, "stop_updated", id, { fields: fields.join(",") });
    if (r.changed.includes("status")) netAudit(req, r.stop.status === "inactive" ? "stop_deactivated" : "stop_activated", id);
    if (r.changed.length) await applyTracked(req);
    res.json(r.stop);
  } catch (e) { next(e); }
});

app.post("/api/routes", requirePermission("routes:manage"), async (req, res, next) => {
  try {
    const r = await createRoute(req.body);
    if (r.error) return reject(req, res, "route_create_rejected", idOf(req.body?.routeId), r);
    netAudit(req, "route_created", r.route.routeId, { name: r.route.name, status: r.route.status });
    res.status(201).json(r.route);
  } catch (e) { next(e); }
});
app.patch("/api/routes/:routeId", requirePermission("routes:manage"), async (req, res, next) => {
  try {
    const id = upId(req, res, "routeId"); if (!id) return;
    const r = await updateRoute(id, req.body);
    if (r.error) return reject(req, res, "route_update_rejected", id, r);
    const fields = r.changed.filter((f) => f !== "status");
    if (fields.length) netAudit(req, "route_updated", id, { fields: fields.join(",") });
    if (r.changed.includes("status")) netAudit(req, r.route.status === "inactive" ? "route_deactivated" : "route_activated", id, { buses_unassigned: r.unassigned.length });
    for (const busId of r.unassigned) netAudit(req, "bus_route_unassigned", busId, { route: id, reason: "route_deactivated" });
    if (r.changed.length) await applyTracked(req);
    res.json(r.route);
  } catch (e) { next(e); }
});

// Stops of a route, in order: add, remove, reorder.
app.post("/api/routes/:routeId/stops", requirePermission("routes:manage"), async (req, res, next) => {
  try {
    const id = upId(req, res, "routeId"); if (!id) return;
    const r = await addRouteStop(id, req.body?.stopId, req.body?.position);
    if (r.error) return reject(req, res, "route_stop_rejected", id, r);
    netAudit(req, "route_stop_added", id, { stop: String(req.body.stopId).toUpperCase().slice(0, 16), position: r.position });
    await applyTracked(req);
    res.status(201).json(r.route);
  } catch (e) { next(e); }
});
app.delete("/api/routes/:routeId/stops/:stopId", requirePermission("routes:manage"), async (req, res, next) => {
  try {
    const id = upId(req, res, "routeId"); if (!id) return;
    const sid = upId(req, res, "stopId"); if (!sid) return;
    const r = await removeRouteStop(id, sid);
    if (r.error) return reject(req, res, "route_stop_rejected", id, r);
    netAudit(req, "route_stop_removed", id, { stop: sid });
    await applyTracked(req);
    res.json(r.route);
  } catch (e) { next(e); }
});
app.put("/api/routes/:routeId/stops", requirePermission("routes:manage"), async (req, res, next) => {
  try {
    const id = upId(req, res, "routeId"); if (!id) return;
    const r = await reorderRouteStops(id, req.body?.stopIds);
    if (r.error) return reject(req, res, "route_stops_reorder_rejected", id, r);
    if (r.changed) { netAudit(req, "route_stops_reordered", id, { order: r.route.stops.map((s) => s.stopId).join(",") }); await applyTracked(req); }
    res.json(r.route);
  } catch (e) { next(e); }
});

// Assign a bus to a route (replacing its current one) or remove it (routeId null). One route per bus at a time.
app.put("/api/buses/:busId/route", requirePermission("routes:manage"), async (req, res, next) => {
  try {
    if (!BUS_ID_RE.test(req.params.busId)) return res.status(400).json({ error: "Invalid bus ID." });
    const busId = req.params.busId.toUpperCase();
    const raw = req.body?.routeId;
    if (raw !== null && (typeof raw !== "string" || !ID_PATTERN.test(raw.trim().toUpperCase()))) return reject(req, res, "bus_route_rejected", busId, { error: "Choose a route or none.", field: "routeId", status: 400 });
    const routeId = raw === null ? null : raw.trim().toUpperCase();
    const bus = await getBus(busId);
    if (!bus) return reject(req, res, "bus_route_rejected", busId, { error: "Bus not found.", field: "busId", status: 404 });
    if (routeId !== null) {
      if (bus.status !== "active") return reject(req, res, "bus_route_rejected", busId, { error: "Only Active buses can be assigned to a route.", field: "busId", status: 409 });
      // Simulated GPS drives along the tracked route's road only, so it cannot honestly represent a bus on another route.
      if (routeId !== TRACKED_ROUTE_ID && (await deviceForBus(busId))?.source === "simulation")
        return reject(req, res, "bus_route_rejected", busId, { error: `Simulated GPS only supports route ${TRACKED_ROUTE_ID}. Turn simulated GPS off for this bus first.`, field: "routeId", status: 409 });
    }
    const r = await assignBus(busId, routeId);
    if (r.error) return reject(req, res, "bus_route_rejected", busId, r);
    if (r.changed) netAudit(req, r.to === null ? "bus_route_unassigned" : r.from === null ? "bus_route_assigned" : "bus_route_changed", busId, { from: r.from ?? "none", to: r.to ?? "none" });
    res.json(await busViewById(busId));
  } catch (e) { next(e); }
});

// ---- Dashboard ----
// One endpoint, three tiers. The public part is what any visitor can already see on the map.
// Every other section is added only when the viewer's role holds the matching permission,
// so data a user may not see is never put in their response (it is not just hidden in the UI).
// "null" means "not available yet", which is different from a real zero.
const STATUS_LABEL = { current: "Live", delayed: "Delayed", stale: "Last known", unavailable: "Unavailable" };
const nextEta = (snap, i) => {
  const v = snap.map((b) => b.etas[i]).filter((x) => x != null);
  return v.length ? Math.min(...v) : null;
};
// The stop a bus will reach first (null when no estimate is available).
const nextStopOf = (b) => {
  let best = null;
  b.etas.forEach((e, i) => { if (e != null && (best === null || e < best.etaSeconds)) best = { name: STOPS[i].name, etaSeconds: e }; });
  return best;
};

app.get("/api/dashboard", A(async (req, res) => {
  const role = req.user?.role;
  const ctx = await fleetContext(); // one read of buses, devices and assignments shared by everything below
  const snap = await snapshot(ctx);
  const reporting = snap.filter((b) => b.status === "current" || b.status === "delayed");
  const out = {
    generatedAt: new Date().toISOString(),
    viewer: req.user ?? null, // lets the client notice a session that has expired
    tracking: { source: await trackingSource(ctx), activeBuses: reporting.length },
    route: {
      name: ROUTE_NAME,
      lengthKm: isReady() ? +(TOTAL / 1000).toFixed(1) : null, // null = not available yet
      stops: STOPS.map((s, i) => ({ name: s.name, etaSeconds: nextEta(snap, i) })),
    },
    serviceAlerts: (await listActive(req.user)).slice(0, 5), // active service alerts meant for this viewer (the full list is /api/alerts/active)
    occupancy: ctx.buses.filter((b) => b.status === "active").map((b) => publicOcc(b, ctx)), // real counts kept by conductors; "Not reported" otherwise
    alerts: [
      ...snap.filter((b) => b.occupancy.level === "full").map((b) => ({ id: `full-${b.id}`, text: `${b.name} is full.` })),
      ...snap.filter((b) => b.status === "stale" || b.status === "unavailable").map((b) => ({ id: `lost-${b.id}`, text: `${b.name}: location ${b.status === "stale" ? "is out of date (showing last known position)" : "is not available"}.` })),
    ],
  };

  if (can(role, "fleet:view")) {
    const registry = ctx.buses;
    const byId = new Map(snap.map((b) => [b.id, b]));
    const assigned = ctx.assigned;
    const [allRoutes, allStops] = await Promise.all([listRoutes(), listStops()]);
    out.fleet = {
      registeredBuses: registry.length,
      operation: Object.fromEntries(STATUSES.map((s) => [s, registry.filter((b) => b.status === s).length])),
      assignmentsSupported: true,
      routes: allRoutes.filter((r) => r.status === "active").map((r) => r.name),
      stops: allStops.filter((x) => x.status === "active").length,
      // Every registered bus appears with its operational status. Only Active buses have live tracking.
      buses: registry.map((r) => {
        const b = byId.get(r.busId);
        return {
          id: r.busId, name: r.name, operation: r.status, plate: r.plate, capacity: r.capacity, routeName: assigned.get(r.busId)?.routeName ?? null,
          source: b?.source ?? null, tracking: b ? b.status : "unavailable", updatedAt: b?.updatedAt ?? null,
          direction: b?.dir === 1 ? "To CDO" : b?.dir === -1 ? "To Villanueva" : "Unknown",
          occupancy: occupancyView(r, ctx.conductors.has(r.busId)), conductor: ctx.conductors.get(r.busId) ?? null, // the conductor's name is for staff only
          status: b ? STATUS_LABEL[b.status] : "Not in service", nextStop: b ? nextStopOf(b) : null,
        };
      }),
    };
  }
  if (can(role, "users:read")) {
    const accounts = await listUsers();
    out.users = {
      total: accounts.length,
      active: accounts.filter((u) => u.active).length,
      byRole: Object.fromEntries(ROLES.map((r) => [r, accounts.filter((u) => u.role === r).length])),
      invalidRole: accounts.filter((u) => !isRole(u.role)).length,
    };
    if (out.users.invalidRole) out.alerts.push({ id: "invalid-roles", text: `${out.users.invalidRole} account(s) have no valid role and cannot sign in.` });
  }
  if (can(role, "audit:read")) {
    out.activity = (await readAudit(8)).map(({ ts, action, actor, target, outcome }) => ({ ts, action, actor, target, outcome }));
    out.tracking.unauthorizedAttempts = trackingStats().unauthorizedAttempts;
  }
  res.json(out);
}));

// ---- User management and audit (administrator only) ----
const validName = (req, res) => {
  const name = String(req.params.username).toLowerCase();
  if (USERNAME_RE.test(name)) return name;
  res.status(400).json({ error: "Invalid username." });
  return null;
};

app.get("/api/users", requirePermission("users:read"), A(async (req, res) => res.json(await listUsers())));

// Your own record, or anyone's if you hold users:read. Other users get 403 whether or not the account exists.
app.get("/api/users/:username", requireAuth(), A(async (req, res) => {
  const name = validName(req, res);
  if (!name) return;
  if (name !== req.user.username && !can(req.user.role, "users:read")) return forbid(req, res, "users:read");
  const account = await findUser(name);
  return account ? res.json(account) : res.status(404).json({ error: "User not found." });
}));

app.patch("/api/users/:username", requirePermission("users:manage"), async (req, res, next) => {
  try {
    const name = validName(req, res);
    if (!name) return;
    const body = req.body ?? {};
    const changes = {}; // whitelist: nothing else in the body is ever read
    if ("role" in body) {
      if (!isRole(body.role)) return res.status(400).json({ error: "Invalid role." });
      changes.role = body.role;
    }
    if ("active" in body) {
      if (typeof body.active !== "boolean") return res.status(400).json({ error: "Invalid status." });
      changes.active = body.active;
    }
    if (!Object.keys(changes).length) return res.status(400).json({ error: "Nothing to update." });

    if (name === req.user.username) { // no self-promotion, and no locking yourself out
      audit({ action: "self_change_blocked", actor: req.user.username, role: req.user.role, target: name, outcome: "denied", ip: req.ip, detail: changes });
      return res.status(403).json({ error: "You cannot change your own role or status." });
    }
    const before = await findUser(name);
    if (!before) return res.status(404).json({ error: "User not found." });

    const hadBus = before.role === "conductor" ? (await assignedBus(name))?.busId ?? null : null; // read first: the database drops it with the change
    const after = await updateUser(name, changes);
    if (hadBus && (after.role !== "conductor" || !after.active))
      audit({ action: "conductor_unassigned", actor: req.user.username, role: req.user.role, target: name, ip: req.ip, detail: { bus: hadBus, reason: after.role !== "conductor" ? "role_changed" : "user_deactivated" } });
    if ("role" in changes && before.role !== after.role)
      audit({ action: "role_changed", actor: req.user.username, role: req.user.role, target: name, ip: req.ip, detail: { from: before.role, to: after.role } });
    if ("active" in changes && before.active !== after.active)
      audit({ action: after.active ? "user_activated" : "user_deactivated", actor: req.user.username, role: req.user.role, target: name, ip: req.ip });
    if (!after.active) { await destroyUserSessions(name); await dropSockets((s) => s.data.user === name); }
    res.json(after);
  } catch (e) { next(e); }
});

app.get("/api/audit", requirePermission("audit:read"), A(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
  res.json(await readAudit(limit));
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed" || err.type === "entity.too.large") return res.status(400).json({ error: "Invalid request." });
  // Database problems are logged for the operator by code and constraint name only, and never described to the user:
  // SQL text, table names and values stay on the server.
  if (err.severity || /^(ECONN|ETIMEDOUT|EAI_AGAIN)/.test(err.code || "") || /timeout exceeded when trying to connect|Connection terminated/i.test(err.message || "")) {
    console.error(`[db] request failed (${err.code || "connection"}${err.constraint ? `, ${err.constraint}` : ""})`);
    const down = !err.severity || ["57P01", "57P03", "53300"].includes(err.code) || /^08/.test(err.code || "");
    return res.status(down ? 503 : 500).json({ error: down ? "The service is temporarily unavailable. Please try again." : "Something went wrong. Please try again." });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

// Every 2 seconds: re-check how fresh each position is, tell the viewers, and log lost/restored connections.
// Revalidating the staff room here means an expired session or changed role stops receiving operational data.
let ticking = false; // a slow database must not pile up overlapping rounds
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    const staff = io.sockets.adapter.rooms.get("staff");
    if (staff) for (const id of [...staff]) {
      const sock = io.sockets.sockets.get(id);
      if (!sock) continue;
      try { await loadUser(sock.request); if (!isStaff(sock.request.user)) sock.leave("staff"); }
      catch { /* database unavailable: keep the room as it is; HTTP requests fail closed meanwhile */ }
    }
    const ctx = await fleetContext();
    await watchConnections(ctx);
    io.emit("buses", await snapshot(ctx));
    io.to("staff").emit("tracking:staff", await staffSnapshot(ctx));
  } catch (e) { console.error(`[tracking] update round failed (${e.code || e.message})`); }
  finally { ticking = false; }
}, 2000);

// Phase 6 setup: an EMPTY network gets the original route (R-01) and its stops, so tracking has something to follow.
// With data already in the database (for example after `npm run db:import`) this does nothing.
if (await bootstrapNetwork({ routeName: ROUTE_NAME, stops: SEED_STOPS })) console.log(`[network] created route ${TRACKED_ROUTE_ID}, ${SEED_STOPS.length} stops and the bus assignments from the original route`);
// The tracked route (road geometry, arrival estimates, simulator) follows what the administrators saved.
let appliedGeo = null, appliedNames = null;
// One at a time, so two quick edits cannot configure the route in the wrong order.
let applying = Promise.resolve();
const applyTracked = (req) => (applying = applying.then(() => applyTrackedNow(req)).catch((e) => { console.error(`[network] could not apply the tracked route (${e.code || e.message})`); return false; }));
async function applyTrackedNow(req) {
  const spec = await trackedSpec();
  if (!spec) return false; // missing or unusable: keep the current configuration (the network module refuses changes that would break it)
  const geo = JSON.stringify(spec.stops.map((s) => [s.id, s.p]));
  const names = JSON.stringify([spec.name, spec.stops.map((s) => s.name)]);
  if (geo === appliedGeo && names === appliedNames) return false;
  const first = appliedGeo === null;
  if (geo !== appliedGeo) {
    appliedGeo = geo; configureStops(spec.name, spec.stops);
    if (!first) {
      forgetAll(); reloadRouting();
      audit({ action: "tracked_route_reconfigured", actor: req?.user?.username ?? "system", role: req?.user?.role, target: spec.routeId, ip: req?.ip, detail: { stops: spec.stops.length } });
    }
  } else renameStops(spec.name, spec.stops);
  appliedNames = names;
  return true;
}
await applyTracked(null);
startRouting(); // load the road route (saved copy first, then OSRM) without delaying startup
server.listen(PORT, () => {
  console.log(`RouteWatch server on http://localhost:${PORT}`);
  // Development convenience: run the simulated GPS devices alongside the server. Never in production.
  // It follows the simulated devices registered in Bus Management, so it starts even when there are none yet.
  if (process.env.AUTO_SIMULATOR !== "off" && process.env.NODE_ENV !== "production") {
    const sim = fork(new URL("./simulator.js", import.meta.url), { env: { ...process.env, SERVER_URL: `http://localhost:${PORT}` } });
    process.on("exit", () => sim.kill());
  }
  countUsers().then((n) => { if (n === 0) console.warn("No user accounts yet. Create one with: npm run seed-user -- <username> admin"); }).catch(() => {});
});

// Orderly stop (Ctrl+C or a service manager): finish writing audit entries, then close the database connections.
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => {
  if (stopping) return;
  stopping = true;
  console.log(`[server] ${sig}: shutting down`);
  io.close(); server.close();
  try { await flushAudit(); await closeDb(); } catch { /* exiting anyway */ }
  process.exit(0);
});
