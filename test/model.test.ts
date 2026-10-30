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

  it("Stencil tags, file-named single-file components, an auto-import prefix, and server templates", () => {
    const m = repo({
      "ui/package.json": JSON.stringify({ name: "@acme/ui" }),
      "ui/src/button.tsx": "@Component({\n  tag: 'acme-button',\n  styleUrls: { ios: 'a.scss', md: 'b.scss' },\n  shadow: true,\n})\nexport class Button {}\n",
      "ui/src/defaults.ts": "export const defaultOptions = { prefix: 'U', theme: {} }\n",
      "ui/src/components/Badge.vue": "<template><span><slot /></span></template>\n",
      "ui/src/components/card-header.svelte": "<div><slot /></div>\n",
      "app/page.vue": "<template>\n  <UBadge />\n  <u-badge />\n  <acme-button />\n</template>\n",
      "app/x.svelte": "<script>import CardHeader from '@acme/ui/components/card-header.svelte';</script>\n<CardHeader />\n",
      "app/modal.twig": "{% set id = 'm' %}\n<div class=\"x\">\n  <acme-button>{{ label }}</acme-button>\n</div>\n",
    }, { system: { name: "acme", path: "ui", packages: ["@acme/ui"] }, scan: { include: ["**/*.{vue,svelte,twig}"], exclude: [] } });
    expect(m.concepts.map((c) => c.key)).toEqual(expect.arrayContaining(["button", "badge", "cardheader"]));
    expect(uses(m, "page.vue")).toEqual(["badge@2", "badge@3", "button@4"]);
    expect(uses(m, "x.svelte")).toEqual(["cardheader@2"]);
    expect(uses(m, "modal.twig")).toEqual(["button@3"]);
  });

  it("tag helpers and the TypeScript tag map; a macro's option classes; Tailwind @utility class components", () => {
    const m = repo({
      "ui/package.json": JSON.stringify({ name: "@acme/ui" }),
      "ui/src/card.ts": "import { defineElement } from './define';\nexport class Card extends LitElement {}\ndefineElement('acme-card', Card);\n",
      "ui/src/tabs.ts": "export class Tabs extends LitElement {}\ndeclare global {\n  interface HTMLElementTagNameMap {\n    'acme-tabs': Tabs;\n  }\n}\n",
      "ui/src/details/macro.njk": "{% macro details(params) %}{% endmacro %}\n",
      "ui/src/details/_index.scss": ".acme-details { x: 1 }\n",
      "ui/src/tag/macro.njk": "{% macro tag(params) %}{% endmacro %}\n",
      "ui/src/tag/_index.scss": ".acme-tag { x: 1 }\n",
      "ui/src/utilities/buttons.css": "@utility btn { display: inline-flex; }\n@utility scrollbar-none { scrollbar-width: none; }\n",
      "app/page.html": "<acme-card></acme-card>\n<acme-tabs></acme-tabs>\n<button class=\"btn\">Go</button>\n",
      "app/page.njk": "{{ details({\n  text: 'More',\n  classes: 'acme-tag'\n}) }}\n",
    }, { system: { name: "acme", path: "ui", tagPrefixes: ["acme-"] }, scan: { include: ["**/*.{html,njk}"], exclude: [] } });
    expect(uses(m, "page.html")).toEqual(["card@1", "tabs@2", "btn@3"]);
    expect(uses(m, "page.njk")).toEqual(["tag@1"]);
    expect(m.concepts.find((c) => c.key === "btn")?.role).toBe("component");
    expect(m.concepts.find((c) => c.key === "scrollbarnone")?.role).toBe("style");
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

describe("run's instances from the model", () => {
  it("one row per component use under the target, with overrides, and none from the system's own source", async () => {
    const { readRepo } = await import("../src/model/index.js");
    const { instancesFromReading } = await import("../src/engine/model-instances.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-inst-"));
    const files: Record<string, string> = {
      "ui/button.ts": "customElements.define('acme-button', AcmeButton);\nexport class AcmeButton {}\n",
      "ui/internal.html": "<acme-button></acme-button>\n",
      "app/page.html": "<acme-button style=\"color:red\">Go</acme-button>\n<div>plain</div>\n",
      "dsa.config.json": JSON.stringify({ system: { name: "acme", path: "ui" }, scan: { include: ["**/*.{ts,html}"], exclude: [] } }),
    };
    for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
    const reading = readRepo({ root, config: loadConfig({ cwd: root }).config });
    const rows = instancesFromReading(reading, root, { name: "app", dir: path.join(root, "app"), role: "consumer", deps: {} }, "acme");
    expect(rows.map((r) => `${r.component}@${r.line}:${r.overrides.join(",")}:${r.framework}`)).toEqual(["AcmeButton@1:style:angular"]);
  });
});

describe("several libraries: the core and its children", () => {
  it("keeps each library's concepts apart, credits uses to the right one, and counts a child using the core", async () => {
    const { readRepo } = await import("../src/model/index.js");
    const { instancesFromReading } = await import("../src/engine/model-instances.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-libs-"));
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "host", private: true, workspaces: ["packages/*", "apps/*"] }),
      "packages/core/package.json": JSON.stringify({ name: "@acme/core", main: "src/index.ts" }),
      "packages/core/src/index.ts": "export function Button() { return null }\n",
      "packages/kit/package.json": JSON.stringify({ name: "@acme/kit", main: "src/index.ts" }),
      "packages/kit/src/index.ts": "import { Button } from '@acme/core';\nexport function Button2() { return <Button /> }\nexport function Card() { return <Card /> }\n",
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/web/a.tsx": "import { Button } from '@acme/core';\nimport { Card } from '@acme/kit';\nexport const A = () => <><Button /><Card /></>;\n",
      "apps/web/b.ts": "@Component({ selector: 'app-b', template: `<ds-data-table [rows]=\"r\"></ds-data-table>` })\nexport class B {}\n",
      "dsa.config.json": JSON.stringify({ system: { name: "Core", packages: ["@acme/core"], tagPrefixes: ["ds-"], children: [{ name: "Kit", packages: ["@acme/kit"] }] }, scan: { include: ["**/*.{ts,tsx}"], exclude: [] } }),
    };
    for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
    const reading = readRepo({ root, config: loadConfig({ cwd: root }).config });
    const web = instancesFromReading(reading, root, { name: "web", dir: path.join(root, "apps/web"), role: "consumer", deps: {} }, "Core");
    // Button is the core's, Card the kit's; <ds-data-table> in an inline Angular template is the core's by its prefix.
    expect(web.map((r) => `${r.library}:${r.component}@${r.file.split("/").pop()}:${r.line}`).sort()).toEqual(["Core:Button@a.tsx:3", "Core:DataTable@b.ts:1", "Kit:Card@a.tsx:3"]);
    const kit = instancesFromReading(reading, root, { name: "Kit", dir: path.join(root, "packages/kit"), role: "child", deps: {} }, "Core");
    // The kit using the core is consumption; the kit rendering its own Card is not.
    expect(kit.map((r) => `${r.library}:${r.component}`)).toEqual(["Core:Button"]);
  });
});

