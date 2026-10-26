// Sereina sur Cloudflare Workers.
//
// - Les pages statiques (dist/, générées par build.py) sont servies directement par Workers Static Assets.
// - /api/*, /admin* passent par ce Worker, qui les confie à UN Durable Object (« main ») : il exécute
//   l'application Express d'origine (server/app.js) avec sa base SQLite (stockage du Durable Object,
//   synchrone, via l'adaptateur server/platform/do-sqlite.js). C'est l'équivalent du process Node unique.
// - Les setInterval du serveur Node deviennent l'alarme du Durable Object (tâches horaires, 6 h, file d'e-mails).
import { DurableObject } from "cloudflare:workers";
import { handleAsNodeRequest } from "cloudflare:node";
import { bindStorage } from "../server/platform/do-sqlite.js";

const PORT = 3000;
const HOUR = 3600_000;
const DYNAMIC = p => p.startsWith("/api/") || p === "/admin" || p.startsWith("/admin/") || p.startsWith("/__sereina/");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!DYNAMIC(url.pathname)) return env.ASSETS.fetch(request);
    // Adresse du client : celle vue par Cloudflare, jamais celle annoncée par le client (anti-abus, limites de débit).
    const headers = new Headers(request.headers);
    headers.set("x-real-ip", request.headers.get("cf-connecting-ip") || "");
    headers.delete("x-forwarded-for");
    return env.SEREINA.getByName("main").fetch(new Request(request, { headers }));
  },
};

export class Sereina extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      bindStorage(ctx.storage);
      this.mod = await import("../server/app.js");
      const { app } = this.mod;
      // Chemins dynamiques inconnus : même page 404 que le site statique.
      app.use(async (req, res) => {
        const r = await env.ASSETS.fetch(new Request(new URL("/404.html", this.mod.SITE_URL)));
        res.status(404).type("html").send(await r.text());
      });
      this.server = app.listen(PORT);
      if (!(await ctx.storage.getAlarm())) {
        // Premier démarrage : premier contrôle horaire 5 minutes après, comme sous Node.
        await ctx.storage.put({ nextHourly: Date.now() + 5 * 60_000, nextSix: Date.now() + 6 * HOUR });
        await this.schedule();
      }
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === "/__sereina/import") return this.importData(request);
    const res = await handleAsNodeRequest(PORT, request);
    // Un e-mail mis en file (ou à réessayer) doit réveiller l'alarme à temps.
    this.ctx.waitUntil(this.schedule().catch(e => console.error("schedule", e.message)));
    return res;
  }

  /** Programme la prochaine alarme : tâche horaire, tâche des 6 h ou prochain e-mail en attente. */
  async schedule() {
    const { nextHourly = Date.now() + HOUR, nextSix = Date.now() + 6 * HOUR } = Object.fromEntries(await this.ctx.storage.get(["nextHourly", "nextSix"]));
    const mail = this.mod.nextDueAt();
    const candidates = [nextHourly, nextSix];
    if (mail) candidates.push(Math.max(Date.parse(mail), Date.now() + 1000));
    const at = Math.min(...candidates);
    const cur = await this.ctx.storage.getAlarm();
    if (!cur || cur > at) await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    await this.ready;
    const t = Date.now();
    const { nextHourly = 0, nextSix = 0 } = Object.fromEntries(await this.ctx.storage.get(["nextHourly", "nextSix"]));
    if (t >= nextHourly) { await this.mod.hourlyTasks(); await this.ctx.storage.put("nextHourly", t + HOUR); }
    if (t >= nextSix) { this.mod.sixHourlyTasks(); await this.ctx.storage.put("nextSix", t + 6 * HOUR); }
    try { await this.mod.processQueue(); } catch (e) { console.error("mailqueue", e.message); }
    await this.schedule();
  }

  /**
   * Import (ou ré-import au moment de la bascule) des données de la base SQLite Node.
   * Protégé par le secret IMPORT_TOKEN ; sans lui, la route n'existe pas. Corps JSON produit par worker/export-sqlite.mjs :
   * { tables: { nom: { columns: [...], rows: [[...], ...] } } }. Les tables listées sont vidées puis remplies.
   */
  async importData(request) {
    const token = this.env.IMPORT_TOKEN;
    if (!token || request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${token}`) return new Response("Not found", { status: 404 });
    const { tables } = await request.json();
    const sql = this.ctx.storage.sql;
    const known = new Set(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(r => r.name));
    const counts = {};
    this.ctx.storage.transactionSync(() => {
      sql.exec("PRAGMA defer_foreign_keys = ON");
      for (const name of Object.keys(tables)) if (known.has(name)) sql.exec(`DELETE FROM "${name}"`);
      for (const [name, { columns, rows }] of Object.entries(tables)) {
        if (!known.has(name)) { counts[name] = "table inconnue, ignorée"; continue; }
        const cols = new Set(sql.exec(`PRAGMA table_info("${name}")`).toArray().map(r => r.name));
        const keep = columns.map((c, i) => [c, i]).filter(([c]) => cols.has(c));
        const ins = `INSERT INTO "${name}" (${keep.map(([c]) => `"${c}"`).join(", ")}) VALUES (${keep.map(() => "?").join(", ")})`;
        for (const row of rows) sql.exec(ins, ...keep.map(([, i]) => row[i]));
        counts[name] = rows.length;
      }
    });
    return Response.json({ ok: true, imported: counts });
  }
}
