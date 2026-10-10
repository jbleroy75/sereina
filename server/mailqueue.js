// File d'attente d'e-mails avec reprise, reprise de renta-immo (lib/infra/email-queue.ts) :
// un e-mail est d'abord écrit en base, puis envoyé par un processeur ; en cas d'échec,
// nouvel essai après 1 min, 5 min, 30 min, puis statut FAILED visible dans /api/health et le back-office.
import nodemailer from "nodemailer";
import { db, now } from "./db.js";

const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000];

db.exec(`CREATE TABLE IF NOT EXISTS email_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to TEXT,
  priority TEXT DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'PENDING',     -- PENDING | SENT | FAILED
  attempts INTEGER DEFAULT 0,
  next_retry_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_queue_due ON email_queue(status, next_retry_at);`);

const q = {
  insert: db.prepare("INSERT INTO email_queue (type, recipient, subject, body, reply_to, priority, next_retry_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  due: db.prepare("SELECT * FROM email_queue WHERE status = 'PENDING' AND next_retry_at <= ? ORDER BY id LIMIT ?"),
  sent: db.prepare("UPDATE email_queue SET status = 'SENT', sent_at = ?, attempts = attempts + 1 WHERE id = ?"),
  retry: db.prepare("UPDATE email_queue SET attempts = attempts + 1, next_retry_at = ?, last_error = ? WHERE id = ?"),
  failed: db.prepare("UPDATE email_queue SET status = 'FAILED', attempts = attempts + 1, last_error = ? WHERE id = ?"),
  stats: db.prepare("SELECT status, COUNT(*) AS n FROM email_queue GROUP BY status"),
  purge: db.prepare("DELETE FROM email_queue WHERE status = 'SENT' AND sent_at < datetime('now', '-30 day')"),
};

export const emailConfigured = () => !!(process.env.SMTP_HOST && (process.env.SMTP_FROM || process.env.SMTP_USER));

let transport = null;
function getTransport() {
  if (!transport) transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === "1",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: 10_000, socketTimeout: 20_000,
  });
  return transport;
}

/** Met un e-mail en file. Retourne l'id, ou null si l'e-mail n'est pas configuré. */
export function queueEmail({ type, to, subject, text, replyTo = null, priority = "normal" }) {
  if (!emailConfigured() || !to) return null;
  const clean = s => String(s ?? "").replace(/[\r\n]/g, " ").slice(0, 500); // anti-injection d'en-têtes (repris)
  const r = q.insert.run(type, clean(to), clean(subject), String(text), replyTo ? clean(replyTo) : null, priority, now(), now());
  // Tentative immédiate, sans bloquer l'appelant
  setImmediate(() => processQueue(5).catch(e => console.error("mailqueue", e.message)));
  return r.lastInsertRowid;
}

let running = false;
export async function processQueue(batch = 50) {
  if (running || !emailConfigured()) return { sent: 0, failed: 0 };
  running = true;
  const result = { sent: 0, failed: 0, retried: 0 };
  try {
    for (const m of q.due.all(now(), batch)) {
      try {
        await getTransport().sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: m.recipient, subject: m.subject, text: m.body, replyTo: m.reply_to || undefined, priority: m.priority === "high" ? "high" : "normal" });
        q.sent.run(now(), m.id); result.sent++;
      } catch (e) {
        const err = String(e.message || e).slice(0, 300);
        if (m.attempts < RETRY_DELAYS_MS.length) { q.retry.run(new Date(Date.now() + RETRY_DELAYS_MS[m.attempts]).toISOString(), err, m.id); result.retried++; }
        else { q.failed.run(err, m.id); result.failed++; console.error(`[mailqueue] e-mail ${m.id} (${m.type}) abandonné après ${m.attempts + 1} essais : ${err}`); }
      }
    }
  } finally { running = false; }
  return result;
}

export function queueStats() {
  const s = { PENDING: 0, SENT: 0, FAILED: 0 };
  for (const r of q.stats.all()) s[r.status] = r.n;
  return s;
}

export function startQueueProcessor() {
  setInterval(() => processQueue().catch(e => console.error("mailqueue", e.message)), 60_000);
  setInterval(() => { try { q.purge.run(); } catch {} }, 6 * 3600 * 1000);
}
