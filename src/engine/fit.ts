import fs from 'node:fs';
import path from 'node:path';
import type { ElementEval } from './elements.js';
import { compare, normalize } from './signatures.js';
import { compareRendered, readRendered, renderedFor, type Styles } from './rendered.js';

/**
 * How well each option of each axis (variant, size, …) of a component fits the elements being replaced.
 * Size options are judged on box properties only (height, padding, radius, type size); variant options on
 * color and decoration only, so "which size?" isn't muddied by color and the other way round.
 *
 * Measured (the element as rendered in the app vs the option as rendered in Storybook) when there's a
 * screenshot; read from the classes vs the component's signature otherwise. Averaged over the instances.
 */

const BOX_R = ['height', 'paddingLeft', 'borderRadius', 'fontSize'];
const COLOR_R = ['backgroundColor', 'color', 'borderWidth', 'borderColor', 'textDecoration', 'fontWeight'];
const BOX_S = /^(height|width|px|py|radius|font-size|text-size|gap)$/;

export interface AxisFit { score: number; n: number; source: 'rendered' | 'static' | 'mixed'; height?: number | undefined; note?: string }
export interface Fit {
  component: string;
  axes: Record<string, Record<string, AxisFit>>;
  best: Record<string, string>;
  /** The elements as measured in the app (averages), or what their classes say. */
  measured: { from: 'rendered' | 'classes'; height?: number | undefined; paddingX?: number | undefined; fontSize?: number | undefined; radius?: number | undefined; text?: string; own?: number; shared?: number } | null;
  instances: number;
}

/** A token value in px: 2.25rem, 36px, var:button-height → its root literal. */
function toPx(v: string | undefined, values: Map<string, string>): number | undefined {
  if (!v) return undefined;
  let x = v.startsWith('var:') ? values.get(v.slice(4)) ?? '' : v;
  x = x.replace(/\s*\/\*.*$/, '').trim();
  const m = x.match(/^(-?[\d.]+)(rem|px)?$/);
  if (!m) return undefined;
  return m[2] === 'rem' ? parseFloat(m[1]!) * 16 : parseFloat(m[1]!);
}
const px = (v: unknown) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : undefined; };
const pick = (s: Styles, keys: string[]) => Object.fromEntries(Object.entries(s).filter(([k]) => keys.includes(k)));

