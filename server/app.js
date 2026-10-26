import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import { db, q, now } from "./db.js";
import { GUIDES, streamReply, assessRisk } from "./ai.js";
import { notifyAlert } from "./notify.js";
import { SECRET, checkSig } from "./security/secret.js";
import { stripe, PACKS, DEFAULT_PACK, eur, fulfillCheckout, fulfillAutoRecharge, autoRecharge } from "./billing.js";
import { requestCode, verifyCode, setMarketingOptin, maskEmail, purgeCodes, emailHash, normalizeEmail } from "./account.js";
import { claimTrial, claimEmailForTrial, purgeClaims } from "./antiabuse.js";
import { sendWelcome, afterPaidMessage, runLifecycle, unsubscribeUser } from "./lifecycle.js";
import * as NL from "./newsletter.js";
import { reviewEligible, submitReview, listPublic, deleteByUser } from "./reviews.js";
import { runCanary, lastRuns } from "./canary.js";
import { admin } from "./admin.js";
import { securityHeaders, csrfOrigin, stripHtml } from "./security/headers.js";
import { RateLimiter, rateLimit, clientIp } from "./security/ratelimit.js";
import { bootstrapOwner, purgeSessions, readSession } from "./security/auth.js";
import { queueEmail, queueStats, processQueue, purgeQueue, emailConfigured } from "./mailqueue.js";
import { timingSafeCompare } from "./security/password.js";

const PORT = Number(process.env.PORT || 3000);
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const FREE_MINUTES = Number(process.env.FREE_MINUTES || 5);
const FREE_MESSAGES = Number(process.env.FREE_MESSAGES || 8);
const COOKIE_SECRET = process.env.COOKIE_SECRET || SECRET;

export const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(securityHeaders({ https: SITE_URL.startsWith("https") }));
app.use(cookieParser(COOKIE_SECRET));
bootstrapOwner();

// ---------- Stripe webhook (corps brut, avant express.json) ----------
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let ev;
  try { ev = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (e) { return res.status(400).send(`Webhook error: ${e.message}`); }
  const o = ev.data.object;
  if (ev.type === "checkout.session.completed") {
    fulfillCheckout(o, "webhook");
    // L'e-mail saisi au paiement sert aux reçus et à retrouver son compte, s'il n'est pas déjà pris.
    const uid = o.client_reference_id || o.metadata?.user_id, email = normalizeEmail(o.customer_details?.email);
    const u = uid && q.getUser.get(uid);
    if (u && !u.email && email && !db.prepare("SELECT 1 FROM users WHERE email_hash = ?").get(emailHash(email))) {
      db.prepare("UPDATE users SET email = ?, email_hash = ? WHERE id = ?").run(email, emailHash(email), uid);
    }
  } else if (ev.type === "payment_intent.succeeded") {
    fulfillAutoRecharge(o, "webhook"); // filet de sécurité pour les recharges automatiques
  }
  res.json({ received: true });
});

app.use(express.json({ limit: "32kb" }));
app.use(csrfOrigin({ allowedHosts: new Set([new URL(SITE_URL).hostname]) }));
const chatLimiter = new RateLimiter({ limit: 20, windowMs: 5 * 60 * 1000 });
const contactLimiter = new RateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });
const checkoutLimiter = new RateLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });
app.use("/api/chat", rateLimit(chatLimiter, req => req.signedCookies.sid || clientIp(req), "Trop de messages d'un coup. Attendez un instant."));
app.use("/api/contact", rateLimit(contactLimiter, clientIp));
app.use("/api/checkout", rateLimit(checkoutLimiter, req => req.signedCookies.sid || clientIp(req)));
const reviewLimiter = new RateLimiter({ limit: 4, windowMs: 60 * 60 * 1000 });
app.use("/api/review", rateLimit(reviewLimiter, req => req.signedCookies.sid || clientIp(req)));
const authLimiter = new RateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
const nlLimiter = new RateLimiter({ limit: 6, windowMs: 60 * 60 * 1000 });
app.use("/api/auth", rateLimit(authLimiter, clientIp, "Trop de tentatives. Patientez quelques minutes."));
app.use("/api/newsletter", rateLimit(nlLimiter, clientIp, "Trop d'inscriptions depuis cette connexion. Réessayez plus tard."));

