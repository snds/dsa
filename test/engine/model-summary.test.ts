import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.js";
import { modelSummary, readRepo } from "../../src/model/index.js";
import { instancesFromReading, layoutOnly } from "../../src/engine/model-instances.js";

function dir(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-summary-"));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}

describe("dashboard data from the model", () => {
  it("a className of layout utilities only is not an override; anything else, or a computed one, is", () => {
    expect(layoutOnly("w-full mt-4 md:w-1/2 self-end shrink-0")).toBe(true);
    for (const c of ["text-red-500", "w-full bg-muted", "rounded-full", "p-4", "{expr}"]) expect([c, layoutOnly(c)]).toEqual([c, false]);
  });

  it("reads an app in another checkout, rolls part uses up to their component, and summarises the inventory", () => {
    const system = dir({
      "package.json": JSON.stringify({ name: "acme-ds", private: true }),
      "ui/package.json": JSON.stringify({ name: "@acme/ui", main: "src/index.ts" }),
      "ui/src/index.ts": "export { Dialog, DialogTitle } from './dialog';\nexport { Badge } from './badge';\n",
      "ui/src/dialog.tsx": "export function Dialog() { return null }\nexport function DialogTitle() { return null }\n",
      "ui/src/badge.tsx": "export function Badge() { return null }\n",
    });
    const app = dir({
      "src/page.tsx": "import { Dialog, DialogTitle } from '@acme/ui';\nexport function Page() {\n  return <Dialog className=\"w-full\"><DialogTitle className=\"text-red-500\" /></Dialog>\n}\n",
    });
    const config = parseConfig({ system: { name: "acme", packages: ["@acme/ui"] } });
    const reading = readRepo({ root: system, config, include: ["**/*.tsx"], extraDirs: [app] });
    const rows = instancesFromReading(reading, system, { name: "app", role: "consumer", dir: app } as any, "acme");
    expect(rows.map((r) => [r.component, r.overrides])).toEqual([["Dialog", []], ["Dialog.Title", ["className"]]]);
    const s = modelSummary(reading, system, config);
    expect(s.counts).toMatchObject({ components: 2, parts: 1 });
    const dialog = s.components.find((c) => c.name === "Dialog")!;
    expect(dialog.uses).toMatchObject({ consumer: 2, files: 1 });
    expect(dialog.evidence.tier).toBe("export");
    expect(s.components.find((c) => c.name === "Badge")!.uses.consumer).toBe(0);
  });
});
