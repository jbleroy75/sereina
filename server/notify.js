import { queueEmail } from "./mailqueue.js";

const LEVELS = ["vert", "jaune", "orange", "rouge"];

// Anti-spam repris de renta-immo (telegram-alert.ts) : un même utilisateur au même niveau ne renotifie qu'après 6 h.
const lastSent = new Map();
function telegramThrottled(userId, level) {
  const k = `${userId}|${level}`, t = Date.now();
  if (lastSent.size > 500) for (const [kk, ts] of lastSent) if (t - ts > 864e5) lastSent.delete(kk);
  if (lastSent.has(k) && t - lastSent.get(k) < 6 * 3600 * 1000) return true;
  lastSent.set(k, t); return false;
}

/** Prévient l'équipe d'astreinte : e-mail, webhook (Slack/Discord/Teams), SMS Twilio. Tout est optionnel selon .env. */
export async function notifyAlert({ user, level, reason, lastMessage, adminUrl }) {
  const label = LEVELS[level].toUpperCase();
  const subject = `[Sereina] Alerte ${label} : utilisateur ${user.id.slice(0, 8)}`;
  const body = [
    `Niveau : ${label}`,
    `Raison : ${reason}`,
    `Prénom : ${user.first_name || "inconnu"}   Téléphone : ${user.phone || "inconnu"}   Ville : ${user.city || "inconnue"}`,
    `Dernier message : « ${(lastMessage || "").slice(0, 400)} »`,
    ``,
    `Ouvrir la fiche : ${adminUrl}`,
    ``,
    level === 3 ? `PROTOCOLE ROUGE : lire la conversation, rappeler la personne si un numéro est connu, et si danger immédiat appeler le 15 (ou le 112) en donnant les éléments d'identification disponibles. Noter l'issue dans la fiche.` : `Lire la conversation et décider d'un rappel.`,
  ].join("\n");

  const results = [];
  if (process.env.ALERT_EMAIL) {
    const id = queueEmail({ type: `alerte_${LEVELS[level]}`, to: process.env.ALERT_EMAIL, subject, text: body, priority: level === 3 ? "high" : "normal" });
    if (id) results.push("email");
  }
  if (process.env.ALERT_WEBHOOK_URL) {
    try {
      await fetch(process.env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${subject}\n${body}`, content: `${subject}\n${body}` }) });
      results.push("webhook");
    } catch (e) { console.error("notify webhook failed", e.message); }
  }
  if (process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM && process.env.ALERT_SMS_TO && level === 3) {
    try {
      const params = new URLSearchParams({ From: process.env.TWILIO_FROM, To: process.env.ALERT_SMS_TO, Body: `${subject} - ${reason}. ${adminUrl}` });
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, {
        method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: params });
      results.push("sms");
    } catch (e) { console.error("notify sms failed", e.message); }
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && !telegramThrottled(user.id, level)) {
    try {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: `${level === 3 ? "🚨" : "⚠️"} ${subject}\n${body}`, disable_web_page_preview: true }) });
      results.push("telegram");
    } catch (e) { console.error("notify telegram failed", e.message); }
  }
  if (!results.length) console.warn(`[ALERTE ${label}] aucun canal de notification configuré. ${reason} (${user.id})`);
  return results;
}
