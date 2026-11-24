import { useEffect, useRef } from "react";

// A dialog: focuses its first control, keeps Tab inside, closes on Escape or a click on the backdrop, and gives focus back on close.
export function Modal({ title, onClose, children, labelledBy }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    const first = ref.current?.querySelector("input:not([disabled]), textarea:not([disabled]), select, button");
    first?.focus();
    const key = (e) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab") return; // keep keyboard focus inside the dialog
      const f = [...ref.current.querySelectorAll("input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])")];
      if (!f.length) return;
      const a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        <h2 id={labelledBy}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// A yes/no dialog built on Modal: Cancel, and a confirm button that shows "Working…" while busy.
export function Confirm({ title, children, label, busy, onCancel, onConfirm, danger = true }) {
  return (
    <Modal title={title} onClose={onCancel} labelledBy="h-confirm">
      {children}
      <div className="modal__actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className={`btn ${danger ? "btn--danger" : "btn--primary"}`} disabled={busy} onClick={onConfirm}>{busy ? "Working…" : label}</button>
      </div>
    </Modal>
  );
}
