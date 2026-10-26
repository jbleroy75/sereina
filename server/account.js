// Compte sans mot de passe par code e-mail (repris de renta-immo : email-otp-gate).
// L'utilisateur anonyme (cookie) donne son e-mail, reçoit un code à 6 chiffres, et son espace devient un compte.
// S'il existe déjà un compte pour cet e-mail (autre appareil), l'espace anonyme y est fusionné : crédits,
// conversations, achats. Les crédits ne sont donc plus liés au navigateur.
import crypto from "node:crypto";
import { disposableDomains } from "#files";
import { db, q, now } from "./db.js";
import { hmac } from "./security/secret.js";
import { queueEmail } from "./mailqueue.js";

const DISPOSABLE = new Set(disposableDomains());
const CODE_TTL_MIN = 10, MAX_ATTEMPTS = 5;

db.exec(`CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email_hash, created_at);`);

export function normalizeEmail(raw) {
  const e = String(raw || "").trim().toLowerCase().slice(0, 254);
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e) ? e : null;
}
/** Forme canonique pour l'anti-abus : Gmail ignore les points et les « +alias ». */
export function canonicalEmail(e) {
  let [local, domain] = e.split("@");
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}
export const isDisposable = e => { const d = e.split("@")[1]; return DISPOSABLE.has(d) || [...DISPOSABLE].some(x => d.endsWith("." + x)); };
export const emailHash = e => hmac("email", e);
export const maskEmail = e => { const [l, d] = String(e || "").split("@"); return l && d ? `${l.slice(0, 2)}${"•".repeat(Math.max(1, l.length - 2))}@${d}` : ""; };

const qq = {
  insertCode: db.prepare("INSERT INTO login_codes (email_hash, code_hash, expires_at, created_at, ip) VALUES (?, ?, ?, ?, ?)"),
  lastCode: db.prepare("SELECT * FROM login_codes WHERE email_hash = ? ORDER BY id DESC LIMIT 1"),
  recentCount: db.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE email_hash = ? AND created_at > ?"),
  bump: db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?"),
  clear: db.prepare("DELETE FROM login_codes WHERE email_hash = ?"),
  purge: db.prepare("DELETE FROM login_codes WHERE expires_at < ?"),
  byHash: db.prepare("SELECT * FROM users WHERE email_hash = ?"),
  attach: db.prepare("UPDATE users SET email = ?, email_hash = ?, email_verified_at = ? WHERE id = ?"),
  setOptin: db.prepare("UPDATE users SET marketing_optin = ?, marketing_optin_at = CASE WHEN ? = 1 THEN ? ELSE marketing_optin_at END WHERE id = ?"),
};

/** Envoie un code. Retourne {ok} ou {error}. */
export function requestCode(rawEmail, ip) {
  const email = normalizeEmail(rawEmail);
  if (!email) return { error: "Cette adresse e-mail ne semble pas valide." };
  if (isDisposable(email)) return { error: "Merci d'utiliser une adresse e-mail permanente : les adresses temporaires ne sont pas acceptées." };
  const eh = emailHash(email);
  if (qq.recentCount.get(eh, new Date(Date.now() - 15 * 60000).toISOString()).n >= 3) return { error: "Trop de codes demandés. Patientez quelques minutes, puis réessayez." };
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  qq.insertCode.run(eh, hmac("otp", `${eh}:${code}`), new Date(Date.now() + CODE_TTL_MIN * 60000).toISOString(), now(), ip || null);
  queueEmail({ type: "login_code", to: email, priority: "high", subject: `Votre code Sereina : ${code}`,
    text: `Bonjour,\n\nVoici votre code pour accéder à votre espace Sereina :\n\n    ${code}\n\nIl est valable ${CODE_TTL_MIN} minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez simplement ce message.\n\nL'équipe Sereina` });
  return { ok: true };
}

/** Vérifie le code. Retourne {ok, user, created, merged} ou {error}. */
export function verifyCode(rawEmail, rawCode, currentUser, { marketingOptin = false } = {}) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode || "").replace(/\D/g, "");
  if (!email || code.length !== 6) return { error: "Code incorrect." };
  const eh = emailHash(email);
  const row = qq.lastCode.get(eh);
  if (!row || row.expires_at < now()) return { error: "Ce code a expiré. Demandez-en un nouveau." };
  if (row.attempts >= MAX_ATTEMPTS) return { error: "Trop d'essais. Demandez un nouveau code." };
  const expected = hmac("otp", `${eh}:${code}`);
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(row.code_hash))) { qq.bump.run(row.id); return { error: "Code incorrect." }; }
  qq.clear.run(eh);

  const existing = qq.byHash.get(eh);
  let user, created = false, merged = false;
  if (!existing) {
    qq.attach.run(email, eh, now(), currentUser.id);
    user = q.getUser.get(currentUser.id); created = true;
  } else if (existing.id === currentUser.id) {
    qq.attach.run(email, eh, existing.email_verified_at || now(), existing.id);
    user = q.getUser.get(existing.id);
  } else {
    mergeInto(currentUser, existing);
    if (!existing.email_verified_at) qq.attach.run(email, eh, now(), existing.id);
    user = q.getUser.get(existing.id); merged = true;
  }
  if (marketingOptin) qq.setOptin.run(1, 1, now(), user.id);
  q.logEvent.run(user.id, created ? "account_created" : merged ? "account_login_merged" : "account_login", null, now());
  return { ok: true, user, created, merged };
}

/** Fusionne l'espace anonyme `from` dans le compte `to`, puis supprime `from`. */
export const mergeInto = db.transaction((from, to) => {
  if (!from || from.id === to.id) return;
  for (const t of ["messages", "purchases", "alerts", "events", "ai_usage", "email_log"]) {
    try { db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id = ?`).run(to.id, from.id); } catch {}
  }
  try { db.prepare("UPDATE OR IGNORE trial_claims SET user_id = ? WHERE user_id = ?").run(to.id, from.id); db.prepare("DELETE FROM trial_claims WHERE user_id = ?").run(from.id); } catch {}
  db.prepare(`UPDATE users SET
      credits = credits + ?,
      consent_at = COALESCE(consent_at, ?),
      free_started_at = COALESCE(free_started_at, ?),
      free_messages = MAX(free_messages, ?),
      risk_level = MAX(risk_level, ?),
      risk_reason = CASE WHEN ? > risk_level THEN ? ELSE risk_reason END,
      first_name = COALESCE(first_name, ?), phone = COALESCE(phone, ?), city = COALESCE(city, ?),
      stripe_customer_id = COALESCE(stripe_customer_id, ?), stripe_payment_method = COALESCE(stripe_payment_method, ?)
    WHERE id = ?`).run(from.credits || 0, from.consent_at, from.free_started_at, from.free_messages || 0,
    from.risk_level || 0, from.risk_level || 0, from.risk_reason, from.first_name, from.phone, from.city,
    from.stripe_customer_id, from.stripe_payment_method, to.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(from.id);
});

export function setMarketingOptin(userId, on) { qq.setOptin.run(on ? 1 : 0, on ? 1 : 0, now(), userId); }
export function purgeCodes() { try { qq.purge.run(now()); } catch {} }
