#!/usr/bin/env node
// Installs the release tarballs into a fresh project, the way a consumer does, and checks that the one
// `dsa` CLI finds every add-on and runs on the fixture app.
//
//   node scripts/consumer-smoke.mjs [--from artifacts]
//
// The project lists each tarball as a devDependency and nothing else: no overrides, no workspace.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The pnpm running this script (pnpm run sets npm_execpath), else pnpm on PATH.
const pnpm = (a, o) => {
  const exec = process.env.npm_execpath;
  return exec && /pnpm/.test(exec) ? execFileSync(process.execPath, [exec, ...a], o) : execFileSync("pnpm", a, o);
};
const args = process.argv.slice(2);
const i = args.indexOf("--from");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const from = path.resolve(i >= 0 ? args[i + 1] : path.join(root, "artifacts"));
const tarballs = fs.readdirSync(from).filter((f) => f.endsWith(".tgz"));
const nameOf = (f) => JSON.parse(execFileSync("tar", ["-xOzf", path.join(from, f), "package/package.json"], { encoding: "utf8" })).name;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-consumer-"));
const devDependencies = Object.fromEntries(tarballs.map((f) => [nameOf(f), `file:${path.join(from, f)}`]));
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "dsa-consumer-smoke", private: true, type: "module", devDependencies }, null, 2));
// Playwright's browsers aren't needed to load the review add-on.
const env = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };
pnpm(["install", "--config.engine-strict=false"], { cwd: dir, stdio: "inherit", env });

const dsa = (...a) => execFileSync(process.execPath, [path.join(dir, "node_modules", "@snds", "dsa", "dist", "cli.js"), ...a], { cwd: dir, encoding: "utf8", env });
const where = dsa("where");
const line = where.split("\n").find((l) => l.startsWith("Add-ons:")) ?? "";
const want = Object.keys(devDependencies).filter((n) => n !== "@snds/dsa").sort();
const missing = want.filter((n) => !line.includes(n));
if (missing.length) {
  console.error(`consumer-smoke: dsa where did not find ${missing.join(", ")}\n${where}`);
  process.exit(1);
}
const fixture = path.join(root, "test", "fixtures", "app");
dsa("scan", fixture, "--json");
console.log(`consumer-smoke: ${tarballs.length} tarballs installed in ${dir}; ${line.trim()}; scan ran.`);
fs.rmSync(dir, { recursive: true, force: true });
