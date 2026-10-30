import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { parse as babelParse } from "@babel/parser";
import type { Concept, Evidence, Realization, RealizationForm, Tier } from "./types.js";
import { addFacets, type ClassExtension } from "./facets.js";

/**
 * System-side extractors: read how a design system declares its components, in whatever form it
 * uses, into concepts and their realizations. Each extractor reads one declaration form.
 * Prefixes (acme-, acme-, Ac, X) are detected from the declarations themselves, never configured
 * by name, so nothing here knows a system.
 */

const SKIP_DIRS = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/*.d.ts", "**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/*.stories.*", "**/stories/**"];
// Stylesheets that hold settings, helpers or utilities, not components.
const NON_COMPONENT_STYLE = /(^|\/)(_?(root|variables|config|functions|utilities|helpers|reboot|maps|tokens|settings|grid|print)(\.import)?\.(s?css|less)$|(utilities|helpers|mixins|functions|vendor|settings|tools)\/|(-grid|-reboot|-utilities|\.min)\.css$)/i;

const NON_COMPONENT_LAYER = /^@layer\s+[\w.-]*\b(utilities|utility|helpers|base|reset|reboot|tokens|theme|config)\b/i;

interface Raw {
  /** For a class: the classes declared with it in one rule (its aliases). */
  group?: string[];
  name: string; // as declared: AcmeButton, AcButton, XBtn, acmeButton, Button, btn
  family: "class-name" | "tag" | "macro" | "css-class" | "export";
  form: RealizationForm;
  evidence: Evidence;
}

export interface ExtractOptions {
  /** Tag prefixes the config declares (system.tagPrefixes); more are detected. */
  tagPrefixes?: string[];
}

