import fs from "node:fs";

let cached: string | undefined;

/** Package version read from package.json (one level up from both src/ and dist/). */
export function dsaVersion(): string {
  if (!cached) {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    cached = pkg.version;
  }
  return cached;
}
