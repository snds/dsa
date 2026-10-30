import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { Concept, Evidence, Token } from "./types.js";

/**
 * Tokens: the system's named design decisions, read from every format the system writes them in.
 *
 *   CSS custom properties   `--acme-color-primary: #06c;` (with the mode a selector sets: :root, .dark, [data-theme])
 *   Sass variables          top-level `$acme-space-2: 8px;`
 *   DTCG / Style Dictionary JSON   `{ "color": { "primary": { "$value": "{color.blue.500}" } } }`
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
  for (const [g, re] of GROUPS) if (re.test(name)) return g;
  return "other";
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
