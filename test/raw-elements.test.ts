import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ratchet } from "../src/ratchet.js";
import { scan } from "../src/scan.js";
import { RatchetReportSchema, ScanReportSchema } from "../src/schema/index.js";
import { formatRatchet } from "../src/report/text.js";
import { rmrf } from "./helpers.js";

const RAW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/raw");

describe("raw elements", () => {
  it("counts plain <button>s written as JSX, not ones handed to a component", () => {
    const r = scan({ dir: RAW });
    expect(r.correctUse.counts.rawElements).toBe(3);
    expect(r.correctUse.rawElements.map((f) => `${f.element}@${f.line}`)).toEqual(["button@8", "button@12", "button@15"]);
    const parsed = ScanReportSchema.safeParse(r);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("counts the tags the config names", () => {
    const r = scan({ dir: RAW, config: { correctUse: { rawElements: ["button", "input", "a"] } } });
    expect(r.correctUse.counts.rawElements).toBe(5);
    expect(new Set(r.correctUse.rawElements.map((f) => f.element))).toEqual(new Set(["button", "input", "a"]));
  });

  it("counts nothing when the list is empty", () => {
    expect(scan({ dir: RAW, config: { correctUse: { rawElements: [] } } }).correctUse.counts.rawElements).toBe(0);
  });
});

describe("ratchet on raw elements", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-raw-"));
    fs.cpSync(RAW, dir, { recursive: true });
  });
  afterEach(() => rmrf(dir));

  const baseline = (counts: Record<string, number>) => {
    fs.mkdirSync(path.join(dir, ".dsa"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".dsa/baseline.json"), JSON.stringify({ dsaVersion: "0.1.0", updatedAt: "x", counts }));
  };

  it("reports a metric an older baseline lacks without failing on it", () => {
    baseline({ classNameOverrides: 0, styleOverrides: 0, spreadProps: 0, lookAlikes: 0 });
    const r = ratchet({ dir });
    expect(r.ok).toBe(true);
    expect(r.untracked).toEqual(["rawElements"]);
    expect(formatRatchet(r)).toMatch(/Not in the baseline yet: rawElements/);
    const parsed = RatchetReportSchema.safeParse(r);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("starts ratcheting it after --update, and fails when it grows", () => {
    baseline({ classNameOverrides: 0, styleOverrides: 0, spreadProps: 0, lookAlikes: 0 });
    expect(ratchet({ dir, update: true }).untracked).toEqual([]);
    expect(ratchet({ dir }).ok).toBe(true);
    const f = path.join(dir, "src/screen.tsx");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("<a href", '<button type="button">More</button>\n      <a href'));
    const r = ratchet({ dir });
    expect(r.ok).toBe(false);
    expect(r.grew).toEqual(["rawElements"]);
    expect(r.deltas.rawElements).toBe(1);
  });
});
