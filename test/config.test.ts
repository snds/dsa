import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, findConfigFile, loadConfig, parseConfig } from "../src/config.js";
import { FIXTURE } from "./helpers.js";

describe("config", () => {
  it("applies defaults to an empty config", () => {
    const c = parseConfig({});
    expect(c.patterns).toEqual({ minOccurrences: 3, minHosts: 2, minComponents: 2, ignoreIgnoredTimes: 3 });
    expect(c.hosts.by).toBe("file");
    expect(c.output.dir).toBe(".dsa");
    expect(c.ratchet.baseline).toBe(".dsa/baseline.json");
    expect(c.scan.include).toContain("**/*.tsx");
  });

  it("fills missing keys inside a partially specified section", () => {
    const c = parseConfig({ patterns: { minOccurrences: 5 } });
    expect(c.patterns.minOccurrences).toBe(5);
    expect(c.patterns.minHosts).toBe(2);
  });

  it("rejects bad values with a readable message", () => {
    expect(() => parseConfig({ patterns: { minOccurrences: 0 } })).toThrow(/patterns\.minOccurrences/);
    expect(ConfigSchema.safeParse({ hosts: { by: "route" } }).success).toBe(false);
  });

  it("discovers dsa.config.json upward from a nested directory", () => {
    const nested = path.join(FIXTURE, "src/screens");
    expect(findConfigFile(nested)).toBe(path.join(FIXTURE, "dsa.config.json"));
    const loaded = loadConfig({ cwd: nested });
    expect(loaded.root).toBe(FIXTURE);
    expect(loaded.config.system.name).toBe("fixture");
    expect(loaded.config.system.localAliases).toEqual(["@/components/ui"]);
  });

  it("falls back to defaults rooted at cwd when nothing is found", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-noconfig-"));
    try {
      const loaded = loadConfig({ cwd: dir });
      expect(loaded.configPath).toBeNull();
      expect(loaded.root).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
