import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { parseTs } from "./extract.js";
import { archetypes } from "./kinds.js";
import type { Concept, Evidence, Tier } from "./types.js";

/**
 * Facets of each concept: its variant axes (a closed set of values one prop or class picks from) and its
 * parts (the named pieces of its anatomy). Read from whatever the system writes:
 *
 *   axes   TypeScript string-literal unions on props (resolving type aliases across the system),
 *          Lit/Angular class properties and `input<…>()`, Vue `PropType<…>`, React `PropTypes.oneOf`,
 *          cva / tailwind-variants recipes, and stylesheet modifier classes (block--x, block-x)
 *   parts  sub-components (DialogTitle, AcCardTitle, Object.assign(Root, { Item })), `data-slot` and
 *          `data-part` values, `part="…"`, `@csspart` / `@slot` doc tags, and BEM elements (block__x)
 */

// Props that set behaviour or HTML attributes, not a visual variant.
const NON_VISUAL = /^(type|as|role|target|rel|method|enc[Tt]ype|autoComplete|autocomplete|inputMode|inputmode|enterKeyHint|dir|loading|decoding|crossOrigin|referrerPolicy|wrap|spellCheck|spellcheck|autoCapitalize|autocapitalize|lang|translate|form[A-Z]\w*|aria[A-Z-]\w*|data[A-Z-]\w*|on[A-Z]\w*|key|ref|id|name|value|defaultValue|tabIndex|component|tag|mode)$/;

// Words that name a piece of a component, never a component of its own.
const ANATOMY_WORDS = new Set(["title", "subtitle", "header", "footer", "body", "content", "item", "items", "trigger", "label", "description", "icon", "close", "actions", "action", "panel", "list", "separator", "divider", "indicator", "thumb", "track", "root", "positioner", "backdrop", "overlay", "portal", "arrow", "control", "text", "summary", "details", "media", "image", "prefix", "suffix", "addon", "section", "cell", "row", "head", "caption", "value", "heading", "start", "end", "viewport", "scrollbar", "corner", "handle", "fallback", "container", "wrapper", "inner", "outer", "heading", "legend", "hint", "message", "helper", "slot", "subheader", "subcontent", "subtrigger", "marker", "range", "tick", "dot", "skeleton", "placeholder", "chevron", "ellipsis"]);

export interface ClassExtension {
  block: string;
  ext: string;
  kind: "element" | "modifier" | "dash";
  evidence: Evidence;
}

