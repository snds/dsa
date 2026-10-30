#!/usr/bin/env node
// Packs the core and every add-on into release tarballs, all at one version.
//
//   node scripts/pack-release.mjs [--out artifacts] [--tag v0.3.0]
//
// Run after `pnpm build`. pnpm pack rewrites workspace: ranges to real versions; this checks that it
// did, that every package carries the same version, and (with --tag) that the version is the tag's.
// Consumers install the tarballs from the GitHub Release by URL, so nothing may point back at the
// workspace or at npm for a sibling.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The pnpm running this script (pnpm run sets npm_execpath), else pnpm on PATH.
const pnpm = (a, o) => {
  const exec = process.env.npm_execpath;
  return exec && /pnpm/.test(exec) ? execFileSync(process.execPath, [exec, ...a], o) : execFileSync("pnpm", a, o);
};
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const out = path.resolve(opt("out") ?? path.join(root, "artifacts"));
const tag = opt("tag");

const dirs = [root, ...fs.readdirSync(path.join(root, "packages")).map((d) => path.join(root, "packages", d)).filter((d) => fs.existsSync(path.join(d, "package.json")))];
const pkgs = dirs.map((dir) => ({ dir, ...JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) }));

const problems = [];
const versions = new Set(pkgs.map((p) => p.version));
if (versions.size !== 1) problems.push(`packages disagree on the version: ${pkgs.map((p) => `${p.name}@${p.version}`).join(", ")}`);
const version = pkgs[0].version;
if (tag && tag !== `v${version}`) problems.push(`tag ${tag} does not match the package version ${version}`);
for (const p of pkgs) if (!fs.existsSync(path.join(p.dir, "dist"))) problems.push(`${p.name} has no dist/: run pnpm build first`);
if (problems.length) {
  for (const m of problems) console.error(`pack-release: ${m}`);
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const files = [];
for (const p of pkgs) {
  const before = new Set(fs.readdirSync(out));
  pnpm(["pack", "--pack-destination", out], { cwd: p.dir, stdio: ["ignore", "ignore", "inherit"] });
  const file = fs.readdirSync(out).find((f) => !before.has(f));
  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", path.join(out, file), "package/package.json"], { encoding: "utf8" }));
  for (const k of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [d, r] of Object.entries(manifest[k] ?? {})) {
      if (String(r).startsWith("workspace:")) problems.push(`${file}: ${k}.${d} is still ${r}`);
      // A sibling as an ordinary dependency would be fetched from npm, where it isn't.
      if (k !== "peerDependencies" && d.startsWith("@snds/dsa")) problems.push(`${file}: ${d} must be a peer dependency, not ${k}`);
    }
  }
  files.push(file);
}
if (problems.length) {
  for (const m of problems) console.error(`pack-release: ${m}`);
  process.exit(1);
}
console.log(`pack-release: ${files.length} tarballs at ${version} in ${out}`);
for (const f of files) console.log(`  ${f}`);