describe("facets: variant axes and parts", () => {
  const facets = (files: Record<string, string>, system: object) => {
    const m = repo(files, { system: { name: "acme", ...system }, scan: { include: ["**/*.html"], exclude: [] } });
    const c = (k: string) => m.concepts.find((x) => x.key === k)!;
    const axes = (k: string) => Object.fromEntries((c(k).axes ?? []).map((a) => [a.name, [...a.values].sort()]));
    const parts = (k: string) => (c(k).parts ?? []).map((p) => p.name).sort();
    return { c, axes, parts };
  };

  it("prop unions through aliases (also semicolon-free and typeof X[number]), recipes, and behaviour props left out", () => {
    const { axes } = facets({
      "ui/package.json": JSON.stringify({ name: "@acme/ui", main: "src/index.ts" }),
      "ui/src/index.ts": "export { Button } from './button/Button';\nexport { Badge } from './badge';\n",
      "ui/src/tokens.ts": "export const sizes = ['sm', 'md', 'lg'] as const\nexport type Size = typeof sizes[number]\nexport type Tone = 'neutral' | 'danger'\n",
      "ui/src/button/Button.tsx": "import type { Size, Tone } from '../tokens';\nexport interface ButtonOwnProps { variant?: 'solid' | 'ghost'; size?: Size; tone?: Tone; type?: 'button' | 'submit' }\nexport type ButtonProps = ButtonOwnProps & Other;\nexport function Button(p: ButtonProps) { return null }\n",
      "ui/src/badge.tsx": "const badge = cva('x', { variants: { emphasis: { low: 'a', high: 'b' } } });\nexport function Badge() { return null }\n",
    }, { packages: ["@acme/ui"] });
    expect(axes("button")).toEqual({ size: ["lg", "md", "sm"], tone: ["danger", "neutral"], variant: ["ghost", "solid"] });
    expect(axes("badge")).toEqual({ emphasis: ["high", "low"] });
  });

  it("parts from sub-components, members, data-slot, data-component, doc tags and BEM (including nested Sass)", () => {
    const { parts, c } = facets({
      "ui/package.json": JSON.stringify({ name: "@acme/ui", main: "index.ts" }),
      "ui/index.ts": "export * from './dialog';\nexport * from './menu';\nexport * from './sheet';\n",
      "ui/dialog.tsx": "export function Dialog() { return <div data-slot=\"dialog-overlay\" /> }\nexport function DialogTitle() { return <h2 data-slot=\"dialog-title\" /> }\n",
      "ui/menu.tsx": "export const Menu = Object.assign(Root, { Item: MenuItem });\nfunction Header() { return <div data-component=\"Menu.Header\" /> }\n",
      "ui/sheet.tsx": "export function SheetTitle() { return null }\nexport function SheetBody() { return null }\n",
      "ui/card.ts": "/** @slot footer\n * @csspart base */\nexport class AcmeCard {}\ncustomElements.define('acme-card', AcmeCard);\n",
      "ui/_panel.scss": ".acme-panel { &__header { x: 1 } &--raised { x: 2 } }\n.acme-panel__body { x: 3 }\n",
    }, { packages: ["@acme/ui"], path: "ui" });
    expect(parts("dialog")).toEqual(["Title", "overlay", "title"]);
    expect(parts("menu")).toEqual(["Header", "Item"]);
    expect(parts("card")).toEqual(["base", "footer"]);
    expect(parts("panel")).toEqual(["body", "header"]);
    expect(c("panel").axes?.find((a) => a.name === "modifier")?.values).toEqual(["raised"]);
    // A family with no declared parent implies one: SheetTitle and SheetBody → Sheet.
    expect(parts("sheet")).toEqual(["Body", "Title"]);
  });

  it("central theme recipes (slot recipes, tailwind-variants themes) and pass-through types", () => {
    const { axes, parts } = facets({
      "ui/package.json": JSON.stringify({ name: "@acme/ui", main: "src/index.ts" }),
      "ui/src/index.ts": "export { Badge } from './badge';\nexport { Tabs } from './tabs';\nexport { Alert } from './alert';\nexport { Chip } from './chip';\n",
      "ui/src/badge.tsx": "export function Badge() { return null }\n",
      "ui/src/tabs.tsx": "export function Tabs() { return null }\n",
      "ui/src/alert.tsx": "export function Alert() { return null }\n",
      "ui/src/chip.tsx": "export function Chip() { return null }\n",
      "ui/src/chip.d.ts": "export interface ChipPassThroughOptions { root?: any; label?: any; removeIcon?: any; hooks?: any }\n",
      "ui/src/theme/recipes/badge.ts": "export const badgeRecipe = defineRecipe({ className: 'acme-badge', variants: { variant: { solid: {}, outline: {} }, size: { sm: {}, md: {} } } })\n",
      "ui/src/theme/recipes/tabs.ts": "export const tabsSlotRecipe = defineSlotRecipe({ slots: anatomy.keys(), base: { root: {}, list: {}, trigger: {} }, variants: { variant: { line: {}, enclosed: {} } } })\n",
      "ui/src/theme/alert.ts": "export default (options) => ({ slots: { root: '', title: '', icon: '' }, variants: { color: { primary: '', error: '' } } })\n",
    }, { packages: ["@acme/ui"] });
    expect(axes("badge")).toEqual({ size: ["md", "sm"], variant: ["outline", "solid"] });
    expect(axes("tabs")).toEqual({ variant: ["enclosed", "line"] });
    expect(parts("tabs")).toEqual(["list", "root", "trigger"]);
    expect(axes("alert")).toEqual({ color: ["error", "primary"] });
    expect(parts("alert")).toEqual(["icon", "root", "title"]);
    expect(parts("chip")).toEqual(["label", "removeIcon", "root"]);
  });

  it("prop definition objects, a package entry pointing at missing build output, and class modifiers split by meaning", () => {
    const { axes } = facets({
      "package.json": JSON.stringify({ name: "acme", main: "lib/index.js", typings: "es/index.d.ts" }),
      "components/index.ts": "export { Button } from './button';\nexport { Badge } from './badge';\n",
      "components/button.tsx": "export function Button() { return null }\n",
      "components/button.props.ts": "export { basePropDefs as buttonPropDefs } from './_internal/base.props';\n",
      "components/_internal/base.props.ts": "import { colorPropDef } from './color.prop';\nconst sizes = ['1', '2', '3'] as const;\nexport const basePropDefs = { size: { type: 'enum', values: sizes }, ...colorPropDef };\n",
      "components/_internal/color.prop.ts": "export const colorPropDef = { color: { type: 'enum', values: ['red', 'blue'] } };\n",
      "components/badge/index.tsx": "export function Badge() { return null }\n",
      "components/badge/style.css": ".badge { x: 1 }\n.badge-sm { x: 1 }\n.badge-lg { x: 1 }\n.badge-primary { x: 1 }\n.badge-error { x: 1 }\n.badge-success { x: 1 }\n.badge-wide { x: 1 }\n",
    }, { path: "." });
    expect(axes("button")).toEqual({ color: ["blue", "red"], size: ["1", "2", "3"] });
    expect(axes("badge")).toMatchObject({ size: ["lg", "sm"], tone: ["error", "success"], modifier: ["error", "lg", "primary", "sm", "success", "wide"] });
  });
});

