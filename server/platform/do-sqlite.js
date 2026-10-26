// Adaptateur « better-sqlite3 » au-dessus du stockage SQLite d'un Durable Object Cloudflare
// (ctx.storage.sql, synchrone). Sous Cloudflare, `#sqlite` pointe ici (voir package.json « imports ») ;
// sous Node, il pointe vers better-sqlite3. Seule la partie de l'API utilisée par le serveur est couverte :
// prepare().get/all/run, exec, pragma, transaction, close.
//
// Le Durable Object doit appeler bindStorage(ctx.storage) AVANT d'importer app.js : les modules créent
// leurs tables et préparent leurs requêtes au chargement.

let storage = null;
export function bindStorage(s) { storage = s; }
const sql = () => {
  if (!storage) throw new Error("Stockage SQLite non lié : bindStorage(ctx.storage) doit précéder l'import de l'application");
  return storage.sql;
};

// better-sqlite3 refuse undefined et les booléens ; le stockage DO accepte null, nombres, chaînes, ArrayBuffer.
const norm = args => args.map(v => v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) ? new Uint8Array(v).buffer : v);
// Paramètres positionnels uniquement (le code n'utilise pas les paramètres nommés).
const flat = args => norm(args.length === 1 && Array.isArray(args[0]) ? args[0] : args);

class Statement {
  constructor(source) { this.source = source; }
  get(...args) { for (const row of sql().exec(this.source, ...flat(args))) return { ...row }; return undefined; }
  all(...args) { return sql().exec(this.source, ...flat(args)).toArray().map(r => ({ ...r })); }
  run(...args) {
    const s = sql();
    const cur = s.exec(this.source, ...flat(args));
    for (const _ of cur) { /* consommer le curseur : l'écriture n'est effective qu'une fois parcouru */ }
    const changes = cur.rowsWritten;
    const id = /^\s*(INSERT|REPLACE)/i.test(this.source) && changes > 0 ? s.exec("SELECT last_insert_rowid() AS id").one().id : 0;
    return { changes, lastInsertRowid: id };
  }
}

export default class Database {
  constructor() { this.open = true; }
  prepare(source) { return new Statement(source); }
  exec(source) {
    // Le stockage DO accepte plusieurs instructions dans un même appel.
    for (const _ of sql().exec(source)) { /* consommer */ }
    return this;
  }
  pragma() { return []; } // journal WAL, etc. : gérés par la plateforme
  transaction(fn) {
    return (...args) => storage.transactionSync(() => fn(...args));
  }
  close() { this.open = false; }
}
