#!/usr/bin/env node
// Dump a dsa data folder as sorted, normalized JSON: every store table plus every JSON file the run
// wrote. Run ids become R-1, R-2… (by time), timestamps become "<ts>", JSON columns are parsed and
// their keys sorted, and rows are sorted, so two runs that found the same things dump the same bytes.
//
//   node scripts/parity/dump.mjs --data <dir> --out <file.json> [--rename <map.json>]
//
// --rename: a JSON object { "from": "to", … } applied to every string, for a system's own names.
//
// Besides the store and the JSON files, it reads what the CLI writes after runs (Phase 3): the report
// and the published site (the page's embedded data, its HTML with the UI's script and stylesheet set
// aside, the images it ships), the issue drafts, the review queue, and the screenshot and Storybook
// manifests (ids, files, routes; never pixels or measured styles). Timestamps become "<ts>" there too.
// `suite: true` maps the few names dsa changed on purpose (suiteKeys, SUITE_WORDING) on the suite's side;
// `system` is the profile's name, which the suite used in those field names.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TS_COLS = new Set(["taken_at", "opened_at", "updated_at", "resolved_at", "snooze_until", "ts", "set_at"]);
const JSON_COLS = new Set(["settings", "sources", "detail", "affected", "settings_used", "data", "old_value", "new_value"]);

/**
 * Field names dsa renamed: the suite named a few fields after the system it was built for (`<name>Shot`,
 * `<name>Preview`, `<name>Commit`, and `<name>` in a rendered diff). `system` is that name: the profile's.
 */
export const suiteKeys = (system) => (system ? { [`${system}Shot`]: "systemShot", [`${system}Preview`]: "systemPreview", [`${system}Commit`]: "systemCommit", [system]: "system" } : {});
/** Wording dsa changed in what it writes, suite text -> dsa text. */
export const SUITE_WORDING = [
  ["re-run the scan (`./bin/dsa.js run --no-shots` from the analytics suite folder)", "re-run the scan (`dsa run --no-shots`)"],
  ["Raised by ds-analytics-suite on", "Raised by dsa on"],
];
/** Fields only dsa writes: the profile's label in the report data. */
export const DSA_ONLY = ["label"];

export async function dump(dataDir, rename = {}, opts = {}) {
  const { openDuckStore } = await import(pathToFileURL(path.join(here, "..", "..", "packages", "history", "dist", "index.js")).href);
  const { STORE_TABLES } = await import(pathToFileURL(path.join(here, "..", "..", "dist", "index.js")).href);
  const out = { tables: {}, files: {} };
  const store = await openDuckStore(dataDir);
  try {
    const runs = await store.all("select run_id from runs order by taken_at, run_id");
    const runIds = new Map(runs.map((r, i) => [r.run_id, `R-${i + 1}`]));
    out.runIds = runIds;
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
    if (!rel.endsWith(".json") || /^(remotes|shots|rendered|site|report)\//.test(rel)) continue;
    try { out.files[rel] = sortKeys(stamps(fix(JSON.parse(fs.readFileSync(f, "utf8"))))); } catch { out.files[rel] = "<unreadable>"; }
  }
  out.extras = extras(dataDir, renamer(rename, out.runIds), Boolean(opts.suite), suiteKeys(opts.system));
  delete out.runIds;
  return out;
}

/** Timestamps in a JSON file (queue.json keeps when it first saw each item) become "<ts>". */
const stamps = (v) => (typeof v === "string" ? (ISO.test(v) ? "<ts>" : v) : Array.isArray(v) ? v.map(stamps) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stamps(x)])) : v);

const ISO = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)?$/;

/** The report, site, drafts, queue and manifests, normalized. */
function extras(dataDir, fix, suite, SUITE_KEYS) {
  const word = (s) => (suite ? SUITE_WORDING.reduce((x, [a, b]) => x.split(a).join(b), s) : s);
  const norm = (v) => {
    if (typeof v === "string") return ISO.test(v) ? "<ts>" : word(fix(v));
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k0, x] of Object.entries(v)) { const k = fix(k0); o[suite && SUITE_KEYS[k] ? SUITE_KEYS[k] : k] = norm(x); }
      return sortKeys(o);
    }
    return v;
  };
  // The page's data: dsa-only fields dropped, and components with equal counts put in name order
  // (the suite's query leaves ties in any order, so even one side alone differs run to run).
  const data = (d) => {
    if (!d || typeof d !== "object") return norm(d);
    const o = { ...d };
    if (!suite) for (const k of DSA_ONLY) delete o[k];
    if (Array.isArray(o.components)) o.components = [...o.components].sort((a, b) => (Number(b.instances) - Number(a.instances)) || String(a.component).localeCompare(String(b.component)));
    return norm(o);
  };
  const page = (file) => {
    if (!fs.existsSync(file)) return null;
    const html = fs.readFileSync(file, "utf8");
    const m = html.match(/<script id="dsa-data" type="application\/json">([\s\S]*?)<\/script>/);
    let parsed = null;
    try { parsed = m ? JSON.parse(m[1]) : null; } catch { parsed = "<unreadable>"; }
    // The UI's script and stylesheet are rebuilt per side; compare the page around them.
    const shell = html.replace(/<style>[\s\S]*?<\/style>/, "<style>[ui css]</style>").replace(/<script id="dsa-data"[\s\S]*?<\/script>/, "<script id=\"dsa-data\">[data]</script>").replace(/<script>[\s\S]*?<\/script>/, "<script>[ui js]</script>");
    return { data: data(parsed), shell: word(fix(shell)) };
  };
  const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
  const json = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const report = page(path.join(dataDir, "report", "index.html"));
  const site = page(path.join(dataDir, "site", "index.html"));
  const shots = json(path.join(dataDir, "shots", "index.json"));
  const rendered = json(path.join(dataDir, "rendered", "index.json"));
  return {
    report,
    site: site && { ...site, images: { shots: list(path.join(dataDir, "site", "shots")), rendered: list(path.join(dataDir, "site", "rendered")) } },
    queue: report?.data?.queue ?? null,
    issues: Object.fromEntries(list(path.join(dataDir, "issues")).filter((f) => f.endsWith(".md")).map((f) => [f, word(fix(fs.readFileSync(path.join(dataDir, "issues", f), "utf8")))])),
    // Ids, files and routes only: what was captured where, never how it measured.
    shots: shots && norm({
      shots: Object.fromEntries(Object.entries(shots.shots ?? {}).map(([id, x]) => [id, typeof x === "object" && x ? { file: x.file, page: String(x.page ?? "").replace(/^https?:\/\/[^/]+/, ""), revealedBy: x.revealedBy ?? null } : x])),
      missing: [...(shots.missing ?? [])].sort(),
    }),
    rendered: rendered && norm({
      source: rendered.source,
      components: Object.fromEntries(Object.entries(rendered.components ?? {}).map(([c, keys]) => [c, Object.fromEntries(Object.entries(keys).map(([k, x]) => [k, { story: x.story ?? null, shot: x.shot ?? null }]))])),
    }),
  };
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
