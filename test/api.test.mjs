// Tests d'API minimaux, exécutés contre le serveur Node (TEST_TARGET=node, défaut) ou contre le Worker Cloudflare
// en local (TEST_TARGET=worker, via `wrangler dev`), ou contre une URL déjà en ligne (BASE_URL=…, lecture seule
// sauf consentement/chat d'un visiteur anonyme de test).
// Prérequis : dist/ construit (python3 build.py), dépendances de server/ (et de worker/ pour TEST_TARGET=worker).
// Aucun e-mail n'est envoyé (pas de SMTP/Resend configuré) et l'IA est simulée (MOCK_AI=1).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = process.env.BASE_URL ? "remote" : process.env.TEST_TARGET || "node";
const PORT = 18000 + Math.floor(Math.random() * 1000);
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@test.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "Test-Password-123456!";
let BASE = process.env.BASE_URL?.replace(/\/$/, "") || `http://127.0.0.1:${PORT}`;
let child, tmp;

before(async () => {
  if (TARGET === "remote") return;
  fs.mkdirSync(path.join(ROOT, "worker", ".wrangler"), { recursive: true });
  tmp = fs.mkdtempSync(path.join(TARGET === "worker" ? path.join(ROOT, "worker", ".wrangler") : os.tmpdir(), "test-state-"));
  const secrets = {
    APP_SECRET: "a".repeat(64), COOKIE_SECRET: "c".repeat(64), TOTP_ENCRYPTION_KEY: "b".repeat(64),
    ADMIN_EMAIL, ADMIN_PASSWORD, SITE_URL: BASE, MOCK_AI: "1",
  };
  if (TARGET === "node") {
    child = spawn(process.execPath, ["server.js"], { cwd: path.join(ROOT, "server"), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...secrets, PORT: String(PORT), DB_PATH: path.join(tmp, "test.db"), DIST_DIR: path.join(ROOT, "dist"), GUIDES_DIR: path.join(ROOT, "private", "guides") } });
  } else {
    const vars = Object.entries(secrets).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
    child = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", tmp, "--show-interactive-dev-session=false", ...vars],
      { cwd: path.join(ROOT, "worker"), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" }, detached: true });
  }
  let log = "";
  child.stdout.on("data", d => { log += d; }); child.stderr.on("data", d => { log += d; });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Le serveur (${TARGET}) n'a pas démarré :\n${log.slice(-3000)}`);
});
after(() => {
  // wrangler lance des sous-processus : on arrête tout le groupe.
  if (child) { try { process.kill(TARGET === "worker" ? -child.pid : child.pid); } catch {} }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

/** Petit client avec cookies et Origin (le serveur exige un Origin sur les requêtes qui modifient l'état). */
function client() {
  const jar = new Map();
  return async (p, { method = "GET", json, form, headers = {}, origin = true } = {}) => {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (origin && method !== "GET") h.origin = BASE;
    let body;
    if (json) { h["content-type"] = "application/json"; body = JSON.stringify(json); }
    if (form) { h["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form).toString(); }
    const r = await fetch(BASE + p, { method, headers: h, body, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return r;
  };
}

test("pages statiques, en-têtes de sécurité et 404", async () => {
  for (const p of ["/", "/parler/", "/guides/", "/conseils/", "/mentions-legales/"]) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /Sereina/, p);
  }
  const home = await fetch(BASE + "/");
  assert.match(home.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.equal(home.headers.get("x-frame-options"), "DENY");
  const sw = await fetch(BASE + "/sw.js");
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get("cache-control") || "", /no-cache/);
  for (const p of ["/page-qui-n-existe-pas", "/api/n-existe-pas"]) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 404, p);
    assert.match(await r.text(), /introuvable/i, p);
  }
});

test("santé", async () => {
  const r = await fetch(BASE + "/api/health");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal((await fetch(BASE + "/api/health?details=1")).status, 401);
});

test("consentement puis chat (IA simulée, flux SSE)", async () => {
  const c = client();
  const me = await (await c("/api/me")).json();
  assert.equal(me.consent, false);
  assert.equal(me.paywalled, false);
  // Sans Origin : refus CSRF
  assert.equal((await c("/api/consent", { method: "POST", json: {}, origin: false })).status, 403);
  // Chat avant consentement : refusé
  const r0 = await c("/api/chat", { method: "POST", json: { guide: "clara", message: "Bonjour" } });
  assert.equal(r0.status, 403);
  assert.equal((await r0.json()).code, "consent_required");
  assert.deepEqual(await (await c("/api/consent", { method: "POST", json: {} })).json(), { ok: true });
  const r = await c("/api/chat", { method: "POST", json: { guide: "clara", message: "Bonjour, je dors mal en ce moment." } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/event-stream/);
  const events = (await r.text()).split("\n\n").filter(Boolean).map(b => JSON.parse(b.replace(/^data: /, "")));
  assert.ok(events.some(e => e.delta), "au moins un fragment de réponse");
  const done = events.find(e => e.done);
  assert.ok(done, "événement de fin");
  assert.equal(done.free, true);
  const me2 = await (await c("/api/me")).json();
  assert.equal(me2.consent, true);
  assert.equal(me2.free_started, true);
});

test("liens de guide invalides refusés", async () => {
  const r = await fetch(BASE + "/api/guides/sommeil.pdf?id=1&s=" + "0".repeat(32));
  assert.equal(r.status, 404);
});

test("back-office : connexion du propriétaire", { skip: TARGET === "remote" && !process.env.TEST_ADMIN_PASSWORD && "identifiants non fournis" }, async () => {
  const c = client();
  const r0 = await c("/admin/");
  assert.equal(r0.status, 302);
  assert.match(r0.headers.get("location"), /\/admin\/login/);
  assert.equal((await c("/admin/login")).status, 200);
  const bad = await c("/admin/login", { method: "POST", form: { email: ADMIN_EMAIL, password: "mauvais-Mot-de-passe-1" } });
  assert.match(bad.headers.get("location"), /login\?e=/);
  const ok = await c("/admin/login", { method: "POST", form: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.equal(ok.status, 302);
  assert.doesNotMatch(ok.headers.get("location"), /login/);
  // Premier accès : changement de mot de passe demandé.
  let loc = ok.headers.get("location"), page;
  for (let i = 0; i < 3; i++) { page = await c(loc.replace(/^https?:\/\/[^/]+/, "")); if (page.status !== 302) break; loc = page.headers.get("location"); }
  assert.equal(page.status, 200);
  assert.match(await page.text(), /mot de passe/i);
});