/** Read every declaration under the source folders. Returns concepts keyed by normalised identity. */
export function extractConcepts(root: string, sources: string[], options: ExtractOptions = {}): Concept[] {
  const raws: Raw[] = [];
  const consts = new Map<string, string>(); // `const prefix = 'ab'` and friends, for template tags
  // An installed package's code is its dist; elsewhere dist is build output to skip.
  const ignoreFor = (dir: string) => (dir.split(/[\\/]/).includes("node_modules") ? SKIP_DIRS.filter((g) => !/dist|build/.test(g)).concat("**/node_modules/**/node_modules/**", "**/*.map") : SKIP_DIRS);
  const files = sources.flatMap((dir) =>
    fg.sync("**/*.{ts,tsx,js,jsx,mjs,vue,svelte,njk,scss,css,less}", { cwd: path.resolve(root, dir), absolute: true, ignore: ignoreFor(dir) }),
  ).sort();
  // Generated selectors (Sass loops over a list) only exist in built CSS: read the nearest package's dist/.
  for (const dir of sources) {
    const pkg = nearestPackage(path.resolve(root, dir), root);
    if (pkg) for (const f of fg.sync("dist/**/*.css", { cwd: pkg, absolute: true, ignore: ["**/*.min.css"] })) if (!files.includes(f)) files.push(f);
  }
  const texts = new Map<string, string>();
  for (const f of files) {
    try { texts.set(f, fs.readFileSync(f, "utf8")); } catch { /* unreadable: skip */ }
  }
  for (const [, text] of texts) for (const m of text.matchAll(/\bconst\s+(prefix|\w*Prefix)\s*=\s*['"`]([\w-]+)['"`]/g)) consts.set(m[1]!, m[2]!);

  for (const [file, text] of texts) {
    const rel = path.relative(root, file);
    const ev = (extractor: string, tier: Tier, index?: number): Evidence => ({ file: rel, line: index === undefined ? undefined : lineAt(text, index), extractor, tier });
    const ext = path.extname(file);
    if (/\.(ts|tsx|js|jsx|mjs)$/.test(ext)) {
      webComponents(text, consts, (name, tag, i) => raws.push({ name, family: name.includes("-") ? "tag" : "class-name", form: { form: "tag", tag }, evidence: ev("custom-element", "declaration", i) }));
      angularSelectors(text, (name, sel, i) => raws.push({ name, family: "class-name", form: sel, evidence: ev("angular-selector", "declaration", i) }));
      vueComponents(text, (name, i) => raws.push({ name, family: "class-name", form: { form: "tag", tag: name }, evidence: ev("vue-component", "declaration", i) }));
      stencilComponents(text, (name, tag, i) => raws.push({ name, family: "class-name", form: { form: "tag", tag }, evidence: ev("stencil-component", "declaration", i) }));
    } else if (ext === ".vue" || ext === ".svelte") {
      // A single-file component is named by its file (Button.vue, button.svelte) unless it says otherwise.
      const base = path.basename(file, ext);
      if (!/^[+_]|^(index|app|layout|page|error)$/i.test(base) && !/\b(stories|story|examples?|demos?|docs?|test|__tests__|playground)\b/i.test(path.dirname(rel))) {
        const name = base.replace(/(^|[-_.])([a-z0-9])/g, (_, __, ch: string) => ch.toUpperCase());
        raws.push({ name, family: "class-name", form: { form: "import", symbol: name }, evidence: ev("single-file-component", "convention") });
      }
      vueComponents(text, (name, i) => raws.push({ name, family: "class-name", form: { form: "tag", tag: name }, evidence: ev("vue-component", "declaration", i) }));
    } else if (ext === ".njk") {
      for (const m of text.matchAll(/\{%-?\s*macro\s+([A-Za-z_]\w*)\s*\(/g)) raws.push({ name: m[1]!, family: "macro", form: { form: "macro", name: m[1]! }, evidence: ev("template-macro", "declaration", m.index) });
    } else if (/\.(s?css|less)$/.test(ext) && !NON_COMPONENT_STYLE.test(rel.replace(/\\/g, "/"))) {
      for (const { cls, index, group } of topLevelClasses(text)) raws.push({ name: cls, family: "css-class", form: { form: "class", block: cls }, group, evidence: ev("style-class", "style", index) });
    }
  }
  // An auto-import prefix (Nuxt modules, unplugin resolvers: `prefix: 'U'`) makes every single-file
  // component a tag with no import: Button.vue is written <UButton> or <u-button>. Convention tier.
  const prefixes = new Map<string, number>();
  for (const [, text] of texts) for (const m of text.matchAll(/\bprefix\s*:\s*['"]([A-Z][A-Za-z]{0,3})['"]/g)) prefixes.set(m[1]!, (prefixes.get(m[1]!) ?? 0) + 1);
  const autoPrefix = [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (autoPrefix) for (const r of raws.filter((x) => x.evidence.extractor === "single-file-component")) {
    raws.push({ ...r, form: { form: "tag", tag: `${autoPrefix}${r.name}` }, evidence: { ...r.evidence, extractor: "auto-import-prefix" } });
  }
  macroTemplateClasses(root, raws, texts);
  const exported = packageExports(root, sources, texts);
  raws.push(...exported);
  // A Vue system's plugin registers its exported components globally: each is also a tag, written
  // PascalCase or kebab-case, with no import (XBtn, <x-btn>). Convention tier.
  if (raws.some((r) => r.evidence.extractor === "vue-component")) {
    for (const r of exported) raws.push({ ...r, family: "class-name", form: { form: "tag", tag: (r.form as { symbol: string }).symbol }, evidence: { ...r.evidence, extractor: "vue-global-registration", tier: "convention" } });
  }
  const extensions: ClassExtension[] = [];
  const concepts = assemble(raws, options, extensions);
  addFacets(root, sources, concepts, texts, extensions);
  return concepts;
}

// ---------- declaration forms ----------

/** `X.define('acme-button')`, `customElements.define('x-y', Cls)`, `@customElement('x-y')` (with `${prefix}`). */
function webComponents(text: string, consts: Map<string, string>, add: (name: string, tag: string, index: number) => void) {
  const resolve = (raw: string) => raw.replace(/\$\{(\w+)\}/g, (_, v: string) => consts.get(v) ?? `\${${v}}`);
  const ok = (tag: string) => /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(tag);
  for (const m of text.matchAll(/\b([A-Z]\w*)\.define\(\s*['"`]([^'"`]+)['"`]/g)) { const tag = resolve(m[2]!); if (ok(tag)) add(m[1]!, tag, m.index!); }
  for (const m of text.matchAll(/customElements\.define\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\w+)/g)) { const tag = resolve(m[1]!); if (ok(tag)) add(m[2]!, tag, m.index!); }
  for (const m of text.matchAll(/@customElement\(\s*['"`]([^'"`]+)['"`]\s*\)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/g)) {
    const tag = resolve(m[1]!);
    if (ok(tag)) add(m[2]!, tag, m.index!);
  }
}

/** Stencil: `@Component({ tag: 'ion-button', … }) export class Button`. */
function stencilComponents(text: string, add: (name: string, tag: string, index: number) => void) {
  if (!/@Component\(/.test(text)) return;
  for (const m of text.matchAll(/@Component\(\s*\{([\s\S]*?)\}\s*\)\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)/g)) {
    const tag = m[1]!.match(/\btag\s*:\s*['"`]([a-z][a-z0-9]*(?:-[a-z0-9]+)+)['"`]/);
    if (tag) add(m[2]!, tag[1]!, m.index!);
  }
}

/** `@Component({ selector: 'button[acButton], ac-card' }) export class AcButton`. */
function angularSelectors(text: string, add: (name: string, sel: RealizationForm, index: number) => void) {
  if (!/@(Component|Directive)\(/.test(text)) return;
  for (const m of text.matchAll(/@(Component|Directive)\(\s*\{([\s\S]*?)\}\s*\)\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g)) {
    const sel = m[2]!.match(/selector\s*:\s*(['"`])([\s\S]*?)\1/);
    if (!sel) continue;
    for (const part of sel[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      const p = part.match(/^([a-zA-Z][\w-]*)?((?:\[[^\]]+\])*)(?::not\([^)]*\))?$/);
      if (!p) continue;
      const tag = p[1];
      const attrs = [...p[2]!.matchAll(/\[([^\]=]+)(?:=[^\]]*)?\]/g)].map((a) => a[1]!.trim());
      if (attrs.length) for (const attribute of attrs) add(m[3]!, { form: "selector", tag, attribute }, m.index!);
      else if (tag) add(m[3]!, { form: "tag", tag }, m.index!);
    }
  }
}

/** `genericComponent()({ name: 'XBtn' })`, `defineComponent({ name: 'X' })`. */
function vueComponents(text: string, add: (name: string, index: number) => void) {
  for (const m of text.matchAll(/(?:genericComponent(?:<[\s\S]*?>)?\(\)\s*\(|defineComponent\()\s*\{\s*name:\s*['"]([A-Z]\w*)['"]/g)) add(m[1]!, m.index!);
}

/**
 * Class blocks in a stylesheet: classes in rules not nested in another rule (at-rules such as
 * `@layer`, `@media` and `@include` are see-through). A selector counts only when it is exactly one
 * class (`.btn`, `.acme-button`); `.a .b`, `.a:hover` and `.a.b` describe parts and states.
 */
function topLevelClasses(text: string): { cls: string; index: number; group: string[] }[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/[^\n]*/g, (s) => s.replace(/[^\n]/g, " "));
  const out: { cls: string; index: number; group: string[] }[] = [];
  const stack: string[] = []; // the head of each open block; a rule's head doesn't start with "@"
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      // `#{…}` is Sass interpolation, not a block.
      if (src[i - 1] === "#") { const close = src.indexOf("}", i); if (close > i) { i = close; continue; } }
      const head = src.slice(start, i).trim();
      const isAt = head.startsWith("@");
      // Sass nesting under a class block: `.block { &__title {…} &--large {…} }` declares block__title, block--large.
      const parentRule = [...stack].reverse().find((h) => !h.startsWith("@"));
      const parentClass = parentRule?.match(/^\.(-?[a-zA-Z][\w-]*)$/)?.[1];
      if (!isAt && parentClass && stack.filter((h) => !h.startsWith("@")).length === 1) {
        for (const sel of head.split(",").map((s) => s.trim())) {
          const m = sel.match(/^&((?:__|--|-)[a-zA-Z0-9][\w-]*)$/);
          if (m) out.push({ cls: parentClass + m[1], index: start, group: [] });
        }
      }
      // Only classes outside any rule, and outside cascade layers that hold utilities or resets.
      if (!isAt && stack.every((h) => h.startsWith("@")) && !stack.some((h) => NON_COMPONENT_LAYER.test(h))) {
        const sels = head.split(",").map((s) => s.trim());
        // Classes declared together in one rule are one concept written several ways (.btn, .btn-solid, .btn-outline).
        const group = sels.map((sel) => sel.match(/^\.(-?[a-zA-Z][\w-]*)$/)?.[1]).filter((x): x is string => Boolean(x));
        for (const cls of group) out.push({ cls, index: start + Math.max(0, src.slice(start, i).indexOf(`.${cls}`)), group: group.length > 1 ? group : [] });
      }
      stack.push(head);
      start = i + 1;
    } else if (c === "}") {
      stack.pop();
      start = i + 1;
    } else if (c === ";") {
      start = i + 1;
    }
  }
  return out;
}

/**
 * A macro's template emits the component's root class: link them by folder, but only to the class whose
 * name matches the macro (acmeTabs → acme-tabs). A template's first class is often a child's.
 */
function macroTemplateClasses(root: string, raws: Raw[], texts: Map<string, string>) {
  const norm = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  for (const r of raws.filter((x) => x.form.form === "macro")) {
    const dir = path.dirname(path.join(root, r.evidence.file));
    for (const name of ["template.njk", "template.html"]) {
      const text = texts.get(path.join(dir, name));
      if (!text) continue;
      const classes = [...text.matchAll(/(?:classNames\s*=\s*["']|class="\s*)([a-zA-Z][\w-]*)/g)].map((m) => ({ cls: m[1]!, index: m.index! }));
      const want = norm(r.name);
      // Same name, or the same name once each loses its prefix (acme-tabs ~ acmeTabs, x-tabs ~ xTabs).
      const bare = norm(r.name.replace(/^[a-z]+(?=[A-Z])/, ""));
      const hit = classes.find((c) => !/__|--/.test(c.cls) && (norm(c.cls) === want || norm(c.cls.replace(/^[a-z0-9]+-+/, "")) === bare));
      if (hit) raws.push({ name: r.name, family: "macro", form: { form: "class", block: hit.cls }, evidence: { file: path.relative(root, path.join(dir, name)), line: lineAt(text, hit.index), extractor: "macro-template-class", tier: "declaration" } });
    }
  }
}

/**
 * Public exports. A package with an entry point (package.json `exports`/`module`/`main`, or
 * `src/index.*`) is read from that entry, following `export … from` a few hops. A folder with no
 * entry (a copy-in library) is read file by file. Only PascalCase symbols are components.
 */
function packageExports(root: string, sources: string[], texts: Map<string, string>): Raw[] {
  const out: Raw[] = [];
  for (const dir of sources) {
    const abs = path.resolve(root, dir);
    const entries = entryFiles(abs);
    const seen = new Set<string>();
    const visit = (file: string, depth: number) => {
      if (seen.has(file) || depth > 4) return;
      seen.add(file);
      const text = texts.get(file) ?? read(file);
      if (!text) return;
      const ast = parseTs(text, file);
      if (!ast) return;
      const rel = path.relative(root, file);
      const push = (name: string, node: any, from?: string) => {
        if (/^[A-Z][A-Za-z0-9]*$/.test(name)) out.push({ name, family: "export", form: { form: "import", symbol: name }, evidence: { file: from ? path.relative(root, from) : rel, line: from ? undefined : node?.loc?.start.line, extractor: "package-export", tier: "export" } });
      };
      for (const st of ast.program.body) {
        if (st.type === "ExportNamedDeclaration") {
          // Types, interfaces and enums are not components.
          if (st.exportKind === "type") continue;
          const d = st.declaration;
          if (d?.id?.name && !/^TS(InterfaceDeclaration|TypeAliasDeclaration|EnumDeclaration|ModuleDeclaration)$/.test(d.type) && d.declare !== true) push(d.id.name, d);
          for (const v of d?.declarations ?? []) if (v.id?.name) push(v.id.name, v);
          // A re-export's evidence is the module it comes from, where the component (and its props) live.
          const from = st.source?.value?.startsWith(".") ? resolveModule(file, st.source.value) : undefined;
          for (const sp of st.specifiers ?? []) if (sp.exportKind !== "type") push(sp.exported?.name ?? sp.exported?.value, sp, from);
          if (st.source?.value?.startsWith(".")) visit(resolveModule(file, st.source.value), depth + 1);
        } else if (st.type === "ExportAllDeclaration" && st.source?.value?.startsWith(".")) {
          visit(resolveModule(file, st.source.value), depth + 1);
        }
      }
    };
    if (entries.length) for (const e of entries) visit(e, 0);
    else for (const f of fg.sync("**/*.{ts,tsx,js,jsx}", { cwd: abs, absolute: true, ignore: SKIP_DIRS }).sort()) visit(f, 4);
  }
  return out;
}

function entryFiles(dir: string): string[] {
  const out = new Set<string>();
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const cands: string[] = [];
    const walk = (v: unknown) => { if (typeof v === "string") cands.push(v); else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x); };
    walk(pj.exports); // every entry point: ".", "./experimental", "./deprecated"…
    cands.push(pj.source, pj.module, pj.main);
    for (const c of cands.filter(Boolean)) {
      // Built paths point at dist; prefer the source twin.
      const src = c.replace(/^\.?\/?(dist|lib|esm|cjs|build)\//, "src/").replace(/\.(m|c)?js$/, "");
      for (const cand of [path.join(dir, c), path.join(dir, src)]) { const r = resolveModule(cand, "."); if (fs.existsSync(r) && /\.(ts|tsx|js|jsx|mjs)$/.test(r)) out.add(r); }
    }
  } catch { /* no package.json */ }
  for (const f of ["src/index.ts", "src/index.tsx", "src/index.js", "index.ts", "index.js"]) { const p = path.join(dir, f); if (fs.existsSync(p)) out.add(p); }
  return [...out].filter((f) => !/\.d\.ts$/.test(f));
}

function resolveModule(from: string, spec: string): string {
  const base = spec === "." ? from : path.resolve(path.dirname(from), spec);
  const stripped = base.replace(/\.(m|c)?js$/, "");
  for (const c of [base, `${stripped}.ts`, `${stripped}.tsx`, `${stripped}.js`, `${stripped}.jsx`, `${stripped}.mjs`, path.join(base, "index.ts"), path.join(base, "index.tsx"), path.join(base, "index.js")]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return base;
}

// ---------- assembly: detect prefixes, normalise, merge ----------

function assemble(raws: Raw[], options: ExtractOptions, extensions: ClassExtension[] = []): Concept[] {
  // A system writes one stem everywhere: acme-button / AcmeButton, acme-button / acmeButton,
  // ac-card / AcCard, ab-button / ab--btn / ABButton. Detect it once, across every family.
  const stems = systemStems(raws, options.tagPrefixes ?? []);
  const stripStem = (s: string, family: Raw["family"]) => {
    for (const st of stems) {
      if ((family === "tag" || family === "css-class") && new RegExp(`^${st}(--|-)(?=[a-z0-9])`, "i").test(s)) return s.replace(new RegExp(`^${st}(--|-)`, "i"), "");
      if ((family === "macro" || family === "class-name" || family === "export") && s.toLowerCase().startsWith(st) && /^[A-Z]/.test(s.slice(st.length)) && s.length > st.length + 1) return s.slice(st.length);
    }
    return s;
  };
  // A stylesheet block is a class other classes extend (btn → btn-primary, acme-button → acme-button--secondary);
  // a class that extends a block is a modifier or a part, decided where it's used.
  const cssNames = new Set(raws.filter((r) => r.family === "css-class").map((r) => r.name));
  const aliasOf = new Map<string, string>();
  for (const r of raws) if (r.group?.length) {
    const head = [...r.group].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;
    for (const g of r.group) if (!aliasOf.has(g)) aliasOf.set(g, head);
  }
  const isExtension = (n: string) => !aliasOf.has(n) && [...cssNames].some((b) => b !== n && (n.startsWith(`${b}-`) || n.startsWith(`${b}__`)));

  const concepts = new Map<string, Concept>();
  for (const r of raws) {
    if (r.family === "css-class" && isExtension(r.name)) {
      // Kept for facets: block__x is a part, block--x a modifier, block-x either.
      const block = [...cssNames].filter((b) => b !== r.name && (r.name.startsWith(`${b}-`) || r.name.startsWith(`${b}__`))).sort((a, b) => b.length - a.length)[0]!;
      const rest = r.name.slice(block.length);
      extensions.push({ block, ext: rest.replace(/^(__|--|-)/, ""), kind: rest.startsWith("__") ? "element" : rest.startsWith("--") ? "modifier" : "dash", evidence: r.evidence });
      continue;
    }
    const raw = r.form.form === "tag" && r.family !== "class-name" ? r.form.tag : r.family === "css-class" ? aliasOf.get(r.name) ?? r.name : r.name;
    const base = stripStem(raw, r.form.form === "tag" && r.family !== "class-name" ? "tag" : r.family);
    const key = base.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (!key) continue;
    const c = concepts.get(key) ?? { key, name: r.name, role: "component" as const, realizations: [] };
    // Prefer a declared or exported name over a class or macro name for display.
    if ((r.family === "export" || r.family === "class-name") && !/^[A-Z]/.test(c.name)) c.name = r.name;
    if (!c.realizations.some((x) => sameForm(x, r.form))) c.realizations.push({ ...r.form, evidence: r.evidence } as Realization);
    // A tag declared by a class implies its kebab tag for templates that write it either way (XBtn ⇄ x-btn).
    if (r.form.form === "tag" && /^[A-Z]/.test(r.form.tag)) {
      const kebab = r.form.tag.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      if (!c.realizations.some((x) => x.form === "tag" && x.tag === kebab)) c.realizations.push({ form: "tag", tag: kebab, evidence: { ...r.evidence, extractor: `${r.evidence.extractor}+kebab`, tier: "convention" } });
    }
    concepts.set(key, c);
  }
  // Class-only concepts are style objects when the system's own declarations (macros, exports, tags,
  // selectors) cover its classes: a quarter of class blocks merge with a declaration, or there are no
  // more class blocks than declared components. A class system with a few JS plugins keeps its classes.
  const all = [...concepts.values()];
  const withClass = all.filter((c) => c.realizations.some((r) => r.form === "class"));
  const declared = all.filter((c) => c.realizations.some((r) => r.form !== "class"));
  const merged = withClass.filter((c) => c.realizations.some((r) => r.form !== "class")).length;
  const covered = declared.length > 0 && (merged >= 0.25 * withClass.length || withClass.length <= 1.5 * declared.length);
  if (covered) for (const c of all) if (c.realizations.every((r) => r.form === "class")) c.role = "style";
  return [...concepts.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** The stem most declared names share (≥ 3 names, ≥ 50% of them), plus stems of configured tag prefixes. */
function systemStems(raws: Raw[], tagPrefixes: string[]): string[] {
  const stems = new Map<string, number>();
  let n = 0;
  for (const r of raws) {
    const name = r.form.form === "tag" && r.family !== "class-name" ? r.form.tag : r.name;
    const m = r.family === "tag" || r.family === "css-class" || (r.form.form === "tag" && name.includes("-"))
      ? name.match(/^([a-z0-9]+)(?:--|-)/)
      : r.family === "macro" ? name.match(/^([a-z]+)(?=[A-Z])/)
      : r.family === "class-name" ? name.match(/^([A-Z]+(?=[A-Z][a-z])|[A-Z][a-z]*(?=[A-Z]))/)
      : null;
    if (r.family === "export") continue;
    n++;
    if (m) stems.set(m[1]!.toLowerCase(), (stems.get(m[1]!.toLowerCase()) ?? 0) + 1);
  }
  const out = new Set(tagPrefixes.map((p) => p.replace(/-+$/, "").toLowerCase()).filter(Boolean));
  const best = [...stems.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] >= 3 && best[1] / n >= 0.5) out.add(best[0]);
  return [...out];
}

function sameForm(a: RealizationForm, b: RealizationForm): boolean {
  if (a.form !== b.form) return false;
  return JSON.stringify({ ...a, evidence: undefined }) === JSON.stringify({ ...b, evidence: undefined });
}

// ---------- helpers ----------

export function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function nearestPackage(dir: string, root: string): string | undefined {
  for (let d = dir; d.startsWith(root); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "package.json"))) return d;
    if (d === root) break;
  }
  return undefined;
}

function read(file: string): string | undefined {
  try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
}

export function parseTs(text: string, file: string): any {
  try {
    return babelParse(text, { sourceType: "module", errorRecovery: true, plugins: [/\.tsx?$/.test(file) ? "typescript" : "flow", "jsx", "decorators", "classProperties"] as any, sourceFilename: file });
  } catch {
    return undefined;
  }
}
