// Avis : collectés auprès de vraies personnes (chat) ou saisis par l'équipe à partir d'un avis réellement reçu.
// Règles : jamais de texte modifié, publication seulement avec l'accord de l'auteur et après relecture,
// jamais de demande d'avis à une personne qui a traversé une détresse (orange/rouge).
import { db, now } from "./db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  user_id TEXT,
  guide TEXT,
  rating INTEGER NOT NULL,
  comment TEXT,
  display_name TEXT,
  consent_publish INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  source TEXT NOT NULL DEFAULT 'chat',      -- chat | manuel
  origin_note TEXT,                         -- manuel : d'où vient l'avis (e-mail, courrier, oral…)
  moderated_by TEXT,
  moderated_at TEXT,
  reject_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id) WHERE user_id IS NOT NULL AND source = 'chat';
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, created_at);
`);

export const MIN_MESSAGES = 6;       // échanges avant qu'on demande un avis
export const ASK_EVERY_DAYS = 14;    // on ne redemande pas avant
export const REJECT_REASONS = {
  injure: "Propos injurieux ou haineux",
  identifiant: "Permet d'identifier quelqu'un (nom, adresse, employeur…)",
  hors_sujet: "Sans rapport avec Sereina (publicité, message sans sens)",
  sante: "Détails de santé trop précis pour être publiés",
  autre: "Autre raison",
};

const isGuide = g => ["clara", "samuel", "ines", "theo", "maya", "jeanne"].includes(g);

/** Prénom seulement : lettres, espaces, tirets, apostrophes ; 30 caractères maximum. */
export function cleanName(v) {
  const s = String(v || "").normalize("NFC").replace(/<[^>]*>/g, "").replace(/[^\p{L}\s'’-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 30);
  return s || null;
}
const cleanText = (v, max) => String(v || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max);

/** Demande d'avis : après quelques échanges, jamais après une alerte, une seule fois par quinzaine, jamais si déjà donné. */
export function reviewEligible(user) {
  if (!user || (user.risk_level || 0) >= 2) return false;
  const n = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND role = 'user'").get(user.id).n;
  if (n < MIN_MESSAGES) return false;
  if (db.prepare("SELECT 1 FROM messages WHERE user_id = ? AND risk_level >= 2 LIMIT 1").get(user.id)) return false;
  if (db.prepare("SELECT 1 FROM reviews WHERE user_id = ? AND source = 'chat'").get(user.id)) return false;
  const asked = db.prepare("SELECT 1 FROM events WHERE user_id = ? AND type = 'review_asked' AND created_at > datetime('now', ?)").get(user.id, `-${ASK_EVERY_DAYS} days`);
  return !asked;
}
/** Une personne peut répondre même si la demande a été faite il y a un moment : mêmes garde-fous, sans le délai. */
export function mayReview(user) {
  if (!user || (user.risk_level || 0) >= 2) return false;
  const n = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND role = 'user'").get(user.id).n;
  if (n < MIN_MESSAGES) return false;
  if (db.prepare("SELECT 1 FROM reviews WHERE user_id = ? AND source = 'chat'").get(user.id)) return false;
  return !db.prepare("SELECT 1 FROM messages WHERE user_id = ? AND risk_level >= 2 LIMIT 1").get(user.id);
}

/** Avis laissé dans le chat. Sans accord de publication ou sans texte, il sert seulement de retour interne. */
export function submitReview({ user, guide, rating, comment, name, consent }) {
  if (!mayReview(user)) return { error: "Vous ne pouvez pas laisser d'avis pour le moment." };
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) return { error: "Choisissez une note de 1 à 5." };
  const text = cleanText(comment, 1000);
  const publish = !!consent && text.length >= 10;
  db.prepare("INSERT INTO reviews (created_at, user_id, guide, rating, comment, display_name, consent_publish, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'chat')")
    .run(now(), user.id, isGuide(guide) ? guide : null, r, text || null, publish ? cleanName(name) : null, publish ? 1 : 0);
  return { ok: true, publishable: publish };
}

/** Avis reçu par un autre canal et saisi par l'équipe. L'attestation d'accord de la personne est obligatoire. */
export function addManual({ name, rating, comment, guide, origin, adminName }) {
  const r = Number(rating), text = cleanText(comment, 1000), o = cleanText(origin, 200);
  if (!Number.isInteger(r) || r < 1 || r > 5) return { error: "Note de 1 à 5 requise." };
  if (text.length < 10) return { error: "Le texte de l'avis est requis (reproduit tel que reçu)." };
  if (!o) return { error: "Indiquez d'où vient l'avis (e-mail, courrier, de vive voix…)." };
  const id = db.prepare("INSERT INTO reviews (created_at, user_id, guide, rating, comment, display_name, consent_publish, status, source, origin_note, moderated_by, moderated_at) VALUES (?, NULL, ?, ?, ?, ?, 1, 'approved', 'manuel', ?, ?, ?)")
    .run(now(), isGuide(guide) ? guide : null, r, text, cleanName(name), o, adminName || null, now()).lastInsertRowid;
  return { ok: true, id };
}

export function listPublic({ guide, limit = 12 } = {}) {
  const rows = guide && isGuide(guide)
    ? db.prepare("SELECT id, guide, rating, comment, display_name, created_at FROM reviews WHERE status = 'approved' AND consent_publish = 1 AND comment IS NOT NULL AND guide = ? ORDER BY created_at DESC LIMIT ?").all(guide, limit)
    : db.prepare("SELECT id, guide, rating, comment, display_name, created_at FROM reviews WHERE status = 'approved' AND consent_publish = 1 AND comment IS NOT NULL ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows.map(r => ({ guide: r.guide, rating: r.rating, comment: r.comment, name: r.display_name || null, month: r.created_at.slice(0, 7) }));
}

export const counts = () => db.prepare("SELECT status, COUNT(*) AS n FROM reviews GROUP BY status").all().reduce((a, r) => (a[r.status] = r.n, a), { pending: 0, approved: 0, rejected: 0 });
/** À modérer : seuls les avis dont l'auteur accepte la publication ; les autres sont des retours internes. */
export const listByStatus = status => db.prepare("SELECT * FROM reviews WHERE status = ? AND (consent_publish = 1 OR ? != 'pending') ORDER BY id DESC LIMIT 300").all(status, status);
export const feedbackOnly = () => db.prepare("SELECT * FROM reviews WHERE status = 'pending' AND consent_publish = 0 ORDER BY id DESC LIMIT 100").all();
export const stats = () => db.prepare("SELECT COUNT(*) AS n, ROUND(AVG(rating), 2) AS avg FROM reviews WHERE source = 'chat'").get();

export function moderate(id, status, adminName, reason) {
  if (!["approved", "rejected"].includes(status)) return false;
  const r = db.prepare("SELECT * FROM reviews WHERE id = ?").get(id);
  if (!r) return false;
  if (status === "approved" && (!r.consent_publish || !r.comment)) return false; // jamais sans accord ni texte
  db.prepare("UPDATE reviews SET status = ?, moderated_by = ?, moderated_at = ?, reject_reason = ? WHERE id = ?")
    .run(status, adminName || null, now(), status === "rejected" ? (REJECT_REASONS[reason] ? reason : "autre") : null, id);
  return true;
}
export const removeReview = id => db.prepare("DELETE FROM reviews WHERE id = ?").run(id).changes > 0;
export const deleteByUser = userId => db.prepare("DELETE FROM reviews WHERE user_id = ? AND source = 'chat'").run(userId);
