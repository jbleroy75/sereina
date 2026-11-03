// Fichiers lus par le serveur, sous Node : prompts/*.md, security/disposable-domains.json, guides PDF (GUIDES_DIR).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPTS = path.join(ROOT, "prompts");
const GUIDES_DIR = () => process.env.GUIDES_DIR || path.join(process.cwd(), "..", "private", "guides");

/** Fichier SQLite (le dossier est créé au besoin). */
export const dbFile = () => { const f = process.env.DB_PATH || path.join(process.cwd(), "data", "sereina.db"); fs.mkdirSync(path.dirname(f), { recursive: true }); return f; };
/** Secret conservé dans le dossier de données quand APP_SECRET n'est pas défini (créé au premier démarrage). */
export function storedSecret(generate) {
  const dir = path.dirname(process.env.DB_PATH || path.join(process.cwd(), "data", "sereina.db"));
  const file = path.join(dir, ".secret");
  try { return fs.readFileSync(file, "utf8").trim(); } catch {}
  fs.mkdirSync(dir, { recursive: true });
  const s = generate();
  fs.writeFileSync(file, s, { mode: 0o600 });
  console.warn(`[secret] APP_SECRET absent : secret généré et conservé dans ${file}`);
  return s;
}
export const promptKeys = () => fs.readdirSync(PROMPTS).filter(f => f.endsWith(".md")).map(f => f.slice(0, -3));
export const readPrompt = key => { try { return fs.readFileSync(path.join(PROMPTS, `${key}.md`), "utf8"); } catch { return null; } };
export const disposableDomains = () => JSON.parse(fs.readFileSync(path.join(ROOT, "security", "disposable-domains.json"), "utf8"));
export const guidesIndex = () => { try { return JSON.parse(fs.readFileSync(path.join(GUIDES_DIR(), "guides.json"), "utf8")); } catch { return []; } };
export const guidePdfExists = slug => fs.existsSync(path.join(GUIDES_DIR(), `${slug}.pdf`));
export const guidePdf = slug => { try { return fs.readFileSync(path.join(GUIDES_DIR(), `${slug}.pdf`)); } catch { return null; } };
