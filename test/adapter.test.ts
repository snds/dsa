import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { adapterFor, buildGraph, reactAdapter, type SourceAdapter } from "../src/graph/index.js";
import { rmrf, tempFixture } from "./helpers.js";

/** A stand-in for a Vue reader: one root element per file, named after the file. */
function fakeVue(log: string[]): SourceAdapter {
  return {
    framework: "vue",
    extensions: [".vue"],
    createReader(ctx) {
      log.push("create");
      return {
        read(file) {
          const rel = path.relative(ctx.root, file).split(path.sep).join("/");
          const loc = { file: rel, line: 1, column: 1 };
          const root = { component: "Button", kind: "ds" as const, source: "@acme/ui", shapeProps: {}, children: [], loc, overrides: { className: false, style: false }, spread: false };
          return { file: rel, framework: "vue", role: "consumer", roots: [root], declared: [], imports: [] };
        },
        dispose: () => log.push("dispose"),
      };
    },
  };
}

describe("source adapters", () => {
  it("routes files by extension and falls back to the React reader", () => {
    const vue = fakeVue([]);
    expect(adapterFor("/a/b.vue", [vue], reactAdapter)).toBe(vue);
    expect(adapterFor("/a/b.tsx", [vue], reactAdapter)).toBe(reactAdapter);
    expect(adapterFor("/a/b.svelte", [vue], reactAdapter)).toBe(reactAdapter);
  });

  it("builds one graph from React and plugged-in readers, one reader per adapter", () => {
    const dir = tempFixture();
    try {
      fs.writeFileSync(path.join(dir, "src/screens/a.vue"), "<template><Button/></template>\n");
      fs.writeFileSync(path.join(dir, "src/screens/b.vue"), "<template><Button/></template>\n");
      const log: string[] = [];
      const config = parseConfig({ scan: { include: ["src/**/*.tsx", "src/**/*.vue"] } });
      const graph = buildGraph({ root: dir, config, adapters: [fakeVue(log)] });
      const byFramework = (f: string) => graph.files.filter((g) => g.framework === f).map((g) => g.file);
      expect(byFramework("vue")).toEqual(["src/screens/a.vue", "src/screens/b.vue"]);
      expect(byFramework("react").length).toBeGreaterThan(0);
      expect(log).toEqual(["create", "dispose"]);
    } finally {
      rmrf(dir);
    }
  });
});
