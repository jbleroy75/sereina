// Repris de renta-immo (lib/auth/totp.ts) : TOTP RFC 6238 (SHA-1, 6 chiffres, 30 s, fenêtre ±1),
// secret chiffré AES-256-GCM avec TOTP_ENCRYPTION_KEY, codes de récupération hachés HMAC avec sel par compte.
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm", IV_LENGTH = 12;
const RECOVERY_CODE_COUNT = 8, RECOVERY_CODE_LENGTH = 8;

export class TOTPConfigError extends Error {}

function key() {
  const k = process.env.TOTP_ENCRYPTION_KEY;
  if (!k || !/^[0-9a-f]{64}$/i.test(k)) throw new TOTPConfigError("TOTP_ENCRYPTION_KEY manquante ou invalide : 64 caractères hexadécimaux (openssl rand -hex 32)");
  return Buffer.from(k, "hex");
}
export const totpConfigured = () => /^[0-9a-f]{64}$/i.test(process.env.TOTP_ENCRYPTION_KEY || "");

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const c = crypto.createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${iv.toString("hex")}:${enc.toString("hex")}:${c.getAuthTag().toString("hex")}`;
}
export function decryptSecret(s) {
  const [ivH, encH, tagH] = String(s).split(":");
  if (!ivH || !encH || !tagH) throw new Error("Secret chiffré invalide");
  const d = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivH, "hex"));
  d.setAuthTag(Buffer.from(tagH, "hex"));
  return Buffer.concat([d.update(Buffer.from(encH, "hex")), d.final()]).toString("utf8");
}

// Base32 (RFC 4648)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

export const generateTOTPSecret = () => base32Encode(crypto.randomBytes(20));

export function totpUri(secret, label, issuer = "Sereina") {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

/** Vérifie un code à 6 chiffres, période courante ±1. */
export function verifyTOTPCode(secret, code) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  const buf = base32Decode(secret), now = Math.floor(Date.now() / 1000 / 30);
  for (const d of [-1, 0, 1]) {
    const expected = hotp(buf, now + d);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true;
  }
  return false;
}

export const hashRecoveryCode = (code, salt) => crypto.createHmac("sha256", salt).update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");

export function generateRecoveryCodes(salt) {
  const plain = [], hashed = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = crypto.randomBytes(RECOVERY_CODE_LENGTH).toString("hex").toUpperCase().slice(0, 16).replace(/(.{4})/g, "$1-").slice(0, -1);
    plain.push(code); hashed.push(hashRecoveryCode(code, salt));
  }
  return { plain, hashed };
}
