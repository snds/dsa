import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/app");

/** Copy the fixture app into a temp dir so tests that write (.dsa/) do not touch the checked-in one. */
export function tempFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-fixture-"));
  fs.cpSync(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.dsa`) });
  return dir;
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
