#!/usr/bin/env node
// Parity run: the earlier analytics suite and dsa, on the same repo, must store the same data.
//
//   node scripts/parity/run.mjs --old <suite dir> --new <dsa dir> --root <repo> --out <dir>
//        [--profile <file>] [--config <dsa.config.json>] [--rename <map.json>]
//        [--readiness] [--now <iso>] [--shots]
//
// Each side runs twice into fresh data folders (git history, Figma and the npm registry off, fixed
// times). Each time is two runs into the same folder, a day apart, so the finding lifecycle (update,
// hold, resolve) is compared too. Each folder is dumped (dump.mjs), and every pair is compared: old vs old and new vs new
// (each side is deterministic), then old vs new. --rename maps names the old side wrote to the names
// the new side writes (a system's own names), applied to the old dumps only. Exit 1 on any difference.
//
// After the runs, each side also writes what its CLI writes for people (Phase 3): issue drafts, the
// report, and the published site. Those are compared too (dump.mjs normalizes them), along with the
// review queue and any screenshot or Storybook manifests in the data folder.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
// --shots: each side also takes the review's screenshots after its runs (it starts the apps), so the
// screenshot manifests are compared too. Off by default: it needs a browser and apps that start.
const shots = flag("shots");
const rename = opt("rename") ? JSON.parse(fs.readFileSync(path.resolve(opt("rename")), "utf8")) : {};
const abs = (p) => path.resolve(p);
// The profile's name: the suite used the system's name in a few field names (dump.mjs suiteKeys).
const system = opt("profile") ? (await import(pathToFileURL(abs(opt("profile"))).href)).default?.name : undefined;
fs.mkdirSync(abs(outDir), { recursive: true });

function runOld(data, now) {
  const tsx = path.join(abs(oldDir), "node_modules", ".bin", "tsx");
  const r = spawnSync(tsx, [path.join(here, "old-driver.ts"), abs(oldDir), abs(root), data, now, readiness ? "on" : "off"], { cwd: abs(oldDir), encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`old side failed:\n${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function oldExtras(data) {
  const tsx = path.join(abs(oldDir), "node_modules", ".bin", "tsx");
  const r = spawnSync(tsx, [path.join(here, "old-driver.ts"), "extras", abs(oldDir), abs(root), data, ...(shots ? ["shots"] : [])], { cwd: abs(oldDir), encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`old side (report, publish, drafts) failed:\n${r.stderr || r.stdout}`);
}

function newExtras(data) {
  const cli = path.join(abs(newDir), "dist", "cli.js");
  const common = ["--root", abs(root), "--data", data];
  if (opt("profile")) common.push("--profile", abs(opt("profile")));
  if (opt("config")) common.push("--config", abs(opt("config")));
  for (const cmd of [...(shots ? [["shots"]] : []), ["issues", "draft"], ["report"], ["publish", "--out", path.join(data, "site")]]) {
    const r = spawnSync(process.execPath, [cli, ...cmd, ...common], { cwd: abs(root), encoding: "utf8", maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`new side (${cmd.join(" ")}) failed:\n${r.stderr || r.stdout}`);
  }
}

function runNew(data, now) {
  const cli = path.join(abs(newDir), "dist", "cli.js");
  // --no-shots and --no-report: the runs measure what runPipeline stores; screenshots (shots.auto) and the
  // report come afterwards, the same way on both sides (newExtras, oldExtras).
  const a = [cli, "run", "--root", abs(root), "--data", data, "--no-git", "--no-drafts", "--no-shots", "--no-report", "--no-figma", "--now", now];
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
  // What the CLI wrote for people: report and site data by top-level key, their HTML shells, drafts, queue, manifests.
  const ea = a.extras ?? {}, eb = b.extras ?? {};
  const same = (where, x, y) => {
    const sx = JSON.stringify(x ?? null), sy = JSON.stringify(y ?? null);
    if (sx !== sy) diffs.push({ where, counts: [sx.length, sy.length], onlyA: [firstDiff(sx, sy)], onlyB: [firstDiff(sy, sx)] });
  };
  for (const pg of ["report", "site"]) {
    const x = ea[pg], y = eb[pg];
    if (!x || !y) { same(pg, x, y); continue; }
    same(`${pg} html`, x.shell, y.shell);
    if (pg === "site") same("site images", x.images, y.images);
    const keys = [...new Set([...Object.keys(x.data ?? {}), ...Object.keys(y.data ?? {})])].sort();
    for (const k of keys) if (k !== "queue") same(`${pg} data .${k}`, x.data?.[k], y.data?.[k]);
  }
  same("review queue", ea.queue, eb.queue);
  const drafts = [...new Set([...Object.keys(ea.issues ?? {}), ...Object.keys(eb.issues ?? {})])].sort();
  for (const f of drafts) same(`issue draft ${f}`, ea.issues?.[f], eb.issues?.[f]);
  same("shots manifest", ea.shots, eb.shots);
  same("rendered manifest", ea.rendered, eb.rendered);
  return diffs;
}

/** Where two serializations part, with a little context. */
function firstDiff(x, y) {
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return (i > 80 ? "…" : "") + x.slice(Math.max(0, i - 80), i + 320);
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
    (side === "old" ? oldExtras : newExtras)(data);
    dirs[key] = data;
    dumps[key] = await dump(data, side === "old" ? rename : {}, { suite: side === "old", system });
    fs.writeFileSync(path.join(abs(outDir), `${key}.json`), JSON.stringify(dumps[key], null, 1) + "\n");
    const ex = dumps[key].extras;
    console.log(`${key}: ran in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${Object.values(dumps[key].tables).reduce((s, r) => s + r.length, 0)} rows, ${Object.keys(dumps[key].files).length} files, ${Object.keys(ex.issues).length} drafts, report ${ex.report ? "yes" : "no"}, site ${ex.site ? "yes" : "no"}, queue ${ex.queue?.items?.length ?? 0} items`);
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
