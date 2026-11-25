import { useCallback, useEffect, useState } from "react";
import { ROLE_LABEL, ROLES } from "../../utils/roles.js";
import { send } from "../../services/http.js";
import { Badge } from "../../components/ui/Badge.jsx";
import { State } from "../../components/ui/State.jsx";

export function UsersPage({ me, onUnauthorized }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState(null); // { ok, text }
  const [conductors, setConductors] = useState({}); // username -> assigned busId
  const [busList, setBusList] = useState([]);          // active buses a conductor can be assigned to
  const loadAssign = useCallback(() => Promise.all([fetch("/api/conductors", { credentials: "same-origin" }), fetch("/api/buses", { credentials: "same-origin" })])
    .then(async ([c, b]) => {
      if (c.ok) setConductors(Object.fromEntries((await c.json()).conductors.map((x) => [x.username, x.busId])));
      if (b.ok) setBusList(((await b.json()).buses || []).filter((x) => x.status === "active"));
    }).catch(() => {}), []);
  const load = useCallback(() => fetch("/api/users", { credentials: "same-origin" })
    .then(async (r) => {
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      r.ok ? (setUsers(d), setError("")) : setError(d.error || "Request failed");
      loadAssign();
    })
    .catch(() => setError("Cannot reach the server.")), [onUnauthorized, loadAssign]);
  useEffect(() => { load(); }, [load]);

  const assign = async (username, busId) => {
    setFeedback(null);
    try {
      const r = await send("PUT", `/api/conductors/${encodeURIComponent(username)}/bus`, { busId: busId || null });
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setFeedback({ ok: false, text: d.error || "Assignment failed." });
      else setFeedback({ ok: true, text: busId ? `${username} now counts ${busId}.` : `Removed the bus assignment of ${username}.` });
      loadAssign();
    } catch { setFeedback({ ok: false, text: "Cannot reach the server." }); }
  };

  const update = async (username, change) => {
    setFeedback(null);
    try {
      const r = await send("PATCH", `/api/users/${encodeURIComponent(username)}`, change);
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setFeedback({ ok: false, text: d.error || "Update failed." });
      setFeedback({ ok: true, text: `Updated ${username}.` });
      load();
    } catch { setFeedback({ ok: false, text: "Cannot reach the server." }); }
  };

  if (error) return <State title="Unable to load users" text={error} />;
  if (!users) return <State title="Loading users" text="Fetching accounts…" />;
  return (
    <div className="dash">
      <section className="panel" aria-labelledby="h-users">
        <div className="panel__head"><h2 id="h-users">User accounts</h2><span className="muted">{users.length} total</span></div>
        {feedback && <p role="status" className={feedback.ok ? "muted" : "form-error"}>{feedback.text}</p>}
        <div className="table-wrap" tabIndex={0} role="region" aria-label="User accounts table">
          <table>
            <thead><tr><th scope="col">Username</th><th scope="col">Role</th><th scope="col">Assigned bus</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
            <tbody>{users.map((u) => {
              const self = u.username === me.username;
              return (
                <tr key={u.username}>
                  <td>{u.username}{self && <span className="muted"> (you)</span>}</td>
                  <td>
                    <select aria-label={`Role for ${u.username}`} value={u.role} disabled={self} onChange={(e) => update(u.username, { role: e.target.value })}>
                      {!ROLE_LABEL[u.role] && <option value={u.role}>{u.role} (invalid)</option>}
                      {ROLES.map((r) => (<option key={r} value={r}>{ROLE_LABEL[r]}</option>))}
                    </select>
                  </td>
                  <td>
                    {u.role === "conductor" ? (
                      <select aria-label={`Assigned bus for ${u.username}`} value={conductors[u.username] ?? ""} disabled={!u.active} onChange={(e) => assign(u.username, e.target.value)}>
                        <option value="">No bus</option>
                        {busList.map((b) => (<option key={b.busId} value={b.busId}>{b.name} ({b.busId})</option>))}
                      </select>
                    ) : <span className="muted">–</span>}
                  </td>
                  <td><Badge tone={u.active ? "ok" : "off"}>{u.active ? "Active" : "Inactive"}</Badge></td>
                  <td><button className="btn btn--sm" disabled={self} onClick={() => update(u.username, { active: !u.active })}>{u.active ? "Deactivate" : "Activate"}</button></td>
                </tr>);
            })}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
