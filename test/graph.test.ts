import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildGraph, type ElementNode } from "../src/graph/index.js";
import { walk } from "../src/graph/types.js";
import { FIXTURE } from "./helpers.js";

const { config } = loadConfig({ cwd: FIXTURE });
const graph = buildGraph({ root: FIXTURE, config });
const file = (name: string) => {
  const f = graph.files.find((g) => g.file === name);
  if (!f) throw new Error(`missing ${name}`);
  return f;
};
const all = (node: ElementNode) => {
  const out: ElementNode[] = [];
  walk(node, (n) => out.push(n));
  return out;
};

describe("composition graph", () => {
  it("classifies element kinds from import declarations and the config", () => {
    const landing = file("src/screens/landing.tsx");
    const nodes = landing.roots.flatMap(all);
    const kinds = Object.fromEntries(nodes.map((n) => [n.component, n.kind]));
    expect(kinds["Button"]).toBe("ds"); // @/components/ui/* is a localAlias
    expect(kinds["PrimaryButton"]).toBe("local"); // @/components/* that is not the alias
    expect(kinds["Link"]).toBe("external"); // react-router
    expect(kinds["section"]).toBe("html");
    expect(kinds["h1"]).toBe("html");
  });

  it("marks the design system's own source files as ds-source", () => {
    expect(file("src/components/ui/button.tsx").role).toBe("ds-source");
    expect(file("src/screens/inbox.tsx").role).toBe("consumer");
    expect(file("src/components/legacy/badge.tsx").role).toBe("consumer");
  });

  it("collects literal shape props and ignores content-like props", () => {
    const inbox = file("src/screens/inbox.tsx");
    const nodes = inbox.roots.flatMap(all);
    const search = nodes.find((n) => n.component === "Search")!;
    expect(search.shapeProps).toEqual({}); // placeholder is content, not shape
    const chip = nodes.find((n) => n.component === "Chip")!;
    expect(chip.shapeProps).toEqual({ variant: "removable" }); // key is excluded
    const ghost = nodes.find((n) => n.component === "Button" && n.shapeProps["variant"] === "ghost")!;
    expect(ghost.shapeProps).toEqual({ size: "sm", variant: "ghost" });
  });

  it("records className / style overrides and spread props with locations", () => {
    const inbox = file("src/screens/inbox.tsx");
    const nodes = inbox.roots.flatMap(all);
    const overridden = nodes.find((n) => n.component === "Button" && n.overrides.className)!;
    expect(overridden.loc).toMatchObject({ file: "src/screens/inbox.tsx", line: 27, column: 7 });
    const spread = nodes.find((n) => n.component === "Input")!;
    expect(spread.spread).toBe(true);
    const landing = file("src/screens/landing.tsx").roots.flatMap(all);
    expect(landing.find((n) => n.component === "Button")!.overrides.style).toBe(true);
  });

  it("nests children through expressions and map callbacks", () => {
    const inbox = file("src/screens/inbox.tsx");
    const bar = all(inbox.roots[0]!).find((n) => n.component === "div")!;
    expect(bar.children.map((c) => c.component)).toEqual(["Search", "Chip", "Toolbar"]);
    expect(bar.children[2]!.children.map((c) => c.component)).toEqual(["Button"]);
  });

  it("finds declared local components and their render roots", () => {
    const stat = file("src/components/StatCard.tsx");
    expect(stat.declared.map((d) => d.name)).toEqual(["StatCard"]);
    expect(stat.declared[0]!.root?.component).toBe("Card");
    expect(stat.declared[0]!.loc.file).toBe("src/components/StatCard.tsx");
    expect(file("src/screens/settings.tsx").declared.map((d) => d.name)).toEqual(["RenameDialog", "SignatureDialog", "ForwardingDialog"]);
  });
});