// ---------- Identification anonyme par cookie signé ----------
function getUser(req, res) {
  let id = req.signedCookies.sid;
  let u = id && q.getUser.get(id);
  if (!u) {
    id = crypto.randomUUID();
    q.insertUser.run(id, now(), now(), req.ip, String(req.headers["user-agent"] || "").slice(0, 200));
    u = q.getUser.get(id);
    res.cookie("sid", id, { signed: true, httpOnly: true, sameSite: "lax", secure: SITE_URL.startsWith("https"), maxAge: 365 * 864e5 });
  }
  q.touchUser.run(now(), id);
  return u;
}

function freeExhausted(u) {
  if (u.trial_denied) return true;
  if (!u.free_started_at) return false;
  const minutes = (Date.now() - new Date(u.free_started_at).getTime()) / 60000;
  return minutes > FREE_MINUTES || u.free_messages >= FREE_MESSAGES;
}
function paywalled(u) { return freeExhausted(u) && u.credits <= 0; }

// ---------- Chat ----------
let shuttingDown = false, inflight = 0;
/** État partagé avec le point d'entrée (arrêt propre sous Node, Durable Object sous Cloudflare). */
export const runtime = { get inflight() { return inflight; }, get shuttingDown() { return shuttingDown; }, set shuttingDown(v) { shuttingDown = v; } };
app.post("/api/chat", async (req, res) => {
  if (shuttingDown) return res.status(503).json({ error: "Le service redémarre, réessayez dans quelques secondes." });
  const u = getUser(req, res);
  const guide = GUIDES[req.body?.guide] ? req.body.guide : "clara";
  const message = String(req.body?.message || "").trim().slice(0, 4000);
  if (!message) return res.status(400).json({ error: "Message vide" });
  if (!u.consent_at) return res.status(403).json({ code: "consent_required" });
  // Premier message : l'essai gratuit est réservé (appareil, e-mail, réseau) ou refusé s'il a déjà servi.
  let trial = null;
  if (!u.free_started_at && !u.trial_denied) trial = claimTrial(u, req, clientIp(req));
  let cur = q.getUser.get(u.id);
  // Sécurité avant paiement : une personne en détresse obtient toujours une réponse et l'équipe est prévenue,
  // même sans crédit. On n'évalue le risque ici que si la personne serait bloquée.
  let safetyPass = false;
  if (paywalled(cur)) {
    const ok = await autoRecharge(cur);
    if (!ok) {
      const recentForRisk = q.allMessages.all(u.id).filter(m => m.role === "user").slice(-4).map(m => m.content).concat(message);
      const r = await assessRisk(recentForRisk, { userId: u.id });
      if (r.level >= 2) safetyPass = true;
      else return res.status(402).json({ code: "paywall", trial_denied: !!cur.trial_denied && !cur.free_started_at, packs: Object.values(PACKS), defaultPack: DEFAULT_PACK });
    }
    cur = q.getUser.get(u.id);
  }
  let creditUsed = false;
  if (safetyPass) q.logEvent.run(u.id, "safety_pass", null, now());
  else if (freeExhausted(cur)) { q.useCredit.run(u.id); creditUsed = true; } else q.startFree.run(now(), u.id);
  const userMsgId = q.insertMessage.run(u.id, guide, "user", message, now(), null, null).lastInsertRowid;

  // Historique (20 derniers tours de ce guide), ordre chronologique
  const hist = q.history.all(u.id, guide, 20).reverse().map(m => ({ role: m.role, content: m.content }));
  if (hist[0]?.role !== "user") hist.shift();

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);

  // Évaluation du risque en parallèle de la réponse
  const recent = q.allMessages.all(u.id).filter(m => m.role === "user").slice(-5).map(m => m.content);
  const riskP = assessRisk(recent, { userId: u.id }).then(async r => {
    db.prepare("UPDATE messages SET risk_level = ?, risk_reason = ? WHERE id = ?").run(r.level, r.reason, userMsgId);
    if (r.first_name || r.phone || r.city) q.setContact.run(r.first_name, r.phone, null, r.city, u.id);
    const prev = q.getUser.get(u.id);
    const escalate = r.level > prev.risk_level || (r.level >= 2 && prev.handled_at);
    if (r.level >= prev.risk_level || prev.handled_at) q.setRisk.run(r.level, r.reason, now(), r.level, u.id);
    if (r.level >= 2 && escalate) {
      const alertId = q.insertAlert.run(u.id, userMsgId, r.level, r.reason, now()).lastInsertRowid;
      const fresh = q.getUser.get(u.id);
      const channels = await notifyAlert({ user: fresh, level: r.level, reason: r.reason, lastMessage: message, adminUrl: `${SITE_URL}/admin/u/${u.id}` });
      if (channels.length) q.markNotified.run(now(), alertId);
    }
    if (r.level === 3) { try { send({ risk: "rouge" }); } catch {} }
    return r;
  }).catch(e => console.error(e));

  const ac = new AbortController();
  req.on("close", () => ac.abort());
  inflight++;
  try {
    const full = await streamReply(guide, hist, delta => send({ delta }), ac.signal, undefined, { userId: u.id, kind: "chat", billable: creditUsed });
    if (full) q.insertMessage.run(u.id, guide, "assistant", full, now(), null, null);
    await riskP;
    const after = q.getUser.get(u.id);
    if (creditUsed) afterPaidMessage(after);
    // Demande d'avis : jamais en cas de détresse, jamais à une personne passée sans crédit par le filet de sécurité.
    let askReview = false;
    if (!safetyPass && reviewEligible(after)) { askReview = true; q.logEvent.run(u.id, "review_asked", guide, now()); }
    send({ done: true, credits: after.credits, free: !creditUsed, safety: safetyPass || undefined, trial_denied: trial && !trial.allowed ? true : undefined, review: askReview || undefined });
  } catch (e) {
    if (!ac.signal.aborted) { console.error("chat error", e.message); send({ error: "La réponse a été interrompue. Vous pouvez renvoyer votre message. En cas d'urgence : 15 ou 3114." }); }
  } finally { inflight--; res.end(); }
});

