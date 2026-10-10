// Anti-abus de l'essai gratuit (logique reprise de renta-immo : anti-abuse, trial-identity, fingerprint-limiter).
// Un essai gratuit est réservé, au moment où il démarre, sous plusieurs clés hachées :
//   - l'empreinte du navigateur (calculée côté client) : un même appareil n'a qu'un essai, même cookies effacés ;
//   - l'e-mail canonique, si la personne s'est identifiée : un essai par adresse ;
//   - l'adresse IP : au plus TRIAL_PER_IP essais distincts sur 30 jours (souple, pour les familles et réseaux partagés).
// Seules des empreintes HMAC sont stockées, jamais l'IP ni l'e-mail en clair.
import { db, now } from "./db.js";
import { hmac } from "./security/secret.js";
import { canonicalEmail } from "./account.js";

const TRIAL_PER_IP = Number(process.env.TRIAL_PER_IP || 3);

db.exec(`CREATE TABLE IF NOT EXISTS trial_claims (
  key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, user_id)
);
CREATE INDEX IF NOT EXISTS idx_trial_claims_key ON trial_claims(key, created_at);`);

const qq = {
  others: db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM trial_claims WHERE key = ? AND user_id != ? AND created_at > ?"),
  claim: db.prepare("INSERT OR IGNORE INTO trial_claims (key, user_id, created_at) VALUES (?, ?, ?)"),
  deny: db.prepare("UPDATE users SET trial_denied = 1 WHERE id = ?"),
  setFp: db.prepare("UPDATE users SET fp_hash = COALESCE(?, fp_hash) WHERE id = ?"),
  purge: db.prepare("DELETE FROM trial_claims WHERE created_at < ?"),
};

/** Empreinte du navigateur envoyée par le client (en-tête X-Client-Fp), hachée côté serveur. */
export function fpKey(req) {
  const raw = String(req.headers["x-client-fp"] || "").slice(0, 128);
  return /^[a-f0-9]{32,128}$/.test(raw) ? hmac("fp", raw) : null;
}

/**
 * À appeler juste avant le premier message gratuit. Retourne {allowed, reason}.
 * Si l'essai est refusé, l'utilisateur est marqué trial_denied (il passe directement aux crédits).
 */
export function claimTrial(user, req, ip) {
  const since180 = new Date(Date.now() - 180 * 864e5).toISOString(), since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const fp = fpKey(req);
  if (fp) qq.setFp.run(fp, user.id);
  const keys = [];
  if (fp) keys.push(["fp:" + fp, since180, 1, "appareil"]);
  if (user.email) keys.push(["email:" + hmac("email-trial", canonicalEmail(user.email)), since180, 1, "e-mail"]);
  if (ip) keys.push(["ip:" + hmac("ip", ip), since30, TRIAL_PER_IP, "réseau"]);
  for (const [key, since, max, label] of keys) {
    if (qq.others.get(key, user.id, since).n >= max) {
      qq.deny.run(user.id);
      db.prepare("INSERT INTO events (user_id, type, detail, created_at) VALUES (?, 'trial_denied', ?, ?)").run(user.id, label, now());
      return { allowed: false, reason: label };
    }
  }
  for (const [key] of keys) qq.claim.run(key, user.id, now());
  return { allowed: true };
}

/** Quand une personne s'identifie, son e-mail est rattaché à l'essai déjà commencé. */
export function claimEmailForTrial(user) {
  if (!user?.email || !user.free_started_at) return;
  const key = "email:" + hmac("email-trial", canonicalEmail(user.email));
  const since = new Date(Date.now() - 180 * 864e5).toISOString();
  if (qq.others.get(key, user.id, since).n >= 1 && !user.credits) qq.deny.run(user.id);
  qq.claim.run(key, user.id, now());
}

export function purgeClaims() { try { qq.purge.run(new Date(Date.now() - 365 * 864e5).toISOString()); } catch {} }
