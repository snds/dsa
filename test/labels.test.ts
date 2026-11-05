import { describe, expect, it } from "vitest";
import { canonicalProps, historyPairsInFile, parseHunks, parseLabels, stripSystemComponents, systemImports, type StripTarget } from "../src/index.js";

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

const plain: StripTarget = { tag: "div", axes: {}, defaults: {}, classes: () => [] };
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
    '    <Button<Row> variant="ghost" />',
    "  </div>;",
    "}",
  ].join("\n");
  const imports = systemImports(src, ["@acme/ui"]);
  // Card adds no classes of its own: nothing to recognize it by, so it is left alone.
  const r = stripSystemComponents(src, imports, new Map([["Button", button], ["Card", plain]]));

  it("finds the system's imports by package", () => {
    expect([...imports]).toEqual([["Button", "Button"], ["Card", "Card"]]);
  });

  it("labels each with what was there, defaults filled in; unsure ones are left alone", () => {
    expect(r.stripped.map((s) => [s.line, s.component, s.props])).toEqual([
      [5, "Button", { variant: "ghost", size: "sm" }],
      [6, "Button", { variant: "ghost", size: "default" }],
      [10, "Button", { variant: "default", size: "default" }],
      [14, "Button", { variant: "ghost", size: "default" }],
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
    expect(lines[13]).toMatch(/^ {4}<button +className="inline-flex rounded-md bg-transparent h-9" +\/>$/);
  });
});

describe("migrated: size overrides and render slots", () => {
  // A tiny size scale: icon 32px, icon-xs 28px, default 32px high with no width, xs 24px high.
  const scale: Record<string, string[]> = { default: ["h-8", "px-3"], xs: ["h-6", "px-2"], icon: ["size-8"], "icon-xs": ["size-7"] };
  const step = (t: string) => { const m = /^(h|w|size)-(\d+)$/.exec(t); return m ? { dim: m[1]!, px: Number(m[2]) * 4 } : null; };
  const kit: StripTarget = {
    tag: "button", axes: { variant: ["default", "ghost"], size: Object.keys(scale) }, defaults: { variant: "default", size: "default" },
    classes: (v, s) => [...(v === "ghost" ? ["hover:bg-accent"] : ["bg-primary"]), ...(scale[s] ?? [])],
    px: (cls) => { let height: number | undefined, width: number | undefined; for (const t of cls) { const x = step(t); if (!x) continue; if (x.dim !== "w") height = x.px; if (x.dim !== "h") width = x.px; } return { height, width }; },
  };
  const imports = new Map([["Button", "Button"]]);

  it("a className that overrides the size makes the size with those pixels an acceptable answer", () => {
    const src = `export const A = () => <>\n<Button variant="ghost" size="icon" className="size-7">+</Button>\n<Button variant="ghost" size="icon">-</Button>\n<Button variant="ghost" size="default" className="h-6 w-12">%</Button>\n</>;`;
    const r = stripSystemComponents(src, imports, new Map([["Button", kit]]));
    expect(r.stripped.map((x) => x.alts)).toEqual([[{ variant: "ghost", size: "icon-xs" }], undefined, [{ variant: "ghost", size: "xs" }]]);
  });

  it("an element in another component's render slot is not labelled (the scanner never counts it)", () => {
    const src = `export const A = () => <Trigger render={<Button variant="ghost">Open</Button>} />;\nexport const B = () => <Button>Save</Button>;`;
    const r = stripSystemComponents(src, imports, new Map([["Button", kit]]));
    expect(r.stripped.map((x) => x.line)).toEqual([2]);
  });
});

