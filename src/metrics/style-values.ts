import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { dropGitIgnored } from "../git-ignored.js";
import type { DsaConfig } from "../config.js";
import type { Location } from "../graph/types.js";
import { DEFAULT_EXCLUDE, type RepoReading } from "../model/index.js";

/**
 * Hard-coded style values: a colour or a pixel size written straight into consumer code where a
 * token belongs. Each one has a file and line, so a pull-request comment can point at it.
 *
 * Only style contexts are read, to keep false alarms low (the same idea as the engine's token
 * scanner, per line instead of per file):
 *  - stylesheets (.css .scss .sass .less) and <style> blocks: the value side of a declaration
 *  - style="" attributes in templates
 *  - script string literals that are exactly a colour, styled/css tagged templates, and
 *    spacing keys in a single-line style={{ … }} object
 *  - arbitrary values in utility classes, such as bg-[#0af] or p-[13px]
 * Custom properties (--brand: #0af) and preprocessor variables ($brand: #0af) define tokens, so
 * they are not counted. Zero is never counted.
 */
export interface StyleValueFinding extends Location {
  /** The value as written, e.g. `#3b82f6`, `rgb(0 0 0 / 50%)`, `12px`. */
  value: string;
  kind: "color" | "length";
}

const STYLESHEET = /\.(css|scss|sass|less)$/;
const COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\([^)]*\)/g;
const PX = /(?<![\w.#-])(\d*\.?\d+)px\b/g;
const SPACING = /^(?:margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left|font-size|line-height|letter-spacing|border-radius)(?:-[a-z-]+)?$/;
const SPACING_JS = /^(?:margin|padding|gap|rowGap|columnGap|inset|top|right|bottom|left|fontSize|lineHeight|letterSpacing|borderRadius)(?:[A-Z]\w*)?$/;
const ARBITRARY = /-\[(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([^\]]*\)|\d*\.?\d+px)\]/g;
const TAGGED_OPEN = /(?:styled(?:\.\w+|\([^)]*\))(?:\.attrs\([^)]*\))?|\bcss|createGlobalStyle|keyframes)\s*`/;

type Hit = { line: number; column: number; value: string; kind: StyleValueFinding["kind"] };

/** Blank out comments, keeping every newline so line numbers hold. */
function blankComments(text: string, lineComments: boolean): string {
  const keepLines = (s: string) => s.replace(/[^\n]/g, " ");
  let out = text.replace(/\/\*[\s\S]*?\*\//g, keepLines);
  if (lineComments) out = out.replace(/(^|[^:])\/\/[^\n]*/g, (_m, pre: string) => pre + " ".repeat(_m.length - pre.length));
  return out;
}

/** Values in one CSS declaration line (`color: #fff; padding: 12px`). `offset` is the line's column base. */
function declarationHits(lineText: string, lineNo: number, offset = 0): Hit[] {
  const hits: Hit[] = [];
  for (const m of lineText.matchAll(/(^|[;{\s])([a-zA-Z-]+)\s*:\s*([^;{}]+)/g)) {
    const prop = m[2]!.toLowerCase();
    // Custom properties and variables define tokens; a selector like a:hover isn't a declaration.
    if (prop.startsWith("--") || /^\$|^@/.test(prop)) continue;
    const valueStart = m.index! + m[0].length - m[3]!.length;
    const value = m[3]!;
    for (const c of value.matchAll(COLOR)) hits.push({ line: lineNo, column: offset + valueStart + c.index! + 1, value: c[0], kind: "color" });
    if (SPACING.test(prop)) {
      for (const p of value.matchAll(PX)) if (Number(p[1]) !== 0) hits.push({ line: lineNo, column: offset + valueStart + p.index! + 1, value: p[0], kind: "length" });
    }
  }
  return hits;
}

function stylesheetHits(text: string, startLine = 1): Hit[] {
  const lines = blankComments(text, true).split("\n");
  return lines.flatMap((l, i) => (/^\s*(\$|--|@)/.test(l) ? [] : declarationHits(l, startLine + i)));
}

/** style="…" attributes on one line. */
function styleAttrHits(lineText: string, lineNo: number): Hit[] {
  const hits: Hit[] = [];
  for (const m of lineText.matchAll(/\sstyle\s*=\s*"([^"]*)"/g)) {
    const at = m.index! + m[0].indexOf('"') + 1;
    hits.push(...declarationHits(m[1]!, lineNo, at));
  }
  return hits;
}

function arbitraryHits(lineText: string, lineNo: number): Hit[] {
  const hits: Hit[] = [];
  for (const m of lineText.matchAll(ARBITRARY)) {
    const v = m[1]!;
    const kind = v.endsWith("px") ? "length" : "color";
    if (kind === "length" && parseFloat(v) === 0) continue;
    hits.push({ line: lineNo, column: m.index! + 3, value: v, kind });
  }
  return hits;
}

