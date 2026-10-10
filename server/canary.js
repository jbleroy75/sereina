// Surveillance des paiements (repris de renta-immo : payment-canary).
// Toutes les heures, compare les paiements réussis chez Stripe sur les 24 dernières heures avec les achats
// enregistrés. Un paiement réussi sans crédits (webhook perdu, serveur arrêté au mauvais moment) est
// crédité automatiquement, et l'équipe est prévenue pour vérifier le webhook.
import { db, now } from "./db.js";
import { stripe, fulfillCheckout, fulfillAutoRecharge, eur, PACKS } from "./billing.js";
import { notifyOps } from "./notify.js";

db.exec(`CREATE TABLE IF NOT EXISTS canary_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL,
  status TEXT NOT NULL,          -- ok | reconciled | error | not_configured
  checked INTEGER DEFAULT 0,
  missing INTEGER DEFAULT 0,
  detail TEXT
);`);
const known = db.prepare("SELECT 1 FROM purchases WHERE stripe_ref = ?");
const log = db.prepare("INSERT INTO canary_runs (ran_at, status, checked, missing, detail) VALUES (?, ?, ?, ?, ?)");

export async function runCanary() {
  if (!stripe) { log.run(now(), "not_configured", 0, 0, null); return { status: "not_configured" }; }
  const since = Math.floor(Date.now() / 1000) - 24 * 3600, grace = Math.floor(Date.now() / 1000) - 10 * 60;
  let checked = 0; const fixed = [];
  try {
    for await (const s of stripe.checkout.sessions.list({ created: { gte: since }, limit: 100 })) {
      if (s.mode !== "payment" || s.payment_status !== "paid" || !s.metadata?.user_id) continue;
      checked++;
      if (!known.get(s.id) && s.created < grace && fulfillCheckout(s, "canary")) fixed.push(`${s.id} (${eur(s.amount_total || 0)})`);
    }
    for await (const pi of stripe.paymentIntents.list({ created: { gte: since }, limit: 100 })) {
      if (pi.status !== "succeeded" || pi.metadata?.auto !== "1") continue;
      checked++;
      if (!known.get(pi.id) && pi.created < grace && fulfillAutoRecharge(pi, "canary")) fixed.push(`${pi.id} (${eur(pi.amount || 0)})`);
    }
  } catch (e) {
    log.run(now(), "error", checked, 0, String(e.message).slice(0, 300));
    await notifyOps("Contrôle des paiements en erreur", `Impossible d'interroger Stripe : ${e.message}`);
    return { status: "error", error: e.message };
  }
  const status = fixed.length ? "reconciled" : "ok";
  log.run(now(), status, checked, fixed.length, fixed.join(", ") || null);
  if (fixed.length) await notifyOps(`${fixed.length} paiement(s) crédité(s) par le contrôle horaire`,
    `Ces paiements Stripe réussis n'avaient pas été crédités (webhook non reçu) et viennent de l'être automatiquement :\n${fixed.join("\n")}\n\nVérifiez la configuration du webhook Stripe (URL /api/stripe/webhook, secret STRIPE_WEBHOOK_SECRET).`);
  return { status, checked, missing: fixed.length };
}

export const lastRuns = (n = 10) => db.prepare("SELECT * FROM canary_runs ORDER BY id DESC LIMIT ?").all(n);
