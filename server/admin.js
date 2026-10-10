import express from "express";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { db, q, now } from "./db.js";
import * as A from "./security/auth.js";
import { passwordProblem } from "./security/password.js";
import { encryptSecret, decryptSecret, generateTOTPSecret, totpUri, verifyTOTPCode, generateRecoveryCodes, totpConfigured } from "./security/totp.js";
import { clientIp } from "./security/ratelimit.js";
import { stripHtml, sanitizeEmail } from "./security/headers.js";

const LEVELS = ["vert", "jaune", "orange", "rouge"];
const COLORS = { vert: "#2e7d4f", jaune: "#b8860b", orange: "#d2691e", rouge: "#b22222" };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = iso => iso ? new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : "";
const ROLE_LABEL = { owner: "propriétaire", admin: "administrateur", astreinte: "astreinte" };

export const admin = express.Router();
admin.use(express.urlencoded({ extended: false, limit: "64kb" }));
admin.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

// ---------- Authentification : session + 2FA + changement de mot de passe obligatoire ----------
const PUBLIC = new Set(["/login", "/logout"]);
admin.use((req, res, next) => {
  if (PUBLIC.has(req.path)) return next();
  const s = A.readSession(req);
  if (!s) return res.redirect("/admin/login");
  req.admin = s;
  if (s.pending_2fa && req.path !== "/2fa") return res.redirect("/admin/2fa");
  if (!s.pending_2fa && s.must_change_password && req.path !== "/mot-de-passe") return res.redirect("/admin/mot-de-passe");
  // CSRF : jeton de session sur toute mutation (en plus du contrôle d'Origin global)
  if (req.method === "POST" && String(req.body?._csrf || "") !== s.csrf) { A.audit("csrf_rejected", { adminId: s.admin_id, target: req.path, ip: clientIp(req) }); return res.status(403).send("Jeton de formulaire invalide. Rechargez la page."); }
  next();
});
const need = role => (req, res, next) => A.hasRole(req.admin, role) ? next() : res.status(403).send(page("Accès refusé", "<h1>Accès refusé</h1><p>Votre rôle ne permet pas cette action.</p>", false, req));
const csrf = req => `<input type="hidden" name="_csrf" value="${esc(req.admin?.csrf || "")}">`;