export function addFacets(root: string, sources: string[], concepts: Concept[], texts: Map<string, string>, extensions: ClassExtension[]) {
  const aliases = typeAliases(root, sources, texts);
  const ast = new Map<string, any>();
  const parse = (file: string) => {
    if (!ast.has(file)) {
      const text = texts.get(file) ?? read(file);
      // Single-file components: parse their script blocks (blank the rest so lines stay true).
      const script = text && /\.(svelte|vue)$/.test(file) ? text.replace(/<script\b[^>]*>([\s\S]*?)<\/script>|[\s\S]/g, (m, body) => (body !== undefined ? " ".repeat(m.length - body.length - 9) + body + "         " : m === "\n" ? "\n" : " ")) : undefined;
      ast.set(file, script ? parseTs(script, `${file}.ts`) : text && /\.(tsx?|jsx?|mjs)$/.test(file) ? parseTs(text, file) : undefined);
    }
    return ast.get(file);
  };
  const ev = (file: string, line: number | undefined, extractor: string, tier: Tier): Evidence => ({ file: path.relative(root, file), line, extractor, tier });

  for (const c of concepts) {
    const axes = new Map<string, { values: Set<string>; evidence: Evidence }>();
    const parts = new Map<string, Evidence>();
    const addAxis = (name: string, values: string[], e: Evidence) => {
      const vs = values.filter((v) => v.length > 0 && v.length <= 40);
      if (vs.length < 2 || vs.length > 40 || NON_VISUAL.test(name)) return;
      const a = axes.get(name) ?? { values: new Set<string>(), evidence: e };
      for (const v of vs) a.values.add(v);
      axes.set(name, a);
    };
    const addPart = (name: string, e: Evidence) => { if (name && !parts.has(name)) parts.set(name, e); };

    // The concept's files, and siblings named after it (Button.d.ts, button.types.ts, ButtonProps.ts).
    const own = [...new Set(c.realizations.map((r) => r.evidence.file).filter((f) => !f.startsWith("(")))].map((f) => path.resolve(root, f));
    const files = new Set(own);
    for (const f of own) {
      const dir = path.dirname(f);
      try {
        for (const s of fs.readdirSync(dir)) if (/\.(d\.ts|ts|tsx)$/.test(s) && norm(s).includes(c.key) && !/\.(test|spec|stories)\./.test(s)) files.add(path.join(dir, s));
      } catch { /* gone */ }
    }
    const names = new Set([c.name, ...c.realizations.flatMap((r) => (r.form === "import" ? [r.symbol] : []))]);
    // Follow what the concept's own files import: same-folder modules (its types, its base), and the
    // modules behind spread prop factories (`...makeVariantProps()`), one hop.
    // Two hops: a re-exported definition, then the shared definitions it spreads in.
    for (let hop = 0; hop < 2; hop++) for (const f of [...files]) {
      const tree = parse(f);
      if (!tree) continue;
      const imports = new Map<string, string>();
      for (const st of tree.program.body) {
        if (st.type !== "ImportDeclaration") continue;
        const target = resolveImport(f, String(st.source.value));
        if (target) for (const sp of st.specifiers ?? []) imports.set(sp.local.name, target);
      }
      for (const target of new Set(imports.values())) if (path.dirname(target) === path.dirname(f)) files.add(target);
      // `export { basePropDefs as buttonPropDefs } from './_internal/base.props'`: the definition is there.
      for (const st of tree.program.body) if (st.type === "ExportNamedDeclaration" && typeof st.source?.value === "string") { const t = resolveImport(f, st.source.value); if (t) files.add(t); }
      visit(tree.program, (n) => {
        if (n.type !== "SpreadElement") return;
        const name = n.argument?.type === "CallExpression" ? n.argument.callee?.name : n.argument?.type === "Identifier" ? n.argument.name : undefined;
        if (name && imports.has(name)) files.add(imports.get(name)!);
      });
    }
    for (const file of files) {
      const tree = parse(file);
      if (!tree) continue;
      readProps(tree, names, aliases, (name, values, line) => addAxis(name, values, ev(file, line, "prop-union", "declaration")));
      readRecipes(tree, (name, values, line) => addAxis(name, values, ev(file, line, "variant-recipe", "declaration")));
      readMembers(tree, names, (name, line) => addPart(name, ev(file, line, "sub-component-member", "declaration")));
      readNamedKeys(tree, names, aliases, (name, kind, line) => {
        // Class keys mix parts with variant/state combinations (containedPrimary, focusVisible): keep the parts.
        if (kind === "classes" && (/^(focus|focusVisible|disabled|active|selected|checked|expanded|error|readOnly|required|hover)/.test(name) || /[a-z](Small|Medium|Large|Primary|Secondary|Inherit|Error|Info|Success|Warning|Default)$/.test(name) || [...axes.keys()].some((a) => name.startsWith(a) && name.length > a.length))) return;
        addPart(name, ev(file, line, kind === "classes" ? "class-keys" : "slot-types", "declaration"));
      });
      const text = texts.get(file) ?? read(file) ?? "";
      for (const m of text.matchAll(/@(csspart|slot)\s+([\w-]+)/g)) addPart(m[2]!, ev(file, lineAt(text, m.index!), `doc-${m[1]}`, "declaration"));
      for (const m of text.matchAll(/\bpart=["']([\w\s-]+)["']/g)) for (const p of m[1]!.split(/\s+/)) addPart(p, ev(file, lineAt(text, m.index!), "css-part", "declaration"));
    }
    if (axes.size) c.axes = [...axes].map(([name, a]) => ({ name, values: [...a.values], evidence: a.evidence }));
    if (parts.size) c.parts = [...parts].map(([name, evidence]) => ({ name, evidence }));
  }

  // Central theme files: recipes kept apart from the component (Chakra `defineRecipe` / `defineSlotRecipe`,
  // Panda `sva`, Nuxt UI's tailwind-variants themes, any `{ variants: { axis: { value: … } } }` object),
  // matched to a concept by its variable or file name (badgeRecipe, theme/badge.ts) or its className.
  const byKey = new Map(concepts.filter((c) => c.role !== "style").map((c) => [c.key, c]));
  for (const [file, text] of texts) {
    if (!/\.(tsx?|jsx?|mjs)$/.test(file) || !/\bvariants\s*:/.test(text)) continue;
    const tree = parse(file);
    if (!tree) continue;
    readThemeRecipes(tree, path.basename(file).replace(/\.[^.]+$/, ""), (owners, recipe) => {
      const c = owners.map((o) => byKey.get(o)).find(Boolean);
      if (!c) return;
      for (const a of recipe.axes) {
        const vs = a.values.filter((v) => v.length > 0 && v.length <= 40);
        if (vs.length < 2 || vs.length > 40 || NON_VISUAL.test(a.name)) continue;
        c.axes ??= [];
        const have = c.axes.find((x) => x.name === a.name);
        if (have) have.values = [...new Set([...have.values, ...vs])];
        else c.axes.push({ name: a.name, values: vs, evidence: ev(file, a.line, "theme-recipe", "declaration") });
      }
      for (const p of recipe.parts) {
        c.parts ??= [];
        if (!c.parts.some((x) => x.name === p.name)) c.parts.push({ name: p.name, evidence: ev(file, p.line, "recipe-slots", "declaration") });
      }
    });
  }

  // CSS-module classes are a component's private pieces: the classes in Button.module.css are Button's parts.
  const byFileName = new Map(concepts.filter((c) => c.role === "component").map((c) => [norm(c.name), c]));
  for (const [file, text] of texts) {
    const m = file.match(/([^/\\]+)\.module\.(s?css|less)$/);
    const owner = m ? byFileName.get(norm(m[1]!)) : undefined;
    if (!owner) continue;
    for (const cm of text.matchAll(/(?:^|[\s,}])\.([A-Za-z][\w-]*)(?=[\s,{:.[>+~)])/gm)) {
      const name = cm[1]!;
      if (norm(name) === owner.key || /^(is|has)[A-Z-]|^(disabled|active|selected|open|loading|hidden|visible)$/i.test(name)) continue;
      owner.parts ??= [];
      if (!owner.parts.some((p) => p.name === name)) owner.parts.push({ name, evidence: ev(file, lineAt(text, cm.index!), "css-module-class", "style") });
    }
  }

  // A family of sub-components with no declared parent implies it (DialogTitle, DialogContent, DialogActions →
  // Dialog, when only a service or a function opens it). Its parts come from the family below.
  const familyOf = (n: string) => { const f = n.replace(/[A-Z][a-z0-9]*$/, ""); return /[A-Z][a-z]/.test(f) ? f : undefined; };
  const families = new Map<string, Concept[]>();
  for (const c of concepts) {
    const f = c.role !== "style" && /^[A-Z]/.test(c.name) ? familyOf(c.name) : undefined;
    if (!f) continue;
    const k = `${c.library ?? ""}|${f}`;
    families.set(k, [...(families.get(k) ?? []), c]);
  }
  for (const [k, members] of families) {
    const [library, prefix] = k.split("|") as [string, string];
    if (members.length < 2 || concepts.some((c) => c.name === prefix && (c.library ?? "") === library)) continue;
    // The parent's key is what every member's key shares once its own suffix is removed (AcDialogTitle → dialog).
    const heads = members.map((m) => { const suf = norm(m.name.slice(prefix.length)); return m.key.endsWith(suf) ? m.key.slice(0, m.key.length - suf.length) : ""; });
    const parentKey = heads[0];
    if (!parentKey || heads.some((h) => h !== parentKey) || concepts.some((c) => c.key === parentKey)) continue;
    concepts.push({ key: parentKey, name: prefix, role: "component", ...(library ? { library } : {}), realizations: [{ form: "import", symbol: prefix, evidence: { ...members[0]!.realizations[0]!.evidence, extractor: "compound-family", tier: "convention" } }] });
  }

  // Sub-components are parts of their parent: DialogTitle of Dialog, AcCardTitle of AcCard (same library).
  // They leave the inventory (role "part"), unless the name is itself a kind's name (TextInput beside Text).
  const kindNames = new Set(Object.values(archetypes().kinds).flatMap((k) => [k.prefLabel, ...k.altLabels].map(norm)));
  const byName = [...concepts].sort((a, b) => b.name.length - a.name.length);
  for (const child of concepts) {
    if (child.role === "style") continue;
    const parent = byName.find((p) => p !== child && p.role !== "style" && p.library === child.library && child.name.startsWith(p.name) && /^[A-Z]/.test(child.name.slice(p.name.length)));
    if (!parent) continue;
    const part = child.name.slice(parent.name.length);
    // A part only when the extension ends in a word of anatomy (DialogTitle, MenuItem, TabsTrigger), not a
    // word that makes another component (ButtonGroup, InputNumber, TreeView, ColorPicker).
    const lastWord = part.match(/[A-Z][a-z0-9]*$/)?.[0]?.toLowerCase() ?? "";
    if (ANATOMY_WORDS.has(lastWord) && !kindNames.has(norm(child.name)) && !kindNames.has(child.key)) { child.role = "part"; child.partOf = parent.key; }
    parent.parts ??= [];
    if (!parent.parts.some((p) => p.name === part)) parent.parts.push({ name: part, evidence: { ...child.realizations[0]!.evidence, extractor: "sub-component", tier: "convention" } });
  }

  // `data-slot="dialog-title"` and `data-part="title"` name parts of the concept whose name they start with.
  const kebab = (s: string) => s.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  for (const file of new Set(concepts.flatMap((c) => c.realizations.map((r) => r.evidence.file)).filter((f) => !f.startsWith("(")))) {
    const text = texts.get(path.resolve(root, file)) ?? read(path.resolve(root, file));
    if (!text) continue;
    // `data-component="Dialog.Header"`: the part after the dot.
    for (const m of text.matchAll(/data-component=["']([A-Z]\w*)\.([A-Z]\w*)["']/g)) {
      const owner = concepts.find((c) => c.name === m[1] && c.role !== "style");
      if (owner) { owner.parts ??= []; if (!owner.parts.some((p) => p.name === m[2])) owner.parts.push({ name: m[2]!, evidence: { file, line: lineAt(text, m.index!), extractor: "data-component", tier: "declaration" } }); }
    }
    for (const m of text.matchAll(/data-(?:slot|part)=["'{]+([a-z][\w-]*)["'}]/g)) {
      const v = m[1]!;
      const owner = byName.find((c) => c.role !== "style" && v.startsWith(`${kebab(c.name)}-`));
      if (owner) {
        owner.parts ??= [];
        const part = v.slice(kebab(owner.name).length + 1);
        if (!owner.parts.some((p) => p.name === part)) owner.parts.push({ name: part, evidence: { file, line: lineAt(text, m.index!), extractor: "data-slot", tier: "declaration" } });
      }
    }
  }

  // Template macros: the object-typed options in the component's parameter file are its parts (label, hint, errorMessage).
  for (const c of concepts) for (const r of c.realizations) {
    if (r.form !== "macro") continue;
    const dir = path.dirname(path.resolve(root, r.evidence.file));
    for (const f of ["macro-options.json", `${path.basename(dir)}.yaml`, "params.yaml"]) {
      const text = read(path.join(dir, f));
      if (!text) continue;
      const items = f.endsWith(".json") ? safeJson(text) : yamlParams(text);
      for (const p of items ?? []) if (p.type === "object" && p.name && !/^(attributes|classes|html|text)$/.test(p.name)) {
        c.parts ??= [];
        if (!c.parts.some((x) => x.name === p.name)) c.parts.push({ name: p.name, evidence: { file: path.relative(root, path.join(dir, f)), extractor: "macro-params", tier: "manifest" } });
      }
    }
  }

  // Stylesheet extensions: block__x is a part, block--x a modifier, block-x either (decided where it's used).
  const byBlock = new Map<string, Concept>();
  for (const c of concepts) for (const r of c.realizations) if (r.form === "class") byBlock.set(r.block, c);
  for (const x of extensions) {
    const c = byBlock.get(x.block);
    if (!c) continue;
    const value = x.ext;
    if (x.kind !== "modifier") { c.parts ??= []; if (!c.parts.some((p) => p.name === value)) c.parts.push({ name: value, evidence: x.evidence }); }
    if (x.kind !== "element") {
      c.axes ??= [];
      let a = c.axes.find((ax) => ax.name === "modifier");
      if (!a) { a = { name: "modifier", values: [], evidence: x.evidence }; c.axes.push(a); }
      if (!a.values.includes(value)) a.values.push(value);
    }
  }
  // A class system's modifiers are one list (btn-primary, btn-outline, btn-sm, btn-wide). Split them by
  // meaning with the archetypes' variant vocabulary: size, orientation, shape, tone, emphasis. A group needs
  // two values; the full `modifier` list stays as written.
  const vocab = archetypes().variantVocabulary;
  const order = ["size", "orientation", "shape", "tone", "emphasis"].filter((k) => vocab[k]);
  const claim = (v: string) => order.find((k) => Object.values(vocab[k]!.values).flat().includes(v.toLowerCase()));
  for (const c of concepts) {
    const mod = c.axes?.find((a) => a.name === "modifier");
    if (!mod) continue;
    const groups = new Map<string, string[]>();
    for (const v of mod.values) { const k = claim(v); if (k) groups.set(k, [...(groups.get(k) ?? []), v]); }
    for (const [k, vs] of groups) {
      if (vs.length < 2 || c.axes!.some((a) => a.name === k)) continue;
      c.axes!.push({ name: k, values: vs, evidence: { ...mod.evidence, extractor: "modifier-vocabulary" } });
    }
  }
}

// ---------- readers ----------

/** `type Variant = 'a' | 'b' | Other` across the system's TypeScript, resolved through references. */
function typeAliases(root: string, sources: string[], texts: Map<string, string>): Map<string, string[]> {
  const raw = new Map<string, { lits: string[]; refs: string[] }>();
  const files = new Set<string>([...texts.keys()].filter((f) => /\.tsx?$/.test(f)));
  for (const dir of sources) for (const f of fg.sync("**/*.d.ts", { cwd: path.resolve(root, dir), absolute: true, ignore: ["**/node_modules/**/node_modules/**"] })) files.add(f);
  for (const f of files) {
    const text = texts.get(f) ?? read(f);
    if (!text) continue;
    const constArrays = new Map<string, string[]>();
    for (const m of text.matchAll(/\bconst\s+(\w+)\s*=\s*\[([^\]]*)\]\s*as\s+const/g)) constArrays.set(m[1]!, [...m[2]!.matchAll(/['"]([\w-]+)['"]/g)].map((x) => x[1]!));
    // Ends at a semicolon, or at a line break not followed by a continuation (no-semicolon styles).
    for (const m of text.matchAll(/\btype\s+([A-Z]\w*)(?:<[^>]*>)?\s*=\s*([^;=]+?)(?:;|\n(?!\s*[|&]))/g)) {
      const body = m[2]!;
      const tof = body.match(/typeof\s+(\w+)\s*\[\s*number\s*\]/);
      if (tof && constArrays.has(tof[1]!)) { raw.set(m[1]!, { lits: constArrays.get(tof[1]!)!, refs: [] }); continue; }
      const lits = [...body.matchAll(/['"]([\w-]+)['"]/g)].map((x) => x[1]!);
      const refs = [...body.matchAll(/\b([A-Z]\w*)\b/g)].map((x) => x[1]!);
      if (lits.length || refs.length) raw.set(m[1]!, { lits, refs });
    }
  }
  const out = new Map<string, string[]>();
  const resolve = (name: string, seen: Set<string>): string[] => {
    if (out.has(name)) return out.get(name)!;
    const r = raw.get(name);
    if (!r || seen.has(name)) return [];
    seen.add(name);
    const vals = [...new Set([...r.lits, ...r.refs.flatMap((x) => resolve(x, seen))])];
    out.set(name, vals);
    return vals;
  };
  for (const name of raw.keys()) resolve(name, new Set());
  return out;
}

/** String-literal values a type node allows, resolving referenced aliases. */
function literalsOf(t: any, aliases: Map<string, string[]>): string[] {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "TSLiteralType" && typeof n.literal?.value === "string") out.push(n.literal.value);
    else if (n.type === "TSTypeReference" && n.typeName?.type === "Identifier") {
      const a = aliases.get(n.typeName.name);
      if (a) out.push(...a);
    }
    for (const k in n) {
      if (k === "loc" || k === "start" || k === "end") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string") walk(v);
    }
  };
  walk(t);
  return [...new Set(out)];
}

/** Props with a closed set of string values. When the file declares `<Name>Props`, only its members count. */
function readProps(tree: any, names: Set<string>, aliases: Map<string, string[]>, add: (name: string, values: string[], line?: number) => void) {
  const propsTypes = new Set([...names].flatMap((n) => [`${n}Props`, `${n}OwnProps`, `${n}BaseProps`]));
  let scoped: any[] | undefined;
  visit(tree.program, (n) => {
    if ((n.type === "TSInterfaceDeclaration" || n.type === "TSTypeAliasDeclaration") && propsTypes.has(n.id?.name)) (scoped ??= []).push(n);
  });
  // The scoped types first; if they carry no closed sets (built from other types), the whole file.
  let found = 0;
  const counted = (name: string, values: string[], line?: number) => { if (values.length >= 2) found++; add(name, values, line); };
  // `const sizes = ['1', '2'] as const`: arrays a prop definition may name.
  const arrays = new Map<string, string[]>();
  visit(tree.program, (n) => {
    const init = n.type === "VariableDeclarator" ? (n.init?.type === "TSAsExpression" ? n.init.expression : n.init) : undefined;
    if (init?.type === "ArrayExpression" && n.id?.name) arrays.set(n.id.name, init.elements.filter((e: any) => e?.type === "StringLiteral").map((e: any) => e.value));
  });
  for (const roots of scoped ? [scoped, [tree.program]] : [[tree.program]]) {
    if (found) break;
    for (const r of roots) readPropsIn(r, aliases, counted, arrays);
  }
}

function readPropsIn(r: any, aliases: Map<string, string[]>, add: (name: string, values: string[], line?: number) => void, arrays = new Map<string, string[]>()) {
  visit(r, (n) => {
    const keyName = n.key?.name ?? n.key?.value;
    if ((n.type === "TSPropertySignature" || n.type === "ClassProperty" || n.type === "ClassAccessorProperty" || n.type === "PropertyDefinition") && keyName) {
      const t = n.typeAnnotation?.typeAnnotation ?? n.value?.typeParameters ?? n.value?.typeArguments;
      if (t) add(keyName, literalsOf(t, aliases), n.loc?.start.line);
      // Angular signal inputs: `variant = input<'a' | 'b'>()`.
      if (!t && n.value?.type === "CallExpression" && /^(input|model)$/.test(n.value.callee?.name ?? n.value.callee?.object?.name ?? "")) add(keyName, literalsOf(n.value.typeParameters ?? n.value.typeArguments, aliases), n.loc?.start.line);
    }
    if (n.type === "ObjectProperty" && keyName) {
      // Vue: `variant: { type: String as PropType<Variant> }`; React: `kind: PropTypes.oneOf([...])`.
      const v = n.value;
      if (v?.type === "ObjectExpression") for (const p of v.properties ?? []) if ((p.key?.name === "type") && p.value?.type === "TSAsExpression") add(keyName, literalsOf(p.value.typeAnnotation, aliases), n.loc?.start.line);
      if (v?.type === "CallExpression" && v.callee?.property?.name === "oneOf" && v.arguments?.[0]?.type === "ArrayExpression") add(keyName, v.arguments[0].elements.filter((e: any) => e?.type === "StringLiteral").map((e: any) => e.value), n.loc?.start.line);
      // Prop definition objects: `size: { type: 'enum', values: sizes }` (Radix-style PropDefs).
      if (v?.type === "ObjectExpression" && v.properties?.some((p: any) => p.key?.name === "type" && p.value?.value === "enum")) {
        const vals = v.properties.find((p: any) => p.key?.name === "values")?.value;
        const list = vals?.type === "ArrayExpression" ? vals.elements.filter((e: any) => e?.type === "StringLiteral").map((e: any) => e.value) : vals?.type === "Identifier" ? arrays.get(vals.name) ?? [] : [];
        add(keyName, list, n.loc?.start.line);
      }
    }
  });
}

/**
 * Keys of the concept's named shape types: `<Name>Slots` and the type given to `genericComponent<…>()`
 * (slots), `<Name>Classes` (styleable parts), and a `slots` prop's object type.
 */
function readNamedKeys(tree: any, names: Set<string>, aliases: Map<string, string[]>, add: (name: string, kind: "slots" | "classes", line?: number) => void) {
  const slotTypes = new Set([...names].map((n) => `${n}Slots`));
  const classTypes = new Set([...names].map((n) => `${n}Classes`));
  // Pass-through options (PrimeVue `ButtonPassThroughOptions`): one key per styleable part, plus plumbing.
  const passTypes = new Set([...names].map((n) => `${n}PassThroughOptions`));
  const decls = new Map<string, any>();
  visit(tree.program, (n) => { if ((n.type === "TSInterfaceDeclaration" || n.type === "TSTypeAliasDeclaration") && n.id?.name) decls.set(n.id.name, n); });
  const keysOf = (n: any): { name: string; line?: number }[] => {
    const body = n?.body?.body ?? n?.typeAnnotation?.members ?? n?.members ?? [];
    return body.map((m: any) => ({ name: m.key?.name ?? m.key?.value, line: m.loc?.start.line })).filter((k: any) => k.name);
  };
  for (const [name, d] of decls) {
    if (slotTypes.has(name)) for (const k of keysOf(d)) add(k.name, "slots", k.line);
    if (classTypes.has(name)) for (const k of keysOf(d)) add(k.name, "classes", k.line);
    if (passTypes.has(name)) for (const k of keysOf(d)) if (!/^(hooks|directives|transition|global|motion)$/.test(k.name)) add(k.name, "slots", k.line);
  }
  // Styles API selector names (Mantine `type ButtonStylesNames = 'root' | 'inner' | 'label'`): one per part.
  for (const n of names) {
    const d = decls.get(`${n}StylesNames`);
    for (const v of d ? literalsOf(d.typeAnnotation, aliases) : []) add(v, "slots", d.loc?.start.line);
  }
  visit(tree.program, (n) => {
    // genericComponent<OverlaySlots>()({ name: … }): the slots type it's given.
    if (n.type === "CallExpression" && n.callee?.type === "CallExpression" && n.callee.callee?.name === "genericComponent") {
      const t = (n.callee.typeParameters ?? n.callee.typeArguments)?.params?.[0];
      const ref = t?.type === "TSTypeReference" ? decls.get(t.typeName?.name) : t;
      for (const k of keysOf(ref)) add(k.name, "slots", k.line);
    }
    // A `slots` prop with an object type: its keys.
    if ((n.type === "TSPropertySignature") && (n.key?.name === "slots") && n.typeAnnotation?.typeAnnotation?.type === "TSTypeLiteral") for (const k of keysOf(n.typeAnnotation.typeAnnotation)) add(k.name, "slots", k.line);
  });
}

/** `cva(base, { variants: { size: { sm, lg } } })`, `tv({ variants: … })`. */
function readRecipes(tree: any, add: (name: string, values: string[], line?: number) => void) {
  visit(tree.program, (n) => {
    if (n.type !== "CallExpression" || !/^(cva|tv)$/.test(n.callee?.name ?? "")) return;
    for (const arg of n.arguments ?? []) {
      if (arg?.type !== "ObjectExpression") continue;
      const variants = arg.properties?.find((p: any) => (p.key?.name ?? p.key?.value) === "variants");
      for (const axis of variants?.value?.properties ?? []) {
        const name = axis.key?.name ?? axis.key?.value;
        const values = (axis.value?.properties ?? []).map((v: any) => String(v.key?.name ?? v.key?.value ?? "")).filter(Boolean);
        if (name) add(name, values, axis.loc?.start.line);
      }
    }
  });
}

interface Recipe { axes: { name: string; values: string[]; line?: number }[]; parts: { name: string; line?: number }[] }

/**
 * Recipe objects anywhere in a file: an object whose `variants` maps axes to objects of values. Its owner is
 * the variable that holds it (minus Recipe/Theme/Styles/Variants), its `className` (minus the system stem),
 * or, for a default export, the file. Parts are its `slots` (keys or strings), else a slot recipe's `base` keys.
 */
function readThemeRecipes(tree: any, fileBase: string, found: (owners: string[], recipe: Recipe) => void) {
  const key = (n: any) => n?.key?.name ?? n?.key?.value;
  const owner = (s: string) => norm(s.replace(/(Slot)?(Recipe|Theme|Styles?|Variants?|Config)$/, ""));
  const isRecipe = (o: any) => {
    const v = o?.properties?.find((p: any) => key(p) === "variants")?.value;
    return v?.type === "ObjectExpression" && v.properties.some((p: any) => p.value?.type === "ObjectExpression");
  };
  const firstRecipe = (node: any): any => {
    let hit: any;
    visit(node, (n) => { if (!hit && n.type === "ObjectExpression" && isRecipe(n)) hit = n; });
    return hit;
  };
  const read = (o: any, slotCall: boolean): Recipe => {
    const prop = (k: string) => o.properties.find((p: any) => key(p) === k)?.value;
    const axes = (prop("variants")?.properties ?? []).filter((p: any) => p.value?.type === "ObjectExpression").map((p: any) => ({
      name: String(key(p) ?? ""),
      values: p.value.properties.map((v: any) => String(key(v) ?? "")).filter(Boolean),
      line: p.loc?.start.line,
    })).filter((a: any) => a.name);
    const slots = prop("slots");
    let parts: Recipe["parts"] = [];
    if (slots?.type === "ObjectExpression") parts = slots.properties.map((p: any) => ({ name: String(key(p) ?? ""), line: p.loc?.start.line }));
    else if (slots?.type === "ArrayExpression") parts = slots.elements.filter((e: any) => typeof e?.value === "string").map((e: any) => ({ name: e.value, line: e.loc?.start.line }));
    else if (slotCall && prop("base")?.type === "ObjectExpression") parts = prop("base").properties.map((p: any) => ({ name: String(key(p) ?? ""), line: p.loc?.start.line }));
    return { axes, parts: parts.filter((p) => p.name) };
  };
  const className = (o: any) => { const v = o.properties.find((p: any) => key(p) === "className")?.value?.value; return typeof v === "string" ? [norm(v.replace(/^[a-z0-9]+-/, "")), norm(v)] : []; };
  const slotCall = (node: any) => { let s = false; visit(node, (n) => { if (n.type === "CallExpression" && /slot|sva/i.test(n.callee?.name ?? n.callee?.property?.name ?? "")) s = true; }); return s; };
  for (const st of tree.program.body) {
    const decl = st.type === "ExportNamedDeclaration" ? st.declaration : st;
    if (decl?.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        const o = d.init && firstRecipe(d.init);
        if (o) found([owner(d.id?.name ?? ""), ...className(o), owner(fileBase)].filter(Boolean), read(o, slotCall(d.init)));
      }
    } else if (st.type === "ExportDefaultDeclaration") {
      const o = firstRecipe(st.declaration);
      if (o) found([owner(fileBase), ...className(o)], read(o, slotCall(st.declaration)));
    }
  }
}

/** `Object.assign(Root, { Item, Group })` and `Root.Item = Item` for a concept's export. */
function readMembers(tree: any, names: Set<string>, add: (name: string, line?: number) => void) {
  visit(tree.program, (n) => {
    if (n.type === "VariableDeclarator" && names.has(n.id?.name) && n.init?.type === "CallExpression" && n.init.callee?.property?.name === "assign") {
      for (const arg of n.init.arguments.slice(1)) for (const p of arg?.properties ?? []) { const k = p.key?.name ?? p.key?.value; if (k && /^[A-Z]/.test(k)) add(k, p.loc?.start.line); }
    }
    if (n.type === "AssignmentExpression" && n.left?.type === "MemberExpression" && names.has(n.left.object?.name) && /^[A-Z]/.test(n.left.property?.name ?? "")) add(n.left.property.name, n.loc?.start.line);
  });
}

// ---------- helpers ----------

function visit(node: any, fn: (n: any) => void) {
  if (!node || typeof node.type !== "string") return;
  fn(node);
  for (const k in node) {
    if (k === "loc" || k === "start" || k === "end" || k.endsWith("Comments")) continue;
    const v = node[k];
    if (Array.isArray(v)) for (const c of v) visit(c, fn);
    else if (v && typeof v.type === "string") visit(v, fn);
  }
}

const norm = (s: string) => s.replace(/\.(d\.ts|tsx?|jsx?)$/, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** A relative import, or an in-package alias (`@/x`, `~/x`, `#/x` → the package's src/x). */
function resolveImport(from: string, spec: string): string | undefined {
  if (spec.startsWith(".")) return resolveModule(from, spec);
  const alias = spec.match(/^[@~#]\/(.*)$/);
  if (!alias) return undefined;
  for (let d = path.dirname(from); d !== path.dirname(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "package.json"))) {
      const r = resolveModule(path.join(d, "src", "x.ts"), `./${alias[1]}`);
      return fs.existsSync(r) ? r : undefined;
    }
  }
  return undefined;
}

function resolveModule(from: string, spec: string): string {
  const base = path.resolve(path.dirname(from), spec);
  const stripped = base.replace(/\.(m|c)?js$/, "");
  for (const c of [`${stripped}.ts`, `${stripped}.tsx`, `${stripped}.d.ts`, base, `${stripped}.js`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return base;
}

function safeJson(text: string): { name?: string; type?: string }[] | undefined {
  try { const j = JSON.parse(text); return Array.isArray(j) ? j : j.params; } catch { return undefined; }
}

/** Top-level `params:` entries of a component's parameter YAML: name and type. */
function yamlParams(text: string): { name: string; type: string }[] {
  const out: { name: string; type: string }[] = [];
  const top = text.split(/\n(?=\S)/).find((b) => b.startsWith("params:"));
  if (!top) return out;
  for (const m of top.matchAll(/\n  - name: ([\w-]+)\n    type: (\w+)/g)) out.push({ name: m[1]!, type: m[2]! });
  return out;
}

function read(file: string): string | undefined {
  try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
}