// The inputs change only with a scan, a render, or a screenshot pass: cache them by file times.
let cache: { key: string; v: any } | null = null;
function load(dataDir: string) {
  const files = ['signatures.json', 'signatures.set.json', 'rendered/index.json', 'shots/index.json'].map(f => path.join(dataDir, f));
  const key = files.map(f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join('|') + dataDir;
  if (cache?.key === key) return cache.v;
  try {
    const summary = JSON.parse(fs.readFileSync(files[0]!, 'utf8'));
    const set = JSON.parse(fs.readFileSync(files[1]!, 'utf8'));
    let shots: Record<string, any> = {};
    try { shots = JSON.parse(fs.readFileSync(files[3]!, 'utf8')).shots ?? {}; } catch { /* none yet */ }
    const v = { summary, aliases: new Map<string, string>(set.aliases ?? []), values: new Map<string, string>(set.values ?? []), renderedAll: readRendered(dataDir), shots };
    cache = { key, v };
    return v;
  } catch { return null; }
}

export function computeFit(dataDir: string, evals: ElementEval[], component: string, current: Record<string, string> = {}): Fit | null {
  const data = load(dataDir);
  if (!data) return null;
  const { summary, aliases, values, renderedAll, shots } = data;
  const comp = summary.find((c: any) => c.component === component);
  if (!comp) return null;
  const rendered = renderedAll?.components?.[component] ?? null;

  const axes = Object.keys(comp.axes ?? {});
  const bySig = new Map<string, Styles>();
  for (const e of evals) { const st = shots[e.id]?.styles; const k = e.styleKey ?? e.styleSig; if (st && k && !bySig.has(k)) bySig.set(k, st); }
  const twin = (e: ElementEval) => { const k = e.styleKey ?? e.styleSig; return k ? bySig.get(k) : undefined; };
  const sel = (axis: string, opt: string) => {
    const s: Record<string, string> = { ...(comp.defaults ?? {}), ...current, [axis]: opt };
    for (const a of axes) s[a] ??= comp.axes[a][0];
    return s;
  };
  const out: Fit = { component, axes: {}, best: {}, measured: null, instances: evals.length };
  for (const axis of axes) {
    out.axes[axis] = {};
    const subsetR = axis === 'size' ? BOX_R : axis === 'variant' ? COLOR_R : [...BOX_R, ...COLOR_R];
    const subsetS = (k: string) => { const base = k.split(':').pop()!; return axis === 'size' ? BOX_S.test(base) && !k.includes(':') : axis === 'variant' ? !BOX_S.test(base) : true; };
    for (const opt of comp.axes[axis]) {
      const s = sel(axis, opt);
      let sum = 0, n = 0, nr = 0;
      let height: number | undefined;
      const r = rendered ? renderedFor(rendered as any, s.variant ?? 'default', s.size ?? 'default') : null;
      if (r && !r.sizeMissing) height = px(r.styles.height);
      // An icon-only size can't hold a label: rule it out when the instances have text.
      const labelled = evals.some(e => (e.match?.text ?? '').trim());
      if (axis === 'size' && /icon/.test(opt) && labelled) { out.axes[axis][opt] = { score: 0, n: 0, source: 'static', height, note: 'icon-only size; these have labels' }; continue; }
      for (const e of evals) {
        // Identical classes render identically: an instance without its own screenshot borrows a twin's.
        const st = shots[e.id]?.styles ?? twin(e);
        // Size is a matter of degree: 28px vs 21px is closer than 36px vs 21px, so box props score by distance.
        if (st && r && axis === 'size' && !r.sizeMissing) {
          const w: [string, number][] = [['height', 1.5], ['paddingLeft', 0.75], ['fontSize', 0.75], ['borderRadius', 0.5]];
          let g = 0, t = 0;
          for (const [k, wt] of w) { const a = px(st[k]), b2 = px(r.styles[k]); if (a === undefined || b2 === undefined) continue; t += wt; g += wt * (1 - Math.min(1, Math.abs(a - b2) / Math.max(a, b2, 1))); }
          if (t) { sum += g / t; n++; nr++; continue; }
        }
        if (st && r && axis !== 'size') {
          const d = compareRendered(pick(st, subsetR), pick(r.styles, subsetR));
          if (d.diffs.length + d.same.length) { sum += d.score; n++; nr++; continue; }
        }
        const sig = comp.sigs.find((x: any) => Object.entries(s).every(([k, v]) => (k === 'variant' ? x.variant === v : k === 'size' ? x.size === v : true)));
        if (!sig || !e.classTokens?.length) continue;
        const el = new Map([...normalize(e.classTokens, aliases)].filter(([k]) => subsetS(k)));
        const sp = new Map(Object.entries<string>(sig.props).filter(([k]) => subsetS(k)));
        if (axis === 'size') {
          // Only what the element's classes actually set, by distance in px; nothing set says nothing.
          let g = 0, t = 0;
          for (const [k, v] of el) { const a = toPx(v, values), b2 = toPx(sp.get(k), values); if (a === undefined || b2 === undefined) continue; t++; g += 1 - Math.min(1, Math.abs(a - b2) / Math.max(a, b2, 1)); }
          if (t) { sum += g / t; n++; }
          continue;
        }
        if (!el.size && !sp.size) continue;
        sum += compare(el, { props: sp } as any, values).score; n++;
      }
      if (n) out.axes[axis][opt] = { score: Math.round((sum / n) * 100) / 100, n, source: nr === n ? 'rendered' : nr ? 'mixed' : 'static', height };
    }
    const ranked = Object.entries(out.axes[axis]).filter(([, f]) => f.n > 0).sort((a, b) => b[1].score - a[1].score);
    if (ranked.length) out.best[axis] = ranked[0]![0];
  }
  // What the elements measure as rendered (averages), else what their classes say about size.
  const ms = evals.map(e => shots[e.id]?.styles ?? twin(e)).filter(Boolean) as Styles[];
  if (ms.length) {
    const avg = (k: string) => { const v = ms.map(m => px(m[k])).filter((x): x is number => x !== undefined); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : undefined; };
    const own = evals.filter(e => shots[e.id]?.styles).length;
    out.measured = { from: 'rendered', height: avg('height'), paddingX: avg('paddingLeft'), fontSize: avg('fontSize'), radius: avg('borderRadius'), own, shared: ms.length };
  } else {
    const t = evals[0]?.classTokens ?? [];
    const sizeish = t.filter(x => /^(h-|size-|px-|py-|p-|text-(xs|sm|base|lg|xl|\[)|rounded|gap-|leading-)/.test(x));
    out.measured = { from: 'classes', text: sizeish.join(' ') || 'no size classes (sized by its content)' };
  }
  return out;
}
