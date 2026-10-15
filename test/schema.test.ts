import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_FILES, toJsonSchema } from "../src/schema/index.js";

const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schema");

describe("schema/", () => {
  it("contains every generated schema, up to date with the zod source", () => {
    for (const entry of SCHEMA_FILES) {
      const file = path.join(schemaDir, entry.file);
      expect(fs.existsSync(file), `${entry.file} missing: run pnpm build && pnpm schema`).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      expect(onDisk, `${entry.file} is stale: run pnpm build && pnpm schema`).toEqual(toJsonSchema(entry));
    }
  });

  it("publishes stable $id urls", () => {
    const ids = SCHEMA_FILES.map((e) => toJsonSchema(e)["$id"]);
    expect(ids).toContain("https://github.com/snds/dsa/schema/config.json");
    expect(ids).toContain("https://github.com/snds/dsa/schema/suggestion-record.json");
  });
});
