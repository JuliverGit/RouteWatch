import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Minus } from "lucide-react";
import { timeFmt } from "../../utils/format.js";
import { post } from "../../services/http.js";
import { Badge } from "../../components/ui/Badge.jsx";
import { State } from "../../components/ui/State.jsx";
import { Confirm } from "../../components/ui/Modal.jsx";

// ---- Conductor: passenger counter ----
// Mobile-first. The conductor taps + when a passenger boards and - when one gets off. The screen never sends a number:
// it tells the server what happened, and shows whatever count the server answers with. Taps are sent one after another,
// so a quick series is never lost or applied out of order. Which bus the conductor may count is decided by the server.
export function CounterPage({ onUnauthorized }) {
  const [state, setState] = useState(null);   // { bus, occupancy } from the server, or { bus: null }
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [pending, setPending] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const chain = useRef(Promise.resolve());
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/conductor/bus", { credentials: "same-origin" });
      if (r.status === 401) return onUnauthorized();
      const d = await r.json().catch(() => null);
      if (!r.ok || !d) return setError((d && d.error) || "The counter could not be loaded.");
      setState(d); setError("");
    } catch { setError("Cannot reach the server."); }
  }, [onUnauthorized]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]); // follows an administrator's change of bus or capacity

  const busId = state?.bus?.busId;
  const act = (action) => {
    setMsg(""); setPending((n) => n + 1);
    chain.current = chain.current.then(async () => {
      try {
        const r = await post(`/api/buses/${encodeURIComponent(busId)}/occupancy`, { action });
        if (r.status === 401) return onUnauthorized();
        const d = await r.json().catch(() => ({}));
        if (r.ok) setState((s) => ({ ...s, occupancy: d.occupancy }));
        else { setMsg(d.error || "The count could not be changed."); load(); }
      } catch { setMsg("Cannot reach the server. The count was not changed."); }
      finally { setPending((n) => n - 1); }
    });
  };

  if (error && !state) return <State title="Unable to load the counter" text={error} action={<button className="btn" onClick={load}>Try again</button>} />;
  if (!state) return <State title="Loading" text="Fetching your bus…" />;
  if (!state.bus) return <State title="No bus assigned" text="You are not assigned to a bus yet. Ask an administrator to assign you one." action={<button className="btn" onClick={load}>Check again</button>} />;
  const { bus, occupancy: o } = state;
  const cap = o.capacity;
  const started = o.reported;
  const count = started ? o.count : 0;
  return (
    <div className="dash counter">
      {error && <p className="alert" role="alert">{error} Showing the last known count.</p>}
      <section className="panel counter__card" aria-labelledby="h-counter">
        <div className="panel__head"><h2 id="h-counter">{bus.name}</h2><span className="muted">{bus.busId}</span></div>
        <div className="muted">{bus.routeName ?? "No route assigned"}</div>
        {cap == null ? (
          <p className="form-error" role="alert">This bus has no capacity set, so passengers cannot be counted. Ask an administrator to set it.</p>
        ) : (
          <>
            <div className="counter__num" role="status" aria-live="polite" aria-atomic="true">
              <span className="counter__big">{count}</span>
              <span className="counter__of">of {cap} passengers</span>
              <span className="sr-only">{started ? `${count} passengers on board, ${o.available} seats available, ${o.label}` : "Counting has not started"}</span>
            </div>
            <progress className={`meter meter--${o.level}`} value={count} max={cap} aria-label={`${count} of ${cap} seats taken`} />
            <div className="counter__facts">
              <div><span className="muted">Available seats</span><strong>{started ? o.available : cap}</strong></div>
              <div><span className="muted">Occupancy</span><strong>{started ? `${o.percent}%` : "0%"}</strong></div>
              <div><span className="muted">Status</span>{started ? <Badge tone={o.tone}>{o.label}</Badge> : <Badge tone="off">Not started</Badge>}</div>
            </div>
            <div className="counter__buttons">
              <button className="counter__btn counter__btn--minus" onClick={() => act("alight")} disabled={!started || count <= 0} aria-label="Passenger got off: subtract one"><Minus size={40} aria-hidden /><span>Got off</span></button>
              <button className="counter__btn counter__btn--plus" onClick={() => act("board")} disabled={count >= cap} aria-label="Passenger boarded: add one"><Plus size={40} aria-hidden /><span>Boarded</span></button>
            </div>
            <p className="muted small" aria-live="polite">{pending > 0 ? "Saving…" : started && o.updatedAt ? `Last updated ${timeFmt(o.updatedAt)}` : "Tap Boarded for the first passenger, or start the trip at 0."}</p>
            {msg && <p className="form-error" role="alert">{msg}</p>}
            <div className="counter__more">
              <button className="btn" onClick={() => setConfirm(true)} disabled={pending > 0}>{started ? "Start new trip (reset to 0)" : "Start trip at 0"}</button>
            </div>
          </>)}
      </section>
      {confirm && (
        <Confirm title="Reset the passenger count?" label="Reset to 0" danger={false} busy={false} onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); act("reset"); }}>
          <p>Use this at the start of a trip, when the bus is empty. The count for {bus.name} will be set to 0 and the change is recorded in the audit log.</p>
        </Confirm>)}
    </div>
  );
}
