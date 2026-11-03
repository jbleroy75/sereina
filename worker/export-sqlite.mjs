// Exporte une COPIE de la base SQLite Node (sereina.db) au format attendu par /__sereina/import.
// Usage : node worker/export-sqlite.mjs chemin/vers/copie/sereina.db > export.json
// (lecture seule ; nécessite better-sqlite3, installé dans server/).
import { createRequire } from "node:module";
const require = createRequire(new URL("../server/package.json", import.meta.url));
const Database = require("better-sqlite3");

const file = process.argv[2];
if (!file) { console.error("Usage : node worker/export-sqlite.mjs <copie de sereina.db>"); process.exit(1); }
const db = new Database(file, { readonly: true, fileMustExist: true });
const tables = {};
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
  const stmt = db.prepare(`SELECT * FROM "${name}"`).raw(true);
  tables[name] = { columns: stmt.columns().map(c => c.name), rows: stmt.all() };
}
process.stdout.write(JSON.stringify({ tables }));