/** Script files: colour literals, tagged templates, style objects and utility classes. */
function scriptHits(text: string): Hit[] {
  const lines = blankComments(text, true).split("\n");
  const hits: Hit[] = [];
  let inTemplate = false;
  lines.forEach((l, i) => {
    const n = i + 1;
    if (inTemplate) {
      const close = l.indexOf("`");
      const body = close >= 0 ? l.slice(0, close) : l;
      if (!/^\s*(\$|--)/.test(body)) hits.push(...declarationHits(body, n));
      if (close >= 0) inTemplate = false;
      return;
    }
    const open = l.match(TAGGED_OPEN);
    if (open) {
      const start = open.index! + open[0].length;
      const rest = l.slice(start);
      const close = rest.indexOf("`");
      hits.push(...declarationHits(close >= 0 ? rest.slice(0, close) : rest, n, start));
      if (close < 0) inTemplate = true;
      return;
    }
    // A string literal that is exactly a colour.
    for (const m of l.matchAll(/(['"])\s*(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([^)'"]*\))\s*\1/g)) {
      if (/^#[0-9a-fA-F]+$/.test(m[2]!) && ![3, 4, 6, 8].includes(m[2]!.length - 1)) continue;
      hits.push({ line: n, column: m.index! + m[0].indexOf(m[2]!) + 1, value: m[2]!, kind: "color" });
    }
    // Spacing keys in a style object: marginTop: 8, padding: '12px'.
    if (/\bstyle=\{\{/.test(l)) {
      for (const m of l.matchAll(/\b([a-zA-Z]+)\s*:\s*(?:(['"])(\d*\.?\d+)px\2|(\d*\.?\d+)(?=\s*[,}]))/g)) {
        if (!SPACING_JS.test(m[1]!)) continue;
        const num = m[3] ?? m[4]!;
        if (Number(num) === 0) continue;
        const value = m[3] ? `${num}px` : num;
        hits.push({ line: n, column: m.index! + m[0].lastIndexOf(num) + 1, value, kind: "length" });
      }
    }
    hits.push(...arbitraryHits(l, n));
  });
  return hits;
}

/** Templates (Vue, Svelte, HTML and the like): <style> blocks, style="" attributes and utility classes. */
function templateHits(text: string): Hit[] {
  const clean = text.replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, " "));
  const lines = clean.split("\n");
  const hits: Hit[] = [];
  let inStyle = false;
  let inScript = false;
  lines.forEach((l, i) => {
    const n = i + 1;
    if (inStyle) {
      if (/<\/style>/.test(l)) { inStyle = false; return; }
      if (!/^\s*(\$|--|@)/.test(l)) hits.push(...declarationHits(blankComments(l, true), n));
      return;
    }
    if (/<style[\s>]/.test(l) && !/<\/style>/.test(l)) { inStyle = true; return; }
    if (/<script[\s>]/.test(l) && !/<\/script>/.test(l)) inScript = true;
    if (/<\/script>/.test(l)) inScript = false;
    hits.push(...styleAttrHits(l, n), ...arbitraryHits(l, n));
    if (inScript) for (const m of l.matchAll(/(['"])\s*(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([^)'"]*\))\s*\1/g)) hits.push({ line: n, column: m.index! + m[0].indexOf(m[2]!) + 1, value: m[2]!, kind: "color" });
  });
  return hits;
}

/** Hard-coded values in one file's text; `file` decides how it's read. */
export function styleValuesInText(file: string, text: string): StyleValueFinding[] {
  const f = file.replace(/\\/g, "/");
  const hits = STYLESHEET.test(f) ? stylesheetHits(text) : /\.(tsx|jsx|ts|js|mjs)$/.test(f) ? scriptHits(text) : templateHits(text);
  const seen = new Set<string>();
  return hits
    .filter((h) => {
      const k = `${h.line}:${h.column}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.line - b.line || a.column - b.column)
    .map((h) => ({ file: f, ...h }));
}

/**
 * Hard-coded values across the consumer code a reading covers, plus the repo's stylesheets. Files in
 * the system's own source are left out: that's where the values are allowed to live.
 */
export function styleValuesFromReading(root: string, reading: RepoReading, config: DsaConfig, within?: string): StyleValueFinding[] {
  const absRoot = path.resolve(root);
  const inSource = (rel: string) => reading.sources.some((s) => {
    const d = path.resolve(absRoot, s);
    const f = path.resolve(absRoot, rel);
    return f === d || f.startsWith(d + path.sep);
  });
  const scripts = reading.files.filter((f) => !f.inSource).map((f) => f.file);
  const cwd = within ?? absRoot;
  const sheets = dropGitIgnored(cwd, fg.sync(["**/*.{css,scss,sass,less}"], { cwd, absolute: true, ignore: [...DEFAULT_EXCLUDE, ...config.scan.exclude] }))
    .map((f) => path.relative(absRoot, f))
    .filter((f) => !inSource(f));
  const out: StyleValueFinding[] = [];
  for (const rel of [...new Set([...scripts, ...sheets])].sort()) {
    // Generated palettes and reference snapshots aren't authored code.
    if (/\.(generated|reference|snap)\./.test(path.basename(rel))) continue;
    let text: string;
    try { text = fs.readFileSync(path.resolve(absRoot, rel), "utf8"); } catch { continue; }
    if (text.length > 1_500_000) continue;
    out.push(...styleValuesInText(rel, text));
  }
  return out;
}
