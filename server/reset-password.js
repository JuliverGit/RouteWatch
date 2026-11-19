// Resets the password of an EXISTING account. Usage:  npm run reset-password -- <username>
// The new password is typed twice at a hidden prompt, so it is never in the code, the command line or shell history.
// Only the password hash changes: username, role, active status, bus assignments and every other record are kept.
// The account's open sign-in sessions are ended, and the reset is written to the audit log (never the password or hash).
// Runs as the application database account (DB_USER), which is already allowed to update users.
import "./env.js";
import os from "node:os";
import readline from "node:readline";
import { findUser, setPassword, passwordProblem } from "./users.js";
import { audit, flushAudit } from "./audit.js";
import { close } from "./db.js";

/** One readline interface for every question, so piped input (automation, tests) is not lost between prompts. */
function createPrompter() {
  const tty = !!process.stdin.isTTY;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  rl.setPrompt("");
  let muted = false;
  const write = rl._writeToOutput.bind(rl);
  // While muted, typed characters are not echoed; only the final line break is shown.
  rl._writeToOutput = (s) => (muted ? (s.includes("\n") || s.includes("\r") ? write("\n") : undefined) : write(s));
  rl.on("SIGINT", () => rl.close()); // Ctrl+C cancels the prompt
  const lines = rl[Symbol.asyncIterator]();
  return {
    tty,
    /** Resolves to the typed line, or null when input ended or was cancelled. */
    async hidden(question) {
      process.stdout.write(question);
      muted = true;
      try { const r = await lines.next(); return r.done ? null : r.value; }
      finally { muted = false; if (!tty) process.stdout.write("\n"); }
    },
    close: () => rl.close(),
  };
}

const operator = `cli:${String(os.userInfo().username || "unknown").replace(/[^\w.-]/g, "").slice(0, 40)}`;
const args = process.argv.slice(2);
let prompt = null;

try {
  if (args.length !== 1) throw new Error("Usage: npm run reset-password -- <username>");
  const account = await findUser(args[0]);
  if (!account) throw new Error("No account with that username exists. Nothing was changed.");
  console.log(`Resetting the password of "${account.username}" (role: ${account.role}, ${account.active ? "active" : "INACTIVE"}).`);

  prompt = createPrompter();
  if (!prompt.tty) console.error("Note: input is not an interactive terminal; reading the password from standard input.");
  const password = await prompt.hidden("New password: ");
  if (password === null) throw new Error("Cancelled. Nothing was changed.");
  const problem = passwordProblem(password);
  if (problem) throw new Error(`${problem}. Nothing was changed.`);
  const confirm = await prompt.hidden("Confirm new password: ");
  if (confirm === null) throw new Error("Cancelled. Nothing was changed.");
  if (password !== confirm) throw new Error("Passwords do not match. Nothing was changed.");
  prompt.close(); prompt = null;

  const r = await setPassword(account.username, password);
  if (r.error) throw new Error(`${r.error} Nothing was changed.`);
  audit({ action: "password_reset", actor: operator, target: r.user.username, detail: { via: "reset-password", account_role: r.user.role, signed_out: r.sessionsEnded } });
  await flushAudit();
  console.log(`Password changed for "${r.user.username}". Role (${r.user.role}) and status (${r.user.active ? "active" : "inactive"}) are unchanged.`);
  if (r.sessionsEnded) console.log(`${r.sessionsEnded} existing sign-in session(s) were ended; sign in again with the new password.`);
  if (!r.user.active) console.log("Warning: this account is INACTIVE, so it still cannot sign in until an administrator activates it.");
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
} finally {
  prompt?.close();
  await close();
}
