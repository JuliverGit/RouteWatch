import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import AuthScreen from "./Auth.jsx";
import { announceSessionChange, onSessionChange } from "./sessionSync.js";
import { ROLE_LABEL } from "./utils/roles.js";
import { send, post } from "./services/http.js";
import { joinSocket, setSocketIdentity, reconnectIfDropped } from "./services/socket.js"; // the one shared Socket.IO connection
import { State } from "./components/ui/State.jsx";
import { Dashboard } from "./pages/common/DashboardPage.jsx";
import { NotificationsPage } from "./pages/common/NotificationsPage.jsx";
import { AlertsPage } from "./pages/staff/AlertsPage.jsx";
import { BusesPage } from "./pages/staff/BusesPage.jsx";
import { StopsPage } from "./pages/staff/StopsPage.jsx";
import { RoutesPage } from "./pages/staff/RoutesPage.jsx";
import { UsersPage } from "./pages/admin/UsersPage.jsx";
import { AuditPage } from "./pages/admin/AuditPage.jsx";
import { CounterPage } from "./pages/conductor/CounterPage.jsx";
import { ConductorHome } from "./pages/conductor/ConductorHome.jsx";
import { LiveMap } from "./pages/map/LiveMap.jsx";
import { VIEWS } from "./routes/views.js";
import { AppShell } from "./layouts/AppShell.jsx";

// Sign-in, registration, email verification and password recovery live in Auth.jsx (same props as before).
const Login = (props) => <AuthScreen {...props} />;