describe("history: a commit that swapped a raw element for a system component", () => {
  const kit = (tag: string): StripTarget => ({ tag, axes: { variant: ["default", "ghost"], size: ["default", "sm"] }, defaults: { variant: "default", size: "default" }, classes: () => ["x"] });
  const targets = new Map([["Button", kit("button")], ["Icon", kit("svg")], ["Badge", kit("span")], ["MenuTrigger", kit("button")], ["MenuItem", kit("button")], ["MenuContent", kit("button")]]);
  const pkgs = ["@acme/ui"];
  const pairs = (before: string, after: string, hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number }[]) => historyPairsInFile({ file: "src/A.tsx", before, after, hunks, packages: pkgs, targets });
  const imp = 'import { Button, Icon, Badge, MenuTrigger, MenuItem, MenuContent } from "@acme/ui";';

  it("reads hunks from a -U0 diff", () => {
    expect([...parseHunks("diff --git a/src/A.tsx b/src/A.tsx\n--- a/src/A.tsx\n+++ b/src/A.tsx\n@@ -3,2 +3,4 @@\n-x\n+y\n@@ -9 +11 @@\n-z\n+w").entries()]).toEqual([["src/A.tsx", [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 4 }, { oldStart: 9, oldLines: 1, newStart: 11, newLines: 1 }]]]);
  });

  it("pairs by host tag and position, not order: a removed wrapper <div> never becomes the Button", () => {
    const before = `${imp}\nexport const A = () => (\n  <div className="row">\n    <span className="pill">New</span>\n    <button className="h-8 px-3">Save</button>\n  </div>\n);\n`;
    const after = `${imp}\nexport const A = () => (\n  <>\n    <Button variant="ghost">Save</Button>\n    <Badge>New</Badge>\n  </>\n);\n`;
    const r = pairs(before, after, [{ oldStart: 3, oldLines: 4, newStart: 3, newLines: 4 }]);
    expect(r.map((p) => [p.line, p.rawTag, p.component, p.props])).toEqual([[4, "span", "Badge", { size: "default", variant: "default" }], [5, "button", "Button", { size: "default", variant: "ghost" }]]);
  });

  it("a component imported through the app's owned copy of the system counts by its name", () => {
    const before = `export const A = () => (\n  <button className="h-8">Save</button>\n);\n`;
    const after = `import { Button } from "~/components/ui/button";\nimport { Fancy } from "~/components/ui/fancy";\nexport const A = () => (\n  <Button size="sm">Save</Button>\n);\n`;
    expect(pairs(before, after, [{ oldStart: 2, oldLines: 1, newStart: 1, newLines: 4 }]).map((p) => [p.component, p.props])).toEqual([["Button", { size: "sm", variant: "default" }]]);
  });

  it("a raw button becomes a Trigger only if it opens something, an Item only if it was an item, Content never", () => {
    const before = `${imp}\nexport const A = () => (\n  <div>\n    <button onClick={save}>Save</button>\n    <button aria-expanded={open} onClick={() => setOpen(!open)}>More</button>\n    <button onClick={() => setMenuOpen(true)}>Menu</button>\n    <button role="menuitem" onClick={pick}>Pick</button>\n    <button onClick={pick}>Other</button>\n  </div>\n);\n`;
    const after = `${imp}\nexport const A = () => (\n  <div>\n    <MenuTrigger>Save</MenuTrigger>\n    <MenuTrigger>More</MenuTrigger>\n    <MenuTrigger>Menu</MenuTrigger>\n    <MenuItem>Pick</MenuItem>\n    <MenuContent>Other</MenuContent>\n  </div>\n);\n`;
    expect(pairs(before, after, [{ oldStart: 4, oldLines: 5, newStart: 4, newLines: 5 }]).map((p) => [p.line, p.component])).toEqual([[5, "MenuTrigger"], [6, "MenuTrigger"], [7, "MenuItem"]]);
  });

  it("an element whose child changed (an icon swap) is not a label", () => {
    const before = `${imp}\nexport const A = () => (\n  <button onClick={go}>\n    <Icon name="edit" />\n  </button>\n);\n`;
    const after = `${imp}\nexport const A = () => (\n  <button onClick={go}>\n    <Icon name="pencil" size="sm" />\n  </button>\n);\n`;
    expect(pairs(before, after, [{ oldStart: 3, oldLines: 3, newStart: 3, newLines: 3 }])).toEqual([]);
  });

  it("a component in a render slot is not a label, and dynamic props make it unsure", () => {
    const before = `${imp}\nexport const A = () => (\n  <div>\n    <button className="h-8">Open</button>\n    <button className="h-8">Go</button>\n  </div>\n);\n`;
    const after = `${imp}\nexport const A = () => (\n  <div>\n    <Trigger render={<Button variant="ghost" />}>Open</Trigger>\n    <Button variant={v}>Go</Button>\n  </div>\n);\n`;
    expect(pairs(before, after, [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 2 }])).toEqual([]);
  });

  it("props compare with the component's defaults filled in, one rule for both sides", () => {
    const d = { variant: "default", size: "default" };
    expect(canonicalProps({ variant: "ghost" }, d)).toEqual(canonicalProps({ variant: "ghost", size: "default" }, d));
    expect(canonicalProps({ variant: "ghost", render: "<a/>" }, d)).toEqual({ size: "default", variant: "ghost" });
  });
});
