import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildGraph, type SourceAdapter } from "../src/graph/index.js";
import { LockfileResolver } from "../src/engine/scanners/versions.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsa-robust-"));

describe("one bad input never ends a run", () => {
  it("a file its reader can't read is skipped and listed", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "ok.tsx"), "export const A = () => <div />;\n");
    fs.writeFileSync(path.join(root, "bad.tpl"), "{% anything %}\n");
    const throwing: SourceAdapter = { framework: "react", extensions: [".tpl"], createReader: () => ({ read: () => { throw new Error("cannot read this\nmore"); } }) };
    const config = loadConfig({ cwd: root, overrides: { scan: { include: ["**/*.tsx", "**/*.tpl"] } } }).config;
    const g = buildGraph({ root, config, adapters: [throwing] });
    expect(g.files.map((f) => path.basename(f.file))).toEqual(["ok.tsx"]);
    expect(g.skipped).toEqual([{ file: "bad.tpl", message: "cannot read this" }]);
  });

  it("reads a pnpm lockfile holding several YAML documents", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    devDependencies: {}",
      "---",
      "lockfileVersion: '9.0'",
      "importers:",
      "  apps/web:",
      "    dependencies:",
      "      '@acme/ui':",
      "        specifier: ^1.0.0",
      "        version: 1.2.3",
      "",
    ].join("\n"));
    const r = new LockfileResolver(root);
    expect(r.kind).toBe("pnpm");
    expect(r.resolve(path.join(root, "apps/web"), "@acme/ui", "^1.0.0")).toBe("1.2.3");
  });

  it("an unreadable lockfile costs the versions, not the run", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "importers: [unclosed\n");
    expect(new LockfileResolver(root).kind).toBe("none");
  });
});

describe("a reader that collects fewer facts", () => {
  it("a table with no table facts (Angular, Vue templates) is still classified", async () => {
    const { tableCandidates } = await import("../src/engine/classify-fields.js");
    const role = ((id: string) => ({ id })) as any;
    expect(() => tableCandidates({ attrs: {}, classes: [] } as any, role)).not.toThrow();
  });
});