function page(title, body, refresh, req) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">${refresh ? '<meta http-equiv="refresh" content="30">' : ""}
<link rel="stylesheet" href="/static/style.css">
<style>
body{font-family:var(--display);font-size:15px}
.wrap{max-width:1280px;margin:0 auto;padding:16px 20px 60px}
.stats{display:flex;gap:24px;flex-wrap:wrap;margin:16px 0 24px;padding:14px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.stats b{display:block;font-size:26px;font-variant-numeric:tabular-nums}
.stats span{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr.rouge td:first-child{box-shadow:inset 4px 0 0 #b22222}
tr.orange td:first-child{box-shadow:inset 4px 0 0 #d2691e}
.chip{display:inline-block;padding:3px 10px;color:#fff;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.chip.handled{opacity:.45}
.last{color:var(--muted);max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
a{color:var(--steel)}
.proto{background:var(--alert-bg);color:var(--alert-fg);border:1px solid var(--alert-line);padding:16px 20px;margin:18px 0;line-height:1.5}
.proto ol{margin:8px 0 0;padding-left:1.3em}
.conv{display:grid;gap:12px;margin:18px 0;max-width:820px}
.msg{padding:10px 14px;border-left:3px solid var(--line);white-space:pre-wrap;font-family:var(--body);font-size:16px}
.msg.user{border-left-color:var(--steel)}
.msg small{display:block;font-family:var(--display);font-size:12px;color:var(--muted);margin-bottom:4px}
.msg .r{font-size:12px;font-family:var(--display);margin-top:6px}
form.inline{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:16px 0}
textarea,input,select{font:inherit;padding:8px;border:1px solid var(--line);background:var(--paper);color:var(--fg)}
dl{display:grid;grid-template-columns:160px 1fr;gap:6px 14px;margin:14px 0;max-width:720px}
dt{color:var(--muted)}
.btn{min-height:40px;padding:8px 16px}
.nav{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.nav .who{margin-left:auto;color:var(--muted)}.nav .out{display:inline}.nav .ghost{min-height:32px;padding:4px 10px}
.login{max-width:420px;margin:60px auto;display:grid;gap:14px}.login label{display:grid;gap:4px}.login input{min-height:44px}
.err{background:var(--alert-bg);color:var(--alert-fg);border:1px solid var(--alert-line);padding:10px 14px}
.ok{background:var(--mist);padding:10px 14px}
code.codes{display:block;white-space:pre;font-size:16px;line-height:1.7;padding:12px;background:var(--mist);margin:10px 0;max-width:320px}
</style></head><body><div class="wrap">
${req?.admin && !req.admin.pending_2fa ? `<p class="nav"><a href="/admin/">Utilisateurs</a> · <a href="/admin/alertes">Alertes ouvertes</a>${A.hasRole(req.admin, "admin") ? ' · <a href="/admin/journal">Journal</a>' : ""}${A.hasRole(req.admin, "owner") ? ' · <a href="/admin/equipe">Équipe</a>' : ""} · <a href="/admin/securite">Mon compte</a> · <a href="/">Site</a> <span class="who">${esc(req.admin.name || req.admin.email)} (${ROLE_LABEL[req.admin.role] || req.admin.role})</span> <form method="post" action="/admin/logout" class="out"><button class="ghost" type="submit">Déconnexion</button></form></p>` : ""}
${body}</div></body></html>`;
}

function chip(level, handled) {
  const l = LEVELS[level] || "vert";
  return `<span class="chip${handled ? " handled" : ""}" style="background:${COLORS[l]}">${l}${handled ? " · traité" : ""}</span>`;
}

admin.get("/", (req, res) => {
  const s = q.stats.get();
  const users = q.listUsers.all(500);
  const rows = users.map(u => {
    const open = u.risk_level >= 2 && !u.handled_at;
    return `<tr class="${open ? LEVELS[u.risk_level] : ""}">
      <td><a href="/admin/u/${u.id}">${esc(u.first_name || "Anonyme")} <small>${u.id.slice(0, 8)}</small></a></td>
      <td>${chip(u.risk_level, !!u.handled_at)}<br><small>${esc(u.risk_reason || "")}</small></td>
      <td>${esc(u.phone || "")}</td>
      <td>${u.credits}${u.auto_recharge ? " · auto" : ""}</td>
      <td>${u.nb_messages}</td>
      <td>${fmt(u.last_seen)}</td>
      <td class="last" title="${esc(u.last_message || "")}">${esc(u.last_message || "")}</td></tr>`;
  }).join("");
  res.send(page("Back-office Sereina", `
<h1>Utilisateurs</h1>
<div class="stats">
  <div><b style="color:${COLORS.rouge}">${s.rouge}</b><span>rouge à traiter</span></div>
  <div><b style="color:${COLORS.orange}">${s.orange}</b><span>orange à traiter</span></div>
  <div><b>${s.actifs_24h}</b><span>actifs 24 h</span></div>
  <div><b>${s.messages_24h}</b><span>messages 24 h</span></div>
  <div><b>${s.buyers}</b><span>acheteurs</span></div>
  <div><b>${(s.revenue_30d/100).toFixed(0)} €</b><span>encaissé 30 j</span></div>
  <div><b>${s.auto_recharge}</b><span>recharge auto</span></div>
  <div><b>${s.users}</b><span>utilisateurs</span></div>
</div>
<p style="color:var(--muted)">Tri : risque non traité d'abord (rouge, orange, jaune), puis dernière activité. La page se rafraîchit toutes les 30 secondes.</p>
<table><thead><tr><th>Utilisateur</th><th>Risque</th><th>Téléphone</th><th>Crédits</th><th>Msgs</th><th>Dernière activité</th><th>Dernier message</th></tr></thead><tbody>${rows}</tbody></table>`, true, req));
});

admin.get("/alertes", (req, res) => {
  const rows = q.openAlerts.all().map(a => `<tr class="${LEVELS[a.level]}"><td>${chip(a.level)}</td><td><a href="/admin/u/${a.user_id}">${esc(a.first_name || "Anonyme")} ${a.user_id.slice(0, 8)}</a></td><td>${esc(a.phone || "")}</td><td>${esc(a.reason || "")}</td><td>${fmt(a.created_at)}</td><td>${a.notified_at ? "oui" : "non"}</td></tr>`).join("");
  res.send(page("Alertes ouvertes", `<h1>Alertes ouvertes</h1><table><thead><tr><th>Niveau</th><th>Utilisateur</th><th>Téléphone</th><th>Raison</th><th>Date</th><th>Équipe prévenue</th></tr></thead><tbody>${rows || '<tr><td colspan="6">Aucune alerte ouverte.</td></tr>'}</tbody></table>`, true, req));
});

admin.get("/u/:id", (req, res) => {
  const u = q.getUser.get(req.params.id);
  if (!u) return res.status(404).send("Inconnu");
  A.audit("user_viewed", { adminId: req.admin.admin_id, target: u.id, ip: clientIp(req) });
  const msgs = q.allMessages.all(u.id);
  const conv = msgs.map(m => `<div class="msg ${m.role}"><small>${m.role === "user" ? "Utilisateur" : esc(m.guide)} · ${fmt(m.created_at)}</small>${esc(m.content)}${m.role === "user" && m.risk_level != null ? `<div class="r">${chip(m.risk_level)} ${esc(m.risk_reason || "")}</div>` : ""}</div>`).join("");
  const proto = u.risk_level === 3 && !u.handled_at ? `<div class="proto"><b>Protocole rouge : une personne est peut-être en danger immédiat.</b>
<ol>
<li>Lisez les derniers messages ci-dessous pour comprendre la situation (intention, moyen, moment, lieu).</li>
<li>Si un numéro est connu : <b>${esc(u.phone || "aucun numéro")}</b>, appelez la personne tout de suite. Restez calme, dites que vous appelez de Sereina, demandez si elle est en sécurité et si quelqu'un est avec elle.</li>
<li>Si la personne est en danger immédiat (geste fait ou imminent) ou injoignable alors qu'elle a annoncé un passage à l'acte : <b>appelez le 15</b> (ou le 112) et transmettez tout ce que vous savez : prénom, téléphone, ville ${esc(u.city || "(inconnue)")}, contenu des messages, heure. Le SAMU décide de la suite ; c'est leur rôle.</li>
<li>Donnez-lui le 3114 si elle peut parler à quelqu'un maintenant.</li>
<li>Notez ci-dessous ce qui a été fait, puis marquez « pris en charge ».</li>
</ol></div>` : "";
  res.send(page(`Utilisateur ${u.id.slice(0, 8)}`, `
<h1>${esc(u.first_name || "Anonyme")} <small style="color:var(--muted)">${u.id}</small></h1>
<p>${chip(u.risk_level, !!u.handled_at)} ${esc(u.risk_reason || "")} ${u.risk_updated_at ? "· " + fmt(u.risk_updated_at) : ""}</p>
${proto}
<dl><dt>Téléphone</dt><dd>${esc(u.phone || "inconnu")}</dd><dt>Ville</dt><dd>${esc(u.city || "inconnue")}</dd><dt>E-mail</dt><dd>${esc(u.email || "inconnu")}</dd>
<dt>Crédits</dt><dd>${u.credits} · recharge automatique : ${u.auto_recharge ? "oui (" + esc(u.auto_pack || "") + ")" : "non"}${u.stripe_customer_id ? ` · <a href="https://dashboard.stripe.com/customers/${esc(u.stripe_customer_id)}">Stripe</a>` : ""}</dd>
<dt>Achats</dt><dd>${q.purchases.all(u.id).map(p => `${fmt(p.created_at)} : ${esc(p.pack)}, ${p.credits} crédits, ${(p.amount_cents/100).toFixed(2).replace(".", ",")} € (${p.kind === "auto" ? "recharge auto" : "achat"})`).join("<br>") || "aucun"}</dd>
<dt>Première visite</dt><dd>${fmt(u.created_at)}</dd><dt>Dernière activité</dt><dd>${fmt(u.last_seen)}</dd>
<dt>Pris en charge</dt><dd>${u.handled_at ? fmt(u.handled_at) + " par " + esc(u.handled_by) : "non"}</dd><dt>Notes</dt><dd style="white-space:pre-wrap">${esc(u.notes || "")}</dd></dl>
${A.hasRole(req.admin, "admin") ? `<form class="inline" method="post" action="/admin/u/${u.id}/credits">${csrf(req)}<label>Offrir des crédits<br><input name="n" type="number" value="10" min="1" max="1000" style="width:90px"></label><button class="btn" type="submit">Ajouter</button></form>` : ""}
<form class="inline" method="post" action="/admin/u/${u.id}/handle">${csrf(req)}
  <label>Issue / notes<br><textarea name="notes" rows="2" cols="50" placeholder="Ex. : rappelé à 14h10, en sécurité, sa fille est avec elle ; 3114 conseillé."></textarea></label>
  <label>Contact connu<br><input name="phone" value="${esc(u.phone || "")}" placeholder="téléphone"></label>
  <button class="btn" type="submit">Marquer comme pris en charge</button>
</form>
<h2>Conversation</h2><div class="conv">${conv || "<p>Aucun message.</p>"}</div>`, false, req));
});

admin.post("/u/:id/handle", (req, res) => {
  const t = now();
  const by = String(req.admin.name || req.admin.email).slice(0, 80);
  const notes = req.body.notes ? `${fmt(t)} (${by}) : ${String(req.body.notes).slice(0, 2000)}\n` : null;
  const u = q.getUser.get(req.params.id);
  if (!u) return res.status(404).send("Inconnu");
  db.prepare("UPDATE users SET handled_at = ?, handled_by = ?, notes = COALESCE(notes,'') || COALESCE(?, ''), phone = COALESCE(NULLIF(?, ''), phone) WHERE id = ?").run(t, by, notes, req.body.phone, u.id);
  q.handleAlerts.run(t, by, String(req.body.notes || "").slice(0, 500), u.id);
  q.logEvent.run(u.id, "handled", by, t);
  A.audit("user_handled", { adminId: req.admin.admin_id, target: u.id, metadata: { notes: String(req.body.notes || "").slice(0, 200) }, ip: clientIp(req) });
  res.redirect(`/admin/u/${u.id}`);
});

admin.post("/u/:id/credits", need("admin"), (req, res) => {
  const n = Math.max(1, Math.min(1000, Number(req.body.n) || 0));
  if (!q.getUser.get(req.params.id)) return res.status(404).send("Inconnu");
  q.addCredits.run(n, req.params.id); q.logEvent.run(req.params.id, "credits_gift", String(n), now());
  A.audit("credits_gift", { adminId: req.admin.admin_id, target: req.params.id, metadata: { n }, ip: clientIp(req) });
  res.redirect(`/admin/u/${req.params.id}`);
});

admin.get("/api/users.json", need("admin"), (req, res) => res.json(q.listUsers.all(1000)));


// ---------- Connexion ----------
admin.get("/login", (req, res) => {
  if (A.readSession(req)) return res.redirect("/admin/");
  res.send(page("Connexion", `<form class="login" method="post" action="/admin/login"><h1>Back-office Sereina</h1>
  ${req.query.e ? `<div class="err">${esc(req.query.e)}</div>` : ""}
  <label>E-mail<input type="email" name="email" required autocomplete="username"></label>
  <label>Mot de passe<input type="password" name="password" required autocomplete="current-password"></label>
  <button class="btn" type="submit">Se connecter</button></form>`));
});
admin.post("/login", (req, res) => {
  const r = A.login(req.body.email, req.body.password, req);
  if (!r.ok) return res.redirect("/admin/login?e=" + encodeURIComponent(r.reason));
  A.openSession(res, r.admin, req, !!r.admin.totp_enabled);
  res.redirect(r.admin.totp_enabled ? "/admin/2fa" : "/admin/");
});
admin.post("/logout", (req, res) => { A.logout(req, res); res.redirect("/admin/login"); });

admin.get("/2fa", (req, res) => {
  if (!req.admin.pending_2fa) return res.redirect("/admin/");
  res.send(page("Vérification", `<form class="login" method="post" action="/admin/2fa"><h1>Code de vérification</h1><p>Entrez le code à 6 chiffres de votre application d'authentification, ou un code de récupération.</p>
  ${req.query.e ? `<div class="err">${esc(req.query.e)}</div>` : ""}${csrf(req)}
  <label>Code<input name="code" required autocomplete="one-time-code" inputmode="numeric"></label>
  <button class="btn" type="submit">Valider</button></form>`));
});
const twofaTries = new Map();
admin.post("/2fa", (req, res) => {
  if (!req.admin.pending_2fa) return res.redirect("/admin/");
  const k = req.admin.admin_id, n = (twofaTries.get(k) || 0) + 1; twofaTries.set(k, n);
  if (n > 8) { A.logout(req, res); A.audit("2fa_failed", { adminId: k, metadata: { reason: "too_many" }, ip: clientIp(req) }); return res.redirect("/admin/login?e=" + encodeURIComponent("Trop de codes incorrects. Reconnectez-vous.")); }
  if (!A.verify2fa(req.admin, req.body.code)) { A.audit("2fa_failed", { adminId: k, ip: clientIp(req) }); return res.redirect("/admin/2fa?e=" + encodeURIComponent("Code incorrect.")); }
  twofaTries.delete(k); A.complete2fa(req.admin); A.audit("2fa_verified", { adminId: k, ip: clientIp(req) });
  res.redirect("/admin/");
});

// ---------- Mon compte : mot de passe, 2FA, sessions ----------
admin.get("/mot-de-passe", (req, res) => {
  res.send(page("Mot de passe", `<form class="login" method="post" action="/admin/mot-de-passe"><h1>${req.admin.must_change_password ? "Choisissez votre mot de passe" : "Changer le mot de passe"}</h1>
  <p>12 caractères minimum, avec majuscule, minuscule et chiffre. Toutes vos sessions seront fermées.</p>
  ${req.query.e ? `<div class="err">${esc(req.query.e)}</div>` : ""}${csrf(req)}
  <label>Nouveau mot de passe<input type="password" name="password" required autocomplete="new-password"></label>
  <label>Confirmation<input type="password" name="password2" required autocomplete="new-password"></label>
  <button class="btn" type="submit">Enregistrer</button></form>`, false, req));
});
admin.post("/mot-de-passe", (req, res) => {
  const p = String(req.body.password || "");
  const pb = passwordProblem(p);
  if (pb) return res.redirect("/admin/mot-de-passe?e=" + encodeURIComponent(pb));
  if (p !== String(req.body.password2 || "")) return res.redirect("/admin/mot-de-passe?e=" + encodeURIComponent("Les deux mots de passe diffèrent."));
  A.changePassword(req.admin.admin_id, p, req);
  res.clearCookie(A.COOKIE, { path: "/" });
  res.redirect("/admin/login?e=" + encodeURIComponent("Mot de passe enregistré. Reconnectez-vous."));
});

admin.get("/securite", async (req, res) => {
  const a = A.adminById(req.admin.admin_id);
  const sessions = A.listSessions(a.id).map(s => `<tr><td>${fmt(s.created_at)}</td><td>${fmt(s.last_seen)}</td><td>${esc(s.ip || "")}</td><td>${esc((s.user_agent || "").slice(0, 60))}</td></tr>`).join("");
  let totpBlock;
  if (!totpConfigured()) totpBlock = `<p class="err">Double authentification indisponible : définissez TOTP_ENCRYPTION_KEY dans .env (openssl rand -hex 32).</p>`;
  else if (a.totp_enabled) totpBlock = `<p class="ok">Double authentification activée.</p><form method="post" action="/admin/securite/2fa/off" class="inline">${csrf(req)}<label>Code actuel<br><input name="code" inputmode="numeric" required></label><button class="btn" type="submit">Désactiver</button></form>
  <form method="post" action="/admin/securite/2fa/recovery" class="inline">${csrf(req)}<label>Code actuel<br><input name="code" inputmode="numeric" required></label><button class="btn" type="submit">Regénérer les codes de récupération</button></form>`;
  else {
    let secret = a.totp_pending_enc ? decryptSecret(a.totp_pending_enc) : null;
    if (!secret) { secret = generateTOTPSecret(); db.prepare("UPDATE admins SET totp_pending_enc = ? WHERE id = ?").run(encryptSecret(secret), a.id); }
    const qr = await QRCode.toDataURL(totpUri(secret, a.email));
    totpBlock = `<p>Scannez ce code avec une application d'authentification (Google Authenticator, Authy, 1Password…), puis entrez le code affiché pour activer.</p>
    <img src="${qr}" width="180" height="180" alt="QR code"><p><small>Ou saisissez la clé : <code>${esc(secret)}</code></small></p>
    <form method="post" action="/admin/securite/2fa/on" class="inline">${csrf(req)}<label>Code à 6 chiffres<br><input name="code" inputmode="numeric" required></label><button class="btn" type="submit">Activer la double authentification</button></form>`;
  }
  res.send(page("Mon compte", `<h1>Mon compte</h1>
  <dl><dt>E-mail</dt><dd>${esc(a.email)}</dd><dt>Rôle</dt><dd>${ROLE_LABEL[a.role]}</dd><dt>Mot de passe changé</dt><dd>${fmt(a.password_changed_at)} · <a href="/admin/mot-de-passe">Changer</a></dd></dl>
  ${req.query.m ? `<div class="ok">${esc(req.query.m)}</div>` : ""}${req.query.e ? `<div class="err">${esc(req.query.e)}</div>` : ""}
  ${req.query.codes ? `<div class="ok"><b>Codes de récupération</b> (à conserver en lieu sûr, chacun ne sert qu'une fois ; ils ne seront plus affichés) :<code class="codes">${esc(String(req.query.codes).split(",").join("\n"))}</code></div>` : ""}
  <h2>Double authentification</h2>${totpBlock}
  <h2>Sessions ouvertes</h2><table><thead><tr><th>Ouverte le</th><th>Dernière activité</th><th>IP</th><th>Navigateur</th></tr></thead><tbody>${sessions}</tbody></table>
  <form method="post" action="/admin/securite/sessions/revoke" class="inline">${csrf(req)}<button class="btn" type="submit">Fermer toutes les sessions (y compris celle-ci)</button></form>`, false, req));
});
admin.post("/securite/2fa/on", (req, res) => {
  const a = A.adminById(req.admin.admin_id);
  if (!a.totp_pending_enc || !verifyTOTPCode(decryptSecret(a.totp_pending_enc), req.body.code)) return res.redirect("/admin/securite?e=" + encodeURIComponent("Code incorrect, réessayez."));
  const { plain, hashed } = generateRecoveryCodes(a.id);
  db.prepare("UPDATE admins SET totp_enabled = 1, totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, recovery_codes = ? WHERE id = ?").run(JSON.stringify(hashed), a.id);
  A.audit("2fa_enabled", { adminId: a.id, ip: clientIp(req) });
  res.redirect("/admin/securite?m=" + encodeURIComponent("Double authentification activée.") + "&codes=" + encodeURIComponent(plain.join(",")));
});
admin.post("/securite/2fa/off", (req, res) => {
  if (!A.verify2fa(req.admin, req.body.code)) return res.redirect("/admin/securite?e=" + encodeURIComponent("Code incorrect."));
  db.prepare("UPDATE admins SET totp_enabled = 0, totp_secret_enc = NULL, recovery_codes = NULL WHERE id = ?").run(req.admin.admin_id);
  A.audit("2fa_disabled", { adminId: req.admin.admin_id, ip: clientIp(req) });
  res.redirect("/admin/securite?m=" + encodeURIComponent("Double authentification désactivée."));
});
admin.post("/securite/2fa/recovery", (req, res) => {
  if (!A.verify2fa(req.admin, req.body.code)) return res.redirect("/admin/securite?e=" + encodeURIComponent("Code incorrect."));
  const { plain, hashed } = generateRecoveryCodes(req.admin.admin_id);
  db.prepare("UPDATE admins SET recovery_codes = ? WHERE id = ?").run(JSON.stringify(hashed), req.admin.admin_id);
  A.audit("2fa_recovery_regenerated", { adminId: req.admin.admin_id, ip: clientIp(req) });
  res.redirect("/admin/securite?m=" + encodeURIComponent("Nouveaux codes générés.") + "&codes=" + encodeURIComponent(plain.join(",")));
});
admin.post("/securite/sessions/revoke", (req, res) => {
  A.revokeSessions(req.admin.admin_id); A.audit("sessions_revoked", { adminId: req.admin.admin_id, ip: clientIp(req) });
  res.clearCookie(A.COOKIE, { path: "/" }); res.redirect("/admin/login");
});

// ---------- Équipe (propriétaire) ----------
admin.get("/equipe", need("owner"), (req, res) => {
  const rows = db.prepare("SELECT id, email, name, role, active, totp_enabled, last_login_at, locked_until FROM admins ORDER BY created_at").all().map(a => `<tr><td>${esc(a.name || "")}<br><small>${esc(a.email)}</small></td><td>${ROLE_LABEL[a.role]}</td><td>${a.active ? "actif" : "désactivé"}${a.locked_until && a.locked_until > now() ? " · verrouillé" : ""}</td><td>${a.totp_enabled ? "oui" : "non"}</td><td>${fmt(a.last_login_at)}</td>
  <td>${a.role !== "owner" ? `<form method="post" action="/admin/equipe/${a.id}/toggle" class="inline" style="margin:0">${csrf(req)}<button class="ghost" type="submit">${a.active ? "Désactiver" : "Réactiver"}</button></form>` : ""}
  ${a.locked_until && a.locked_until > now() ? `<form method="post" action="/admin/equipe/${a.id}/unlock" class="inline" style="margin:0">${csrf(req)}<button class="ghost" type="submit">Déverrouiller</button></form>` : ""}</td></tr>`).join("");
  res.send(page("Équipe", `<h1>Équipe</h1>
  ${req.query.m ? `<div class="ok">${esc(req.query.m)}</div>` : ""}${req.query.e ? `<div class="err">${esc(req.query.e)}</div>` : ""}
  <table><thead><tr><th>Membre</th><th>Rôle</th><th>État</th><th>2FA</th><th>Dernière connexion</th><th></th></tr></thead><tbody>${rows}</tbody></table>
  <h2>Ajouter un membre</h2>
  <form class="inline" method="post" action="/admin/equipe">${csrf(req)}
    <label>Nom<br><input name="name" required></label>
    <label>E-mail<br><input type="email" name="email" required></label>
    <label>Rôle<br><select name="role"><option value="astreinte">Astreinte (alertes et fiches)</option><option value="admin">Administrateur (tout sauf l'équipe)</option></select></label>
    <label>Mot de passe provisoire<br><input name="password" required minlength="12"></label>
    <button class="btn" type="submit">Créer</button></form>
  <p style="color:var(--muted)">Le membre devra changer ce mot de passe à sa première connexion. Transmettez-le par un canal sûr.</p>`, false, req));
});
admin.post("/equipe", need("owner"), (req, res) => {
  const email = sanitizeEmail(req.body.email), name = stripHtml(req.body.name).slice(0, 80);
  const pb = passwordProblem(String(req.body.password || ""));
  if (!email || pb) return res.redirect("/admin/equipe?e=" + encodeURIComponent(pb || "E-mail invalide."));
  if (db.prepare("SELECT 1 FROM admins WHERE email = ?").get(email)) return res.redirect("/admin/equipe?e=" + encodeURIComponent("Cet e-mail existe déjà."));
  A.createAdmin({ email, name, password: req.body.password, role: req.body.role === "admin" ? "admin" : "astreinte" }, req.admin.admin_id, clientIp(req));
  res.redirect("/admin/equipe?m=" + encodeURIComponent("Membre créé."));
});
admin.post("/equipe/:id/toggle", need("owner"), (req, res) => {
  const a = A.adminById(req.params.id);
  if (!a || a.role === "owner") return res.redirect("/admin/equipe");
  db.prepare("UPDATE admins SET active = ? WHERE id = ?").run(a.active ? 0 : 1, a.id);
  if (a.active) A.revokeSessions(a.id);
  A.audit(a.active ? "admin_disabled" : "admin_enabled", { adminId: req.admin.admin_id, target: a.email, ip: clientIp(req) });
  res.redirect("/admin/equipe");
});
admin.post("/equipe/:id/unlock", need("owner"), (req, res) => {
  db.prepare("UPDATE admins SET failed_attempts = 0, locked_until = NULL WHERE id = ?").run(req.params.id);
  A.audit("admin_unlocked", { adminId: req.admin.admin_id, target: req.params.id, ip: clientIp(req) });
  res.redirect("/admin/equipe");
});

// ---------- Journal d'audit ----------
admin.get("/journal", need("admin"), (req, res) => {
  const rows = db.prepare("SELECT l.*, a.email FROM audit_log l LEFT JOIN admins a ON a.id = l.admin_id ORDER BY l.id DESC LIMIT 300").all()
    .map(l => `<tr><td>${fmt(l.created_at)}</td><td>${esc(l.email || "")}</td><td>${esc(l.action)}</td><td>${esc(l.target || "")}</td><td>${esc(l.metadata || "")}</td><td>${esc(l.ip || "")}</td></tr>`).join("");
  res.send(page("Journal", `<h1>Journal d'audit</h1><p style="color:var(--muted)">300 dernières actions sensibles : connexions, échecs, verrouillages, 2FA, consultations de fiches, prises en charge, crédits offerts, gestion de l'équipe.</p>
  <table><thead><tr><th>Date</th><th>Qui</th><th>Action</th><th>Cible</th><th>Détails</th><th>IP</th></tr></thead><tbody>${rows}</tbody></table>`, false, req));
});