// ---------- Crédits (Stripe Checkout en paiement unique) ----------
app.get("/api/checkout", async (req, res) => {
  const u = getUser(req, res);
  if (!stripe) return res.status(503).send("Paiement non configuré (STRIPE_SECRET_KEY).");
  const pack = PACKS[String(req.query.pack || DEFAULT_PACK)] || PACKS[DEFAULT_PACK];
  const auto = String(req.query.auto || "1") === "1";
  let customer = u.stripe_customer_id;
  if (!customer) { const c = await stripe.customers.create({ metadata: { user_id: u.id }, email: u.email || undefined }); customer = c.id; q.setPaymentMethod.run(customer, null, u.id); }
  const session = await stripe.checkout.sessions.create({
    mode: "payment", locale: "fr", customer,
    line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: pack.cents, product_data: { name: `Sereina, ${pack.label}`, description: `${pack.credits} crédits (1 crédit = 1 message)` } } }],
    payment_intent_data: { setup_future_usage: "off_session", metadata: { user_id: u.id, pack: pack.key } },
    client_reference_id: u.id, metadata: { user_id: u.id, pack: pack.key, auto: auto ? "1" : "0" },
    success_url: `${SITE_URL}/parler/?paid=1`, cancel_url: `${SITE_URL}/parler/`,
    allow_promotion_codes: true,
    custom_text: auto ? { submit: { message: `La recharge automatique du même pack est activée quand vos crédits sont épuisés. Vous pouvez la désactiver à tout moment dans « Mon compte ».` } } : undefined,
  });
  res.redirect(303, session.url);
});

