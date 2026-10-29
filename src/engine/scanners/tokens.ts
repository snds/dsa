import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { displayPath, walk } from '../paths.js';
import { DEFAULT_TOKEN_PATTERNS, type Config } from '../config.js';
import { loadClassReader } from '../tailwind.js';
import type { Target, TokenRow } from '../types.js';

/**
 * Token compliance: raw style values (hex, rgb(), hsl()) vs token references, per file.
 * Heuristic but deterministic. Only style contexts are counted, to keep false positives low:
 *  - stylesheets (.css .scss .sass .less) and Vue <style> blocks
 *  - style="" attributes in templates
 *  - JS/TS string literals that are exactly a color, and styled/css tagged templates
 */
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const FUNC = /\b(?:rgba?|hsla?)\(/g;

const count = (s: string, re: RegExp) => (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) ?? []).length;
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

export function gitTouchedFiles(root: string, days: number): Set<string> | null {
  try {
    const out = execFileSync('git', ['-C', root, 'log', `--since=${days}.days`, '--name-only', '--pretty=format:'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // Uncommitted work counts as new too.
    const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(l => l.slice(3).trim()).filter(Boolean);
    return new Set([...out.split('\n'), ...dirty].filter(Boolean).map(f => path.join(top, f)));
  } catch {
    return null;
  }
}

export function scanTokens(config: Config, target: Target, exclude: string[], touched: Set<string> | null, root: string): TokenRow[] {
  const patterns = (config.tokenPatterns ?? DEFAULT_TOKEN_PATTERNS).map(p => new RegExp(p, 'g'));
  // Tailwind systems: palette utilities count as raw values, semantic utilities as token references.
  const classes = loadClassReader(root, config);
  const exts = new Set(['.css', '.scss', '.sass', '.less', '.vue', '.html', '.tsx', '.jsx', '.ts', '.js']);
  const rows: TokenRow[] = [];
  for (const file of walk(target.dir, exts, exclude)) {
    let src: string;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (src.length > 1_500_000) continue;
    // Generated palettes and reference snapshots aren't authored code.
    if (/\.(generated|reference|snap)\./.test(path.basename(file))) continue;
    const ext = path.extname(file);
    let styleText = '';
    if (['.css', '.scss', '.sass', '.less'].includes(ext)) styleText = src;
    else if (ext === '.vue') styleText = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n') + '\n' + styleAttrs(src);
    else if (ext === '.html') styleText = styleAttrs(src);
    else styleText = jsStyleText(src);
    styleText = stripComments(styleText);
    let rawValues = count(styleText, HEX) + count(styleText, FUNC);
    let tokenRefs = patterns.reduce((n, re) => n + count(styleText, re), 0);
    if (classes && !['.css', '.scss', '.sass', '.less'].includes(ext)) {
      const t = classes.tally(classText(src, ext));
      rawValues += t.raw;
      tokenRefs += t.semantic;
    }
    if (!rawValues && !tokenRefs) continue;
    rows.push({
      target: target.name,
      file: displayPath(root, file, target.dir),
      rawValues,
      tokenRefs,
      isNew: touched ? touched.has(file) : true,
    });
  }
  return rows;
}

/** Class strings: class="" attributes in templates, every string literal in scripts (cn(), cva(), clsx()). */
function classText(src: string, ext: string): string {
  if (ext === '.vue' || ext === '.html') return [...src.matchAll(/\sclass\s*=\s*"([^"]*)"/g)].map(m => m[1]).join(' ');
  return [...src.matchAll(/(['"`])((?:(?!\1)[^\n\\])*)\1/g)].map(m => m[2]).join(' ');
}

function styleAttrs(src: string): string {
  return [...src.matchAll(/\sstyle\s*=\s*"([^"]*)"/g)].map(m => m[1]).join('\n');
}

function jsStyleText(src: string): string {
  const parts: string[] = [];
  // String literals that are exactly a color value.
  for (const m of src.matchAll(/(['"])\s*(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([^)'"]*\))\s*\1/g)) parts.push(m[2]!);
  // styled.x`...`, css`...`, createGlobalStyle`...`
  for (const m of src.matchAll(/(?:styled(?:\.\w+|\([^)]*\))|\bcss|createGlobalStyle|keyframes)\s*`([\s\S]*?)`/g)) parts.push(m[1]!);
  // String literals that reference CSS custom properties, e.g. style={{ color: 'var(--ds-text)' }}.
  for (const m of src.matchAll(/(['"])([^'"\n]*var\(--[^'"\n]*)\1/g)) parts.push(m[2]!);
  // Token references used from JS (e.g. tokens.color.primary) count as compliant usage.
  for (const m of src.matchAll(/\btokens\.[\w.]+/g)) parts.push(m[0]);
  return parts.join('\n');
}
