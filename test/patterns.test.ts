import { describe, expect, it } from "vitest";
import { patterns } from "../src/patterns.js";
import { anatomyId, toAnatomy, type AnatomyNode } from "../src/detect/anatomy.js";
import { detectPatterns } from "../src/detect/patterns.js";
import { buildGraph } from "../src/graph/index.js";
import { loadConfig } from "../src/config.js";
import { PatternsReportSchema, SuggestionRecordSchema } from "../src/schema/index.js";
import { FIXTURE } from "./helpers.js";

const report = patterns({ dir: FIXTURE, decisions: { version: 1, decisions: {} } });
const byName = (name: string) => report.candidates.find((c) => c.name === name)!;

describe("pattern-candidate detection", () => {
  it("raises a composition seen 3 times across 2 files as a pattern", () => {
    const fb = byName("FilterBar");
    expect(fb).toBeDefined();
    expect(fb.tier).toBe("pattern");
    expect(fb.occurrences).toHaveLength(3);
    expect(fb.hosts).toEqual(["src/screens/contacts.tsx", "src/screens/inbox.tsx"]);
    expect(fb.anatomy.component).toBe("div");
    expect(fb.anatomy.children.map((c) => c.component)).toEqual(["Search", "Chip", "Toolbar"]);
    expect(fb.nearestExisting).toMatchObject({ name: "FilterBar", source: "catalog" });
    expect(fb.confidence).toBeGreaterThan(0.5);
  });

  it("calls a small single-family DS composition a compound component", () => {
    const tb = byName("ActionToolbar");
    expect(tb.tier).toBe("compound-component");
    expect(tb.occurrences).toHaveLength(3);
    expect(tb.hosts).toHaveLength(2);
  });

  it("calls an all-DS single-family composition with 4+ nodes a variant of its root", () => {
    const card = byName("CardRecipe");
    expect(card.tier).toBe("variant");
    expect(card.anatomy.component).toBe("Card");
    expect(card.nearestExisting).toMatchObject({ name: "StatCard", source: "local" });
    expect(card.nearestExisting!.score).toBeGreaterThanOrEqual(0.5);
    expect(card.reason).toMatch(/variant/);
  });

  it("keeps a 3x-in-one-file composition a snowflake, and only reports it with --all", () => {
    expect(report.candidates.some((c) => c.anatomy.component === "Dialog")).toBe(false);
    const withAll = patterns({ dir: FIXTURE, all: true, decisions: { version: 1, decisions: {} } });
    const dialog = withAll.candidates.find((c) => c.anatomy.component === "Dialog")!;
    expect(dialog.tier).toBe("snowflake");
    expect(dialog.occurrences).toHaveLength(3);
    expect(dialog.hosts).toEqual(["src/screens/settings.tsx"]);
    expect(dialog.confidence).toBeLessThanOrEqual(0.3);
    expect(dialog.reason).toMatch(/2\+ hosts/);
  });

  it("drops compositions that only ever appear inside a bigger repeated one", () => {
    // Toolbar(Button ghost sm) lives only inside the FilterBar; it must not be its own candidate.
    const ghostToolbar = report.candidates.find(
      (c) => c.anatomy.component === "Toolbar" && c.anatomy.children[0]?.shapeProps["variant"] === "ghost",
    );
    expect(ghostToolbar).toBeUndefined();
  });

  it("only reports the three tiers above the bar by default", () => {
    expect(report.summary.byTier).toEqual({ pattern: 1, "compound-component": 1, variant: 1, snowflake: 0 });
    expect(report.candidates.map((c) => c.tier)).toEqual(["pattern", "compound-component", "variant"]);
  });

  it("produces stable ids from the anatomy alone", () => {
    const a: AnatomyNode = { component: "Card", kind: "ds", shapeProps: { size: "sm" }, children: [{ component: "Badge", kind: "ds", shapeProps: {}, children: [] }] };
    const b: AnatomyNode = JSON.parse(JSON.stringify(a)) as AnatomyNode;
    expect(anatomyId(a)).toBe(anatomyId(b));
    b.shapeProps = { size: "lg" };
    expect(anatomyId(a)).not.toBe(anatomyId(b));
    expect(byName("FilterBar").id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("treats external elements as transparent in the anatomy", () => {
    const { config } = loadConfig({ cwd: FIXTURE });
    const graph = buildGraph({ root: FIXTURE, config });
    const landing = graph.files.find((f) => f.file === "src/screens/landing.tsx")!;
    const anatomy = toAnatomy(landing.roots[0]!)[0]!;
    expect(anatomy.children.map((c) => c.component)).not.toContain("Link");
  });

  it("respects thresholds from the config", () => {
    const { config } = loadConfig({ cwd: FIXTURE });
    const graph = buildGraph({ root: FIXTURE, config });
    const relaxed = detectPatterns({ graph, config: { ...config, patterns: { ...config.patterns, minHosts: 1 } } });
    expect(relaxed.candidates.some((c) => c.anatomy.component === "Dialog")).toBe(true);
    const byDir = detectPatterns({ graph, config: { ...config, hosts: { by: "dir" } } });
    // Every screen lives in src/screens, so by directory there is only one host: nothing qualifies.
    expect(byDir.candidates).toHaveLength(0);
  });

  it("honours parked decisions", () => {
    const id = byName("FilterBar").id;
    const parked = patterns({
      dir: FIXTURE,
      decisions: { version: 1, decisions: { [id]: { status: "parked", ignoredTimes: 3, updatedAt: "x" } } },
    });
    expect(parked.candidates.some((c) => c.id === id)).toBe(false);
    expect(parked.parked).toEqual([{ id, name: "FilterBar", ignoredTimes: 3 }]);
  });

  it("matches the published schema", () => {
    expect(PatternsReportSchema.safeParse(report).success).toBe(true);
    for (const c of report.candidates) expect(SuggestionRecordSchema.safeParse(c).success).toBe(true);
  });
});
