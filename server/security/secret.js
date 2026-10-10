// Secret applicatif stable : APP_SECRET (ou COOKIE_SECRET) si défini, sinon un secret aléatoire
// créé une fois et conservé dans le dossier de données. Sans cela, un redémarrage changerait les
// empreintes d'e-mail, les liens de désinscription et les liens de téléchargement déjà envoyés.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function loadSecret() {
  const env = process.env.APP_SECRET || process.env.COOKIE_SECRET;
  if (env && env.length >= 16) return env;
  const dir = path.dirname(process.env.DB_PATH || path.join(process.cwd(), "data", "sereina.db"));
  const file = path.join(dir, ".secret");
  try { return fs.readFileSync(file, "utf8").trim(); } catch {}
  fs.mkdirSync(dir, { recursive: true });
  const s = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, s, { mode: 0o600 });
  console.warn(`[secret] APP_SECRET absent : secret généré et conservé dans ${file}`);
  return s;
}

export const SECRET = loadSecret();

/** HMAC-SHA256 dérivé par usage (« email », « unsub », « guide »…), en hexadécimal. */
export const hmac = (purpose, value) => crypto.createHmac("sha256", `${SECRET}:${purpose}`).update(String(value)).digest("hex");

/** Jeton signé court pour les liens (désinscription, téléchargement). */
export const sign = (purpose, value) => hmac(purpose, value).slice(0, 32);
export const checkSig = (purpose, value, sig) => {
  const expected = sign(purpose, value);
  return typeof sig === "string" && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
};
