import { describe, expect, it } from "vitest";
import { scan } from "../src/scan.js";
import { ScanReportSchema } from "../src/schema/index.js";
import { FIXTURE } from "./helpers.js";

const report = scan({ dir: FIXTURE });

describe("adoption (definition 1: imports and instances)", () => {
  it("counts every element kind and the custom ratio", () => {
    const t = report.adoption.total;
    expect(t.total).toBe(t.ds + t.local + t.html + t.external);
    expect(t.ds).toBeGreaterThan(t.html);
    expect(t.external).toBe(1); // react-router Link
    expect(t.local).toBe(3); // PrimaryButton, StatCard, legacy Badge
    expect(t.customRatio).toBeCloseTo((t.local + t.html) / t.total, 3);
  });

  it("aggregates per file and per directory", () => {
    expect(Object.keys(report.adoption.byFile)).toContain("src/screens/landing.tsx");
    const landing = report.adoption.byFile["src/screens/landing.tsx"]!;
    expect(landing.html).toBeGreaterThan(landing.ds);
    expect(landing.customRatio).toBeGreaterThan(0.5);
    expect(report.adoption.byDir["src/screens"]!.total).toBeGreaterThan(report.adoption.byDir["src/components"]!.total);
  });

  it("leaves the design system's own source out of the counts", () => {
    expect(report.dsSourceFiles).toContain("src/components/ui/button.tsx");
    expect(report.files).not.toContain("src/components/ui/button.tsx");
    expect(Object.keys(report.adoption.byFile)).not.toContain("src/components/ui/button.tsx");
  });

  it("builds a component inventory", () => {
    expect(report.inventory.ds["Button"]!.count).toBe(15);
    expect(report.inventory.ds["Button"]!.sources).toEqual(["@/components/ui/button"]);
    expect(report.inventory.external["Link"]!.sources).toEqual(["react-router"]);
    expect(report.inventory.html["li"]).toBe(3);
  });
});

describe("correct use", () => {
  it("finds className and style overrides on DS components", () => {
    expect(report.correctUse.overrides).toEqual([
      { file: "src/screens/inbox.tsx", line: 27, column: 7, component: "Button", prop: "className" },
      { file: "src/screens/landing.tsx", line: 21, column: 7, component: "Button", prop: "style" },
    ]);
  });

  it("finds spread props on DS components, including inside thin wrappers", () => {
    expect(report.correctUse.spreadProps.map((s) => `${s.file}:${s.component}`)).toEqual([
      "src/components/PrimaryButton.tsx:Button",
      "src/screens/inbox.tsx:Input",
    ]);
  });

  it("flags same-name and thin-wrapper look-alikes, not compositions", () => {
    const names = report.correctUse.lookAlikes.map((l) => `${l.name}->${l.dsComponent}@${l.score}`);
    expect(names).toEqual(["Badge->Badge@1", "PrimaryButton->Button@0.8"]);
    const badge = report.correctUse.lookAlikes[0]!;
    expect(badge.declaredIn?.file).toBe("src/components/legacy/badge.tsx");
    expect(badge.usages).toBe(1);
  });

  it("summarizes the counts the ratchet uses", () => {
    expect(report.correctUse.counts).toEqual({ classNameOverrides: 1, styleOverrides: 1, spreadProps: 2, lookAlikes: 2, rawElements: 0 });
  });

  it("matches the published schema", () => {
    const parsed = ScanReportSchema.safeParse(report);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
