#!/usr/bin/env node
// Fails when a tracked file names a design system that dsa must not know by name.
//
//   DSA_NAME_DENYLIST='acme|globex' node scripts/name-check.mjs [--require]
//
// The pattern is a case-insensitive regular expression. It comes from the
// environment (in CI, a repository secret) so the names themselves never land in
// this repo. Without it the check skips, unless --require is passed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const required = process.argv.includes("--require");
const source = process.env.DSA_NAME_DENYLIST?.trim();
if (!source) {
  console.log("name check: DSA_NAME_DENYLIST is not set, skipped.");
  process.exit(required ? 1 : 0);
}

let pattern;
try {
  pattern = new RegExp(source, "i");
} catch (e) {
  console.error(`name check: DSA_NAME_DENYLIST is not a valid regular expression: ${e.message}`);
  process.exit(2);
}

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);

const hits = [];
for (const file of files) {
  if (pattern.test(file)) hits.push(`${file}: in the file name`);
  let text;
  try {
    const buf = fs.readFileSync(path.join(root, file));
    if (buf.includes(0)) continue; // binary
    text = buf.toString("utf8");
  } catch {
    continue; // deleted in the working tree
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) hits.push(`${file}:${i + 1}`);
  }
}

if (hits.length) {
  // Print where, never what: the matched names are the secret.
  console.error(`name check: ${hits.length} match${hits.length === 1 ? "" : "es"} for a denied name.`);
  for (const h of hits.slice(0, 50)) console.error(`  ${h}`);
  if (hits.length > 50) console.error(`  … and ${hits.length - 50} more`);
  process.exit(1);
}
console.log(`name check: ${files.length} tracked files, no denied names.`);
