// A labelled form field for the management forms: the control is passed as children, with a hint or an error under it.
// (The sign-in screens in Auth.jsx have their own Field, which renders its own input: a different component.)
export function Field({ id, label, error, hint, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error && <span className="muted small small--tight" id={`${id}-hint`}>{hint}</span>}
      {error && <span className="field-error" id={`${id}-err`} role="alert">{error}</span>}
    </div>
  );
}
