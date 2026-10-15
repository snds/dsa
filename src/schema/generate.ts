#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SCHEMA_FILES, toJsonSchema } from "./index.js";

/** Write `schema/*.json` from the zod schemas. Run via `pnpm schema` after `pnpm build`. */
export function generateSchemas(outDir: string): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const entry of SCHEMA_FILES) {
    const file = path.join(outDir, entry.file);
    fs.writeFileSync(file, JSON.stringify(toJsonSchema(entry), null, 2) + "\n");
    written.push(file);
  }
  return written;
}

// Resolve symlinks: pnpm runs the bin through node_modules/.bin/dsa -> dist/cli.js.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(entry))).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const outDir = fs.existsSync(new URL("../../schema", import.meta.url)) ? new URL("../../schema", import.meta.url).pathname : path.resolve("schema");
  for (const f of generateSchemas(outDir)) console.log(`wrote ${f}`);
}