app.get("/api/portal", async (req, res) => {
  const u = getUser(req, res);
  if (!stripe || !u.stripe_customer_id) return res.redirect("/mon-compte/");
  const s = await stripe.billingPortal.sessions.create({ customer: u.stripe_customer_id, return_url: `${SITE_URL}/mon-compte/` });
  res.redirect(303, s.url);
});

app.post("/api/me/auto", (req, res) => {
  const u = getUser(req, res);
  const enabled = !!req.body?.enabled;
  const pack = PACKS[req.body?.pack] ? req.body.pack : null;
  q.setAuto.run(enabled ? 1 : 0, pack, u.id);
  q.logEvent.run(u.id, enabled ? "auto_on" : "auto_off", pack, now());
  res.json({ ok: true, auto_recharge: enabled });
});

app.get("/api/me", (req, res) => {
  const u = getUser(req, res);
  res.json({ id: u.id, credits: u.credits, free_exhausted: freeExhausted(u), paywalled: paywalled(u),
    email: u.email ? maskEmail(u.email) : null, email_verified: !!u.email_verified_at, marketing_optin: !!u.marketing_optin, trial_denied: !!u.trial_denied,
    free_started: !!u.free_started_at, free_minutes: FREE_MINUTES, free_messages: FREE_MESSAGES,
    auto_recharge: !!u.auto_recharge, auto_pack: u.auto_pack || DEFAULT_PACK, can_auto: !!(u.stripe_customer_id && u.stripe_payment_method),
    has_customer: !!u.stripe_customer_id, consent: !!u.consent_at,
    packs: Object.values(PACKS).map(p => ({ ...p, price: eur(p.cents) })), default_pack: DEFAULT_PACK,
    purchases: q.purchases.all(u.id).map(p => ({ date: p.created_at, pack: p.pack, credits: p.credits, price: eur(p.amount_cents), kind: p.kind })) });
});

// Consentement explicite (données de santé) avant le premier message
app.post("/api/consent", (req, res) => {
  const u = getUser(req, res);
  db.prepare("UPDATE users SET consent_at = COALESCE(consent_at, ?) WHERE id = ?").run(now(), u.id);
  q.logEvent.run(u.id, "consent", null, now());
  res.json({ ok: true });
});

// ---------- Avis ----------
// Public : seulement les avis validés par l'équipe, avec l'accord de leur auteur. Aucune donnée personnelle autre que le prénom choisi.
app.get("/api/reviews", (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({ reviews: listPublic({ guide: String(req.query.guide || ""), limit: 12 }) });
});
app.post("/api/review", (req, res) => {
  const u = getUser(req, res);
  const r = submitReview({ user: u, guide: String(req.body?.guide || ""), rating: req.body?.rating, comment: req.body?.comment, name: req.body?.name, consent: !!req.body?.consent });
  if (r.error) return res.status(400).json(r);
  q.logEvent.run(u.id, "review_sent", null, now());
  res.json(r);
});

