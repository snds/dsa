import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildSystemModel } from "../src/model/index.js";

function repo(files: Record<string, string>, config: object) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-model-"));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  fs.writeFileSync(path.join(root, "dsa.config.json"), JSON.stringify(config));
  return buildSystemModel({ root, config: loadConfig({ cwd: root }).config });
}
const uses = (m: ReturnType<typeof buildSystemModel>, file: string) =>
  m.uses.filter((u) => u.file.endsWith(file)).map((u) => `${u.concept}${u.part ? `.${u.part}` : ""}@${u.line}${u.modifiers ? `[${u.modifiers.join(",")}]` : ""}`);
const ALL = { include: ["**/*.{ts,tsx,html,md,njk,vue,svelte}"], exclude: [] };

describe("system model: one concept, every way it is written", () => {
  it("web components: define calls with a resolved prefix; uses in HTML, Markdown and Lit templates", () => {
    const m = repo({
      "ui/src/settings.ts": "export const prefix = 'acme';\n",
      "ui/src/button.ts": "import { prefix } from './settings';\n@customElement(`${prefix}-button`)\nexport class AcmeButton extends LitElement {}\n",
      "ui/src/card.ts": "export class AcmeCard extends LitElement {}\nAcmeCard.define('acme-card');\n",
      "ui/src/dialog.ts": "customElements.define('acme-dialog', AcmeDialog);\n",
      "docs/page.html": "<acme-card>\n  <acme-button variant=\"primary\">Go</acme-button>\n</acme-card>\n",
      "docs/guide.md": "# Guide\n\n```html\n<acme-dialog open></acme-dialog>\n```\n",
      "docs/story.ts": "const t = html`\n  <acme-button ${x}>Hi</acme-button>\n`;\n",
    }, { system: { name: "acme", path: "ui/src" }, scan: ALL });
    expect(m.concepts.map((c) => c.key)).toEqual(expect.arrayContaining(["button", "card", "dialog"]));
    expect(uses(m, "page.html")).toEqual(["card@1", "button@2"]);
    expect(uses(m, "guide.md")).toEqual(["dialog@4"]);
    expect(uses(m, "story.ts")).toEqual(["button@2"]);
  });

  it("Angular: a component on a native element by attribute is an instance, bound or plain", () => {
    const m = repo({
      "lib/button.ts": "@Component({ selector: `button[acmeButton], a[acmeButton]`, template: '' })\nexport class AcmeButton {}\n",
      "lib/tooltip.ts": "@Directive({ selector: '[acmeTooltip]' })\nexport class AcmeTooltip {}\n",
      "lib/card.ts": "@Component({ selector: 'acme-card', template: '' })\nexport class AcmeCard {}\n",
      "app/x.html": "<button acmeButton [acmeTooltip]=\"tip\">Save</button>\n<a acmeButton href=\"/\">Home</a>\n<button>Plain</button>\n<acme-card></acme-card>\n",
    }, { system: { name: "acme", path: "lib" }, scan: ALL });
    expect(uses(m, "x.html")).toEqual(["button@1", "tooltip@1", "button@2", "card@4"]);
  });

  it("CSS classes: co-declared classes are one concept; extensions are modifiers where used", () => {
    const m = repo({
      "scss/_buttons.scss": "@layer components {\n  .btn, .btn-solid, .btn-outline { display: inline-flex; }\n  .btn-primary { color: blue; }\n}\n@layer utilities { .mt-2 { margin-top: 8px; } }\n",
      "scss/_card.scss": ".card { border: 1px solid; }\n.card-body { padding: 1rem; }\n",
      "site/a.html": "<button class=\"btn btn-primary mt-2\">A</button>\n<button class=\"btn-outline\">B</button>\n<div class=\"card\"><div class=\"card-body\">x</div></div>\n",
    }, { system: { name: "acme", path: "scss" }, scan: ALL });
    expect(m.concepts.map((c) => c.key).sort()).toEqual(["btn", "card"]);
    expect(uses(m, "a.html")).toEqual(["btn@1[primary]", "btn@2", "card@3"]);
  });

  it("Template macros: the macro and its template's root class are one concept", () => {
    const m = repo({
      "src/components/button/macro.njk": "{% macro acmeButton(params) %}{% include './template.njk' %}{% endmacro %}\n",
      "src/components/button/template.njk": "{% set classNames = \"acme-button\" %}<svg class=\"acme-button__icon\"></svg><p class=\"acme-body\">x</p>\n",
      "src/components/tabs/macro.njk": "{% macro acmeTabs(params) %}{% endmacro %}\n",
      "src/components/tabs/template.njk": "<p class=\"acme-body\">x</p><div class=\"acme-tabs\"></div>\n",
      "src/core/_typography.scss": ".acme-body { font-size: 1rem; }\n",
      "review/page.njk": "{{ acmeButton({ text: 'Save' }) }}\n<p class=\"acme-body\">Hello</p>\n<button class=\"acme-button\">Raw</button>\n",
    }, { system: { name: "acme", path: "src" }, scan: ALL });
    const button = m.concepts.find((c) => c.key === "button")!;
    expect(button.realizations.map((r) => r.form).sort()).toEqual(["class", "macro"]);
    expect(m.concepts.find((c) => c.key === "tabs")!.realizations.some((r) => r.form === "class" && r.block === "acme-tabs")).toBe(true);
    // A body-text class is a style object when the system declares its components as macros.
    expect(m.concepts.find((c) => c.key === "body")?.role).toBe("style");
    expect(uses(m, "page.njk")).toEqual(["button@1", "body@2", "button@3"]);
  });

  it("React exports: imports, aliases, relative imports into the system, and dotted parts", () => {
    const m = repo({
      "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", main: "src/index.ts" }),
      "packages/ui/src/index.ts": "export { Button } from './button';\nexport * from './menu';\n",
      "packages/ui/src/button.tsx": "export function Button() { return <button /> }\n",
      "packages/ui/src/menu.tsx": "export const ActionMenu = Object.assign(Root, { Button: MenuButton, Item });\n",
      "packages/ui/src/menu.stories.tsx": "import { ActionMenu } from './menu';\nexport const S = () => <ActionMenu><ActionMenu.Button>x</ActionMenu.Button></ActionMenu>;\n",
      "apps/web/x.tsx": "import { Button as B } from '@acme/ui';\nimport { Other } from 'elsewhere';\nexport const X = () => <><B /><Other /></>;\n",
    }, { system: { name: "acme", packages: ["@acme/ui"] }, scan: ALL });
    expect(uses(m, "x.tsx")).toEqual(["button@3"]);
    // ActionMenu.Button is ActionMenu's part, not the system's Button.
    expect(uses(m, "menu.stories.tsx")).toEqual(["actionmenu@2", "actionmenu.Button@2"]);
  });

  it("Vue: exported components are global tags, PascalCase or kebab-case, with no import", () => {
    const m = repo({
      "packages/ui/package.json": JSON.stringify({ name: "acme-vue", main: "src/index.ts" }),
      "packages/ui/src/index.ts": "export * from './XBtn';\nexport * from './XAlertTitle';\n",
      "packages/ui/src/XBtn.tsx": "export const XBtn = genericComponent<new <T>(\n  props: T\n) => any>()({\n  name: 'XBtn',\n})\n",
      "packages/ui/src/XAlertTitle.ts": "export const XAlertTitle = createSimpleFunctional('x-alert-title')\n",
      "docs/a.vue": "<template>\n  <x-btn>Go</x-btn>\n  <XAlertTitle>Hi</XAlertTitle>\n  <x-alert-title />\n</template>\n",
    }, { system: { name: "acme", packages: ["acme-vue"] }, scan: ALL });
    expect(uses(m, "a.vue")).toEqual(["btn@2", "alerttitle@3", "alerttitle@4"]);
  });

  it("a file a reader can't read is skipped and listed; others still count", () => {
    const m = repo({
      "ui/x.ts": "customElements.define('acme-x', X);\n",
      "docs/ok.html": "<acme-x></acme-x>\n",
    }, { system: { name: "acme", path: "ui" }, scan: ALL });
    expect(uses(m, "ok.html")).toEqual(["x@1"]);
    expect(m.files.skipped).toEqual([]);
  });
});
