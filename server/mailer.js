// Outgoing email (verification and password-recovery codes).
//
//   MAIL_TRANSPORT=smtp        real email through your provider: SMTP_HOST, SMTP_PORT, SMTP_SECURE (true for port 465),
//                              SMTP_USER, SMTP_PASSWORD, MAIL_FROM. Needs the "nodemailer" package (npm install nodemailer@10.3.1).
//   MAIL_TRANSPORT=dev-outbox  DEVELOPMENT ONLY: each message is written as a text file to MAIL_OUTBOX_DIR
//                              (default server/data/dev-outbox, git-ignored) instead of being sent. Refused when NODE_ENV=production.
// Default: dev-outbox in development; in production nothing is configured, so email features report "unavailable".
//
// Message bodies (which contain codes) are never written to the console or the audit log. Only the fact that a message was
// sent, and to a masked address, is printed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const IS_PROD = process.env.NODE_ENV === "production";
const MODE = (process.env.MAIL_TRANSPORT || (IS_PROD ? "" : "dev-outbox")).toLowerCase();
const OUTBOX = process.env.MAIL_OUTBOX_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "dev-outbox");
const FROM = process.env.MAIL_FROM || "RouteWatch <no-reply@localhost>";

/** r***@example.com: enough for an operator to recognise, not enough to collect addresses from logs. */
export const maskEmail = (e) => { const [u, d] = String(e).split("@"); return d ? `${u.slice(0, 1)}***@${d}` : "***"; };

/** Is there a way to deliver email? Registration and recovery are offered only when there is. */
export const mailAvailable = () => MODE === "smtp" ? !!process.env.SMTP_HOST : MODE === "dev-outbox" && !IS_PROD;
export const mailMode = () => (mailAvailable() ? MODE : "none");

let smtp = null;
async function smtpTransport() {
  if (smtp) return smtp;
  let nodemailer;
  try { nodemailer = (await import("nodemailer")).default; }
  catch { throw new Error('MAIL_TRANSPORT=smtp needs the "nodemailer" package. Run in the server folder: npm install --save-exact nodemailer@10.3.1'); }
  smtp = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    requireTLS: process.env.SMTP_SECURE !== "true", // STARTTLS on 587: never send codes over an unencrypted connection
  });
  return smtp;
}

/** Sends one plain-text message. Throws when it cannot be delivered (callers keep their answer generic regardless). */
export async function sendMail({ to, subject, text }) {
  if (!mailAvailable()) throw new Error("Email delivery is not configured (MAIL_TRANSPORT).");
  if (MODE === "smtp") {
    await (await smtpTransport()).sendMail({ from: FROM, to, subject, text });
  } else {
    if (IS_PROD) throw new Error("dev-outbox is not allowed in production");
    fs.mkdirSync(OUTBOX, { recursive: true });
    const file = path.join(OUTBOX, `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}.txt`);
    fs.writeFileSync(file, `From: ${FROM}\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`, { mode: 0o600 });
  }
  console.log(`[mail] ${MODE}: "${subject}" to ${maskEmail(to)}`);
}