// ---------- Compte par code e-mail ----------
app.post("/api/auth/request-code", (req, res) => {
  getUser(req, res);
  const r = requestCode(req.body?.email, clientIp(req));
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true });
});
app.post("/api/auth/verify", (req, res) => {
  const u = getUser(req, res);
  const r = verifyCode(req.body?.email, req.body?.code, u, { marketingOptin: !!req.body?.marketing });
  if (r.error) return res.status(400).json({ error: r.error });
  // Le cookie pointe désormais vers le compte (utile si l'espace anonyme a été fusionné dans un compte existant).
  res.cookie("sid", r.user.id, { signed: true, httpOnly: true, sameSite: "lax", secure: SITE_URL.startsWith("https"), maxAge: 365 * 864e5 });
  claimEmailForTrial(r.user);
  if (r.created) sendWelcome(q.getUser.get(r.user.id));
  res.json({ ok: true, created: r.created, merged: r.merged, credits: q.getUser.get(r.user.id).credits });
});
app.post("/api/auth/logout", (req, res) => { res.clearCookie("sid"); res.json({ ok: true }); });
app.post("/api/me/marketing", (req, res) => {
  const u = getUser(req, res);
  if (!u.email) return res.status(400).json({ error: "Ajoutez d'abord votre adresse e-mail." });
  setMarketingOptin(u.id, !!req.body?.enabled);
  res.json({ ok: true });
});

