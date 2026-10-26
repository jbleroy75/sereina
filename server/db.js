// `#sqlite` : better-sqlite3 sous Node, stockage SQLite du Durable Object sous Cloudflare (platform/do-sqlite.js).
import Database from "#sqlite";
import { dbFile } from "#files";

export const db = new Database(dbFile());
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  first_name TEXT,
  phone TEXT,
  email TEXT,
  city TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'none',   -- none | active | past_due | canceled
  free_started_at TEXT,
  free_messages INTEGER DEFAULT 0,
  risk_level INTEGER DEFAULT 0,              -- 0 vert, 1 jaune, 2 orange, 3 rouge
  risk_reason TEXT,
  risk_updated_at TEXT,
  handled_at TEXT,
  handled_by TEXT,
  notes TEXT,
  ip TEXT,
  user_agent TEXT,
  consent_at TEXT,
  credits INTEGER DEFAULT 0,
  auto_recharge INTEGER DEFAULT 0,
  auto_pack TEXT,
  stripe_payment_method TEXT
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  pack TEXT NOT NULL,
  credits INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- checkout | auto
  stripe_ref TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  guide TEXT NOT NULL,
  role TEXT NOT NULL,                        -- user | assistant
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  risk_level INTEGER,
  risk_reason TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  message_id INTEGER,
  level INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  notified_at TEXT,
  handled_at TEXT,
  handled_by TEXT,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(handled_at, level);
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',        -- owner | admin | astreinte
  active INTEGER DEFAULT 1,
  must_change_password INTEGER DEFAULT 1,
  failed_attempts INTEGER DEFAULT 0,
  lockout_count INTEGER DEFAULT 0,
  locked_until TEXT,
  password_changed_at TEXT,
  totp_enabled INTEGER DEFAULT 0,
  totp_secret_enc TEXT,
  totp_pending_enc TEXT,
  recovery_codes TEXT,                       -- JSON des codes hachés restants
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen TEXT,
  ip TEXT,
  user_agent TEXT,
  pending_2fa INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  metadata TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
`);

// Migration douce pour les bases créées avant l'ajout de consent_at
for (const col of ["consent_at TEXT", "credits INTEGER DEFAULT 0", "auto_recharge INTEGER DEFAULT 0", "auto_pack TEXT", "stripe_payment_method TEXT",
  "email_verified_at TEXT", "email_hash TEXT", "marketing_optin INTEGER DEFAULT 0", "marketing_optin_at TEXT",
  "trial_denied INTEGER DEFAULT 0", "fp_hash TEXT"]) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch {}
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash) WHERE email_hash IS NOT NULL");

export const now = () => new Date().toISOString();

export const q = {
  getUser: db.prepare("SELECT * FROM users WHERE id = ?"),
  insertUser: db.prepare("INSERT INTO users (id, created_at, last_seen, ip, user_agent) VALUES (?, ?, ?, ?, ?)"),
  touchUser: db.prepare("UPDATE users SET last_seen = ? WHERE id = ?"),
  startFree: db.prepare("UPDATE users SET free_started_at = COALESCE(free_started_at, ?), free_messages = free_messages + 1 WHERE id = ?"),
  setContact: db.prepare("UPDATE users SET first_name = COALESCE(?, first_name), phone = COALESCE(?, phone), email = COALESCE(?, email), city = COALESCE(?, city) WHERE id = ?"),
  setRisk: db.prepare("UPDATE users SET risk_level = ?, risk_reason = ?, risk_updated_at = ?, handled_at = CASE WHEN ? > risk_level THEN NULL ELSE handled_at END WHERE id = ?"),
  setStripe: db.prepare("UPDATE users SET stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id), subscription_status = ? WHERE id = ?"),
  addCredits: db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?"),
  useCredit: db.prepare("UPDATE users SET credits = credits - 1 WHERE id = ? AND credits > 0"),
  setAuto: db.prepare("UPDATE users SET auto_recharge = ?, auto_pack = COALESCE(?, auto_pack) WHERE id = ?"),
  setPaymentMethod: db.prepare("UPDATE users SET stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_payment_method = COALESCE(?, stripe_payment_method) WHERE id = ?"),
  insertPurchase: db.prepare("INSERT OR IGNORE INTO purchases (user_id, pack, credits, amount_cents, kind, stripe_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  purchases: db.prepare("SELECT * FROM purchases WHERE user_id = ? ORDER BY id DESC LIMIT 50"),
  userByCustomer: db.prepare("SELECT * FROM users WHERE stripe_customer_id = ?"),
  userBySubscription: db.prepare("SELECT * FROM users WHERE stripe_subscription_id = ?"),
  insertMessage: db.prepare("INSERT INTO messages (user_id, guide, role, content, created_at, risk_level, risk_reason) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  history: db.prepare("SELECT role, content FROM messages WHERE user_id = ? AND guide = ? ORDER BY id DESC LIMIT ?"),
  allMessages: db.prepare("SELECT * FROM messages WHERE user_id = ? ORDER BY id ASC"),
  insertAlert: db.prepare("INSERT INTO alerts (user_id, message_id, level, reason, created_at) VALUES (?, ?, ?, ?, ?)"),
  markNotified: db.prepare("UPDATE alerts SET notified_at = ? WHERE id = ?"),
  openAlerts: db.prepare("SELECT a.*, u.first_name, u.phone FROM alerts a JOIN users u ON u.id = a.user_id WHERE a.handled_at IS NULL ORDER BY a.level DESC, a.created_at DESC"),
  handleAlerts: db.prepare("UPDATE alerts SET handled_at = ?, handled_by = ?, outcome = ? WHERE user_id = ? AND handled_at IS NULL"),
  handleUser: db.prepare("UPDATE users SET handled_at = ?, handled_by = ?, notes = COALESCE(?, notes) WHERE id = ?"),
  listUsers: db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.role='user') AS nb_messages,
      (SELECT content FROM messages m WHERE m.user_id = u.id AND m.role='user' ORDER BY id DESC LIMIT 1) AS last_message
      FROM users u ORDER BY (CASE WHEN handled_at IS NULL THEN risk_level ELSE -1 END) DESC, risk_updated_at DESC, last_seen DESC LIMIT ?`),
  stats: db.prepare(`SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(DISTINCT user_id) FROM purchases) AS buyers,
      (SELECT COALESCE(SUM(amount_cents),0) FROM purchases WHERE created_at > datetime('now','-30 day')) AS revenue_30d,
      (SELECT COUNT(*) FROM users WHERE auto_recharge=1) AS auto_recharge,
      (SELECT COUNT(*) FROM users WHERE risk_level=3 AND handled_at IS NULL) AS rouge,
      (SELECT COUNT(*) FROM users WHERE risk_level=2 AND handled_at IS NULL) AS orange,
      (SELECT COUNT(*) FROM users WHERE last_seen > datetime('now','-1 day')) AS actifs_24h,
      (SELECT COUNT(*) FROM messages WHERE role='user' AND created_at > datetime('now','-1 day')) AS messages_24h`),
  logEvent: db.prepare("INSERT INTO events (user_id, type, detail, created_at) VALUES (?, ?, ?, ?)"),
  purgeOld: db.prepare("DELETE FROM messages WHERE created_at < datetime('now', ?)"),
};
