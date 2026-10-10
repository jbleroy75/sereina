// Paiements : packs de crédits, traitement d'un paiement Stripe (webhook ET contrôle horaire),
// recharge automatique. Les autres modules écoutent `billingEvents` (reçus, alertes) sans dépendance circulaire.
import Stripe from "stripe";
import { EventEmitter } from "node:events";
import { q, now } from "./db.js";

export const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
export const billingEvents = new EventEmitter();

// Packs : "cle:credits:centimes:libellé" séparés par des virgules
export const PACKS = Object.fromEntries((process.env.PACKS || "petit:20:490:Petit pack,moyen:60:1290:Pack confort,grand:150:2490:Grand pack").split(",").map(p => {
  const [key, credits, cents, label] = p.split(":");
  return [key.trim(), { key: key.trim(), credits: Number(credits), cents: Number(cents), label: (label || key).trim() }];
}));
export const DEFAULT_PACK = process.env.DEFAULT_PACK || Object.keys(PACKS)[1] || Object.keys(PACKS)[0];
export const eur = c => (c / 100).toFixed(2).replace(".", ",") + " €";

/**
 * Crédite un paiement Checkout réussi. Idempotent : la référence Stripe est unique en base,
 * donc le webhook, une relivraison ou le contrôle horaire ne créditent qu'une seule fois.
 * Retourne true si des crédits ont été ajoutés maintenant.
 */
export function fulfillCheckout(session, source = "webhook") {
  if (session.mode !== "payment" || session.payment_status !== "paid") return false;
  const uid = session.client_reference_id || session.metadata?.user_id;
  const pack = PACKS[session.metadata?.pack];
  if (!uid || !pack || !q.getUser.get(uid)) return false;
  const ins = q.insertPurchase.run(uid, pack.key, pack.credits, pack.cents, "checkout", session.id, now());
  if (!ins.changes) return false;
  q.addCredits.run(pack.credits, uid);
  q.setAuto.run(session.metadata?.auto === "1" ? 1 : 0, pack.key, uid);
  q.setPaymentMethod.run(session.customer || null, null, uid);
  q.logEvent.run(uid, "purchase", `${pack.key} ${pack.credits} crédits ${eur(pack.cents)} (${source})`, now());
  if (stripe && session.payment_intent) {
    stripe.paymentIntents.retrieve(String(session.payment_intent))
      .then(pi => { if (pi.payment_method) q.setPaymentMethod.run(null, String(pi.payment_method), uid); })
      .catch(e => console.error("pm fetch", e.message));
  }
  billingEvents.emit("purchase", { userId: uid, pack, kind: "checkout", source, email: session.customer_details?.email || null });
  return true;
}

/** Crédite une recharge automatique réussie (appel direct, webhook de secours ou contrôle horaire). */
export function fulfillAutoRecharge(pi, source = "direct") {
  const uid = pi.metadata?.user_id, pack = PACKS[pi.metadata?.pack];
  if (pi.status !== "succeeded" || pi.metadata?.auto !== "1" || !uid || !pack || !q.getUser.get(uid)) return false;
  const ins = q.insertPurchase.run(uid, pack.key, pack.credits, pack.cents, "auto", pi.id, now());
  if (!ins.changes) return false;
  q.addCredits.run(pack.credits, uid);
  q.logEvent.run(uid, "auto_recharge", `${pack.key} ${eur(pack.cents)} (${source})`, now());
  billingEvents.emit("purchase", { userId: uid, pack, kind: "auto", source });
  return true;
}

/** Recharge automatique : débite la carte enregistrée hors session. */
export async function autoRecharge(u) {
  if (!stripe || !u.auto_recharge || !u.stripe_customer_id || !u.stripe_payment_method) return false;
  const pack = PACKS[u.auto_pack] || PACKS[DEFAULT_PACK];
  try {
    const pi = await stripe.paymentIntents.create({
      amount: pack.cents, currency: "eur", customer: u.stripe_customer_id, payment_method: u.stripe_payment_method,
      off_session: true, confirm: true, description: `Sereina, ${pack.label} (${pack.credits} crédits), recharge automatique`,
      metadata: { user_id: u.id, pack: pack.key, auto: "1" },
    });
    fulfillAutoRecharge(pi, "direct");
    return pi.status === "succeeded";
  } catch (e) {
    console.error("auto recharge failed", e.code || e.message);
    q.logEvent.run(u.id, "auto_recharge_failed", e.code || e.message, now());
    q.setAuto.run(0, null, u.id); // désactivée pour ne pas réessayer en boucle ; la personne rachète à la main
    billingEvents.emit("auto_recharge_failed", { userId: u.id, pack, code: e.code || "" });
    return false;
  }
}
