import fs from 'node:fs';
import path from 'node:path';
import { openStore } from './store.js';

/**
 * Rendered signatures: what each system component × variant × size looks like in a browser, read from
 * the design system's own Storybook by the review add-on (@snds/dsa-review, `dsa render`). Static
 * signatures (signatures.ts) say which classes a variant applies; rendered ones say what they compute
 * to: height, padding, radius, colors, border, type. App elements are measured the same way during
 * screenshots, so the two compare property by property.
 *
 * This file is the part without a browser: reading the measurements, comparing them, and applying
 * them to the element review. The measuring lives in the review add-on.
 */

export type Styles = Record<string, string | number>;

export interface RenderedSet {
  takenAt: string;
  source: string;
  components: Record<string, Record<string, { styles: Styles; shot?: string; story: string }>>;
  notes: string[];
}

export function readRendered(dataDir: string): RenderedSet | null {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'rendered', 'index.json'), 'utf8')); } catch { return null; }
}

/**
 * A proposed replacement rendered as the review proposes it: the system component with exactly the
 * recommended props, set through Storybook args. `check` says how far the picture can be trusted:
 * exact (the rendered element's data attributes confirm every prop), unverified (rendered with the
 * args, but the component doesn't expose the props to confirm), closest (the story ignored the args,
 * so this is the nearest rendering it had), none (nothing rendered; `note` says why).
 */
export interface Proposal {
  use: string;
  props: Record<string, string>;
  check: 'exact' | 'unverified' | 'closest' | 'none';
  shot?: string | undefined;
  styles?: Styles | undefined;
  story?: string | undefined;
  /** Where the content came from when the props were set on another story's element: its default label, or an icon borrowed from a story that has one. */
  content?: string | undefined;
  /** The props the rendered element shows, when they differ from the ones asked for. */
  actual?: Record<string, string> | undefined;
  note?: string | undefined;
  hash?: string | undefined;
}

/** Props that change how a component looks; `render` and `asChild` change what it's built from. */
export const lookProps = (props?: Record<string, unknown> | null): Record<string, string> =>
  Object.fromEntries(Object.entries(props ?? {}).filter(([k, v]) => k !== 'render' && k !== 'asChild' && v != null).map(([k, v]): [string, string] => [k, String(v)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

/** The key a proposal is stored under: the component and its look props, in name order. The dashboard builds the same key. */
export function proposalKey(use: string, props?: Record<string, unknown> | null) {
  const p = Object.entries(lookProps(props)).map(([k, v]) => `${k}=${v}`).join(';');
  return p ? `${use}|${p}` : use;
}

export function readProposals(dataDir: string): Record<string, Proposal> {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'rendered', 'proposals.json'), 'utf8')).items ?? {}; } catch { return {}; }
}

// ---------- comparison ----------

