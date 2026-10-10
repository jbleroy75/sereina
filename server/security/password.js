// Repris de renta-immo (lib/auth/password.ts) : PBKDF2-SHA512, 310 000 itérations, sel 32 octets, format "sel:hash".
import crypto from "node:crypto";

const ITERATIONS = 310_000, KEY_LENGTH = 64, DIGEST = "sha512", SALT_LENGTH = 32;
const DUMMY_SALT = "0".repeat(SALT_LENGTH * 2);

export function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString("hex");
  return `${salt}:${hash}`;
}

/** Calcul factice pour égaliser le temps de réponse quand le compte n'existe pas (anti-énumération). */
export function dummyVerify(password) {
  crypto.pbkdf2Sync(password, DUMMY_SALT, ITERATIONS, KEY_LENGTH, DIGEST);
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString("hex");
  if (candidate.length !== hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}

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
