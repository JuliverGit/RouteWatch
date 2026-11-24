import { useEffect, useState } from "react";

/** Active service alerts for the signed-in user or visitor. Reloads when the server says alerts changed (tick) and once a minute (expiry). */
export function useActiveAlerts(tick) {
  const [alerts, setAlerts] = useState(null);
  useEffect(() => {
    let live = true;
    const go = () => fetch("/api/alerts/active", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (live && d && Array.isArray(d.alerts)) setAlerts(d.alerts); }).catch(() => {});
    go(); const t = setInterval(go, 60000);
    return () => { live = false; clearInterval(t); };
  }, [tick]);
  return alerts;
}
