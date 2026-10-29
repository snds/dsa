#!/usr/bin/env node
// Parity run: the earlier analytics suite and dsa, on the same repo, must store the same data.
//
//   node scripts/parity/run.mjs --old <suite dir> --new <dsa dir> --root <repo> --out <dir>
//        [--profile <file>] [--config <dsa.config.json>] [--rename <map.json>]
//        [--readiness] [--now <iso>]
//
// Each side runs twice into fresh data folders (git history, Figma and the npm registry off, fixed
// times). Each time is two runs into the same folder, a day apart, so the finding lifecycle (update,
// hold, resolve) is compared too. Each folder is dumped (dump.mjs), and every pair is compared: old vs old and new vs new
// (each side is deterministic), then old vs new. --rename maps names the old side wrote to the names
// the new side writes (a system's own names), applied to the old dumps only. Exit 1 on any difference.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dump } from "./dump.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

const oldDir = opt("old"), newDir = opt("new"), root = opt("root"), outDir = opt("out");
if (!oldDir || !newDir || !root || !outDir) {
  console.error("usage: run.mjs --old <suite dir> --new <dsa dir> --root <repo> --out <dir> [--profile f] [--config f] [--rename f] [--readiness] [--now iso]");
  process.exit(2);
}
const now = opt("now") ?? "2026-01-01T00:00:00.000Z";
const later = new Date(Date.parse(now) + 864e5).toISOString();
const readiness = flag("readiness");
const rename = opt("rename") ? JSON.parse(fs.readFileSync(path.resolve(opt("rename")), "utf8")) : {};
const abs = (p) => path.resolve(p);
fs.mkdirSync(abs(outDir), { recursive: true });

function runOld(data, now) {
  const tsx = path.join(abs(oldDir), "node_modules", ".bin", "tsx");
  const r = spawnSync(tsx, [path.join(here, "old-driver.ts"), abs(oldDir), abs(root), data, now, readiness ? "on" : "off"], { cwd: abs(oldDir), encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`old side failed:\n${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function runNew(data, now) {
  const cli = path.join(abs(newDir), "dist", "cli.js");
  const a = [cli, "run", "--root", abs(root), "--data", data, "--no-git", "--no-drafts", "--now", now];
  if (!readiness) a.push("--no-readiness");
  if (opt("profile")) a.push("--profile", abs(opt("profile")));
  if (opt("config")) a.push("--config", abs(opt("config")));
  const r = spawnSync(process.execPath, a, { cwd: abs(root), encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`new side failed:\n${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Compare two dumps; returns a list of differences, one per table or file. */
function compare(a, b) {
  const diffs = [];
  const tables = [...new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])].sort();
  for (const t of tables) {
    const x = (a.tables[t] ?? []).map((r) => JSON.stringify(r));
    const y = (b.tables[t] ?? []).map((r) => JSON.stringify(r));
    const onlyA = multisetMinus(x, y), onlyB = multisetMinus(y, x);
    if (onlyA.length || onlyB.length) diffs.push({ where: `table ${t}`, counts: [x.length, y.length], onlyA, onlyB });
  }
  const files = [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort();
  for (const f of files) {
    const x = JSON.stringify(a.files[f] ?? null), y = JSON.stringify(b.files[f] ?? null);
    if (x !== y) diffs.push({ where: `file ${f}`, counts: [x.length, y.length], onlyA: [x], onlyB: [y] });
  }
  return diffs;
}

function multisetMinus(x, y) {
  const m = new Map();
  for (const s of y) m.set(s, (m.get(s) ?? 0) + 1);
  const out = [];
  for (const s of x) {
    const n = m.get(s) ?? 0;
    if (n) m.set(s, n - 1);
    else out.push(s);
  }
  return out;
}

function report(label, diffs, names) {
  if (!diffs.length) {
    console.log(`  ${label}: identical`);
    return 0;
  }
  console.log(`  ${label}: ${diffs.length} difference${diffs.length === 1 ? "" : "s"}`);
  for (const d of diffs) {
    console.log(`    ${d.where} (${names[0]} ${d.counts[0]} rows, ${names[1]} ${d.counts[1]}): ${d.onlyA.length} only in ${names[0]}, ${d.onlyB.length} only in ${names[1]}`);
    for (const s of d.onlyA.slice(0, 2)) console.log(`      - ${names[0]}: ${s.slice(0, 400)}`);
    for (const s of d.onlyB.slice(0, 2)) console.log(`      + ${names[1]}: ${s.slice(0, 400)}`);
  }
  return diffs.length;
}

const dirs = {};
const dumps = {};
for (const side of ["old", "new"]) {
  for (const n of [1, 2]) {
    const key = `${side}${n}`;
    const data = path.join(abs(outDir), "data", key);
    fs.rmSync(data, { recursive: true, force: true });
    fs.mkdirSync(data, { recursive: true });
    const t0 = Date.now();
    for (const t of [now, later]) (side === "old" ? runOld : runNew)(data, t);
    dirs[key] = data;
    dumps[key] = await dump(data, side === "old" ? rename : {});
    fs.writeFileSync(path.join(abs(outDir), `${key}.json`), JSON.stringify(dumps[key], null, 1) + "\n");
    console.log(`${key}: ran in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${Object.values(dumps[key].tables).reduce((s, r) => s + r.length, 0)} rows, ${Object.keys(dumps[key].files).length} files`);
  }
}

console.log("\nParity");
let total = 0;
total += report("old is deterministic", compare(dumps.old1, dumps.old2), ["old1", "old2"]);
total += report("new is deterministic", compare(dumps.new1, dumps.new2), ["new1", "new2"]);
const cross = compare(dumps.old1, dumps.new1);
total += report("old vs new", cross, ["old", "new"]);
fs.writeFileSync(path.join(abs(outDir), "diff.json"), JSON.stringify(cross, null, 1) + "\n");
console.log(total ? `\n${total} difference(s). Dumps and diff.json are in ${abs(outDir)}.` : "\nNo differences.");
process.exitCode = total ? 1 : 0;
