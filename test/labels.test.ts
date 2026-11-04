import { describe, expect, it } from "vitest";
import { historyPairs, parseLabels, stripSystemComponents, systemImports, type StripTarget } from "../src/index.js";

// Ground truth for dsa bench: a schema every label line must meet, and two ways to get labels from
// code that already answers (a component stripped back to its markup; a commit that swapped one in).

const label = (o: object = {}) => ({
  id: "L-1", app: "ledger", file: "src/Toolbar.tsx", line: 4, sourceRef: "abc1234", elementHash: "f00d",
  truth: { verdict: "replace", use: "Button", props: { variant: "ghost" } }, acceptableAlts: [], labeler: "pat", method: "human", at: "2026-10-06T12:00:00Z", ...o,
});

describe("labels.jsonl", () => {
  it("reads valid lines and says what's wrong with the rest, by line", () => {
    const text = [
      JSON.stringify(label()),
      "",
      JSON.stringify(label({ id: "L-2", truth: { verdict: "keep" }, method: "migrated", acceptableAlts: undefined })),
      JSON.stringify(label({ id: "L-3", truth: { verdict: "replace" } })),
      JSON.stringify(label({ id: "L-4", method: "guess" })),
      "{not json",
      JSON.stringify(label({ id: "L-5", at: "yesterday" })),
    ].join("\n");
    const { labels, errors } = parseLabels(text);
    expect(labels.map((l) => l.id)).toEqual(["L-1", "L-2"]);
    expect(labels[1]!.acceptableAlts).toEqual([]);
    expect(errors.map((e) => e.line)).toEqual([4, 5, 6, 7]);
    expect(errors[0]!.message).toContain("truth.use");
    expect(errors[1]!.message).toContain("method");
  });
});

const button: StripTarget = {
  tag: "button",
  axes: { variant: ["default", "ghost"], size: ["default", "sm"] },
  defaults: { variant: "default", size: "default" },
  classes: (v, s) => ["inline-flex", "rounded-md", v === "ghost" ? "bg-transparent" : "bg-blue-10", s === "sm" ? "h-7" : "h-9"],
};

describe("migrated: a system component stripped back to the markup it renders", () => {
  const src = [
    'import { Button } from "@acme/ui/button";',
    'import { Card } from "@acme/ui/card";',
    "export function Bar({ on }: { on: boolean }) {",
    "  return <div>",
    '    <Button variant="ghost" size="sm" onClick={go}>Save</Button>',
    "    <Button",
    '      variant="ghost"',
    "      className={on ? \"is-on\" : \"\"}",
    "    >Edit</Button>",
    "    <Button>Done</Button>",
    "    <Button variant={tone}>Maybe</Button>",
    "    <Button asChild><a href=\"/x\">Go</a></Button>",
    "    <Card />",
    "  </div>;",
    "}",
  ].join("\n");
  const imports = systemImports(src, ["@acme/ui"]);
  const r = stripSystemComponents(src, imports, new Map([["Button", button]]));

  it("finds the system's imports by package", () => {
    expect([...imports]).toEqual([["Button", "Button"], ["Card", "Card"]]);
  });

  it("labels each with what was there, defaults filled in; unsure ones are left alone", () => {
    expect(r.stripped.map((s) => [s.line, s.component, s.props])).toEqual([
      [5, "Button", { variant: "ghost", size: "sm" }],
      [6, "Button", { variant: "ghost", size: "default" }],
      [10, "Button", { variant: "default", size: "default" }],
    ]);
  });

  it("draws the raw element with the classes its variant and size add, its own classes kept, lines unchanged", () => {
    const lines = r.text.split("\n");
    expect(lines.length).toBe(src.split("\n").length);
    expect(lines[4]).toMatch(/^ {4}<button className="inline-flex rounded-md bg-transparent h-7" +onClick=\{go\}>Save<\/button>$/);
    expect(lines[5]).toBe("    <button");
    expect(lines[6]!.trim()).toBe("");
    expect(lines[7]).toBe('      className={`inline-flex rounded-md bg-transparent h-9 ${on ? "is-on" : ""}`}');
    expect(lines[8]).toBe("    >Edit</button>");
    expect(lines[9]).toBe('    <button className="inline-flex rounded-md bg-blue-10 h-9">Done</button>');
    expect(lines[10]).toBe("    <Button variant={tone}>Maybe</Button>");
    expect(lines[11]).toContain("<Button asChild>");
    expect(lines[12]).toBe("    <Card />");
  });
});

describe("history: a commit that swapped a raw element for a system component", () => {
  it("pairs the removed raw element with the component added in its place, at the old line", () => {
    const diff = [
      "diff --git a/src/Bar.tsx b/src/Bar.tsx",
      "--- a/src/Bar.tsx",
      "+++ b/src/Bar.tsx",
      "@@ -12,2 +12,2 @@ export function Bar() {",
      '-    <button className="px-2 h-7 rounded">Save</button>',
      '-    <span className="x">note</span>',
      '+    <Button variant="ghost" size={"sm"}>Save</Button>',
      "@@ -30 +30 @@",
      "-    <a href='/x'>Go</a>",
      "+    <Link href='/x'>Go</Link>",
    ].join("\n");
    const pairs = historyPairs(diff, new Set(["Button"]));
    expect(pairs).toEqual([{ file: "src/Bar.tsx", line: 12, rawTag: "button", component: "Button", props: { variant: "ghost", size: "sm" }, elementHash: expect.any(String) }]);
  });
});
