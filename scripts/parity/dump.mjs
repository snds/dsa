#!/usr/bin/env node
// Dump a dsa data folder as sorted, normalized JSON: every store table plus every JSON file the run
// wrote. Run ids become R-1, R-2… (by time), timestamps become "<ts>", JSON columns are parsed and
// their keys sorted, and rows are sorted, so two runs that found the same things dump the same bytes.
//
//   node scripts/parity/dump.mjs --data <dir> --out <file.json> [--rename <map.json>]
//
// --rename: a JSON object { "from": "to", … } applied to every string, for a system's own names.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TS_COLS = new Set(["taken_at", "opened_at", "updated_at", "resolved_at", "snooze_until", "ts", "set_at"]);
const JSON_COLS = new Set(["settings", "sources", "detail", "affected", "settings_used", "data", "old_value", "new_value"]);

export async function dump(dataDir, rename = {}) {
  const { openDuckStore } = await import(pathToFileURL(path.join(here, "..", "..", "packages", "history", "dist", "index.js")).href);
  const { STORE_TABLES } = await import(pathToFileURL(path.join(here, "..", "..", "dist", "index.js")).href);
  const out = { tables: {}, files: {} };
  const store = await openDuckStore(dataDir);
  try {
    const runs = await store.all("select run_id from runs order by taken_at, run_id");
    const runIds = new Map(runs.map((r, i) => [r.run_id, `R-${i + 1}`]));
    const fix = renamer(rename, runIds);
    for (const t of STORE_TABLES) {
      const rows = await store.all(`select * from ${t}`);
      const norm = rows.map((r) => {
        const o = {};
        for (const [k, v] of Object.entries(r)) {
          let x = v;
          if (TS_COLS.has(k) && x != null) x = "<ts>";
          else if (JSON_COLS.has(k) && typeof x === "string") { try { x = JSON.parse(x); } catch { /* keep */ } }
          o[k] = fix(x);
        }
        return sortKeys(o);
      });
      out.tables[t] = norm.map((r) => JSON.stringify(r)).sort().map((s) => JSON.parse(s));
    }
  } finally {
    store.close();
  }
  const fix = renamer(rename, new Map());
  for (const f of walk(dataDir)) {
    const rel = path.relative(dataDir, f).split(path.sep).join("/");
    if (!rel.endsWith(".json") || rel.startsWith("remotes/")) continue;
    try { out.files[rel] = sortKeys(fix(JSON.parse(fs.readFileSync(f, "utf8")))); } catch { out.files[rel] = "<unreadable>"; }
  }
  return out;
}

/** Replace run ids and the rename map's names in every string, deeply. */
function renamer(rename, runIds) {
  const pairs = Object.entries(rename).sort((a, b) => b[0].length - a[0].length);
  const str = (s) => {
    let x = s;
    for (const [from, to] of runIds) x = x.split(from).join(to);
    for (const [from, to] of pairs) x = x.split(from).join(to);
    return x;
  };
  const deep = (v) => (typeof v === "string" ? str(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [str(k), deep(x)])) : v);
  return deep;
}

export function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

function walk(dir) {
  const out = [];
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out.sort();
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const data = arg("data");
  const outFile = arg("out");
  if (!data || !outFile) {
    console.error("usage: dump.mjs --data <dir> --out <file.json> [--rename <map.json>]");
    process.exit(2);
  }
  const rename = arg("rename") ? JSON.parse(fs.readFileSync(arg("rename"), "utf8")) : {};
  fs.writeFileSync(outFile, JSON.stringify(await dump(path.resolve(data), rename), null, 1) + "\n");
}