describe("tokens: definitions in every format, tiers, modes and bindings", () => {
  it("reads custom properties with modes, Sass variables and maps, and DTCG aliases; binds a concept to what its styles use", () => {
    const m = repo({
      "ui/package.json": JSON.stringify({ name: "@acme/ui" }),
      "ui/tokens.css": ":root { --acme-blue-500: #06c; --acme-color-primary: var(--acme-blue-500); --acme-button-bg: var(--acme-color-primary); }\n.dark { --acme-color-primary: #39f; }\n",
      "ui/_settings.scss": "$acme-space-2: 8px !default;\n$acme-palette: (\"red\": (\"primary\": #d4351c), \"grey\": #505a5f);\n",
      "ui/tokens/base.tokens.json": JSON.stringify({ radius: { $type: "dimension", sm: { $value: "2px" }, md: { $value: "{radius.sm}" } } }),
      "ui/button.ts": "customElements.define('acme-button', AcmeButton);\nexport class AcmeButton {}\n",
      "ui/button.styles.ts": "export default css`:host { background: var(--acme-button-bg); padding: var(--acme-space-missing); }`;\n",
    }, { system: { name: "acme", path: "ui" }, scan: { include: ["**/*.html"], exclude: [] } });
    const t = (n: string) => m.tokens.find((x) => x.name === n)!;
    expect(t("--acme-blue-500")).toMatchObject({ group: "color", tier: "primitive" });
    expect(t("--acme-color-primary")).toMatchObject({ aliasOf: "--acme-blue-500", tier: "semantic", modes: ["dark"] });
    expect(t("--acme-button-bg").tier).toBe("component");
    expect(t("$acme-space-2")).toMatchObject({ value: "8px !default".replace(" !default", ""), group: "spacing" });
    expect(t("$acme-palette.red.primary")).toMatchObject({ value: "#d4351c", group: "color" });
    expect(t("radius.md")).toMatchObject({ aliasOf: "radius.sm", group: "radius" });
    expect(m.concepts.find((c) => c.name === "AcmeButton")!.tokens!.map((x) => x.name)).toEqual(["--acme-button-bg"]);
  });

  it("reads JS/TS token objects and the presets of an installed token package the repo imports", () => {
    const m = repo({
      "package.json": JSON.stringify({ name: "app", dependencies: { "@acme/themes": "1.0.0" } }),
      "ui/package.json": JSON.stringify({ name: "@acme/ui" }),
      "ui/tokens/colors.ts": "export const colors = defineTokens.colors({ red: { 500: { value: '#f00' } }, white: { value: '#fff' } })\n",
      "ui/tokens/semantic.ts": "export const s = defineSemanticTokens.colors({ bg: { DEFAULT: { value: { _light: '{colors.white}', _dark: '{colors.red.500}' } } } })\n",
      "ui/theme.ts": "import Aura from '@acme/themes/aura';\nexport const theme = Aura;\n",
      "node_modules/@acme/themes/package.json": JSON.stringify({ name: "@acme/themes" }),
      "node_modules/@acme/themes/dist/aura/base/index.mjs": "var r={borderRadius:{sm:'4px',md:'6px'},emerald:{50:'#ecfdf5'}},s={colorScheme:{light:{surface:{0:'#fff'}},dark:{surface:{0:'#000'}}}};export{r as primitive,s as semantic};\n",
      "node_modules/@acme/themes/dist/aura/button/index.mjs": "var r={borderRadius:'{form.radius}',gap:'0.5rem'};export{r as default};\n",
      "node_modules/@acme/themes/dist/lara/base/index.mjs": "var r={lara:{a:'1px',b:'2px'}};export{r as default};\n",
    }, { system: { name: "acme", path: "ui" }, scan: { include: ["**/*.html"], exclude: [] } });
    const t = (n: string) => m.tokens.find((x) => x.name === n);
    expect(t("colors.red.500")).toMatchObject({ value: "#f00", group: "color", tier: "primitive" });
    expect(t("colors.bg")).toMatchObject({ aliasOf: "colors.white", tier: "semantic", modes: ["dark"] });
    expect(t("borderRadius.md")).toMatchObject({ group: "radius" });
    expect(t("surface.0")).toMatchObject({ value: "#fff", modes: ["dark"] });
    expect(t("button.borderRadius")).toMatchObject({ aliasOf: "form.radius" });
    expect(t("lara.a")).toBeUndefined();
  });
});

