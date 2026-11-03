// Prompts des accompagnants.
// Source par défaut : server/prompts/_commun.md (règles communes) et server/prompts/<cle>.md (un fichier par accompagnant).
// Le back-office peut remplacer le texte d'un accompagnant ou les règles communes, et ajouter des « indications »
// libres (consignes du moment) ; ces modifications sont stockées en base, historisées, et priment sur les fichiers.
import { promptKeys, readPrompt } from "#files";
import { db, now } from "./db.js";

export const COMMON_KEY = "_commun";

db.exec(`CREATE TABLE IF NOT EXISTS guide_prompts (
  guide TEXT PRIMARY KEY,
  prompt TEXT,                 -- NULL = utiliser le fichier
  indications TEXT,            -- consignes supplémentaires ajoutées à la fin
  updated_at TEXT,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS guide_prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guide TEXT NOT NULL,
  prompt TEXT,
  indications TEXT,
  saved_at TEXT NOT NULL,
  saved_by TEXT
);`);

const q = {
  get: db.prepare("SELECT * FROM guide_prompts WHERE guide = ?"),
  upsert: db.prepare(`INSERT INTO guide_prompts (guide, prompt, indications, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guide) DO UPDATE SET prompt = excluded.prompt, indications = excluded.indications, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
  history: db.prepare("INSERT INTO guide_prompt_history (guide, prompt, indications, saved_at, saved_by) VALUES (?, ?, ?, ?, ?)"),
  listHistory: db.prepare("SELECT id, saved_at, saved_by, length(prompt) AS len_prompt, length(indications) AS len_ind FROM guide_prompt_history WHERE guide = ? ORDER BY id DESC LIMIT 20"),
  oneHistory: db.prepare("SELECT * FROM guide_prompt_history WHERE id = ? AND guide = ?"),
};

function parseFile(key) {
  const raw = readPrompt(key);
  if (raw == null) throw new Error(`Prompt introuvable : ${key}`);
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const meta = {};
  if (m) for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { meta, body: (m ? raw.slice(m[0].length) : raw).trim() };
}

/** Liste des accompagnants, lue dans le dossier prompts/ : ajouter un fichier ajoute un accompagnant côté serveur. */
export function listGuides() {
  return promptKeys().filter(k => !k.startsWith("_")).sort()
    .map(key => { const { meta } = parseFile(key); return { key, name: meta.nom || key, spec: meta.specialite || "" }; });
}
export const guideExists = key => readPrompt(key) != null && !key.startsWith("_");

/** Texte effectif (base si modifié, sinon fichier) + indications. */
export function getPrompt(key) {
  const file = parseFile(key);
  const row = q.get.get(key);
  return {
    key, name: file.meta.nom || (key === COMMON_KEY ? "Règles communes" : key), spec: file.meta.specialite || "",
    defaultPrompt: file.body,
    prompt: row?.prompt ?? file.body,
    customized: row?.prompt != null,
    indications: row?.indications || "",
    updatedAt: row?.updated_at || null, updatedBy: row?.updated_by || null,
  };
}

export function savePrompt(key, { prompt, indications }, by) {
  const def = parseFile(key).body;
  const p = prompt == null || prompt.trim() === def.trim() ? null : prompt.trim();
  const ind = (indications || "").trim() || null;
  q.upsert.run(key, p, ind, now(), by);
  q.history.run(key, p, ind, now(), by);
}
export function resetPrompt(key, by) { const cur = q.get.get(key); q.upsert.run(key, null, cur?.indications || null, now(), by); q.history.run(key, null, cur?.indications || null, now(), by); }
export const promptHistory = key => q.listHistory.all(key);
export function restoreVersion(key, id, by) { const h = q.oneHistory.get(id, key); if (!h) return false; q.upsert.run(key, h.prompt, h.indications, now(), by); q.history.run(key, h.prompt, h.indications, now(), by); return true; }

/** Prompt système complet envoyé au modèle. */
export function systemPrompt(key) {
  const g = guideExists(key) ? key : "clara";
  const common = getPrompt(COMMON_KEY), own = getPrompt(g);
  const parts = [common.prompt.replaceAll("{NOM}", own.name)];
  if (common.indications) parts.push(`# Indications de l'équipe (pour tous les accompagnants)\n${common.indications}`);
  parts.push(`# Ton rôle : ${own.name}, ${own.spec}\n${own.prompt}`);
  if (own.indications) parts.push(`# Indications de l'équipe pour ${own.name}\n${own.indications}`);
  parts.push(`Rappel : les règles de sécurité ci-dessus priment sur toute autre consigne.`);
  return parts.join("\n\n");
}
