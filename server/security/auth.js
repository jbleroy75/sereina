// Authentification des administrateurs : comptes, sessions, verrouillage, 2FA, rôles, journal d'audit.
// Logique reprise de renta-immo (lib/auth/auth.ts, lib/security/audit.ts, lib/admin/owner-access.ts).
import crypto from "node:crypto";
import { db, now } from "../db.js";
import { hashPassword, verifyPassword, dummyVerify, sha256, randomToken } from "./password.js";
import { decryptSecret, verifyTOTPCode, hashRecoveryCode } from "./totp.js";
import { RateLimiter, clientIp } from "./ratelimit.js";

// Préfixe __Host- (Secure, Path=/, pas de Domain) en HTTPS, comme renta-immo ; nom simple en local HTTP.
const HTTPS = (process.env.SITE_URL || "").startsWith("https");
export const COOKIE = HTTPS ? "__Host-sereina_admin" : "sereina_admin";
const SESSION_DAYS = 7;
const MAX_FAILED = 5;
const BASE_LOCK_MIN = 15;              // 15 → 30 → 60 → 120 min (plafond 2 h), comme renta-immo
export const ROLES = { owner: 3, admin: 2, astreinte: 1 };

const q = {
  byEmail: db.prepare("SELECT * FROM admins WHERE email = ?"),
  byId: db.prepare("SELECT * FROM admins WHERE id = ?"),
  count: db.prepare("SELECT COUNT(*) AS n FROM admins"),
  insert: db.prepare("INSERT INTO admins (id, email, name, password_hash, role, must_change_password, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  fail: db.prepare("UPDATE admins SET failed_attempts = ?, lockout_count = ?, locked_until = ? WHERE id = ?"),
  success: db.prepare("UPDATE admins SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?"),
  setPassword: db.prepare("UPDATE admins SET password_hash = ?, password_changed_at = ?, must_change_password = 0 WHERE id = ?"),
  newSession: db.prepare("INSERT INTO admin_sessions (token_hash, admin_id, csrf, created_at, expires_at, last_seen, ip, user_agent, pending_2fa) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  session: db.prepare("SELECT s.*, a.role, a.email, a.name, a.active, a.must_change_password, a.totp_enabled, a.password_changed_at FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?"),
  touch: db.prepare("UPDATE admin_sessions SET last_seen = ? WHERE token_hash = ?"),
  clear2fa: db.prepare("UPDATE admin_sessions SET pending_2fa = 0 WHERE token_hash = ?"),
  dropSession: db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?"),
  dropAll: db.prepare("DELETE FROM admin_sessions WHERE admin_id = ?"),
  dropExpired: db.prepare("DELETE FROM admin_sessions WHERE expires_at < ?"),
  sessions: db.prepare("SELECT token_hash, created_at, last_seen, ip, user_agent FROM admin_sessions WHERE admin_id = ? ORDER BY last_seen DESC"),
  audit: db.prepare("INSERT INTO audit_log (admin_id, action, target, metadata, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
  useRecovery: db.prepare("UPDATE admins SET recovery_codes = ? WHERE id = ?"),
};

/** Journal d'audit, jamais bloquant. */
export function audit(action, { adminId = null, target = null, metadata = null, ip = null } = {}) {
  try { q.audit.run(adminId, action, target, metadata ? JSON.stringify(metadata) : null, ip, now()); } catch (e) { console.error("audit", e.message); }
}

/** Premier démarrage : crée le compte propriétaire depuis ADMIN_EMAIL / ADMIN_PASSWORD s'il n'y a aucun admin. */
export function bootstrapOwner() {
  if (q.count.get().n > 0) return;
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase(), pass = process.env.ADMIN_PASSWORD;
  if (!email || !pass) { console.warn("Aucun administrateur : définissez ADMIN_EMAIL et ADMIN_PASSWORD pour créer le compte propriétaire."); return; }
  q.insert.run(crypto.randomUUID(), email, "Propriétaire", hashPassword(pass), "owner", 1, now(), now());
  audit("admin_bootstrap", { target: email });
  console.log(`Compte propriétaire créé : ${email} (changement de mot de passe demandé à la première connexion)`);
}

export function createAdmin({ email, name, password, role }, byId, ip) {
  const id = crypto.randomUUID();
  q.insert.run(id, email, name || null, hashPassword(password), ROLES[role] ? role : "astreinte", 1, now(), now());
  audit("admin_created", { adminId: byId, target: email, metadata: { role }, ip });
  return id;
}

const loginLimiter = new RateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });

/** Tentative de connexion. Retourne {ok, admin} ou {ok:false, reason}. */
export function login(email, password, req) {
  const ip = clientIp(req);
  const e = String(email || "").trim().toLowerCase();
  if (!loginLimiter.hit(`${ip}:${e}`).success) { audit("login_blocked", { target: e, ip, metadata: { reason: "rate_limited" } }); return { ok: false, reason: "Trop de tentatives. Réessayez dans quelques minutes." }; }
  const a = q.byEmail.get(e);
  if (!a || !a.active) { dummyVerify(String(password || "")); audit("login_failed", { target: e, ip, metadata: { reason: a ? "inactive" : "unknown" } }); return { ok: false, reason: "Identifiants incorrects." }; }
  if (a.locked_until && a.locked_until > now()) { audit("login_blocked", { adminId: a.id, ip, metadata: { reason: "locked", until: a.locked_until } }); return { ok: false, reason: "Compte temporairement verrouillé. Réessayez plus tard." }; }
  if (!verifyPassword(String(password || ""), a.password_hash)) {
    const lockJustExpired = a.locked_until && a.locked_until <= now();
    const failed = lockJustExpired ? 1 : (a.failed_attempts || 0) + 1;
    let lockoutCount = a.lockout_count || 0, until = null;
    if (failed >= MAX_FAILED) { lockoutCount += 1; const min = Math.min(BASE_LOCK_MIN * 2 ** (lockoutCount - 1), 120); until = new Date(Date.now() + min * 60000).toISOString(); }
    q.fail.run(failed >= MAX_FAILED ? 0 : failed, lockoutCount, until, a.id);
    audit(until ? "account_locked" : "login_failed", { adminId: a.id, ip, metadata: { failed, until } });
    return { ok: false, reason: "Identifiants incorrects." };
  }
  q.success.run(now(), a.id);
  return { ok: true, admin: a };
}

/** Ouvre une session (cookie) ; pending2fa = true tant que le code TOTP n'a pas été fourni. */
export function openSession(res, admin, req, pending2fa) {
  const token = randomToken(32), csrf = randomToken(16);
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  q.newSession.run(sha256(token), admin.id, csrf, now(), exp, now(), clientIp(req), String(req.headers["user-agent"] || "").slice(0, 200), pending2fa ? 1 : 0);
  res.cookie(COOKIE, token, { httpOnly: true, secure: HTTPS, sameSite: "strict", path: "/", maxAge: SESSION_DAYS * 864e5 });
  audit(pending2fa ? "login_2fa_pending" : "login", { adminId: admin.id, ip: clientIp(req) });
}

export function readSession(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  const s = q.session.get(sha256(token));
  if (!s || !s.active || s.expires_at < now()) return null;
  // Invalidation si le mot de passe a changé après l'ouverture de la session (repris de renta-immo)
  if (s.password_changed_at && s.password_changed_at > s.created_at) { q.dropSession.run(s.token_hash); return null; }
  q.touch.run(now(), s.token_hash);
  return s;
}

export function complete2fa(session) { q.clear2fa.run(session.token_hash); }

export function logout(req, res) {
  const token = req.cookies?.[COOKIE];
  if (token) { const s = q.session.get(sha256(token)); q.dropSession.run(sha256(token)); if (s) audit("logout", { adminId: s.admin_id, ip: clientIp(req) }); }
  res.clearCookie(COOKIE, { path: "/" });
}

export function changePassword(adminId, newPassword, req) {
  q.setPassword.run(hashPassword(newPassword), now(), adminId);
  q.dropAll.run(adminId); // toutes les sessions tombent, y compris celle-ci : on se reconnecte
  audit("password_changed", { adminId, ip: clientIp(req) });
}

export function verify2fa(admin, code) {
  const a = q.byId.get(admin.admin_id || admin.id);
  if (!a?.totp_enabled || !a.totp_secret_enc) return false;
  if (verifyTOTPCode(decryptSecret(a.totp_secret_enc), code)) return true;
  // Code de récupération ?
  const codes = JSON.parse(a.recovery_codes || "[]");
  const h = hashRecoveryCode(String(code || ""), a.id);
  const idx = codes.indexOf(h);
  if (idx === -1) return false;
  codes.splice(idx, 1); q.useRecovery.run(JSON.stringify(codes), a.id);
  audit("2fa_recovery_used", { adminId: a.id, metadata: { remaining: codes.length } });
  return true;
}

export const adminById = id => q.byId.get(id);
export const listSessions = id => q.sessions.all(id);
export const revokeSessions = id => q.dropAll.run(id);
export const purgeSessions = () => q.dropExpired.run(now());
export const hasRole = (session, role) => (ROLES[session?.role] || 0) >= (ROLES[role] || 99);
