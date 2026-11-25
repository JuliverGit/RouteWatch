import { useCallback, useEffect, useState } from "react";
import { Badge } from "../../components/ui/Badge.jsx";
import { State } from "../../components/ui/State.jsx";

export function AuditPage({ onUnauthorized }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(() => fetch("/api/audit?limit=100", { credentials: "same-origin" })
    .then(async (r) => {
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => ({}));
      r.ok ? (setRows(d), setError("")) : setError(d.error || "Request failed");
    })
    .catch(() => setError("Cannot reach the server.")), [onUnauthorized]);
  useEffect(() => { load(); }, [load]);
  const tone = { success: "ok", denied: "bad", failure: "warn" };

  if (error) return <State title="Unable to load audit log" text={error} />;
  if (!rows) return <State title="Loading audit log" text="Fetching recent activity…" />;
  return (
    <div className="dash">
      <section className="panel" aria-labelledby="h-audit">
        <div className="panel__head"><h2 id="h-audit">Recent security activity</h2><button className="btn btn--sm" onClick={load}>Refresh</button></div>
        {rows.length === 0 ? <p className="muted">No activity recorded yet.</p> : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Audit log table">
            <table>
              <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">User</th><th scope="col">Target</th><th scope="col">Result</th><th scope="col">IP</th><th scope="col">Details</th></tr></thead>
              <tbody>{rows.map((e, i) => (
                <tr key={`${e.ts}-${i}`}>
                  <td>{new Date(e.ts).toLocaleString()}</td><td>{e.action.replaceAll("_", " ")}</td><td>{e.actor ?? "–"}</td><td>{e.target ?? "–"}</td>
                  <td><Badge tone={tone[e.outcome] || "info"}>{e.outcome}</Badge></td><td>{e.ip ?? "–"}</td>
                  <td>{e.detail ? Object.entries(e.detail).map(([k, v]) => `${k}: ${v}`).join(", ") : "–"}</td>
                </tr>))}</tbody>
            </table>
          </div>)}
      </section>
    </div>
  );
}
