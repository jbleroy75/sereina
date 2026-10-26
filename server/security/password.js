// Repris de renta-immo (lib/auth/password.ts) : PBKDF2-SHA512, 310 000 itérations, sel 32 octets, format "sel:hash".
import crypto from "node:crypto";
import { pbkdf2Sha512 } from "./pbkdf2-js.js";

const KEY_LENGTH = 64, DIGEST = "sha512", SALT_LENGTH = 32;
// Cloudflare Workers refuse PBKDF2 au-delà de 100 000 itérations ; Node garde 310 000 (format historique « sel:hash »).
const WORKERS = globalThis.navigator?.userAgent === "Cloudflare-Workers";
const LEGACY_ITERATIONS = 310_000;
const ITERATIONS = WORKERS ? 100_000 : LEGACY_ITERATIONS;
const DUMMY_SALT = "0".repeat(SALT_LENGTH * 2);

/** Formats : « sel:hash » (310 000 itérations, historique) ou « pbkdf2$<itérations>$sel$hash ». */
function parse(stored) {
  const s = String(stored || "");
  if (s.startsWith("pbkdf2$")) { const [, it, salt, hash] = s.split("$"); return { iterations: Number(it), salt, hash }; }
  const [salt, hash] = s.split(":");
  return { iterations: LEGACY_ITERATIONS, salt, hash };
}

function derive(password, salt, iterations) {
  try { return crypto.pbkdf2Sync(password, salt, iterations, KEY_LENGTH, DIGEST).toString("hex"); }
  catch (e) {
    // Hash créé sous Node (310 000 itérations) vérifié sous Workers : calcul en JavaScript (≈ 1 s), puis re-hachage.
    if (iterations > 100_000) return Buffer.from(pbkdf2Sha512(password, salt, iterations, KEY_LENGTH)).toString("hex");
    throw e;
  }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH).toString("hex");
  const hash = derive(password, salt, ITERATIONS);
  return ITERATIONS === LEGACY_ITERATIONS ? `${salt}:${hash}` : `pbkdf2$${ITERATIONS}$${salt}$${hash}`;
}

/** Calcul factice pour égaliser le temps de réponse quand le compte n'existe pas (anti-énumération). */
export function dummyVerify(password) {
  derive(password, DUMMY_SALT, ITERATIONS);
}

export function verifyPassword(password, stored) {
  const { iterations, salt, hash } = parse(stored);
  if (!salt || !hash || !(iterations > 0)) return false;
  const candidate = derive(password, salt, iterations);
  if (candidate.length !== hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}

/** Vrai si le hash n'utilise pas le nombre d'itérations de la plateforme (à refaire après une connexion réussie). */
export const needsRehash = stored => parse(stored).iterations !== ITERATIONS;

/** Complexité : 12 caractères minimum, une majuscule, une minuscule, un chiffre. */
export function passwordProblem(p) {
  if (typeof p !== "string" || p.length < 12) return "12 caractères minimum.";
  if (!/[A-Z]/.test(p) || !/[a-z]/.test(p) || !/\d/.test(p)) return "Il faut au moins une majuscule, une minuscule et un chiffre.";
  return null;
}

/** Comparaison à temps constant de deux chaînes (secrets, jetons). */
export function timingSafeCompare(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  const max = Math.max(A.length, B.length);
  const pa = Buffer.alloc(max), pb = Buffer.alloc(max);
  A.copy(pa); B.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && A.length === B.length;
}

export const sha256 = s => crypto.createHash("sha256").update(String(s)).digest("hex");
export const randomToken = (n = 32) => crypto.randomBytes(n).toString("hex");
