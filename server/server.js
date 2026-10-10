import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import Stripe from "stripe";
import { db, q, now } from "./db.js";
import { GUIDES, streamReply, assessRisk } from "./ai.js";
import { notifyAlert } from "./notify.js";
import { admin } from "./admin.js";
import { securityHeaders, csrfOrigin, stripHtml } from "./security/headers.js";
import { RateLimiter, rateLimit, clientIp } from "./security/ratelimit.js";
import { bootstrapOwner, purgeSessions, readSession } from "./security/auth.js";
import { queueEmail, queueStats, startQueueProcessor, emailConfigured } from "./mailqueue.js";
import { timingSafeCompare } from "./security/password.js";

const PORT = Number(process.env.PORT || 3000);
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DIST = process.env.DIST_DIR || path.join(process.cwd(), "..", "dist");
const FREE_MINUTES = Number(process.env.FREE_MINUTES || 5);
const FREE_MESSAGES = Number(process.env.FREE_MESSAGES || 8);
// Packs de crédits : "cle:credits:centimes:libellé" séparés par des virgules
const PACKS = Object.fromEntries((process.env.PACKS || "petit:20:490:Petit pack,moyen:60:1290:Pack confort,grand:150:2490:Grand pack").split(",").map(p => {
  const [key, credits, cents, label] = p.split(":"); return [key.trim(), { key: key.trim(), credits: Number(credits), cents: Number(cents), label: (label || key).trim() }];
}));
const DEFAULT_PACK = process.env.DEFAULT_PACK || Object.keys(PACKS)[1] || Object.keys(PACKS)[0];
const eur = c => (c / 100).toFixed(2).replace(".", ",") + " €";
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString("hex");
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const app = express();
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
  if (ev.type === "checkout.session.completed" && o.mode === "payment" && o.payment_status === "paid") {
    const uid = o.client_reference_id || o.metadata?.user_id;
    const pack = PACKS[o.metadata?.pack];
    if (uid && pack && q.getUser.get(uid)) {
      const ins = q.insertPurchase.run(uid, pack.key, pack.credits, pack.cents, "checkout", o.id, now());
      if (ins.changes) {
        q.addCredits.run(pack.credits, uid);
        q.setAuto.run(o.metadata?.auto === "1" ? 1 : 0, pack.key, uid);
        q.setPaymentMethod.run(o.customer, null, uid);
        q.logEvent.run(uid, "purchase", `${pack.key} ${pack.credits} crédits ${eur(pack.cents)}`, now());
        // Récupère le moyen de paiement enregistré pour la recharge automatique
        stripe.paymentIntents.retrieve(String(o.payment_intent)).then(pi => { if (pi.payment_method) q.setPaymentMethod.run(null, String(pi.payment_method), uid); }).catch(e => console.error("pm fetch", e.message));
      }
    }
  } else if (ev.type === "payment_intent.succeeded" && o.metadata?.auto === "1" && o.metadata?.user_id) {
    // Filet de sécurité : si la recharge auto a réussi mais que le serveur n'a pas pu créditer (coupure), on crédite ici.
    const pack = PACKS[o.metadata.pack];
    if (pack && q.getUser.get(o.metadata.user_id)) {
      const ins = q.insertPurchase.run(o.metadata.user_id, pack.key, pack.credits, pack.cents, "auto", o.id, now());
      if (ins.changes) q.addCredits.run(pack.credits, o.metadata.user_id);
    }
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
  if (!u.free_started_at) return false;
  const minutes = (Date.now() - new Date(u.free_started_at).getTime()) / 60000;
  return minutes > FREE_MINUTES || u.free_messages >= FREE_MESSAGES;
}
function paywalled(u) { return freeExhausted(u) && u.credits <= 0; }