// ---------- Newsletter et guides ----------
app.post("/api/newsletter", (req, res) => {
  if (req.body?.website) return res.json({ ok: true }); // champ piège
  const u = getUser(req, res);
  const r = NL.subscribe({ email: req.body?.email, guide: String(req.body?.guide || ""), source: String(req.body?.source || ""), userId: u.id });
  if (r.error) return res.status(400).json(r);
  res.json(r);
});
app.get("/api/newsletter/confirm", (req, res) => {
  const sub = NL.confirm(req.query.id, String(req.query.t || ""));
  if (!sub) return res.redirect("/guides/merci/?erreur=1");
  const g = sub.guide && NL.guideExists(sub.guide) ? sub.guide : "";
  res.redirect(g ? `/guides/merci/?g=${g}&dl=${encodeURIComponent(NL.downloadUrl(sub.id, g).replace(/^https?:\/\/[^/]+/, ""))}` : "/guides/merci/");
});
app.get("/api/guides/:file", (req, res) => {
  const slug = String(req.params.file).replace(/\.pdf$/, "");
  const pdf = NL.guideFileFor(slug, req.query.id, String(req.query.s || ""));
  if (!pdf) return res.status(404).send("Lien de téléchargement invalide ou expiré. Réinscrivez-vous depuis la page des guides pour en recevoir un nouveau.");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="sereina-${slug}.pdf"`);
  res.send(pdf);
});

// ---------- Désinscription (lien signé ; accepte aussi le « un clic » des messageries) ----------
app.post("/api/unsubscribe", express.urlencoded({ extended: false }), (req, res) => {
  const t = String(req.body?.t || req.query.t || ""), id = String(req.body?.id || req.query.id || ""), sig = String(req.body?.s || req.query.s || "");
  if (!["u", "n"].includes(t) || !checkSig("unsub", `${t}:${id}`, sig)) return res.status(400).json({ error: "Lien invalide." });
  if (t === "u") unsubscribeUser(id); else NL.unsubscribeNewsletter(id);
  res.json({ ok: true });
});

// Formulaire de contact -> e-mail à CONTACT_EMAIL (ou ALERT_EMAIL)
app.post("/api/contact", async (req, res) => {
  if (req.body?.website) { q.logEvent.run(null, "honeypot", clientIp(req), now()); return res.json({ ok: true }); } // champ piège rempli par les robots
  const email = String(req.body?.email || "").trim().slice(0, 200);
  const subject = stripHtml(req.body?.subject || "Contact").slice(0, 120);
  const message = stripHtml(req.body?.message || "").slice(0, 5000);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !message) return res.status(400).json({ error: "Champs invalides" });
  const to = process.env.CONTACT_EMAIL || process.env.ALERT_EMAIL;
  q.logEvent.run(null, "contact", JSON.stringify({ email, subject, message }), now());
  queueEmail({ type: "contact", to, subject: `[Sereina contact] ${subject}`, text: `De : ${email}\n\n${message}`, replyTo: email });
  res.json({ ok: true });
});

// Suppression des données à la demande de l'utilisateur (RGPD)
app.post("/api/me/delete", (req, res) => {
  const u = getUser(req, res);
  db.prepare("DELETE FROM messages WHERE user_id = ?").run(u.id);
  db.prepare("DELETE FROM alerts WHERE user_id = ?").run(u.id);
  db.prepare("DELETE FROM purchases WHERE user_id = ?").run(u.id);
  deleteByUser(u.id);
  for (const sql of ["DELETE FROM email_log WHERE user_id = ?", "DELETE FROM events WHERE user_id = ?", "UPDATE ai_usage SET user_id = NULL WHERE user_id = ?"]) { try { db.prepare(sql).run(u.id); } catch {} }
  if (u.email_hash) { try { db.prepare("DELETE FROM login_codes WHERE email_hash = ?").run(u.email_hash); } catch {} NL.deleteByEmailHash(u.email_hash); }
  db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
  res.clearCookie("sid").json({ ok: true });
});

// ---------- Santé (repris de renta-immo app/api/health) ----------
// GET /api/health        : public, minimal, pour la surveillance externe (UptimeRobot…) ; 503 pendant l'arrêt.
// GET /api/health?details=1 : détails pour un admin connecté ou un Bearer HEALTH_SECRET.
app.get("/api/health", (req, res) => {
  if (shuttingDown) return res.status(503).json({ ok: false, status: "shutting_down" });
  let dbOk = true; try { db.prepare("SELECT 1").get(); } catch { dbOk = false; }
  const base = { ok: dbOk, status: dbOk ? "ok" : "degraded", time: now() };
  if (!dbOk) return res.status(503).json(base);
  if (!("details" in req.query)) return res.json(base);
  const auth = req.headers.authorization || "";
  const allowed = (process.env.HEALTH_SECRET && timingSafeCompare(auth, `Bearer ${process.env.HEALTH_SECRET}`)) || !!readSession(req);
  if (!allowed) return res.status(401).json(base);
  const s = q.stats.get(), mail = queueStats();
  res.json({ ...base,
    ai: process.env.MOCK_AI === "1" ? "mock" : (process.env.ANTHROPIC_API_KEY ? "configured" : "missing"),
    stripe: !!stripe && !!process.env.STRIPE_WEBHOOK_SECRET, email: emailConfigured(),
    alerts_channels: ["ALERT_EMAIL", "ALERT_WEBHOOK_URL", "TELEGRAM_BOT_TOKEN", "TWILIO_SID"].filter(k => process.env[k]),
    mail_queue: mail, open_alerts: { rouge: s.rouge, orange: s.orange }, users: s.users, messages_24h: s.messages_24h,
    payments_check: lastRuns(1)[0] || null,
    inflight_chats: inflight, uptime_s: Math.round(process.uptime?.() || 0), version: process.env.APP_VERSION || null });
});

// ---------- Back-office ----------
app.use("/admin", admin);

// ---------- Tâches périodiques ----------
// Lancées par setInterval sous Node (server.js) et par l'alarme du Durable Object sous Cloudflare (worker/index.js).
/** Toutes les heures : contrôle des paiements, relances, codes expirés. */
export async function hourlyTasks() {
  try { await runCanary(); } catch (e) { console.error("canary", e.message); }
  try { runLifecycle(); } catch (e) { console.error("lifecycle", e.message); }
  try { purgeCodes(); } catch (e) { console.error("purgeCodes", e.message); }
}
/** Toutes les 6 heures : nettoyage (RGPD : RETENTION_DAYS, défaut 90 jours de conversations). */
export function sixHourlyTasks() {
  try { purgeClaims(); purgeSessions(); q.purgeOld.run(`-${Number(process.env.RETENTION_DAYS || 90)} days`); purgeQueue(); } catch (e) { console.error(e); }
}
export { processQueue, emailConfigured, SITE_URL };
export { nextDueAt } from "./mailqueue.js";