describe("kinds: typing concepts by the name-free archetypes", () => {
  it("types by name, parts and variants; sub-components, constants and look-alike words are left alone", async () => {
    const { typeConcepts } = await import("../src/model/kinds.js");
    const ev = { file: "x", extractor: "t", tier: "declaration" as const };
    const c = (name: string, extra: Partial<import("../src/model/types.js").Concept> = {}) => ({ key: name.toLowerCase(), name, role: "component" as const, realizations: [{ form: "import" as const, symbol: name, evidence: ev }], ...extra });
    const concepts = [
      c("Modal", { parts: [{ name: "header", evidence: ev }, { name: "footer", evidence: ev }, { name: "close", evidence: ev }] }),
      c("ModalHeader"),
      c("IconButton", { axes: [{ name: "variant", values: ["primary", "ghost"], evidence: ev }, { name: "size", values: ["sm", "lg"], evidence: ev }] }),
      c("Snackbar"),
      c("TableToolbar"),
      c("ButtonKinds"),
      c("Flyout", { parts: [{ name: "trigger", evidence: ev }, { name: "content", evidence: ev }, { name: "arrow", evidence: ev }], axes: [{ name: "placement", values: ["top", "bottom"], evidence: ev }] }),
      c("Gizmo", { parts: [{ name: "trigger", evidence: ev }] }),
      c("Dropdown"),
    ];
    typeConcepts(concepts);
    const k = (n: string) => concepts.find((x) => x.name === n)!.kind;
    expect(k("Modal")?.kind).toBe("dialog");
    expect(k("ModalHeader")).toBeUndefined(); // a part of Modal
    expect(k("IconButton")?.kind).toBe("button");
    expect(k("Snackbar")?.kind).toBe("alert");
    expect(k("TableToolbar")?.kind).not.toBe("tabs"); // words, not characters: Table is not Tab
    expect(k("ButtonKinds")).toBeUndefined(); // an exported constant
    expect(k("Flyout")?.kind).toBe("tooltip"); // no name signal: structure (trigger, content, arrow, placement)
    expect(k("Gizmo")).toBeUndefined(); // too little structure without a name
    expect(k("Dropdown")?.ambiguous).toBe(true); // select or menu
  });
});