/** Recharge automatique : débite la carte enregistrée hors session et crédite le compte. */
async function autoRecharge(u) {
  if (!stripe || !u.auto_recharge || !u.stripe_customer_id || !u.stripe_payment_method) return false;
  const pack = PACKS[u.auto_pack] || PACKS[DEFAULT_PACK];
  try {
    const pi = await stripe.paymentIntents.create({
      amount: pack.cents, currency: "eur", customer: u.stripe_customer_id, payment_method: u.stripe_payment_method,
      off_session: true, confirm: true, description: `Sereina, ${pack.label} (${pack.credits} crédits), recharge automatique`,
      metadata: { user_id: u.id, pack: pack.key, auto: "1" },
    });
    if (pi.status === "succeeded") {
      const ins = q.insertPurchase.run(u.id, pack.key, pack.credits, pack.cents, "auto", pi.id, now());
      if (ins.changes) q.addCredits.run(pack.credits, u.id);
      q.logEvent.run(u.id, "auto_recharge", `${pack.key} ${eur(pack.cents)}`, now());
      return true;
    }
  } catch (e) {
    console.error("auto recharge failed", e.code || e.message);
    q.logEvent.run(u.id, "auto_recharge_failed", e.code || e.message, now());
    q.setAuto.run(0, null, u.id); // on désactive pour ne pas réessayer en boucle ; la personne rachète à la main
  }
  return false;
}

// ---------- Chat ----------
let shuttingDown = false, inflight = 0;
app.post("/api/chat", async (req, res) => {
  if (shuttingDown) return res.status(503).json({ error: "Le service redémarre, réessayez dans quelques secondes." });
  const u = getUser(req, res);
  const guide = GUIDES[req.body?.guide] ? req.body.guide : "clara";
  const message = String(req.body?.message || "").trim().slice(0, 4000);
  if (!message) return res.status(400).json({ error: "Message vide" });
  if (!u.consent_at) return res.status(403).json({ code: "consent_required" });
  if (paywalled(u)) {
    const ok = await autoRecharge(u);
    if (!ok) return res.status(402).json({ code: "paywall", packs: Object.values(PACKS), defaultPack: DEFAULT_PACK });
  }
  const fresh = q.getUser.get(u.id);
  let creditUsed = false;
  if (freeExhausted(fresh)) { q.useCredit.run(u.id); creditUsed = true; } else q.startFree.run(now(), u.id);
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
  const riskP = assessRisk(recent).then(async r => {
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
    const full = await streamReply(guide, hist, delta => send({ delta }), ac.signal);
    if (full) q.insertMessage.run(u.id, guide, "assistant", full, now(), null, null);
    await riskP;
    const after = q.getUser.get(u.id);
    send({ done: true, credits: after.credits, free: !creditUsed });
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
  if (!customer) { const c = await stripe.customers.create({ metadata: { user_id: u.id } }); customer = c.id; q.setPaymentMethod.run(customer, null, u.id); }
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
    inflight_chats: inflight, uptime_s: Math.round(process.uptime()), version: process.env.APP_VERSION || null });
});

// ---------- Back-office ----------
app.use("/admin", admin);

// ---------- Site statique ----------
app.use(express.static(DIST, { extensions: ["html"], maxAge: "1h" }));
app.use((req, res) => {
  const p = path.join(DIST, "404.html");
  res.status(404).sendFile(fs.existsSync(p) ? p : path.join(DIST, "index.html"));
});

// Purge des conversations anciennes (RGPD) : RETENTION_DAYS, défaut 90
setInterval(() => { try { purgeSessions(); q.purgeOld.run(`-${Number(process.env.RETENTION_DAYS || 90)} days`); } catch (e) { console.error(e); } }, 6 * 3600 * 1000);

startQueueProcessor();
const server = app.listen(PORT, () => console.log(`Sereina sur ${SITE_URL} (port ${PORT}) ${process.env.MOCK_AI === "1" ? "[MOCK_AI]" : ""}`));
server.keepAliveTimeout = 65_000;

// ---------- Arrêt propre (repris de renta-immo lib/infra/shutdown.ts) ----------
// SIGTERM : /api/health passe à 503 (le proxy retire l'instance), on refuse les nouveaux chats,
// on laisse finir les réponses en flux (DRAIN max SHUTDOWN_DRAIN_MS, défaut 15 s), puis on ferme la base.
const DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS || 15_000);
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} reçu, ${inflight} conversation(s) en cours, drain ${DRAIN_MS} ms`);
  // On continue de répondre pendant le drain (health 503, chat refusé) pour que le proxy nous retire proprement.
  const t0 = Date.now();
  while (inflight > 0 && Date.now() - t0 < DRAIN_MS) await new Promise(r => setTimeout(r, 200));
  server.close();
  try { db.close(); } catch {}
  console.log(`[shutdown] terminé (${inflight} interrompue(s))`);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
