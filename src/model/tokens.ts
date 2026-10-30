import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { parseTs } from "./extract.js";
import type { Concept, Evidence, Token } from "./types.js";

/**
 * Tokens: the system's named design decisions, read from every format the system writes them in.
 *
 *   CSS custom properties   `--acme-color-primary: #06c;` (with the mode a selector sets: :root, .dark, [data-theme])
 *   Sass variables          top-level `$acme-space-2: 8px;`
 *   DTCG / Style Dictionary JSON   `{ "color": { "primary": { "$value": "{color.blue.500}" } } }`
 *   JS/TS token objects     `defineTokens.colors({ red: { 500: { value: "#f00" } } })`, `defineSemanticTokens`,
 *                           `{ tokens, semanticTokens }` configs, and preset objects (`{ primitive, semantic }`)
 *   installed token packages   a dependency named for tokens, themes or presets, read from node_modules
 *                           (only the presets the repo imports, when it imports a subpath: `@x/themes/aura`)
 *
 * Each token gets an alias (when its value is another token), a group from the words in its name, and a
 * tier from the alias graph: a literal is a primitive, an alias is semantic, a name carrying a component's
 * name is a component token. Bindings: the tokens a concept's own styles reference (`var(--x)`, `$x`).
 */

const GROUPS: [Token["group"], RegExp][] = [
  ["zIndex", /(^|[-_.])(z-?index|z|layer|stack)([-_.]|$)/i],
  ["breakpoints", /(^|[-_.])(breakpoints?|bp|screen|media|viewport)([-_.]|$)/i],
  ["motion", /(^|[-_.])(duration|easing|ease|motion|transition|animation|timing|delay)([-_.]|$)/i],
  ["elevation", /(^|[-_.])(shadow|elevation|depth)([-_.]|$)/i],
  ["radius", /(^|[-_.])(radius|radii|rounded|corner)([-_.]|$)/i],
  ["typography", /(^|[-_.])(font|type|typography|text-size|line-height|leading|letter-spacing|tracking|weight|family|heading|body)([-_.]|$)/i],
  ["spacing", /(^|[-_.])(space|spacing|spacer|gap|gutter|inset|padding|margin|size|sizing|dimension)([-_.]|$)/i],
  ["color", /(^|[-_.])(color|colour|bg|background|fg|foreground|text|border|fill|stroke|surface|primary|secondary|accent|neutral|gray|grey|red|green|blue|yellow|orange|purple|danger|error|success|warning|info|brand|ring|focus|muted|destructive|hover|active)([-_.]|$)/i],
];
const COLOR_VALUE = /^(#[0-9a-f]{3,8}\b|(rgb|hsl|oklch|oklab|lab|lch|color)a?\()/i;

export function readTokens(root: string, sources: string[], concepts: Concept[]): { tokens: Token[] } {
  const files = sources.flatMap((dir) => {
    const cwd = path.resolve(root, dir);
    const inModules = dir.split(/[\\/]/).includes("node_modules");
    return fg.sync(["**/*.{css,scss,sass,less}", "**/*.tokens.json", "**/tokens/**/*.json", "**/*.tokens", "**/design-tokens/**/*.json"], {
      cwd, absolute: true,
      ignore: ["**/node_modules/**/node_modules/**", "**/*.min.css", "**/*.map", ...(inModules ? [] : ["**/node_modules/**", "**/build/**"])],
    });
  });
  // Built CSS often holds the generated variables (Sass maps compiled to --x): read the nearest package's dist too.
  for (const dir of sources) {
    let d = path.resolve(root, dir);
    while (d.startsWith(path.resolve(root)) && !fs.existsSync(path.join(d, "package.json")) && d !== path.dirname(d)) d = path.dirname(d);
    if (fs.existsSync(path.join(d, "package.json"))) for (const f of fg.sync("dist/**/*.css", { cwd: d, absolute: true, ignore: ["**/*.min.css"] })) if (!files.includes(f)) files.push(f);
  }

  // Tokens written as JS/TS objects: in the system's sources, and in installed token packages.
  const scripts = sources.flatMap((dir) => {
    const cwd = path.resolve(root, dir);
    if (dir.split(/[\\/]/).includes("node_modules")) return [];
    return fg.sync("**/*.{ts,mts,js,mjs}", { cwd, absolute: true, ignore: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/*.d.ts", "**/*.test.*", "**/*.spec.*", "**/*.stories.*"] });
  });
  const tokenPackages = installedTokenPackages(root, sources, scripts);

  const tokens = new Map<string, Token>();
  const add = (t: Token) => {
    const prev = tokens.get(t.name);
    if (!prev) { tokens.set(t.name, t); return; }
    // The same token set again under another selector: another mode's value.
    for (const m of t.modes ?? []) if (!(prev.modes ?? []).includes(m)) (prev.modes ??= []).push(m);
  };
  for (const file of [...new Set(files)].sort()) {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const rel = path.relative(root, file);
    if (file.endsWith(".json") || file.endsWith(".tokens")) { readJsonTokens(text, rel, add); continue; }
    readStyleTokens(text, rel, add);
  }
  for (const file of scripts) {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    if (/define\w*Tokens|create\w*Tokens|semanticTokens\s*:|\bprimitive\s*:\s*\{/.test(text)) readScriptTokens(text, path.relative(root, file), add, false);
  }
  for (const pkg of tokenPackages) for (const file of pkg.files) {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const rel = path.relative(root, file);
    if (file.endsWith(".css")) readStyleTokens(text, rel, add);
    else if (file.endsWith(".json")) readJsonTokens(text, rel, add);
    else readScriptTokens(text, rel, add, true, pkg.prefixOf(file));
  }

  // A copy-in system's tokens live in the app's global stylesheet, not beside its components: with none in the
  // system's sources, read stylesheets anywhere in the repo that define a set of custom properties at :root.
  if (tokens.size === 0) {
    for (const f of fg.sync("**/*.css", { cwd: root, absolute: true, ignore: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**", "**/*.min.css"] })) {
      let text: string;
      try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
      if ((text.match(/^\s*--[\w-]+\s*:/gm) ?? []).length < 8 || !/:root|@theme/.test(text)) continue;
      readStyleTokens(text, path.relative(root, f), (t) => add({ ...t, evidence: { ...t.evidence, tier: "convention", extractor: "global-stylesheet" } }));
    }
  }

  // Tier from the alias graph and the concepts' names.
  const all = [...tokens.values()];
  const conceptKeys = concepts.filter((c) => c.role !== "style" && c.key.length >= 4).map((c) => c.key);
  for (const t of all) {
    const segs = t.name.toLowerCase().split(/[-_.]+/).join("");
    if (conceptKeys.some((k) => segs.includes(k))) t.tier = "component";
    else t.tier = t.aliasOf ? "semantic" : "primitive";
  }

  // Bindings: the tokens each concept's own style files reference.
  for (const c of concepts) {
    if (c.role === "style") continue;
    const own = new Set(c.realizations.map((r) => r.evidence.file).filter((f) => !f.startsWith("(")).map((f) => path.resolve(root, f)));
    const styleFiles = new Set<string>();
    for (const f of own) {
      if (/\.(s?css|sass|less)$/.test(f)) styleFiles.add(f);
      const dir = path.dirname(f);
      try {
        for (const s of fs.readdirSync(dir)) if ((/\.(module\.)?(s?css|sass|less)$/.test(s) || /[.-]styles?\.(t|j)s$/.test(s)) && named(norm(s), c.key)) styleFiles.add(path.join(dir, s));
      } catch { /* gone */ }
      // Lit / CSS-in-JS: styles written in the component's own file.
      styleFiles.add(f);
    }
    const bound = new Map<string, Evidence>();
    for (const f of styleFiles) {
      let text: string;
      try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
      for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) if (tokens.has(m[1]!) && !bound.has(m[1]!)) bound.set(m[1]!, { file: path.relative(root, f), line: lineAt(text, m.index!), extractor: "token-reference", tier: "declaration" });
      if (/\.(s[ac]ss)$/.test(f)) for (const m of text.matchAll(/(?<![\w-])(\$[\w-]+)/g)) if (tokens.has(m[1]!) && !bound.has(m[1]!)) bound.set(m[1]!, { file: path.relative(root, f), line: lineAt(text, m.index!), extractor: "token-reference", tier: "declaration" });
    }
    if (bound.size) c.tokens = [...bound].map(([name, evidence]) => ({ name, evidence }));
  }
  return { tokens: all.sort((a, b) => a.name.localeCompare(b.name)) };
}

function groupOf(name: string, value?: string): Token["group"] {
  if (value && COLOR_VALUE.test(value.trim())) return "color";
  // Also as words: fontSizes.md → font-size.md, colors.bg → color.bg, shadows → shadow.
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/(colors|fonts|sizes|shadows|borders|spacings|durations|easings|breakpoints|layers)(?=[-_.]|$)/g, (w) => w.slice(0, -1)).replace(/radii(?=[-_.]|$)/g, "radius");
  for (const [g, re] of GROUPS) if (re.test(name) || re.test(words)) return g;
  return "other";
}

const MODE_KEY = /^(_?light|_?dark|base|_?default|DEFAULT|_osLight|_osDark|_highContrast)$/;

/**
 * Tokens in a JS/TS module. `{ value }` leaves under a `define*Tokens` call (or `tokens` / `semanticTokens`
 * keys); plain leaves under a preset's `primitive` / `semantic` keys, or (in an installed token package) any
 * top-level object of literal leaves. `{ _light, _dark }` values and `colorScheme.light|dark` set modes.
 */
function readScriptTokens(text: string, file: string, add: (t: Token) => void, plainTopLevel: boolean, prefix: string[] = []) {
  let tree: any;
  try { tree = parseTs(text, file.replace(/\.(mjs|js|mts)$/, ".ts")); } catch { return; }
  if (!tree) return;
  const key = (p: any) => p?.key?.name ?? p?.key?.value;
  const lit = (n: any): string | undefined => n?.type === "StringLiteral" ? n.value : n?.type === "NumericLiteral" ? String(n.value) : n?.type === "TemplateLiteral" && !n.expressions.length ? n.quasis.map((q: any) => q.value.cooked).join("") : undefined;
  const emit = (trail: string[], value: string, mode: string | undefined, line?: number) => {
    if (value.length > 200 || /[;\n]/.test(value)) return; // raw CSS strings, not tokens
    const segs = trail.filter((s) => s !== "DEFAULT" && s !== "root" && s !== "colorScheme");
    if (!segs.length) return;
    const name = segs.join(".");
    const alias = value.match(/^\{([\w.-]+)\}$/)?.[1];
    add({ name, value, ...(alias ? { aliasOf: alias } : {}), group: groupOf(name, value), tier: "primitive", ...(mode ? { modes: [mode] } : {}), evidence: { file, line, extractor: "token-object", tier: "declaration" } });
  };
  const modeOfKey = (k: string) => (k.replace(/^_/, "") === "light" || /^(base|_?default)$/.test(k) ? undefined : k.replace(/^_(os)?/, "").toLowerCase());
  // `{ value }` leaves (Chakra, Panda, Stitches-like configs).
  const walkValue = (o: any, trail: string[]) => {
    for (const p of o?.properties ?? []) {
      const k = key(p);
      if (k === undefined) continue;
      if (String(k) === "value" || String(k) === "$value") {
        const v = lit(p.value);
        if (v !== undefined) emit(trail, v, undefined, p.loc?.start.line);
        else if (p.value?.type === "ObjectExpression") for (const m of p.value.properties) { const mv = lit(m.value); if (mv !== undefined) emit(trail, mv, MODE_KEY.test(String(key(m))) ? modeOfKey(String(key(m))) : String(key(m)), m.loc?.start.line); }
        continue;
      }
      if (p.value?.type === "ObjectExpression") walkValue(p.value, [...trail, String(k)]);
    }
  };
  // Plain leaves (PrimeUIX presets): every literal is a token; colorScheme.light|dark set the mode.
  const walkPlain = (o: any, trail: string[], mode: string | undefined) => {
    for (const p of o?.properties ?? []) {
      const k = key(p);
      if (k === undefined) continue;
      const v = lit(p.value);
      if (v !== undefined) emit([...trail, String(k)], v, mode, p.loc?.start.line);
      else if (p.value?.type === "ObjectExpression") {
        const inScheme = trail[trail.length - 1] === "colorScheme" && /^(light|dark)$/.test(String(k));
        walkPlain(p.value, inScheme ? trail : [...trail, String(k)], inScheme ? (String(k) === "dark" ? "dark" : undefined) : mode);
      }
    }
  };
  const visitAll = (n: any, fn: (n: any) => void) => {
    if (!n || typeof n.type !== "string") return;
    fn(n);
    for (const k in n) {
      if (k === "loc" || k === "start" || k === "end") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => visitAll(x, fn));
      else if (v && typeof v.type === "string") visitAll(v, fn);
    }
  };
  visitAll(tree.program, (n) => {
    if (n.type === "CallExpression" && n.arguments?.[0]?.type === "ObjectExpression") {
      const c = n.callee;
      const fname = c?.name ?? c?.object?.name ?? "";
      if (/^(define|create)\w*Tokens$/.test(fname)) walkValue(n.arguments[0], c?.type === "MemberExpression" && c.property?.name ? [c.property.name] : []);
    }
    if (n.type === "ObjectExpression") for (const p of n.properties ?? []) {
      const k = key(p);
      if ((k === "tokens" || k === "semanticTokens") && p.value?.type === "ObjectExpression") walkValue(p.value, []);
      if ((k === "primitive" || k === "semantic") && p.value?.type === "ObjectExpression") walkPlain(p.value, [], undefined);
    }
  });
  if (plainTopLevel) {
    for (const st of tree.program.body) {
      const decls = st.type === "VariableDeclaration" ? st.declarations : st.type === "ExportNamedDeclaration" && st.declaration?.type === "VariableDeclaration" ? st.declaration.declarations : [];
      for (const d of decls) {
        if (d.init?.type !== "ObjectExpression") continue;
        // An object of literal leaves (some nested): a token set. Objects only of other bindings are skipped.
        let leaves = 0;
        visitAll(d.init, (x) => { if (x.type === "ObjectProperty" && lit(x.value) !== undefined) leaves++; });
        if (leaves >= 2) walkPlain(d.init, prefix, undefined);
      }
    }
  }
}

/**
 * Dependencies named for tokens, themes or presets (`@acme/tokens`, `@primeuix/themes`), installed in
 * node_modules. When the repo imports subpaths of one (`@primeuix/themes/aura`), only those presets are read.
 */
function installedTokenPackages(root: string, sources: string[], scripts: string[]): { files: string[]; prefixOf: (file: string) => string[] }[] {
  const names = new Set<string>();
  const pkgJsons = new Set([path.join(root, "package.json"), ...sources.map((s) => path.join(path.resolve(root, s), "package.json"))]);
  for (const pj of pkgJsons) {
    try {
      const j = JSON.parse(fs.readFileSync(pj, "utf8"));
      for (const n of Object.keys({ ...j.dependencies, ...j.devDependencies, ...j.peerDependencies })) if (/(^|[-/@])(design-)?(tokens?|themes?|presets?|primitives)($|[-/])/.test(n)) names.add(n);
    } catch { /* none */ }
  }
  const out: { files: string[]; prefixOf: (file: string) => string[] }[] = [];
  for (const name of names) {
    const dir = path.join(root, "node_modules", name);
    if (!fs.existsSync(path.join(dir, "package.json"))) continue;
    const subpaths = new Set<string>();
    const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    for (const f of scripts) {
      let t: string;
      try { t = fs.readFileSync(f, "utf8"); } catch { continue; }
      for (const m of t.matchAll(new RegExp(`['"]${esc}/([\\w-]+)`, "g"))) subpaths.add(m[1]!);
    }
    const base = fs.existsSync(path.join(dir, "dist")) ? path.join(dir, "dist") : dir;
    const globs = subpaths.size ? [...subpaths].map((s) => `${s}/**/*.{mjs,js,css,json}`) : ["**/*.{mjs,js,css,json}"];
    const files = fg.sync(globs, { cwd: base, absolute: true, ignore: ["**/node_modules/**", "**/*.map", "**/*.min.*", "**/*.d.*", "**/*.cjs", "**/package.json"] }).slice(0, 2000);
    // The file's folders inside the preset name its tokens' component (aura/button/index.mjs → button).
    const prefixOf = (file: string) => {
      const segs = path.relative(base, path.dirname(file)).split(path.sep).filter(Boolean);
      const inPreset = subpaths.size ? segs.slice(1) : segs;
      return inPreset.filter((s) => s !== "base" && s !== "index");
    };
    out.push({ files, prefixOf });
  }
  return out;
}

/** Sass maps: `$palette: ("blue": ("primary": #1d70b8), …)` → `$palette.blue.primary`. */
function readSassMaps(text: string, file: string, add: (t: Token) => void) {
  for (const m of text.matchAll(/^\$([\w-]+)\s*:\s*\(/gm)) {
    let depth = 0, i = m.index! + m[0].length - 1, end = i;
    for (; i < text.length; i++) { if (text[i] === "(") depth++; else if (text[i] === ")" && --depth === 0) { end = i; break; } }
    const body = text.slice(m.index! + m[0].length, end);
    const walk = (src: string, trail: string[], offset: number) => {
      let d = 0, keyStart = 0;
      const entries: string[] = [];
      for (let j = 0; j < src.length; j++) { const ch = src[j]; if (ch === "(") d++; else if (ch === ")") d--; else if (ch === "," && d === 0) { entries.push(src.slice(keyStart, j)); keyStart = j + 1; } }
      entries.push(src.slice(keyStart));
      for (const e of entries) {
        const kv = e.match(/^\s*["']?([\w-]+)["']?\s*:\s*([\s\S]+?)\s*$/);
        if (!kv) continue;
        const v = kv[2]!;
        if (v.startsWith("(") && v.endsWith(")")) walk(v.slice(1, -1), [...trail, kv[1]!], offset);
        else { const name = `$${[m[1]!, ...trail, kv[1]!].join(".")}`; add({ name, value: v, ...(/^\$[\w-]+$/.test(v) ? { aliasOf: v } : {}), group: groupOf(name, v), tier: "primitive", evidence: { file, line: lineAt(text, m.index!), extractor: "sass-map", tier: "declaration" } }); }
      }
    };
    if (body.includes(":")) walk(body, [], m.index!);
  }
}

/** `--x: v` anywhere (the enclosing selector names its mode), and top-level `$x: v`. */
function readStyleTokens(text: string, file: string, add: (t: Token) => void) {
  if (/\.s[ac]ss$/.test(file)) readSassMaps(text, file, add);
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "));
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      if (src[i - 1] === "#") { const close = src.indexOf("}", i); if (close > i) { i = close; continue; } }
      stack.push(src.slice(start, i).trim());
      start = i + 1;
    } else if (ch === "}" || ch === ";") {
      const decl = src.slice(start, i).trim();
      const m = decl.match(/^(--[\w-]+)\s*:\s*([\s\S]+)$/) ?? (stack.length === 0 ? decl.match(/^(\$[\w-]+)\s*:\s*([\s\S]+?)(\s*!default)?$/) : null);
      if (m) {
        const value = m[2]!.trim();
        const alias = value.match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/)?.[1] ?? value.match(/^(\$[\w-]+)$/)?.[1];
        const sel = [...stack].reverse().find((h) => !h.startsWith("@")) ?? ":root";
        const mode = modeOf(sel, stack);
        add({ name: m[1]!, value, ...(alias ? { aliasOf: alias } : {}), group: groupOf(m[1]!, value), tier: "primitive", ...(mode ? { modes: [mode] } : {}), evidence: { file, line: lineAt(text, start), extractor: m[1]!.startsWith("$") ? "sass-variable" : "css-custom-property", tier: "declaration" } });
      }
      if (ch === "}") stack.pop();
      start = i + 1;
    }
  }
}

/** The mode a selector or at-rule sets for the values inside it: dark, light, a theme name, or none. */
function modeOf(selector: string, stack: string[]): string | undefined {
  const at = stack.find((h) => /prefers-color-scheme\s*:\s*(dark|light)/.test(h));
  if (at) return at.match(/prefers-color-scheme\s*:\s*(dark|light)/)![1];
  const m = selector.match(/\.(dark|light)\b|\[data-(?:theme|mode|color-scheme|bs-theme)=["']?([\w-]+)["']?\]|\.theme-([\w-]+)|\.([\w-]*(?:dark|light|theme)[\w-]*)/i);
  return m ? (m[1] ?? m[2] ?? m[3] ?? m[4])?.toLowerCase() : undefined;
}

/** DTCG (`$value`) and Style Dictionary (`value`) token trees; `{a.b}` values are aliases. */
function readJsonTokens(text: string, file: string, add: (t: Token) => void) {
  let json: any;
  try { json = JSON.parse(text); } catch { return; }
  const walk = (node: any, trail: string[], inheritedType?: string) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const type = node.$type ?? node.type ?? inheritedType;
    const v = "$value" in node ? node.$value : "value" in node && trail.length && typeof node.value !== "object" ? node.value : undefined;
    if (v !== undefined) {
      const name = trail.join(".");
      const value = typeof v === "string" ? v : JSON.stringify(v);
      const alias = typeof v === "string" ? v.match(/^\{([^}]+)\}$/)?.[1] : undefined;
      const group = type === "color" ? "color" : type === "dimension" ? groupOf(name) === "other" ? "spacing" : groupOf(name) : type === "duration" || type === "cubicBezier" || type === "transition" ? "motion" : type === "shadow" ? "elevation" : type === "typography" || type === "fontFamily" || type === "fontWeight" ? "typography" : groupOf(name, value);
      add({ name, value, ...(alias ? { aliasOf: alias } : {}), group, tier: "primitive", evidence: { file, extractor: "token-json", tier: "manifest" } });
      return;
    }
    for (const [k, child] of Object.entries(node)) if (!k.startsWith("$")) walk(child, [...trail, k], type);
  };
  walk(json, []);
}

/** A file named after the concept: its name holds the key, or the key ends with it (acmebutton ~ button.styles.ts). */
const named = (file: string, key: string) => file.length >= 3 && (file.includes(key) || key.endsWith(file));
const norm = (s: string) => s.replace(/\.(module\.)?(s?css|sass|less)$/, "").replace(/[.-]styles?\.(t|j)s$/, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
