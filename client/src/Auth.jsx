// Sign-in, registration, email verification and password recovery screens.
// Everything security-relevant is decided by the server: this file only collects input and shows the server's answers.
// No secret is ever held here: Google sign-in is a plain link to the server (/api/auth/google), which holds the client secret.
import { useEffect, useRef, useState } from "react";
import { Bus, Eye, EyeOff, ArrowLeft, CheckCircle2, Mail } from "lucide-react";

const post = async (url, body) => {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  } catch { return { ok: false, status: 0, data: { error: "Cannot reach RouteWatch. Check your connection and try again." } }; }
};
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
const bytes = (s) => new TextEncoder().encode(s).length;
const passwordError = (p) => (!p ? "Enter a password." : p.length < 8 ? "Use at least 8 characters." : bytes(p) > 72 ? "Use at most 72 bytes (a shorter password)." : "");

// What the server's ?auth_error= codes mean (set when Google sign-in ends without a session).
const GOOGLE_ERRORS = {
  google_cancelled: "Google sign-in was cancelled. You can try again or sign in another way.",
  google_expired: "That Google sign-in took too long or was already used. Please try again.",
  google_state: "The Google sign-in could not be confirmed as started on this device. Please try again.",
  google_failed: "Google sign-in did not complete. Please try again.",
  google_email_unverified: "Your Google account's email address is not verified by Google, so it cannot be used to sign in.",
  google_email_in_use: "An account with this email address already exists. Sign in with your username or email and password. For your security, Google is not linked to an existing account automatically.",
  account_disabled: "This account is deactivated. Contact a RouteWatch administrator.",
  google_unavailable: "Google sign-in is not available on this server.",
  rate_limited: "Too many sign-in attempts. Wait a few minutes and try again.",
};

function GoogleMark() { // Google "G" logo, used as Google's sign-in branding guidelines describe
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>);
}

function Field({ id, label, error, hint, ...input }) {
  const describedBy = [error && `${id}-err`, hint && `${id}-hint`].filter(Boolean).join(" ") || undefined;
  return (
    <div className="au-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={!!error} aria-describedby={describedBy} {...input} />
      {hint && !error && <span className="au-hint" id={`${id}-hint`}>{hint}</span>}
      {error && <span className="au-err" id={`${id}-err`} role="alert">{error}</span>}
    </div>);
}

function PasswordField({ id, label, error, hint, value, onChange, autoComplete, extra }) {
  const [shown, setShown] = useState(false);
  const describedBy = [error && `${id}-err`, hint && `${id}-hint`].filter(Boolean).join(" ") || undefined;
  return (
    <div className="au-field">
      <div className="au-label-row"><label htmlFor={id}>{label}</label>{extra}</div>
      <div className="au-pw">
        <input id={id} type={shown ? "text" : "password"} value={value} onChange={onChange} autoComplete={autoComplete} maxLength={72}
          aria-invalid={!!error} aria-describedby={describedBy} spellCheck={false} autoCapitalize="off" />
        <button type="button" className="au-pw__toggle" onClick={() => setShown((s) => !s)} aria-pressed={shown} aria-controls={id}
          aria-label={shown ? "Hide password" : "Show password"} title={shown ? "Hide password" : "Show password"}>
          {shown ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
        </button>
      </div>
      {hint && !error && <span className="au-hint" id={`${id}-hint`}>{hint}</span>}
      {error && <span className="au-err" id={`${id}-err`} role="alert">{error}</span>}
    </div>);
}

const CodeField = ({ value, onChange, error, minutes }) => (
  <Field id="au-code" label="Verification code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*"
    className="au-code" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))} error={error}
    hint={`6 digits from the email. Valid for ${minutes} minutes, one use.`} />);

function Submit({ busy, children, busyText }) {
  return <button className="au-btn au-btn--primary" disabled={busy} aria-busy={busy}>{busy ? <><span className="au-spin" aria-hidden />{busyText}</> : children}</button>;
}

