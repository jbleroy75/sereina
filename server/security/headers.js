// Repris de renta-immo (middleware.ts) : en-têtes de sécurité, CSRF par contrôle d'Origin, limite de taille.
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_EXEMPT = new Set(["/api/stripe/webhook", "/api/unsubscribe"]); // ce dernier est protégé par signature (désinscription « un clic » des messageries)

export function securityHeaders({ https }) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    "base-uri 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=(), browsing-topics=()");
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", csp);
    if (https) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    res.removeHeader("X-Powered-By");
    next();
  };
}

/** CSRF : toute requête qui modifie l'état doit porter un Origin dont l'hôte correspond à l'hôte servi. */
export function csrfOrigin({ allowedHosts }) {
  return (req, res, next) => {
    if (SAFE.has(req.method) || CSRF_EXEMPT.has(req.path)) return next();
    const origin = req.headers.origin;
    const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().split(":")[0];
    if (!origin) return res.status(403).json({ error: "Origine manquante" });
    try {
      const h = new URL(origin).hostname;
      if (h === host || allowedHosts.has(h)) return next();
    } catch {}
    res.status(403).json({ error: "Origine refusée" });
  };
}

/** Repris : sanitisation minimale des champs texte (null bytes, balises). */
export const stripHtml = s => String(s ?? "").replace(/\0/g, "").replace(/<[^>]*>/g, "").trim();
export const sanitizeEmail = s => { const e = String(s ?? "").trim().toLowerCase().slice(0, 254); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null; };
