// PBKDF2-HMAC-SHA512 en JavaScript pur, pour vérifier sous Cloudflare Workers les mots de passe hachés sous Node
// avec 310 000 itérations : la plateforme refuse PBKDF2 au-delà de 100 000 itérations. Utilisé seulement en
// repli (environ une seconde de calcul), puis le mot de passe est re-haché au format natif de la plateforme.
// Les états HMAC internes/externes sont précalculés : 2 compressions SHA-512 par itération.

const K = [
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538,
  0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118, 0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe,
  0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235,
  0xc19bf174, 0xcf692694, 0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5, 0x983e5152, 0xee66dfab,
  0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4, 0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725,
  0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70, 0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed,
  0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218,
  0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8, 0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53,
  0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373,
  0x682e6ff3, 0xd6b2b8a3, 0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b, 0xca273ece, 0xea26619c,
  0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6,
  0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b, 0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc,
  0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
];
const IV = [0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179];

const W = new Int32Array(160);
// Note : W et les états sont réutilisés sans allocation dans la boucle (≈ 620 000 compressions pour 310 000 itérations).
/** Compresse un bloc de 32 mots (hi, lo) dans l'état H (16 mots). */
function compress(H, M) {
  for (let i = 0; i < 32; i++) W[i] = M[i];
  for (let i = 32; i < 160; i += 2) {
    // σ0(W[i-15]) et σ1(W[i-2]) sur des paires 32 bits
    let xh = W[i - 30], xl = W[i - 29];
    const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
    const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
    xh = W[i - 4]; xl = W[i - 3];
    const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
    const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
    let l = (s0l >>> 0) + (s1l >>> 0) + (W[i - 13] >>> 0) + (W[i - 31] >>> 0);
    let h = s0h + s1h + W[i - 14] + W[i - 32] + ((l / 0x100000000) | 0);
    W[i] = h | 0; W[i + 1] = l | 0;
  }
  let ah = H[0], al = H[1], bh = H[2], bl = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7];
  let eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
  for (let i = 0; i < 160; i += 2) {
    const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
    const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
    const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
    let l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K[i + 1] >>> 0) + (W[i + 1] >>> 0);
    const t1h = (hh + S1h + chh + K[i] + W[i] + ((l / 0x100000000) | 0)) | 0, t1l = l | 0;
    const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
    const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
    const mh = (ah & bh) ^ (ah & ch) ^ (bh & ch), ml = (al & bl) ^ (al & cl) ^ (bl & cl);
    l = (S0l >>> 0) + (ml >>> 0);
    const t2h = (S0h + mh + ((l / 0x100000000) | 0)) | 0, t2l = l | 0;
    hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
    l = (dl >>> 0) + (t1l >>> 0); eh = (dh + t1h + ((l / 0x100000000) | 0)) | 0; el = l | 0;
    dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
    l = (t1l >>> 0) + (t2l >>> 0); ah = (t1h + t2h + ((l / 0x100000000) | 0)) | 0; al = l | 0;
  }
  const add = (j, xh, xl) => { const l = (H[j + 1] >>> 0) + (xl >>> 0); H[j] = (H[j] + xh + ((l / 0x100000000) | 0)) | 0; H[j + 1] = l | 0; };
  add(0, ah, al); add(2, bh, bl); add(4, ch, cl); add(6, dh, dl); add(8, eh, el); add(10, fh, fl); add(12, gh, gl); add(14, hh, hl);
}

const toWords = bytes => { const w = new Int32Array(bytes.length / 4); for (let i = 0; i < w.length; i++) w[i] = (bytes[4 * i] << 24) | (bytes[4 * i + 1] << 16) | (bytes[4 * i + 2] << 8) | bytes[4 * i + 3]; return w; };

/** SHA-512 complet d'un message (pour les clés et le premier bloc). */
function sha512(bytes, initial = IV, prefixLen = 0) {
  const H = Int32Array.from(initial);
  const len = bytes.length, total = prefixLen + len;
  const padded = new Uint8Array(Math.ceil((len + 17) / 128) * 128);
  padded.set(bytes); padded[len] = 0x80;
  const bits = total * 8, view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bits >>> 0); view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  const w = toWords(padded);
  for (let i = 0; i < w.length; i += 32) compress(H, w.subarray(i, i + 32));
  return H;
}

const enc = s => typeof s === "string" ? new TextEncoder().encode(s) : new Uint8Array(s);

/** PBKDF2-HMAC-SHA512(password, salt, iterations, keyLength) → Uint8Array. */
export function pbkdf2Sha512(password, salt, iterations, keyLength) {
  let key = enc(password);
  if (key.length > 128) key = wordsToBytes(sha512(key));
  const k = new Uint8Array(128); k.set(key);
  const ipad = k.map(b => b ^ 0x36), opad = k.map(b => b ^ 0x5c);
  const Hi = Int32Array.from(IV), Ho = Int32Array.from(IV);
  compress(Hi, toWords(ipad)); compress(Ho, toWords(opad));
  // Bloc de 64 octets (U précédent) + bourrage pour un message de 128 + 64 octets.
  const block = new Int32Array(32); block[16] = 0x80000000 | 0; block[31] = (128 + 64) * 8;
  const out = new Uint8Array(keyLength), s = enc(salt);
  for (let n = 1, pos = 0; pos < keyLength; n++, pos += 64) {
    const first = new Uint8Array(s.length + 4); first.set(s); new DataView(first.buffer).setUint32(s.length, n);
    const inner = sha512(first, Hi, 128);
    block.set(inner.subarray(0, 16));
    const U = Int32Array.from(Ho), A = new Int32Array(16); compress(U, block);
    const T = Int32Array.from(U);
    for (let i = 1; i < iterations; i++) {
      block.set(U); A.set(Hi); compress(A, block);
      block.set(A); U.set(Ho); compress(U, block);
      for (let j = 0; j < 16; j++) T[j] ^= U[j];
    }
    out.set(wordsToBytes(T).subarray(0, Math.min(64, keyLength - pos)), pos);
  }
  return out;
}

function wordsToBytes(w) { const b = new Uint8Array(w.length * 4); const v = new DataView(b.buffer); for (let i = 0; i < w.length; i++) v.setInt32(4 * i, w[i]); return b.subarray(0, 64); }