function Privacy() {
  return (
    <details className="au-privacy">
      <summary>How RouteWatch uses your information</summary>
      <ul>
        <li><strong>What we keep:</strong> your username, email address and role. Your password is stored only as a one-way (bcrypt) hash, never as text.</li>
        <li><strong>With Google:</strong> we receive only your Google account ID and verified email address. We do not get your Google password, name, photo or contacts.</li>
        <li><strong>Why:</strong> to sign you in, email you verification and password-reset codes, and protect your account. It is not used for advertising and not sold.</li>
        <li><strong>Security log:</strong> sign-ins and account changes (time, IP address, result) are recorded so administrators can investigate misuse.</li>
        <li><strong>Your location</strong> on the live map stays in your browser; it is not sent to RouteWatch.</li>
        <li><strong>Cookie:</strong> one cookie keeps you signed in. It ends when you sign out, after inactivity, or after a fixed time.</li>
      </ul>
    </details>);
}

export default function AuthScreen({ onLogin, onGuest, notice }) {
  const [view, setView] = useState("signin"); // signin | register | verify | forgot | reset | done
  const [opts, setOpts] = useState({ google: false, email: false, devOutbox: false, codeMinutes: 10 });
  const [banner, setBanner] = useState(null);  // { tone: "error" | "info" | "ok", text }
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ id: "", password: "", username: "", email: "", code: "", newPassword: "", confirm: "" });
  const [regPassword, setRegPassword] = useState(""); // kept in memory only, to finish sign-up; never stored
  const [cooldown, setCooldown] = useState(0);
  const heading = useRef(null);
  const first = useRef(true);

  useEffect(() => {
    fetch("/api/auth/options", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((o) => o && setOpts(o)).catch(() => {});
    const q = new URLSearchParams(window.location.search);
    const code = q.get("auth_error");
    if (code) {
      setBanner({ tone: "error", text: GOOGLE_ERRORS[code] ?? GOOGLE_ERRORS.google_failed });
      q.delete("auth_error");
      window.history.replaceState(null, "", `${window.location.pathname}${q.size ? `?${q}` : ""}${window.location.hash}`);
    }
  }, []);
  useEffect(() => { if (first.current) { first.current = false; return; } heading.current?.focus(); }, [view]); // screen readers hear the new step
  useEffect(() => { if (cooldown <= 0) return; const t = setTimeout(() => setCooldown((c) => c - 1), 1000); return () => clearTimeout(t); }, [cooldown]);

  const set = (k) => (e) => { setF((s) => ({ ...s, [k]: e.target.value })); if (errors[k]) setErrors((x) => ({ ...x, [k]: "" })); };
  const setCode = (v) => { setF((s) => ({ ...s, code: v })); if (errors.code) setErrors((x) => ({ ...x, code: "" })); };
  const go = (v, keepBanner = false) => { setView(v); setErrors({}); if (!keepBanner) setBanner(null); };
  const serverError = (r, fieldMap = {}) => {
    const field = fieldMap[r.data?.field] ?? r.data?.field;
    if (field && field in f) setErrors({ [field]: r.data.error });
    else setBanner({ tone: "error", text: r.status === 429 ? r.data?.error ?? "Too many attempts. Please wait." : r.data?.error ?? "Something went wrong. Please try again." });
  };
  const run = async (fn) => { setBusy(true); setBanner(null); try { await fn(); } finally { setBusy(false); } };

  // ---- actions ----
  const signIn = (e) => {
    e.preventDefault();
    const err = { id: f.id.trim() ? "" : "Enter your username or email.", password: f.password ? "" : "Enter your password." };
    if (err.id || err.password) return setErrors(err);
    run(async () => {
      const r = await post("/api/login", { username: f.id.trim(), password: f.password });
      if (r.ok) return onLogin(r.data);
      setF((s) => ({ ...s, password: "" }));
      setBanner({ tone: "error", text: r.data?.error ?? "Sign in failed. Please try again." });
    });
  };
  const register = (e) => {
    e.preventDefault();
    const username = f.username.trim().toLowerCase(), email = f.email.trim();
    const err = {
      username: USERNAME_RE.test(username) ? "" : "3-32 characters: lowercase letters, numbers, . _ -",
      email: EMAIL_RE.test(email) ? "" : "Enter a valid email address.",
      password: passwordError(f.password),
    };
    if (Object.values(err).some(Boolean)) return setErrors(err);
    run(async () => {
      const r = await post("/api/auth/register", { username, email, password: f.password });
      if (!r.ok) return serverError(r);
      setRegPassword(f.password); setF((s) => ({ ...s, password: "", code: "", email: r.data.email ?? email }));
      setCooldown(60); go("verify");
    });
  };
  const verify = (e) => {
    e.preventDefault();
    const password = regPassword || f.password;
    const err = { code: /^\d{6}$/.test(f.code) ? "" : "Enter the 6-digit code.", password: regPassword ? "" : passwordError(f.password) };
    if (err.code || err.password) return setErrors(err);
    run(async () => {
      const r = await post("/api/auth/register/verify", { email: f.email, code: f.code, password });
      if (r.ok) { setRegPassword(""); return onLogin(r.data); }
      if (r.data?.code === "username_taken") { setRegPassword(""); go("register"); setErrors({ username: r.data.error }); return; }
      setErrors({ code: r.data?.error ?? "That code did not work." });
    });
  };
  const resend = (url) => run(async () => {
    const r = await post(url, { email: f.email });
    if (!r.ok) return serverError(r);
    setCooldown(60);
    setBanner({ tone: "info", text: "If a code can be sent to this address, a new one is on its way. Only the newest code works." });
  });
  const forgot = (e) => {
    e.preventDefault();
    if (!EMAIL_RE.test(f.email.trim())) return setErrors({ email: "Enter the email address of your account." });
    run(async () => {
      const r = await post("/api/auth/password/forgot", { email: f.email.trim() });
      if (!r.ok) return serverError(r);
      setF((s) => ({ ...s, email: s.email.trim(), code: "", newPassword: "", confirm: "" }));
      setCooldown(60); go("reset");
    });
  };
  const reset = (e) => {
    e.preventDefault();
    const err = {
      code: /^\d{6}$/.test(f.code) ? "" : "Enter the 6-digit code.",
      newPassword: passwordError(f.newPassword),
      confirm: f.confirm === f.newPassword ? "" : "The passwords do not match.",
    };
    if (Object.values(err).some(Boolean)) return setErrors(err);
    run(async () => {
      const r = await post("/api/auth/password/reset", { email: f.email, code: f.code, password: f.newPassword });
      if (r.ok) { setF((s) => ({ ...s, code: "", newPassword: "", confirm: "", password: "", id: s.email })); return go("done"); }
      if (r.data?.field === "password") return setErrors({ newPassword: r.data.error });
      setErrors({ code: r.data?.error ?? "That code did not work." });
    });
  };

  const google = (label) => opts.google && (
    <>
      <a className="au-btn au-btn--google" href="/api/auth/google"><GoogleMark />{label}</a>
      <div className="au-or" role="separator"><span>or</span></div>
    </>);
  const back = (to, text = "Back to sign in") => <button type="button" className="au-back" onClick={() => go(to)}><ArrowLeft size={16} aria-hidden />{text}</button>;
  const devNote = opts.devOutbox && <p className="au-dev">Development mode: emails are not sent. They are saved as files in <code>server/data/dev-outbox</code>.</p>;
  const resendBtn = (url) => (
    <button type="button" className="au-link" disabled={busy || cooldown > 0} onClick={() => resend(url)}>
      {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
    </button>);

  let body;
  if (view === "signin") body = (
    <form onSubmit={signIn} noValidate>
      <h1 ref={heading} tabIndex={-1}>Sign in</h1>
      <p className="au-sub">Track buses and plan your trip on the Villanueva–CDO corridor.</p>
      {google("Continue with Google")}
      <Field id="au-id" label="Email or username" autoComplete="username" maxLength={254} autoCapitalize="off" spellCheck={false} value={f.id} onChange={set("id")} error={errors.id} />
      <PasswordField id="au-password" label="Password" autoComplete="current-password" value={f.password} onChange={set("password")} error={errors.password}
        extra={opts.email && <button type="button" className="au-link" onClick={() => { setF((s) => ({ ...s, email: s.id.includes("@") ? s.id.trim() : s.email })); go("forgot"); }}>Forgot password?</button>} />
      <Submit busy={busy} busyText="Signing in…">Sign in</Submit>
      {(opts.email || opts.google) && <p className="au-switch">New to RouteWatch? <button type="button" className="au-link" onClick={() => go("register")}>Create an account</button></p>}
      <button type="button" className="au-link au-guest" onClick={onGuest}>Continue as guest (live map only)</button>
    </form>);
  else if (view === "register") body = (
    <form onSubmit={register} noValidate>
      <h1 ref={heading} tabIndex={-1}>Create your account</h1>
      <p className="au-sub">Passenger accounts are free. Staff accounts are set up by an administrator.</p>
      {google("Sign up with Google")}
      {opts.email ? (
        <>
          <Field id="au-username" label="Username" autoComplete="username" maxLength={32} autoCapitalize="off" spellCheck={false} value={f.username} onChange={set("username")} error={errors.username} hint="3-32 characters: lowercase letters, numbers, . _ -" />
          <Field id="au-email" label="Email" type="email" autoComplete="email" maxLength={254} value={f.email} onChange={set("email")} error={errors.email} hint="We'll send a code to confirm it's yours." />
          <PasswordField id="au-password" label="Password" autoComplete="new-password" value={f.password} onChange={set("password")} error={errors.password} hint="At least 8 characters." />
          <Submit busy={busy} busyText="Creating account…">Create account</Submit>
        </>) : <p className="au-sub">Email sign-up is not available on this server yet.</p>}
      <p className="au-switch">Already have an account? <button type="button" className="au-link" onClick={() => go("signin")}>Sign in</button></p>
    </form>);
  else if (view === "verify") body = (
    <form onSubmit={verify} noValidate>
      {back("register", "Use a different email")}
      <div className="au-icon" aria-hidden><Mail size={22} /></div>
      <h1 ref={heading} tabIndex={-1}>Check your email</h1>
      <p className="au-sub">If <strong>{f.email}</strong> can receive a code from us, it is on its way. Enter it below to finish creating your account.</p>
      {devNote}
      <CodeField value={f.code} onChange={setCode} error={errors.code} minutes={opts.codeMinutes} />
      {!regPassword && <PasswordField id="au-password" label="Password you chose" autoComplete="current-password" value={f.password} onChange={set("password")} error={errors.password} hint="Needed again because the page was reloaded." />}
      <Submit busy={busy} busyText="Verifying…">Verify and continue</Submit>
      <p className="au-switch">Didn't get it? Check spam, then {resendBtn("/api/auth/register/resend")}</p>
    </form>);
  else if (view === "forgot") body = (
    <form onSubmit={forgot} noValidate>
      {back("signin")}
      <h1 ref={heading} tabIndex={-1}>Reset your password</h1>
      <p className="au-sub">Enter the email address of your account and we'll send you a code.</p>
      <Field id="au-email" label="Email" type="email" autoComplete="email" maxLength={254} value={f.email} onChange={set("email")} error={errors.email} />
      <Submit busy={busy} busyText="Sending…">Send code</Submit>
      <p className="au-note">Signed up with Google? Your account has no RouteWatch password. Use Continue with Google instead.</p>
    </form>);
  else if (view === "reset") body = (
    <form onSubmit={reset} noValidate>
      {back("forgot", "Use a different email")}
      <div className="au-icon" aria-hidden><Mail size={22} /></div>
      <h1 ref={heading} tabIndex={-1}>Enter your code</h1>
      <p className="au-sub">If an account with a password uses <strong>{f.email}</strong>, we sent it a code.</p>
      {devNote}
      <CodeField value={f.code} onChange={setCode} error={errors.code} minutes={opts.codeMinutes} />
      <PasswordField id="au-new" label="New password" autoComplete="new-password" value={f.newPassword} onChange={set("newPassword")} error={errors.newPassword} hint="At least 8 characters." />
      <PasswordField id="au-confirm" label="Confirm new password" autoComplete="new-password" value={f.confirm} onChange={set("confirm")} error={errors.confirm} />
      <Submit busy={busy} busyText="Saving…">Reset password</Submit>
      <p className="au-switch">Didn't get it? Check spam, then {resendBtn("/api/auth/password/forgot")}</p>
    </form>);
  else body = (
    <div className="au-done">
      <div className="au-icon au-icon--ok" aria-hidden><CheckCircle2 size={24} /></div>
      <h1 ref={heading} tabIndex={-1}>Password updated</h1>
      <p className="au-sub">For your security, you were signed out on all devices. Sign in with your new password.</p>
      <button className="au-btn au-btn--primary" onClick={() => go("signin")}>Sign in</button>
    </div>);

  const shownBanner = banner ?? (notice ? { tone: "info", text: notice } : null);
  return (
    <main className="au">
      <div className="au-card" key={view}>
        <div className="brand au-brand"><span className="brand__mark"><Bus size={20} aria-hidden /></span>RouteWatch</div>
        {shownBanner && <p className={`au-banner au-banner--${shownBanner.tone}`} role={shownBanner.tone === "error" ? "alert" : "status"}>{shownBanner.text}</p>}
        {body}
        <Privacy />
      </div>
    </main>);
}
