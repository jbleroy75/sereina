// Suivi des coûts IA (repris de renta-immo : ai-cost-tracking).
// Chaque appel au modèle enregistre ses jetons réels (entrée, sortie, cache) et son coût en dollars.
// Tarifs en $ par million de jetons [entrée, sortie], vérifiés le 11/10/2026 sur
// https://platform.claude.com/docs/en/about-claude/pricing — surchargeables par AI_PRICES (JSON).
// Écriture en cache : 1,25 × l'entrée ; lecture en cache : selon le modèle (0,05 × pour Sonnet/Opus 5.5, 0,1 × sinon).
import { db, now } from "./db.js";

const DEFAULT_PRICES = {
  "claude-fable-5-1": [10, 50, 0.025],
  "claude-opus-5-5": [4, 20, 0.05],
  "claude-sonnet-5-5": [2, 10, 0.05],
  "claude-haiku-5-5": [0.10, 0.50, 0.1],      // ≤ 100 000 jetons de prompt (toujours le cas ici)
  "claude-sonnet-5": [2, 10, 0.1],
  "claude-opus-5": [5, 25, 0.1],
  "claude-sonnet-4-6": [3, 15, 0.1],
  "claude-sonnet-4-5": [3, 15, 0.1],
  "claude-haiku-4-5": [1, 5, 0.1],
  "claude-opus-4-5": [5, 25, 0.1],
};
let PRICES = DEFAULT_PRICES;
try { if (process.env.AI_PRICES) PRICES = { ...DEFAULT_PRICES, ...JSON.parse(process.env.AI_PRICES) }; } catch { console.warn("AI_PRICES invalide, tarifs par défaut utilisés"); }
export const USD_EUR = Number(process.env.USD_EUR || 0.86); // taux de conversion indicatif, à ajuster

db.exec(`CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  kind TEXT NOT NULL,              -- chat | risk | test
  guide TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  billable INTEGER DEFAULT 0,      -- 1 si le message a consommé un crédit payant
  mock INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id, created_at);`);

const ins = db.prepare(`INSERT INTO ai_usage (user_id, kind, guide, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_usd, billable, mock, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

export function priceFor(model) {
  if (PRICES[model]) return PRICES[model];
  const fam = Object.keys(PRICES).find(k => model.startsWith(k));
  if (fam) return PRICES[fam];
  if (/haiku/.test(model)) return PRICES["claude-haiku-5-5"];
  if (/opus/.test(model)) return PRICES["claude-opus-5-5"];
  return PRICES["claude-sonnet-5-5"];
}

export function costUsd(model, u) {
  const [pin, pout, readMult = 0.1] = priceFor(model);
  const input = u.input_tokens || 0, output = u.output_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
  return (input * pin + output * pout + cw * pin * 1.25 + cr * pin * readMult) / 1e6;
}

/** Enregistre un appel. `usage` = objet usage de l'API Anthropic. */
export function recordUsage({ userId = null, kind, guide = null, model, usage = {}, billable = false, mock = false }) {
  try {
    ins.run(userId, kind, guide, model, usage.input_tokens || 0, usage.output_tokens || 0,
      usage.cache_creation_input_tokens || 0, usage.cache_read_input_tokens || 0,
      costUsd(model, usage), billable ? 1 : 0, mock ? 1 : 0, now());
  } catch (e) { console.error("recordUsage", e.message); }
}

export function markBillable(userId, sinceIso) {
  try { db.prepare("UPDATE ai_usage SET billable = 1 WHERE user_id = ? AND created_at >= ?").run(userId, sinceIso); } catch {}
}

/** Estimation grossière des jetons pour le mode simulé (≈ 4 caractères par jeton). */
export const estimateTokens = s => Math.ceil(String(s || "").length / 4);