const px = (v: string | number | undefined) => (typeof v === 'number' ? v : parseFloat(String(v)) || 0);
function rgb(v: string): [number, number, number, number] | null {
  const m = String(v).match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]; }
  const k = String(v).match(/oklab\(([\d.]+%?)\s+(-?[\d.e-]+)\s+(-?[\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\)/);
  if (k) { const L = parseFloat(k[1]!) / (k[1]!.endsWith('%') ? 100 : 1), A = +k[2]!, B = +k[3]!; const C = Math.hypot(A, B), H = (Math.atan2(B, A) * 180) / Math.PI; return oklchToRgb(L, C, H, k[4]! ? parseFloat(k[4]!) / (k[4]!.endsWith('%') ? 100 : 1) : 1); }
  const o = String(v).match(/oklch\(([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\)/);
  if (o) return oklchToRgb(parseFloat(o[1]!) / (o[1]!.endsWith('%') ? 100 : 1), +o[2]!, +o[3]!, o[4]! ? parseFloat(o[4]!) / (o[4]!.endsWith('%') ? 100 : 1) : 1);
  return null;
}
function oklchToRgb(L: number, C: number, H: number, a: number): [number, number, number, number] {
  const h = (H * Math.PI) / 180, A = C * Math.cos(h), B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const g = (x: number) => 255 * Math.max(0, Math.min(1, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  return [g(lin[0]!), g(lin[1]!), g(lin[2]!), a];
}
/** Perceptual-ish distance (redmean), with transparency treated as its own value. 0 = same, ~>25 visible. */
function colorDistance(a: string, b: string) {
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return a === b ? 0 : 100;
  if (x[3] < 0.05 && y[3] < 0.05) return 0;
  if ((x[3] < 0.05) !== (y[3] < 0.05)) return 100;
  const r = (x[0] + y[0]) / 2, dr = x[0] - y[0], dg = x[1] - y[1], db = x[2] - y[2];
  return Math.sqrt((2 + r / 256) * dr * dr + 4 * dg * dg + (2 + (255 - r) / 256) * db * db) / 3;
}

const CHECKS: { prop: string; label: string; weight: number; same: (a: any, b: any) => boolean }[] = [
  { prop: 'height', label: 'height', weight: 1.5, same: (a, b) => Math.abs(px(a) - px(b)) <= 1 },
  { prop: 'paddingLeft', label: 'padding-x', weight: 0.75, same: (a, b) => Math.abs(px(a) - px(b)) <= 1 },
  { prop: 'borderRadius', label: 'radius', weight: 1, same: (a, b) => Math.abs(px(a) - px(b)) <= 1 },
  { prop: 'backgroundColor', label: 'background', weight: 2, same: (a, b) => colorDistance(a, b) < 12 },
  { prop: 'color', label: 'text color', weight: 1.5, same: (a, b) => colorDistance(a, b) < 12 },
  { prop: 'borderWidth', label: 'border width', weight: 1, same: (a, b) => Math.abs(px(a) - px(b)) < 0.5 },
  { prop: 'borderColor', label: 'border color', weight: 0.75, same: (a, b) => colorDistance(a, b) < 12 },
  { prop: 'fontSize', label: 'font size', weight: 0.5, same: (a, b) => Math.abs(px(a) - px(b)) < 0.5 },
  { prop: 'fontWeight', label: 'font weight', weight: 0.25, same: (a, b) => String(a) === String(b) },
  { prop: 'textDecoration', label: 'underline', weight: 0.75, same: (a, b) => String(a).includes('underline') === String(b).includes('underline') },
];

export interface RenderedDiff { score: number; diffs: { label: string; element: string; system: string }[]; same: string[] }

export function compareRendered(el: Styles, sys: Styles): RenderedDiff {
  let got = 0, total = 0;
  const diffs: RenderedDiff['diffs'] = [], same: string[] = [];
  for (const c of CHECKS) {
    if (sys[c.prop] === undefined || el[c.prop] === undefined) continue; // not measured on one side
    // A border nobody can see isn't a border.
    if (c.prop === 'borderColor' && (px(el.borderWidth) === 0 && px(sys.borderWidth) === 0)) continue;
    if (c.prop === 'borderWidth' && (px(el.borderWidth) === 0 || rgb(String(el.borderColor))?.[3] === 0) && (px(sys.borderWidth) === 0 || rgb(String(sys.borderColor))?.[3] === 0)) continue;
    total += c.weight;
    if (c.same(el[c.prop], sys[c.prop])) { got += c.weight; same.push(c.label); }
    else diffs.push({ label: c.label, element: String(el[c.prop]), system: String(sys[c.prop]) });
  }
  return { score: total ? Math.round((got / total) * 100) / 100 : 0, diffs, same };
}

/** Which rendered variant/size of a component is closest to the element (independent of the static pick). */
export function closestRendered(el: Styles, comp: Record<string, { styles: Styles }>): { key: string; diff: RenderedDiff } | null {
  let best: { key: string; diff: RenderedDiff } | null = null;
  for (const [key, v] of Object.entries(comp)) {
    const d = compareRendered(el, v.styles);
    if (!best || d.score > best.diff.score) best = { key, diff: d };
  }
  return best;
}

const BOX = ['height', 'width', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'borderRadius', 'fontSize', 'gap', 'lineHeight'];
/**
 * Styles for a variant × size Storybook didn't show together: color props from the variant at its
 * default size, box props from the size at the default variant. Marked as composed.
 */
export function renderedFor(comp: Record<string, { styles: Styles; shot?: string }>, variant: string, size: string): { key: string; styles: Styles; shot?: string | undefined; composed: boolean; sizeMissing?: boolean } | null {
  const exact = comp[`${variant}/${size}`];
  if (exact) return { key: `${variant}/${size}`, ...exact, composed: false };
  const v = comp[`${variant}/default`] ?? Object.entries(comp).find(([k]) => k.startsWith(`${variant}/`))?.[1];
  const z = comp[`default/${size}`] ?? Object.entries(comp).find(([k]) => k.endsWith(`/${size}`))?.[1];
  if (!v && !z) return null;
  const styles: Styles = { ...(v?.styles ?? z!.styles) };
  // Box props come from the size; if Storybook never showed that size, leave them unmeasured rather than guess.
  for (const k of BOX) { if (z && z.styles[k] !== undefined) styles[k] = z.styles[k]!; else delete styles[k]; }
  return { key: `${variant}/${size}`, styles, shot: v?.shot ?? z?.shot, composed: true, sizeMissing: !z };
}

/**
 * After screenshots: what elements look like in the running app vs each system variant in Storybook.
 * Updates the latest run's evaluations — confirmation raises confidence a little; a clear disagreement
 * on variant switches the recommendation to what the rendering supports and sends it to a human.
 * Elements with identical classes share the measurement.
 */
export async function applyRenderedEvidence(dataDir: string, threshold = 0.9): Promise<{ confirmed: number; switched: number; measured: number }> {

  const rendered = readRendered(dataDir);
  let idx: any = null;
  try { idx = JSON.parse(fs.readFileSync(path.join(dataDir, 'shots', 'index.json'), 'utf8')); } catch { /* none */ }
  const res = { confirmed: 0, switched: 0, measured: 0 };
  if (!rendered || !idx) return res;
  const store = await openStore(dataDir, 'rendered evidence');
  try {
    const run = (await store.all<any>('select run_id from runs order by taken_at desc limit 1'))[0]?.run_id;
    if (!run) return res;
    const rows = await store.all<any>('select id, data from element_evals where run_id=$1', [run]);
    const evals = rows.map(r => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
    const bySig = new Map<string, Styles>();
    for (const e of evals) { const st = idx.shots?.[e.id]?.styles; if (st && e.styleSig) bySig.set(e.styleSig, st); }
    for (const e of evals) {
      const st: Styles | undefined = idx.shots?.[e.id]?.styles ?? (e.styleSig ? bySig.get(e.styleSig) : undefined);
      const comp = e.signature && rendered.components[e.signature.component];
      if (!st || !comp || e.decided) continue;
      e.reasons = (e.reasons ?? []).filter((r: any) => !String(r.text).startsWith('Rendered:'));
      const pick = renderedFor(comp, e.signature.variant, e.signature.size);
      if (!pick) continue;
      res.measured++;
      const mine = compareRendered(st, pick.styles);
      // Compare variants on color props only (size already chosen); closest among same-size or default-size renderings.
      const variants = Object.keys(comp).map(k => k.split('/')[0]!).filter((v, i, a) => a.indexOf(v) === i);
      let best = { v: e.signature.variant, score: mine.score };
      for (const v of variants) { const r = renderedFor(comp, v, e.signature.size); if (r) { const s = compareRendered(st, r.styles).score; if (s > best.score) best = { v, score: s }; } }
      const own = idx.shots?.[e.id]?.styles ? 'this element' : 'an identical element';
      // The classes say what the button is at rest; a screenshot can catch another state (disabled, unselected)
      // or miss a dark-theme border. A switch that contradicts the resting look is reported, not applied.
      // Red is a tone: a screenshot at rest can't see hover red, and a switch off a red variant loses it.
      const why = (v: string) => !e.look ? ''
        : e.look.danger && /^(destructive|danger)$/.test(e.signature.variant) && !/^(destructive|danger)$/.test(v) ? 'a red danger tone'
        : (e.look.fill || e.look.border === 'box') && /^(ghost|link)$/.test(v) ? 'a box at rest'
        : e.look.fromBranch ? 'a box that a condition switches on'
        : e.look.toolbar && v !== 'toolbar' ? 'toolbar chrome' : '';
      if (best.v !== e.signature.variant && best.score - mine.score >= 0.15 && why(best.v)) {
        // Kept, but the disagreement is a real doubt: a person confirms.
        const before = e.confidence;
        e.confidence = Math.min(before, Math.round((threshold - 0.05) * 100) / 100);
        e.alternatives = [{ verdict: e.verdict, role: e.role, use: e.use, from: e.from, props: { ...e.props, variant: best.v }, confidence: e.confidence }, ...(e.alternatives ?? [])].slice(0, 3);
        e.reasons.push({ text: `Rendered: the running app looked more like ${e.use} ${best.v} (${Math.round(best.score * 100)}%), but the classes show ${why(best.v)}; kept ${e.signature.variant}. A person should confirm.`, delta: Math.round((e.confidence - before) * 100) / 100 });
      } else if (best.v !== e.signature.variant && best.score - mine.score >= 0.15) {
        const before = e.confidence;
        e.alternatives = [{ verdict: e.verdict, role: e.role, use: e.use, from: e.from, props: { ...e.props }, confidence: before }, ...(e.alternatives ?? [])].slice(0, 3);
        e.props = { ...(e.props ?? {}), variant: best.v };
        e.signature = { ...e.signature, variant: best.v };
        e.confidence = Math.min(before, Math.round((threshold - 0.05) * 100) / 100);
        e.reasons.push({ text: `Rendered: in the running app ${own} looks like ${e.use} ${best.v} (${Math.round(best.score * 100)}% of measured properties), not ${pick.key.split('/')[0]} (${Math.round(mine.score * 100)}%). Switched the variant; a human should confirm.`, delta: Math.round((e.confidence - before) * 100) / 100 });
        res.switched++;
      } else if (mine.score >= 0.7) {
        const up = Math.min(0.04, 0.98 - e.confidence);
        e.confidence = Math.round((e.confidence + up) * 100) / 100;
        e.reasons.push({ text: `Rendered: ${own} measures ${Math.round(mine.score * 100)}% like ${e.use} ${pick.key}${pick.composed ? ' (size measured separately)' : ''}${mine.diffs.length ? `; differs on ${mine.diffs.map(d => d.label).join(', ')}` : ''}.`, delta: Math.round(up * 100) / 100 });
        res.confirmed++;
      } else {
        e.reasons.push({ text: `Rendered: ${own} measures ${Math.round(mine.score * 100)}% like ${e.use} ${pick.key}; differs on ${mine.diffs.map(d => d.label).join(', ')}.`, delta: 0 });
      }
      e.needsHuman = !e.decided && e.confidence < threshold;
      await store.exec('update element_evals set data=$3, confidence=$4, needs_human=$5 where run_id=$1 and id=$2', [run, e.id, JSON.stringify(e), e.confidence, e.needsHuman]);
    }
  } finally { store.close(); }
  return res;
}
