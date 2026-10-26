// Prépare le déploiement Cloudflare (lancé par `npm run build` dans worker/, après build.py et build_guides.py) :
//  1. server/platform/embedded.gen.js : prompts des accompagnants, domaines jetables, index et PDF des guides,
//     embarqués dans le bundle (un Worker n'a pas de système de fichiers) ;
//  2. dist/_headers : en-têtes de sécurité et de cache des pages statiques (servies par Workers Static Assets,
//     sans passer par Express).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server");
const GUIDES = process.env.GUIDES_DIR || path.join(ROOT, "private", "guides");
const DIST = path.join(ROOT, "dist");
if (!fs.existsSync(path.join(DIST, "index.html"))) throw new Error("dist/ absent : lancer d'abord python3 build.py --site-url …");

const prompts = Object.fromEntries(fs.readdirSync(path.join(SERVER, "prompts")).filter(f => f.endsWith(".md")).sort()
  .map(f => [f.slice(0, -3), fs.readFileSync(path.join(SERVER, "prompts", f), "utf8")]));
const disposable = JSON.parse(fs.readFileSync(path.join(SERVER, "security", "disposable-domains.json"), "utf8"));
const pdfs = fs.existsSync(GUIDES) ? fs.readdirSync(GUIDES).filter(f => f.endsWith(".pdf")).sort() : [];
if (!pdfs.length) console.warn("[gen-embedded] aucun guide PDF (lancer build_guides.py --out private/guides)");
const index = fs.existsSync(path.join(GUIDES, "guides.json")) ? JSON.parse(fs.readFileSync(path.join(GUIDES, "guides.json"), "utf8")) : [];

const rel = f => path.relative(path.join(SERVER, "platform"), path.join(GUIDES, f)).split(path.sep).join("/");
const out = [
  "// Fichier généré par worker/gen-embedded.mjs : ne pas modifier, ne pas versionner.",
  ...pdfs.map((f, i) => `import pdf${i} from ${JSON.stringify(rel(f))};`),
  `export const PROMPTS = ${JSON.stringify(prompts)};`,
  `export const DISPOSABLE = ${JSON.stringify(disposable)};`,
  `export const GUIDES_INDEX = ${JSON.stringify(index)};`,
  `export const GUIDE_PDFS = { ${pdfs.map((f, i) => `${JSON.stringify(f.slice(0, -4))}: pdf${i}`).join(", ")} };`,
  "",
].join("\n");
fs.writeFileSync(path.join(SERVER, "platform", "embedded.gen.js"), out);

// Mêmes en-têtes que securityHeaders() d'Express (server/security/headers.js) et mêmes règles de cache que server.js.
const csp = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com", "base-uri 'self'", "object-src 'none'",
  "upgrade-insecure-requests"].join("; ");
fs.writeFileSync(path.join(DIST, "_headers"), `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=(), browsing-topics=()
  X-Permitted-Cross-Domain-Policies: none
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  Content-Security-Policy: ${csp}
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  Cache-Control: public, max-age=3600

/sw.js
  ! Cache-Control
  Cache-Control: no-cache
  Service-Worker-Allowed: /

/manifest.webmanifest
  ! Cache-Control
  Cache-Control: no-cache
  Content-Type: application/manifest+json; charset=utf-8
`);
console.log(`[gen-embedded] ${Object.keys(prompts).length} prompts, ${disposable.length} domaines jetables, ${pdfs.length} guides PDF, dist/_headers écrit`);
