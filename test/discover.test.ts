import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { discoverSources } from "../src/model/index.js";

function repo(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-discover-"));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}
const component = (name: string) => `export interface ${name}Props { variant?: 'solid' | 'ghost'; size?: 'sm' | 'lg' }\nexport function ${name}(p: ${name}Props) { return <div className="x" /> }\n`;
const NAMES = ["Button", "Card", "Dialog", "Tabs", "Badge", "Alert", "Menu", "Tooltip", "Select", "Input", "Avatar", "Switch"];

describe("finding the system's source", () => {
  const lib: Record<string, string> = {
    "package.json": JSON.stringify({ name: "acme-monorepo", private: true }),
    "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", exports: { ".": "./src/index.ts" } }),
    "packages/ui/src/index.ts": NAMES.map((n) => `export * from './${n}';`).join("\n"),
    "packages/ui/src/tokens.css": `:root {\n${Array.from({ length: 24 }, (_, i) => `  --acme-space-${i}: ${i * 4}px;`).join("\n")}\n}\n`,
    ...Object.fromEntries(NAMES.map((n) => [`packages/ui/src/${n}.tsx`, component(n)])),
    "packages/ui/src/Button.stories.tsx": "import { Button } from './Button';\nexport default { component: Button };\n",
    "packages/cli/package.json": JSON.stringify({ name: "@acme/cli", bin: "x.js", main: "x.js" }),
    "packages/cli/x.js": "console.log('hi')\n",
    "apps/web/package.json": JSON.stringify({ name: "web", private: true }),
    "apps/web/src/pages/Home.tsx": "import { Button, Card } from '@acme/ui';\nexport function Home() { return <Card><Button /></Card> }\n",
    "apps/web/src/pages/About.tsx": "import { Tabs } from '@acme/ui';\nexport function About() { return <Tabs /> }\n",
    "apps/web/src/pages/Team.tsx": "import { Avatar } from '@acme/ui';\nexport function Team() { return <Avatar /> }\n",
  };

  it("with no config, scores every folder and reads the one above the threshold; tools and apps stay out", () => {
    const root = repo(lib);
    const d = discoverSources(root, parseConfig({ system: { name: "acme" } }));
    expect(d.how).toBe("discovered");
    expect(d.accepted).toEqual(["packages/ui"]);
    const ui = d.candidates.find((c) => c.dir === "packages/ui")!;
    expect(ui.confidence).toBeGreaterThanOrEqual(0.9);
    expect(ui.signals.map((s) => s.name)).toEqual(["declarations", "uses", "surface", "variants", "tokens", "stories"]);
    expect(d.candidates.find((c) => c.dir === "packages/cli")?.confidence ?? 0).toBeLessThan(0.5);
  });

  it("the config's packages are checked first and trusted; a pinned folder wins outright", () => {
    const root = repo(lib);
    const named = discoverSources(root, parseConfig({ system: { name: "acme", packages: ["@acme/ui"] } }));
    expect(named).toMatchObject({ how: "expected", accepted: ["packages/ui"] });
    expect(named.candidates.find((c) => c.dir === "packages/ui")).toMatchObject({ expected: true, because: "named by the config" });
    const pinned = discoverSources(root, parseConfig({ system: { name: "acme", sources: ["apps/web/src"] } }));
    expect(pinned).toMatchObject({ how: "pinned", accepted: ["apps/web/src"] });
  });

  it("copy-in components inside an app are found but not read below the threshold; a person confirms", () => {
    const root = repo({
      "package.json": JSON.stringify({ name: "app", private: true }),
      ...Object.fromEntries(NAMES.slice(0, 6).map((n) => [`src/components/ui/${n.toLowerCase()}.tsx`, `function ${n}() { return null }\nexport { ${n} }\n`])),
      "src/app/page.tsx": "import { Button } from '@/components/ui/button';\nexport default function Page() { return <Button /> }\n",
    });
    const d = discoverSources(root, parseConfig({ system: { name: "app" } }));
    const ui = d.candidates.find((c) => c.dir === "src/components/ui")!;
    expect(ui).toBeDefined();
    expect(ui.signals.find((s) => s.name === "uses")!.score).toBeGreaterThan(0); // the alias import counts
    expect(d.accepted).not.toContain("src/components/ui");
    expect(discoverSources(root, parseConfig({ system: { name: "app" } }), { threshold: ui.confidence }).accepted).toContain("src/components/ui");
  });

  it("a family of scoped packages comes in together, members that hold components or tokens only", () => {
    const pkgs = NAMES.map((n) => n.toLowerCase());
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "root", private: true }),
      "packages/eslint-config/package.json": JSON.stringify({ name: "@kit/eslint-config", main: "index.js" }),
      "packages/eslint-config/index.js": "module.exports = {}\n",
      "docs/a.html": "<kit-button></kit-button><kit-card></kit-card>\n",
      "docs/b.html": "<kit-tabs></kit-tabs>\n",
      "docs/c.html": "<kit-dialog></kit-dialog>\n",
    };
    for (const p of pkgs) {
      files[`packages/${p}/package.json`] = JSON.stringify({ name: `@kit/${p}`, exports: { ".": "./src/index.ts" } });
      files[`packages/${p}/src/${p}.ts`] = `@customElement('kit-${p}')\nexport class Kit${p[0]!.toUpperCase()}${p.slice(1)} { @property() variant: 'a' | 'b' | 'c' = 'a' }\n`;
    }
    const d = discoverSources(repo(files), parseConfig({ system: { name: "kit" } }));
    expect(d.accepted).toEqual(pkgs.map((p) => `packages/${p}`).sort());
    expect(d.candidates.find((c) => c.members)?.members).toContain("packages/eslint-config");
  });
});
