// Repris de renta-immo (lib/infra/rate-limit.ts) : fenêtre glissante en mémoire, éviction LRU, nettoyage périodique.
export class RateLimiter {
  constructor({ limit, windowMs, maxEntries = 10_000, cleanupIntervalMs = 60_000 }) {
    Object.assign(this, { limit, windowMs, maxEntries, cleanupIntervalMs });
    this.store = new Map(); this.lastCleanup = Date.now();
  }
  cleanup() {
    const now = Date.now();
    if (now - this.lastCleanup < this.cleanupIntervalMs) return;
    this.lastCleanup = now;
    for (const [k, ts] of this.store) { const live = ts.filter(t => t > now - this.windowMs); if (live.length) this.store.set(k, live); else this.store.delete(k); }
  }
  /** Enregistre une requête. Retourne {success, remaining, reset}. */
  hit(key) {
    this.cleanup();
    const now = Date.now(), start = now - this.windowMs;
    const ts = (this.store.get(key) || []).filter(t => t > start);
    ts.push(now);
    this.store.delete(key); this.store.set(key, ts);
    while (this.store.size > this.maxEntries) this.store.delete(this.store.keys().next().value);
    return { success: ts.length <= this.limit, remaining: Math.max(0, this.limit - ts.length), reset: ts[0] + this.windowMs };
  }
  peek(key) { const start = Date.now() - this.windowMs; return (this.store.get(key) || []).filter(t => t > start).length; }
  reset(key) { this.store.delete(key); }
}

/** Middleware Express : refuse avec 429 au-delà de la limite. keyFn(req) => chaîne. */
export function rateLimit(limiter, keyFn = req => req.ip, message = "Trop de requêtes. Réessayez dans un instant.") {
  return (req, res, next) => {
    const r = limiter.hit(String(keyFn(req)));
    res.setHeader("RateLimit-Remaining", r.remaining);
    if (!r.success) { res.setHeader("Retry-After", Math.ceil((r.reset - Date.now()) / 1000)); return res.status(429).json({ error: message }); }
    next();
  };
}

/** Repris : derrière un reverse proxy de confiance, l'IP vient de x-real-ip puis du dernier x-forwarded-for. */
export function clientIp(req) {
  const real = req.headers["x-real-ip"];
  if (real) return String(real).trim();
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",").pop().trim();
  return req.socket?.remoteAddress || req.ip || "";
}
