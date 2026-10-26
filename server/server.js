// Point d'entrée Node (Docker / Coolify) : site statique, écoute HTTP, tâches périodiques, arrêt propre.
// Les routes sont dans app.js, partagé avec le Worker Cloudflare (worker/index.js).
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { app, runtime, hourlyTasks, sixHourlyTasks, processQueue, SITE_URL } from "./app.js";
import { db } from "./db.js";

const PORT = Number(process.env.PORT || 3000);
const DIST = process.env.DIST_DIR || path.join(process.cwd(), "..", "dist");

// ---------- Site statique ----------
app.use(express.static(DIST, { extensions: ["html"], maxAge: "1h", setHeaders(res, file) {
  // Le service worker et le manifeste doivent toujours être relus, pour que les mises à jour arrivent vite.
  if (file.endsWith(`${path.sep}sw.js`)) { res.setHeader("Cache-Control", "no-cache"); res.setHeader("Service-Worker-Allowed", "/"); }
  if (file.endsWith(".webmanifest")) { res.setHeader("Content-Type", "application/manifest+json; charset=utf-8"); res.setHeader("Cache-Control", "no-cache"); }
} }));
app.use((req, res) => {
  const p = path.join(DIST, "404.html");
  res.status(404).sendFile(fs.existsSync(p) ? p : path.join(DIST, "index.html"), { dotfiles: "allow" }); // chemin fixe : un dossier parent caché (ex. .wt) ne doit pas provoquer de 404 brute
});

// Tâches horaires : contrôle des paiements, relances, nettoyage ; file d'e-mails chaque minute.
setInterval(hourlyTasks, 3600 * 1000);
setTimeout(hourlyTasks, 5 * 60 * 1000);
setInterval(sixHourlyTasks, 6 * 3600 * 1000);
setInterval(() => processQueue().catch(e => console.error("mailqueue", e.message)), 60_000);

const server = app.listen(PORT, () => console.log(`Sereina sur ${SITE_URL} (port ${PORT}) ${process.env.MOCK_AI === "1" ? "[MOCK_AI]" : ""}`));
server.keepAliveTimeout = 65_000;

// ---------- Arrêt propre (repris de renta-immo lib/infra/shutdown.ts) ----------
// SIGTERM : /api/health passe à 503 (le proxy retire l'instance), on refuse les nouveaux chats,
// on laisse finir les réponses en flux (DRAIN max SHUTDOWN_DRAIN_MS, défaut 15 s), puis on ferme la base.
const DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS || 15_000);
async function shutdown(signal) {
  if (runtime.shuttingDown) return;
  runtime.shuttingDown = true;
  console.log(`[shutdown] ${signal} reçu, ${runtime.inflight} conversation(s) en cours, drain ${DRAIN_MS} ms`);
  const t0 = Date.now();
  while (runtime.inflight > 0 && Date.now() - t0 < DRAIN_MS) await new Promise(r => setTimeout(r, 200));
  server.close();
  try { db.close(); } catch {}
  console.log(`[shutdown] terminé (${runtime.inflight} interrompue(s))`);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
