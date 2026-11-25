import { Bus, LogOut, Bell } from "lucide-react";
import { initials } from "../utils/format.js";
import { ROLE_LABEL } from "../utils/roles.js";

// The page frame: side menu, top bar, notification bell and toast. It holds no state; App passes what it shows and the
// setters its buttons call. `children` is the current page (App keys it by the session epoch).
export function AppShell({ user, isMember, nav, view, setView, current, notif, toast, setToast, logout, children }) {
  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand"><span className="brand__mark"><Bus size={20} aria-hidden /></span>RouteWatch</div>
        <div className="rail__links">
          {[...new Set(nav.map((v) => v.group))].map((g) => (
            <div className="rail__group" key={g} role="group" aria-label={g}>
              <span className="rail__heading" aria-hidden>{g}</span>
              {nav.filter((v) => v.group === g).map(({ id, label, Icon }) => (
                <button key={id} className="rail__link" aria-current={view === id ? "page" : undefined} onClick={() => setView(id)} aria-label={label} title={label}><Icon size={18} aria-hidden /><span className="rail__text">{label}</span></button>))}
            </div>))}
        </div>
        <div className="rail__user"><span className="avatar" aria-hidden>{initials(user.username)}</span><span className="rail__who"><strong>{user.username}</strong><br /><span className="muted">{ROLE_LABEL[user.role] ?? user.role}</span></span>
          <button className="btn btn--icon" onClick={logout} aria-label={isMember ? "Log out" : "Back to sign in"}><LogOut size={18} aria-hidden /></button></div>
      </nav>
      <main className="main">
        <header className="topbar"><h1>{current.label}</h1>
          <span className="topbar__end"><span className="muted">Villanueva – CDO route</span>
            {isMember && (
              <button className="bell" onClick={() => setView("notifications")} aria-label={notif.unread > 0 ? `Notifications, ${notif.unread} unread` : "Notifications, none unread"} title="Notifications">
                <Bell size={18} aria-hidden />{notif.unread > 0 && <span className="bell__count" aria-hidden>{notif.unread > 99 ? "99+" : notif.unread}</span>}
              </button>)}
          </span></header>
        {toast && <div className="toast" role="status"><button className="toast__btn" onClick={() => { setToast(""); setView("notifications"); }}>{toast}</button></div>}
        {children}
      </main>
    </div>
  );
}
