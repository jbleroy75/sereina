// Fichiers lus par le serveur, sous Cloudflare Workers : pas de système de fichiers, tout est embarqué
// dans le bundle par worker/gen-embedded.mjs (prompts, liste des domaines jetables, guides PDF privés).
import { PROMPTS, DISPOSABLE, GUIDES_INDEX, GUIDE_PDFS } from "./embedded.gen.js";

export const dbFile = () => null; // la base est celle du Durable Object
/** Pas de disque persistant : APP_SECRET (secret Wrangler) est obligatoire. */
export function storedSecret() { throw new Error("APP_SECRET (ou COOKIE_SECRET) doit être défini : wrangler secret put APP_SECRET"); }
export const promptKeys = () => Object.keys(PROMPTS);
export const readPrompt = key => Object.hasOwn(PROMPTS, key) ? PROMPTS[key] : null;
export const disposableDomains = () => DISPOSABLE;
export const guidesIndex = () => GUIDES_INDEX;
export const guidePdfExists = slug => Object.hasOwn(GUIDE_PDFS, slug);
export const guidePdf = slug => Object.hasOwn(GUIDE_PDFS, slug) ? Buffer.from(GUIDE_PDFS[slug]) : null;
