// E-mails de cycle de vie (repris de renta-immo : email-lifecycle, notifications, subscription-lifecycle).
// Transactionnels (toujours envoyés si l'e-mail est connu) : code de connexion, bienvenue, reçu d'achat,
//   crédits presque épuisés, recharge automatique refusée.
// Relances (seulement avec consentement marketing_optin, jamais à une personne avec une alerte orange/rouge
//   non traitée, uniquement entre 9 h et 20 h, heure de Paris) : inactivité 7 jours, client parti 30 jours.
// Objets volontairement neutres : rien ne laisse deviner le sujet des conversations à qui verrait la boîte mail.
import { db, q, now } from "./db.js";
import { queueEmail } from "./mailqueue.js";
import { sign } from "./security/secret.js";
import { billingEvents, eur } from "./billing.js";

const SITE_URL = () => (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");

db.exec(`CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  kind TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_log_user ON email_log(user_id, kind, sent_at);`);

const qq = {
  log: db.prepare("INSERT INTO email_log (user_id, kind, sent_at) VALUES (?, ?, ?)"),
  lastOf: db.prepare("SELECT MAX(sent_at) AS t FROM email_log WHERE user_id = ? AND kind = ?"),
  unsubUser: db.prepare("UPDATE users SET marketing_optin = 0 WHERE id = ?"),
  inactive: db.prepare(`SELECT * FROM users u WHERE u.email IS NOT NULL AND u.marketing_optin = 1
      AND u.last_seen < ? AND u.last_seen > ?
      AND (u.risk_level < 2 OR u.handled_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM email_log l WHERE l.user_id = u.id AND l.kind = 'inactive_7d' AND l.sent_at > u.last_seen)
      LIMIT 200`),
  winback: db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM purchases p WHERE p.user_id = u.id) AS nb_purchases FROM users u
      WHERE u.email IS NOT NULL AND u.marketing_optin = 1 AND u.last_seen < ?
      AND (u.risk_level < 2 OR u.handled_at IS NOT NULL)
      AND EXISTS (SELECT 1 FROM purchases p WHERE p.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM email_log l WHERE l.user_id = u.id AND l.kind = 'winback' AND l.sent_at > ?)
      LIMIT 200`),
};

export const unsubLink = (type, id) => `${SITE_URL()}/desinscription/?t=${type}&id=${encodeURIComponent(id)}&s=${sign("unsub", `${type}:${id}`)}`;

function footer(user, marketing) {
  const lines = ["", "—", "Sereina, espace d'écoute. En cas d'urgence : 15 ou 3114 (gratuit, 24 h/24).", `Votre espace : ${SITE_URL()}/mon-compte/`];
  if (marketing) lines.push(`Ne plus recevoir ces messages : ${unsubLink("u", user.id)}`);
  return lines.join("\n");
}

/** Envoie un e-mail à un utilisateur et le journalise. Retourne true si mis en file. */
export function sendToUser(user, kind, subject, body, { marketing = false } = {}) {
  if (!user?.email) return false;
  if (marketing && !user.marketing_optin) return false;
  const headers = marketing ? { "List-Unsubscribe": `<${unsubLink("u", user.id)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : null;
  const id = queueEmail({ type: kind, to: user.email, subject, text: `${body}\n${footer(user, marketing)}`, headers });
  if (id) qq.log.run(user.id, kind, now());
  return !!id;
}

const hello = u => (u.first_name ? `Bonjour ${u.first_name},` : "Bonjour,");

export function sendWelcome(user) {
  return sendToUser(user, "welcome", "Bienvenue sur Sereina", `${hello(user)}

Votre espace Sereina est créé. Vos crédits et vos conversations sont maintenant rattachés à votre adresse e-mail : vous les retrouverez sur votre téléphone, votre ordinateur ou votre tablette, en vous connectant avec un simple code.

Pour reprendre une conversation : ${SITE_URL()}/parler/
Nos guides gratuits : ${SITE_URL()}/guides/

Les accompagnants Sereina sont des programmes d'intelligence artificielle d'écoute, pas des professionnels de santé. Si vous traversez un moment très difficile, le 3114 répond jour et nuit, gratuitement.

L'équipe Sereina`);
}

function sendReceipt({ userId, pack, kind }) {
  const u = q.getUser.get(userId); if (!u?.email) return;
  sendToUser(u, "receipt", "Votre achat sur Sereina", `${hello(u)}

Merci. ${kind === "auto" ? "Votre recharge automatique a bien été effectuée" : "Votre achat a bien été enregistré"} :

    ${pack.label} : ${pack.credits} crédits, ${eur(pack.cents)}
    Solde actuel : ${u.credits} crédits (1 crédit = 1 message)

${u.auto_recharge ? "La recharge automatique est active : le même pack sera racheté quand vos crédits seront épuisés. Vous pouvez la désactiver à tout moment dans votre espace." : ""}
Le reçu de paiement officiel vous est envoyé séparément par notre prestataire de paiement, Stripe.

L'équipe Sereina`);
}

function sendRechargeFailed({ userId, pack }) {
  const u = q.getUser.get(userId); if (!u?.email) return;
  sendToUser(u, "recharge_failed", "Votre recharge automatique n'a pas abouti", `${hello(u)}

La recharge automatique de votre ${pack.label.toLowerCase()} (${eur(pack.cents)}) n'a pas pu être effectuée : votre banque a refusé le paiement ou votre carte a expiré. Aucun montant n'a été prélevé, et la recharge automatique a été désactivée.

Pour continuer vos conversations, vous pouvez acheter des crédits depuis votre espace : ${SITE_URL()}/mon-compte/

L'équipe Sereina`);
}

/** Après chaque message payé : prévient une fois par semaine quand il reste peu de crédits. */
export function afterPaidMessage(user) {
  if (!user?.email || user.auto_recharge || user.credits <= 0 || user.credits > 3) return;
  const last = qq.lastOf.get(user.id, "low_credits").t;
  if (last && Date.now() - new Date(last).getTime() < 7 * 864e5) return;
  sendToUser(user, "low_credits", `Il vous reste ${user.credits} crédit${user.credits > 1 ? "s" : ""}`, `${hello(user)}

Il vous reste ${user.credits} crédit${user.credits > 1 ? "s" : ""} sur Sereina (1 crédit = 1 message). Pour ne pas être interrompu au milieu d'une conversation, vous pouvez en reprendre quand vous voulez : ${SITE_URL()}/credits/

Vous pouvez aussi activer la recharge automatique dans votre espace : ${SITE_URL()}/mon-compte/

L'équipe Sereina`);
}

billingEvents.on("purchase", e => { try { sendReceipt(e); } catch (err) { console.error("receipt", err.message); } });
billingEvents.on("auto_recharge_failed", e => { try { sendRechargeFailed(e); } catch (err) { console.error("recharge mail", err.message); } });

const parisHour = () => Number(new Date().toLocaleString("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }));

/** Relances : à lancer toutes les heures. */
export function runLifecycle({ force = false } = {}) {
  const h = parisHour();
  if (!force && (h < 9 || h >= 20)) return { skipped: "hors horaires" };
  const d = n => new Date(Date.now() - n * 864e5).toISOString();
  let inactive = 0, winback = 0;
  for (const u of qq.inactive.all(d(7), d(14))) {
    if (sendToUser(u, "inactive_7d", "Comment allez-vous ?", `${hello(u)}

Cela fait quelques jours que vous n'êtes pas venu sur Sereina. Nous espérons que les choses vont un peu mieux.

Si vous avez envie d'en parler, votre accompagnant est là, jour et nuit : ${SITE_URL()}/parler/
Et si vous préférez lire à votre rythme, nos guides gratuits sont ici : ${SITE_URL()}/guides/

Prenez soin de vous,
L'équipe Sereina`, { marketing: true })) inactive++;
  }
  for (const u of qq.winback.all(d(30), d(90))) {
    const credits = u.credits > 0 ? `Il vous reste ${u.credits} crédit${u.credits > 1 ? "s" : ""} : ils n'expirent pas et vous attendent.` : "";
    if (sendToUser(u, "winback", "Des nouvelles de Sereina", `${hello(u)}

Cela fait un moment que nous ne nous sommes pas parlé. ${credits}

Depuis votre dernière visite, nous avons publié de nouveaux conseils et des guides gratuits à télécharger : ${SITE_URL()}/guides/

Si quelque chose vous a manqué ou déplu dans Sereina, répondez simplement à cet e-mail : nous lisons tous les messages.

L'équipe Sereina`, { marketing: true })) winback++;
  }
  return { inactive, winback };
}

export function unsubscribeUser(id) { qq.unsubUser.run(id); q.logEvent.run(id, "marketing_unsubscribed", null, now()); }
