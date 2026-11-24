import { useCallback, useEffect, useState } from "react";
import { getJson } from "../services/http.js";

/** Loads several staff endpoints together and polls them. Returns [data, error, reload]. */
export function useStaffData(urls, onUnauthorized, every = 8000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const key = urls.join("|");
  const load = useCallback(async () => {
    try {
      const rs = await Promise.all(key.split("|").map(getJson));
      if (rs.some((r) => r.status === 401)) return onUnauthorized();
      const bad = rs.find((r) => !r.ok || !r.body);
      if (bad) return setError((bad.body && bad.body.error) || "The data could not be read.");
      setData(rs.map((r) => r.body)); setError("");
    } catch { setError("Cannot reach the server."); }
  }, [key, onUnauthorized]);
  useEffect(() => { load(); const t = setInterval(load, every); return () => clearInterval(t); }, [load, every]);
  return [data, error, load];
}
