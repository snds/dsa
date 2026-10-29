import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';

/**
 * Tailwind-aware class reading, for systems (like shadcn-based ones) where `className` is the normal
 * composition API. A class only counts as drift when it skips the semantic tier:
 *   - a palette utility the tier-leakage spec names (bg-blue-500, text-acme-red-600, bg-white)
 *   - an arbitrary value (bg-[#fff], p-[13px])
 * Semantic utilities (bg-primary, text-muted-foreground) count as token references.
 *
 * The leak grammar is read from the host's own spec file (e.g. packages/lint/tier-leakage.json),
 * so the suite and the repo's lint rule agree on what a leak is.
 */
export interface ClassReader {
  /** Classify one utility class. */
  classify(cls: string): 'leak' | 'arbitrary' | 'semantic' | 'other';
  /** Count raw (leak + arbitrary color) vs semantic utilities in a class string. */
  tally(text: string): { raw: number; semantic: number; leaks: string[] };
  /** True when a className string carries drift (a leak or an arbitrary value). */
  isDrift(text: string): boolean;
}

interface LeakSpec { prefixes: string[]; hues: string[]; steps: string[]; literal_palette?: string[]; compat_prefixes?: string[]; compat_extra_families?: string[] }

const alt = (vs: string[]) => [...vs].sort((a, b) => b.length - a.length).map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/** Strip variants (hover:, md:), important (!), and opacity (/50): "hover:!bg-blue-500/50" -> "bg-blue-500". */
export function utilityStem(token: string): string {
  let v = token.trim();
  if (v.startsWith('!')) v = v.slice(1);
  // Variant separators outside brackets.
  let depth = 0, cut = -1;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ':' && depth === 0) cut = i;
  }
  if (cut >= 0) v = v.slice(cut + 1);
  if (v.startsWith('!')) v = v.slice(1);
  if (!v.includes('[')) { const s = v.indexOf('/'); if (s !== -1) v = v.slice(0, s); }
  return v;
}

export function loadClassReader(root: string, config: Config): ClassReader | null {
  const tw = config.tailwind;
  if (!tw) return null;
  let leak: RegExp | null = null;
  let prefixes: string[] = ['bg', 'text', 'border', 'ring', 'fill', 'stroke', 'outline'];
  if (tw.tierLeakageSpec) {
    const spec: LeakSpec = JSON.parse(fs.readFileSync(path.resolve(root, tw.tierLeakageSpec), 'utf8'));
    prefixes = spec.prefixes;
    const compat = spec.compat_prefixes?.length ? alt(spec.compat_prefixes) : '(?!)';
    const fam = alt([...spec.hues, ...(spec.compat_extra_families ?? ['black'])]);
    leak = new RegExp(`^(?:${alt(spec.prefixes)})-(?:(?:${alt(spec.hues)})A?-(?:${alt(spec.steps)})|(?:${alt(spec.literal_palette ?? ['black', 'white'])})|(?:${compat})-(?:${fam})A?-(?:${alt(spec.steps)}))$`);
  }
  const semantic = new Set<string>();
  for (const f of tw.semanticCss ? [tw.semanticCss].flat() : []) {
    const text = fs.readFileSync(path.resolve(root, f), 'utf8');
    for (const m of text.matchAll(/--color-([a-z0-9-]+)\s*:/g)) semantic.add(m[1]!);
  }
  const pre = new RegExp(`^(?:${alt(prefixes)})-(.+)$`);
  const ARB_COLOR = /-\[(?:#|rgb|hsl|oklch|color)/i;
  const ARB = /^[a-z-]+-\[[^\]]+\]$/;
  const arbMode = tw.arbitraryValues ?? 'color';

  const classify = (raw: string): ReturnType<ClassReader['classify']> => {
    const cls = utilityStem(raw);
    if (!cls) return 'other';
    if (leak?.test(cls)) return 'leak';
    if (ARB.test(cls)) {
      if (arbMode === 'none') return 'other';
      if (arbMode === 'color' && !ARB_COLOR.test(cls)) return 'other';
      return 'arbitrary';
    }
    const m = cls.match(pre);
    if (m && semantic.has(m[1]!)) return 'semantic';
    return 'other';
  };
  return {
    classify,
    tally(text: string) {
      let raw = 0, sem = 0;
      const leaks: string[] = [];
      for (const tok of text.split(/\s+/)) {
        if (!tok) continue;
        const k = classify(tok);
        if (k === 'leak' || (k === 'arbitrary' && ARB_COLOR.test(tok))) { raw++; if (leaks.length < 5) leaks.push(tok); }
        else if (k === 'semantic') sem++;
      }
      return { raw, semantic: sem, leaks };
    },
    isDrift(text: string) {
      return text.split(/\s+/).some(t => { const k = classify(t); return k === 'leak' || k === 'arbitrary'; });
    },
  };
}
