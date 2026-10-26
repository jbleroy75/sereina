// Newsletter et guides à télécharger (repris de renta-immo : newsletter, lead-magnet).
// Double consentement : l'inscription est « en attente » jusqu'au clic sur le lien de confirmation reçu par e-mail ;
// le guide est alors téléchargeable via un lien signé (pas d'URL publique devinable).
import crypto from "node:crypto";
import { guidesIndex, guidePdfExists, guidePdf } from "#files";
import { db, now } from "./db.js";
import { queueEmail } from "./mailqueue.js";
import { hmac, sign, checkSig } from "./security/secret.js";
import { normalizeEmail, isDisposable, emailHash } from "./account.js";
import { unsubLink } from "./lifecycle.js";

const SITE_URL = () => (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");

db.exec(`CREATE TABLE IF NOT EXISTS newsletter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  email_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | active | unsubscribed
  source TEXT,
  guide TEXT,
  verify_hash TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  unsubscribed_at TEXT
);
CREATE TABLE IF NOT EXISTS newsletter_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  recipients INTEGER DEFAULT 0,
  sent_by TEXT,
  sent_at TEXT NOT NULL
);`);

const qq = {
  byHash: db.prepare("SELECT * FROM newsletter WHERE email_hash = ?"),
  byId: db.prepare("SELECT * FROM newsletter WHERE id = ?"),
  insert: db.prepare("INSERT INTO newsletter (email, email_hash, status, source, guide, verify_hash, user_id, created_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)"),
  repending: db.prepare("UPDATE newsletter SET status = 'pending', guide = ?, source = COALESCE(?, source), verify_hash = ?, unsubscribed_at = NULL WHERE id = ?"),
  setGuide: db.prepare("UPDATE newsletter SET guide = ? WHERE id = ?"),
  confirm: db.prepare("UPDATE newsletter SET status = 'active', confirmed_at = COALESCE(confirmed_at, ?), verify_hash = NULL WHERE id = ?"),
  unsub: db.prepare("UPDATE newsletter SET status = 'unsubscribed', unsubscribed_at = ? WHERE id = ?"),
  active: db.prepare("SELECT * FROM newsletter WHERE status = 'active' ORDER BY id"),
};

export function listGuideFiles() {
  return guidesIndex();
}
export const guideExists = slug => /^[a-z0-9-]+$/.test(slug) && guidePdfExists(slug);
export const downloadUrl = (subId, slug) => `${SITE_URL()}/api/guides/${slug}.pdf?id=${subId}&s=${sign("guide", `${subId}:${slug}`)}`;

/** Inscription. Retourne {ok, already} ou {error}. */
export function subscribe({ email: raw, guide, source, userId }) {
  const email = normalizeEmail(raw);
  if (!email) return { error: "Cette adresse e-mail ne semble pas valide." };
  if (isDisposable(email)) return { error: "Merci d'utiliser une adresse e-mail permanente." };
  const g = guide && guideExists(guide) ? guide : null;
  const eh = emailHash(email);
  const existing = qq.byHash.get(eh);
  if (existing?.status === "active") {
    // Déjà inscrit : on renvoie directement le guide demandé, sans nouvelle confirmation.
    if (g) { qq.setGuide.run(g, existing.id); sendGuideEmail(existing, g); }
    return { ok: true, already: true };
  }
  const token = crypto.randomBytes(24).toString("hex");
  let id;
  if (existing) { qq.repending.run(g, source || null, hmac("nl-verify", token), existing.id); id = existing.id; }
  else id = qq.insert.run(email, eh, (source || "").slice(0, 60) || null, g, hmac("nl-verify", token), userId || null, now()).lastInsertRowid;
  const link = `${SITE_URL()}/api/newsletter/confirm?id=${id}&t=${token}`;
  queueEmail({ type: "newsletter_confirm", to: email, priority: "high", subject: g ? "Confirmez pour recevoir votre guide" : "Confirmez votre inscription",
    text: `Bonjour,\n\nPour ${g ? "recevoir votre guide gratuit et " : ""}confirmer votre inscription à la lettre Sereina, cliquez sur ce lien :\n\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message : vous ne recevrez rien.\n\nL'équipe Sereina` });
  return { ok: true };
}

/** Confirmation (lien de l'e-mail). Retourne l'abonné confirmé ou null. */
export function confirm(id, token) {
  const sub = qq.byId.get(Number(id));
  if (!sub || !sub.verify_hash || !token) return sub?.status === "active" ? sub : null;
  const ok = crypto.timingSafeEqual(Buffer.from(hmac("nl-verify", token)), Buffer.from(sub.verify_hash));
  if (!ok) return null;
  qq.confirm.run(now(), sub.id);
  const fresh = qq.byId.get(sub.id);
  if (fresh.guide) sendGuideEmail(fresh, fresh.guide);
  return fresh;
}

function sendGuideEmail(sub, slug) {
  const meta = listGuideFiles().find(g => g.slug === slug);
  queueEmail({ type: "guide_link", to: sub.email, subject: "Votre guide Sereina",
    headers: { "List-Unsubscribe": `<${unsubLink("n", sub.id)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    text: `Bonjour,\n\nMerci pour votre inscription. Voici votre guide gratuit${meta ? ` « ${meta.titre} »` : ""} :\n\n${downloadUrl(sub.id, slug)}\n\nVous pouvez l'imprimer et le relire à votre rythme. Les autres guides sont ici : ${SITE_URL()}/guides/\n\n—\nSereina, espace d'écoute. En cas d'urgence : 15 ou 3114.\nSe désinscrire : ${unsubLink("n", sub.id)}` });
}

/** Vérifie un lien de téléchargement. Retourne le contenu du PDF (Buffer) ou null. */
export function guideFileFor(slug, id, sig) {
  if (!guideExists(slug) || !checkSig("guide", `${id}:${slug}`, sig)) return null;
  const sub = qq.byId.get(Number(id));
  if (!sub || sub.status === "unsubscribed") return null;
  return guidePdf(slug);
}

export function unsubscribeNewsletter(id) { qq.unsub.run(now(), Number(id)); }
export function deleteByEmailHash(eh) { try { db.prepare("DELETE FROM newsletter WHERE email_hash = ?").run(eh); } catch {} }

export function stats() {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM newsletter GROUP BY status").all();
  const s = { pending: 0, active: 0, unsubscribed: 0 }; for (const r of rows) s[r.status] = r.n;
  s.byGuide = db.prepare("SELECT guide, COUNT(*) AS n FROM newsletter WHERE status = 'active' GROUP BY guide ORDER BY n DESC").all();
  s.bySource = db.prepare("SELECT source, COUNT(*) AS n FROM newsletter WHERE status = 'active' GROUP BY source ORDER BY n DESC LIMIT 10").all();
  return s;
}
export const latest = (n = 200) => db.prepare("SELECT id, email, status, source, guide, created_at, confirmed_at FROM newsletter ORDER BY id DESC LIMIT ?").all(n);
export const allForExport = () => db.prepare("SELECT email, status, source, guide, created_at, confirmed_at, unsubscribed_at FROM newsletter ORDER BY id").all();
export const campaigns = () => db.prepare("SELECT * FROM newsletter_campaigns ORDER BY id DESC LIMIT 20").all();

/** Envoie une lettre à tous les abonnés confirmés. Retourne le nombre de destinataires. */
export function sendCampaign(subject, body, by) {
  const subs = qq.active.all();
  for (const s of subs) {
    queueEmail({ type: "newsletter", to: s.email, subject,
      headers: { "List-Unsubscribe": `<${unsubLink("n", s.id)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      text: `${body}\n\n—\nSereina, espace d'écoute. En cas d'urgence : 15 ou 3114 (gratuit, 24 h/24).\nSe désinscrire en un clic : ${unsubLink("n", s.id)}` });
  }
  db.prepare("INSERT INTO newsletter_campaigns (subject, body, recipients, sent_by, sent_at) VALUES (?, ?, ?, ?, ?)").run(subject, body, subs.length, by, now());
  return subs.length;
}