export default function App() {
  const [user, setUser] = useState(null);
  setSocketIdentity(user && user.role !== "guest" ? `${user.username}\u0000${user.role}` : ""); // the live connection must carry the identity of whoever is signed in now (guests and signed-out are the same: no session); a new role reconnects too, because the server decides the rooms when connecting
  const [view, setView] = useState("dash");
  const [notif, setNotif] = useState({ unread: 0, items: null, error: "" }); // the signed-in user's own notifications (kept in PostgreSQL by the server)
  const [alertsTick, setAlertsTick] = useState(0);  // bumped when the server says the alerts changed, so lists reload
  const [mapFocus, setMapFocus] = useState(null);   // an alert's bus / route / stop the map should show
  const [toast, setToast] = useState("");
  const [focusToken, setFocusToken] = useState(0); // bumped by "View my bus on Live Map" so the map centres on the conductor's bus
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState("");
  const isMember = !!user && user.role !== "guest"; // guests are unauthenticated, public-map-only visitors
  // Notifications belong to one identity. Reset while rendering (not in an effect), so a frame with the previous user's content is never painted.
  // Clearing the toast also cancels its dismissal timer (the cleanup of the toast effect below).
  // `epoch` numbers each identity on screen, so a response can be tied to the one that asked for it, even when the same user signs in again.
  // The role is part of the identity: data loaded under a previous role (for example staff data after a demotion) is dropped too.
  const identity = user ? `${user.username}\u0000${user.role}` : null;
  const [session, setSession] = useState({ identity, epoch: 0 });
  const epoch = session.identity === identity ? session.epoch : session.epoch + 1;
  const epochRef = useRef(epoch);
  epochRef.current = epoch;
  if (session.identity !== identity) { setSession({ identity, epoch }); setToast(""); setNotif({ unread: 0, items: null, error: "" }); }
  const clearMapFocus = useCallback(() => { setMapFocus(null); setFocusToken(0); }, []);
  useEffect(() => { clearMapFocus(); }, [user?.username, clearMapFocus]); // a map focus belongs to one user: log out, expiry and account changes drop it

  const endSession = useCallback((message = "") => { setUser(null); setView("dash"); setNotice(message); }, []);
  // Every page reports a 401 through the `expire` of the identity that made the request. A report from an earlier identity is ignored.
  // Otherwise the server decides: the cookie may already belong to a newer session (a sign-in in another tab), so only a 401 from /api/me ends this one.
  const confirmingExpiry = useRef(null);
  const expire = useCallback(() => {
    if (epochRef.current !== epoch || confirmingExpiry.current === epoch) return;
    confirmingExpiry.current = epoch;
    fetch("/api/me", { credentials: "same-origin" })
      .then(async (r) => {
        if (epochRef.current !== epoch) return;
        if (r.status === 401) return endSession("Your session has expired. Please sign in again.");
        if (!r.ok) return;
        const u = await r.json();
        if (epochRef.current === epoch) setUser((prev) => (JSON.stringify(prev) === JSON.stringify(u) ? prev : u));
      })
      .catch(() => {}) // server unreachable: not proof the session ended; the next request or session check decides
      .finally(() => { if (confirmingExpiry.current === epoch) confirmingExpiry.current = null; });
  }, [epoch, endSession]);

  // Asks the server who this tab is signed in as, and follows the answer: another account, another role, signed out, or a sign-in made in
  // another tab. Only the server's answer counts; whatever prompted the check carries no identity. One check at a time; a prompt that
  // arrives meanwhile runs one more afterwards, so a change made after the request was sent is not missed.
  const userRef = useRef(user);
  userRef.current = user;
  const sessionCheck = useRef({ busy: false, again: false, last: 0 });
  const checkSession = useCallback(function run() {
    const c = sessionCheck.current;
    if (c.busy) { c.again = true; return; }
    c.busy = true; c.again = false; c.last = Date.now();
    const asked = epochRef.current;
    fetch("/api/me", { credentials: "same-origin" })
      .then(async (r) => {
        if (epochRef.current !== asked) return; // this tab changed account itself in the meantime
        const shown = userRef.current, member = !!shown && shown.role !== "guest";
        if (r.status === 401) { if (member) endSession("You were signed out. Please sign in again."); return; }
        if (!r.ok) return;
        const u = await r.json();
        if (epochRef.current !== asked) return;
        // The server may have ended our live connection although nothing changed in the end (a role changed and changed back): connect again.
        // When the account or role did change, the new identity reconnects it anyway (setSocketIdentity).
        if (shown && shown.username === u.username && shown.role === u.role) reconnectIfDropped();
        setUser((prev) => (prev && JSON.stringify(prev) === JSON.stringify(u) ? prev : u));
        if (!member) { setNotice(""); setView("dash"); } // a sign-in made in another tab
      })
      .catch(() => {}) // server unreachable: change nothing; the next prompt or the minute check decides
      .finally(() => { c.busy = false; if (c.again) run(); });
  }, [endSession]);

  // Prompts: another tab signed in or out; this tab is shown, focused, resumed after being suspended, restored from the back/forward
  // cache, or back online. Tab activity is limited to one check every 3 seconds; messages from other tabs are always checked.
  useEffect(() => {
    const wake = () => { if (document.visibilityState === "visible" && Date.now() - sessionCheck.current.last > 3000) checkSession(); };
    const shown = (e) => { if (e.persisted) checkSession(); };
    document.addEventListener("visibilitychange", wake);
    document.addEventListener("resume", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", shown);
    const stop = onSessionChange(checkSession);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      document.removeEventListener("resume", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", shown);
      stop();
    };
  }, [checkSession]);

  // Restore an existing server session (e.g. after a page refresh).
  useEffect(() => {
    let live = true;
    fetch("/api/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => { if (live && u) { setUser(u); announceSessionChange(); } }) // a tab opened after a sign-in elsewhere (or a Google sign-in) lets the others check
      .catch(() => {})
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, []);

  // Notice an expired session, or a role change made by an administrator, even while only the map is open.
  useEffect(() => {
    if (!isMember) return;
    const t = setInterval(() => {
      fetch("/api/me", { credentials: "same-origin" })
        .then(async (r) => {
          if (epochRef.current !== epoch) return; // answer for an earlier identity
          if (r.status === 401) return expire();
          if (r.ok) { const u = await r.json(); if (epochRef.current === epoch) setUser((prev) => (JSON.stringify(prev) === JSON.stringify(u) ? prev : u)); }
        })
        .catch(() => {});
    }, 60000);
    return () => clearInterval(t);
  }, [isMember, epoch, expire]);

  // The dashboard response says who the server thinks we are; if our role changed, reload the account.
  const syncViewer = useCallback((v) => {
    if (user && v.role !== user.role) {
      fetch("/api/me", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((u) => { if (u && epochRef.current === epoch) setUser(u); }).catch(() => {});
    }
  }, [user, epoch]);

  const logout = async () => {
    if (isMember) { try { await post("/api/logout"); } catch { /* the cookie also expires on its own */ } announceSessionChange(); }
    endSession();
  };

  const loadNotif = useCallback(async () => {
    if (!isMember) return;
    const askedFor = epochRef.current, stale = () => epochRef.current !== askedFor; // a late answer for a previous session is dropped
    try {
      const r = await fetch("/api/notifications", { credentials: "same-origin" });
      if (stale()) return;
      if (r.status === 401) return expire();
      const d = await r.json().catch(() => null);
      if (stale()) return;
      if (!r.ok || !d || !Array.isArray(d.notifications)) return setNotif((p) => ({ ...p, error: "Notifications could not be loaded." }));
      setNotif({ unread: d.unread, items: d.notifications, error: "" });
    } catch { if (!stale()) setNotif((p) => ({ ...p, error: "Cannot reach the server." })); }
  }, [isMember, expire]);
  useEffect(() => { if (!isMember) { setNotif({ unread: 0, items: null, error: "" }); return; } loadNotif(); const t = setInterval(loadNotif, 60000); return () => clearInterval(t); }, [isMember, identity, loadNotif]);
  // One Socket.IO connection for the app. The server sends "notification" only to this user's own room; "alerts:changed" carries no content.
  useEffect(() => {
    if (!user) return;
    const sock = joinSocket();
    sock.on("notification", (n) => {
      if (!n || !n.alert) return;
      setNotif((p) => ({ ...p, unread: p.unread + 1, items: p.items ? [n, ...p.items.filter((x) => x.id !== n.id)] : p.items }));
      setToast(`New notification: ${n.alert.title}`); loadNotif();
    });
    sock.on("notification:read", () => loadNotif()); // another tab of this user read something
    sock.on("alerts:changed", () => { setAlertsTick((n) => n + 1); loadNotif(); }); // an alert was published, edited or resolved: lists and the notification states refresh
    sock.on("disconnect", (reason) => { if (reason === "io server disconnect") checkSession(); }); // the server ended our connection (sign-out, deactivation, role change): ask who we are now
    return () => sock.disconnect();
  }, [user?.username, loadNotif, checkSession]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 6000); return () => clearTimeout(t); }, [toast]);
  const readOne = async (id) => {
    setNotif((p) => ({ ...p, items: p.items && p.items.map((n) => (n.id === id ? { ...n, read: true } : n)), unread: p.items && p.items.some((n) => n.id === id && !n.read) ? Math.max(0, p.unread - 1) : p.unread }));
    try { const r = await send("PATCH", `/api/notifications/${id}/read`); if (r.status === 401) return expire(); } catch { /* the next refresh corrects the screen */ }
    loadNotif();
  };
  const readAll = async () => {
    setNotif((p) => ({ ...p, unread: 0, items: p.items && p.items.map((n) => ({ ...n, read: true })) }));
    try { const r = await post("/api/notifications/read-all", {}); if (r.status === 401) return expire(); } catch { /* corrected on the next refresh */ }
    loadNotif();
  };
  const showOnMap = (kind, id) => { setMapFocus({ kind, id, token: Date.now() }); setView("map"); };

  if (checking) return <main className="auth"><State title="Loading" text="Checking your session…" /></main>;
  if (!user) return <Login notice={notice} onLogin={(u) => { setUser(u); setNotice(""); setView("dash"); announceSessionChange(); }} onGuest={() => setUser({ username: "Guest", role: "guest", permissions: [] })} />;

  const isConductor = (user.permissions ?? []).includes("occupancy:update");
  const allowed = (v) => (!v.permission || (user.permissions ?? []).includes(v.permission)) && (!v.member || isMember);
  const canAlerts = (user.permissions ?? []).includes("alerts:manage");
  const nav = VIEWS.filter(allowed);
  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0];
  // The server enforces every permission; this only keeps the screen consistent with it.
  const page = !allowed(current) ? (
    <State title="Access denied" text={`Your role (${ROLE_LABEL[user.role] ?? "unknown"}) does not have permission to view this page.`}
      action={<button className="btn" onClick={() => setView("dash")}>Back to dashboard</button>} />
  ) : current.id === "map" ? <LiveMap key={user.username} canFleet={(user.permissions ?? []).includes("fleet:view")} isConductor={isConductor} isPassenger={user.role === "passenger"} focusToken={focusToken} alertsTick={alertsTick} mapFocus={mapFocus} onFocusUsed={clearMapFocus} />
    : current.id === "notifications" ? <NotificationsPage notif={notif} onRead={readOne} onReadAll={readAll} onFocus={showOnMap} onManage={canAlerts ? () => setView("alerts") : null} reload={loadNotif} />
    : current.id === "alerts" ? <AlertsPage onUnauthorized={expire} alertsTick={alertsTick} />
    : current.id === "counter" ? <CounterPage onUnauthorized={expire} />
    : current.id === "dash" && isConductor ? <ConductorHome onUnauthorized={expire} onNavigate={setView} onShowMap={() => { setFocusToken((n) => n + 1); setView("map"); }} onFocus={showOnMap} alertsTick={alertsTick} />
    : current.id === "dash" ? <Dashboard member={isMember} onUnauthorized={expire} onNavigate={setView} onViewer={syncViewer} onFocus={showOnMap} canManageAlerts={canAlerts} alertsTick={alertsTick} />
    : current.id === "buses" ? <BusesPage onUnauthorized={expire} />
    : current.id === "routes" ? <RoutesPage onUnauthorized={expire} />
    : current.id === "stops" ? <StopsPage onUnauthorized={expire} />
    : current.id === "users" ? <UsersPage me={user} onUnauthorized={expire} />
    : <AuditPage onUnauthorized={expire} />;
  return (
    <AppShell user={user} isMember={isMember} nav={nav} view={view} setView={setView} current={current} notif={notif} toast={toast} setToast={setToast} logout={logout}>
      {/* Page data belongs to one identity: a new `epoch` replaces the page in the same render that shows the new account,
          so the previous account's data is never painted and its late responses reach an unmounted page (React drops them). */}
      <Fragment key={epoch}>{page}</Fragment>
    </AppShell>
  );
}
