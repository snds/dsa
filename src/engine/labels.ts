import fs from 'node:fs';
import { calibrate, type CalibrationStats, type Recommendation } from './classify.js';
import type { ElementEval } from './elements.js';

/**
 * Confidence as measured precision (review item 20).
 *
 * A label set (`labels.jsonl`, one JSON object per line, written by the labelling tools) says what each
 * labelled element should become. With it, every decision path (the rule that fired and the verdict it
 * gave) gets a measured precision:
 *
 * 1. calibrate() (classify.ts) runs on the labels: each rule's starting score is replaced by its observed
 *    agreement, as it is for reviewers' decisions. An element never calibrates itself.
 * 2. Isotonic calibration (pool-adjacent-violators) maps each path's score to its measured precision, so a
 *    higher score never means a lower precision. Paths with few labels share the pooled fit.
 * 3. "Ready" is decided on a pooled band of scores: every element scoring at or above a cut, where the
 *    cut is the lowest score whose band (all paths' labels at or above it) has a one-sided 95% lower
 *    bound of at least 0.99 (readyCut; about 270 clean labels). The element's own path must show no
 *    error among its labels in that band. Everything else stays under the bar, its measured
 *    precision squeezed into [0, threshold) so blocks keep their order (squeeze).
 *
 * Without labels nothing changes, and each evaluation says its confidence is uncalibrated.
 */

export interface Label {
  id?: string | undefined;
  app?: string | undefined;
  file?: string | undefined;
  line?: number | undefined;
  sourceRef?: string | undefined;
  elementHash?: string | undefined;
  truth: Recommendation;
  acceptableAlts?: Recommendation[] | undefined;
  labeler?: string | undefined;
  method?: string | undefined;
  at?: string | undefined;
  notes?: string | undefined;
}

export interface Calibration {
  status: 'calibrated' | 'uncalibrated';
  /** The decision path: rule and verdict. */
  path?: string | undefined;
  /** Labels behind the fit (the path's own, or the pool's). */
  n?: number | undefined;
  /** Measured precision at this score. */
  precision?: number | undefined;
  /** One-sided 95% lower bound of that precision (Wilson). */
  lower?: number | undefined;
  /** The lower bound clears READY_LOWER_BOUND. */
  ready?: boolean | undefined;
  /** The fit came from all labels, because this path has too few. */
  pooled?: boolean | undefined;
  /** The ready band (readyCut): the cut it starts at, its labels across paths, and its lower bound. */
  band?: { from: number; n: number; right: number; lower: number } | undefined;
}

export const READY_LOWER_BOUND = 0.99;
/** A path needs this many labels for a fit of its own. */
export const MIN_PATH_LABELS = 20;
const Z95 = 1.6449;

/** Read labels.jsonl. Blank and unreadable lines are skipped and counted. */
export function readLabels(file: string): { labels: Label[]; skipped: number } {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { labels: [], skipped: 0 }; }
  const labels: Label[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const l = JSON.parse(line);
      if (l && typeof l === 'object' && l.truth && typeof l.truth.verdict === 'string') labels.push(l); else skipped++;
    } catch { skipped++; }
  }
  return { labels, skipped };
}

// Props compare as the bench compares them: "default" and empty values are the same as unset.
const norm = (p?: Record<string, string>) => JSON.stringify(Object.entries(p ?? {}).filter(([k, v]) => !['render', 'asChild', 'children'].includes(k) && v != null && v !== '' && v !== 'default').map(([k, v]) => [k, String(v)]).sort());
const same = (a: Recommendation, b: Recommendation) => a.verdict === b.verdict && (a.verdict !== 'replace' || ((a.use ?? '') === (b.use ?? '') && norm(a.props) === norm(b.props)));

/** Either path may carry a leading folder the other doesn't (the app's name, a workspace folder). */
const sameFile = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/**
 * The label for an evaluation: by id, else by app, line and file. (A label's elementHash hashes the
 * element's source text; it says when the code changed under a label, so it isn't used to match.)
 */
export function labelFor(e: ElementEval, labels: Label[]): Label | undefined {
  return labels.find(l => l.id === e.id)
    ?? labels.find(l => l.line === e.line && l.file !== undefined && sameFile(e.file, l.file) && (!l.app || l.app === e.target))
    // A label may name any line of a multi-line opening tag.
    ?? labels.find(l => l.line !== undefined && l.line > e.line && l.line <= (e.openEndLine ?? e.line) && l.file !== undefined && sameFile(e.file, l.file) && (!l.app || l.app === e.target));
}

/** Is the recommendation right by the label? The truth, or any acceptable alternative. */
export const isCorrect = (e: Recommendation, l: Label) => same(e, l.truth) || (l.acceptableAlts ?? []).some(a => same(e, a) || (e.verdict === 'replace' && a.use === e.use && a.props === undefined));

export const pathOf = (e: { ruleId: string; verdict: string }) => `${e.ruleId}|${e.verdict}`;

/**
 * A not-ready block's measured precision, mapped into [0, threshold) keeping order: v·(threshold − 0.001),
 * to three decimals. A block that isn't ready can't claim, but ranking and coverage still see how good it is.
 */
export const squeeze = (v: number, threshold: number) => Math.floor(Math.max(0, Math.min(1, v)) * (threshold - 0.001) * 1000) / 1000;

/** Wilson score interval, one-sided 95% lower bound. */
export function lowerBound(k: number, n: number): number {
  if (!n) return 0;
  const p = k / n, z2 = Z95 * Z95;
  return (p + z2 / (2 * n) - Z95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

/** Isotonic regression by pool-adjacent-violators: maximal blocks of scores with their pooled precision and size. */
export function isotonic(points: { score: number; ok: boolean }[]): { lo: number; hi: number; k: number; n: number }[] {
  const sorted = [...points].sort((a, b) => a.score - b.score);
  const blocks: { lo: number; hi: number; k: number; n: number }[] = [];
  // Points that share a score are one block from the start: their order among themselves means nothing.
  const groups: { lo: number; hi: number; k: number; n: number }[] = [];
  for (const p of sorted) {
    const g = groups[groups.length - 1];
    if (g && g.hi === p.score) { g.n++; if (p.ok) g.k++; } else groups.push({ lo: p.score, hi: p.score, k: p.ok ? 1 : 0, n: 1 });
  }
  for (const g of groups) {
    blocks.push({ ...g });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!, a = blocks[blocks.length - 2]!;
      // Pool violators and ties: equal neighbours are one block, so the lower bound counts all of them.
      if (a.k / a.n < b.k / b.n) break;
      blocks.splice(blocks.length - 2, 2, { lo: a.lo, hi: b.hi, k: a.k + b.k, n: a.n + b.n });
    }
  }
  return blocks;
}

/** The block a score falls in: the last one starting at or below it (scores below every label take the first). */
const blockAt = (blocks: ReturnType<typeof isotonic>, score: number) => [...blocks].reverse().find(b => b.lo <= score) ?? blocks[0];

/** Per-rule agreement from the labels, the shape calibrate() takes. */
function ruleStatsFrom(pairs: { e: ElementEval; l: Label }[], without?: string): Map<string, CalibrationStats> {
  const m = new Map<string, CalibrationStats & { fixes: Record<string, number> }>();
  for (const { e, l } of pairs) {
    if (e.id === without) continue;
    const s = m.get(e.ruleId) ?? { n: 0, agree: 0, componentAgree: 0, propFixes: 0, fixes: {} };
    s.n++;
    if (isCorrect(e, l)) s.agree++;
    if (e.verdict === l.truth.verdict && (e.use ?? '') === (l.truth.use ?? '')) {
      s.componentAgree = (s.componentAgree ?? 0) + 1;
      const a = l.truth.props ?? {}, b = e.props ?? {};
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k] && k !== 'render') { s.fixes[`${k}=${a[k] ?? 'unset'}`] = (s.fixes[`${k}=${a[k] ?? 'unset'}`] ?? 0) + 1; s.propFixes = (s.propFixes ?? 0) + 1; }
    }
    m.set(e.ruleId, s);
  }
  return m;
}

/**
 * The ready cut: the lowest score c such that every labelled point scoring c or more, pooled across paths,
 * has a one-sided 95% lower bound of at least READY_LOWER_BOUND. Undefined when no cut clears it.
 */
export function readyCut(points: { score: number; ok: boolean }[]): { cut: number; n: number; k: number; lower: number } | undefined {
  const sorted = [...points].sort((a, b) => b.score - a.score);
  let n = 0, k = 0, best: { cut: number; n: number; k: number; lower: number } | undefined;
  for (let i = 0; i < sorted.length; i++) {
    n++; if (sorted[i]!.ok) k++;
    // Only between distinct scores: a cut takes every point at its score.
    if (i + 1 < sorted.length && sorted[i + 1]!.score === sorted[i]!.score) continue;
    const lower = lowerBound(k, n);
    if (lower >= READY_LOWER_BOUND) best = { cut: sorted[i]!.score, n, k, lower: Math.round(lower * 1000) / 1000 };
  }
  return best;
}

/**
 * Calibrate every evaluation on the labels (in place). Returns how many labels matched an element.
 * Decided elements are left alone: a person's decision isn't a guess.
 */
export function applyLabels(evals: ElementEval[], labels: Label[], threshold: number): { matched: number; paths: number } {
  if (!labels.length) {
    for (const e of evals) e.calibration = { status: 'uncalibrated' };
    return { matched: 0, paths: 0 };
  }
  const pairs = evals.map(e => ({ e, l: labelFor(e, labels) })).filter((x): x is { e: ElementEval; l: Label } => Boolean(x.l));
  // 1. Rule agreement replaces each rule's prior (an element's own label left out).
  const all = ruleStatsFrom(pairs);
  const labelled = new Set(pairs.map(p => p.e.id));
  for (const e of evals) {
    if (e.decided) continue;
    const stats = labelled.has(e.id) ? ruleStatsFrom(pairs, e.id).get(e.ruleId) : all.get(e.ruleId);
    const c = calibrate(e, stats);
    if (c !== e) Object.assign(e, { confidence: c.confidence, reasons: c.reasons, alternatives: c.alternatives, calibrated: c.calibrated });
  }
  // 2. Isotonic fit of the (now rule-calibrated) score to measured precision, per path, pooled when thin.
  const points = (ps: typeof pairs) => ps.map(({ e, l }) => ({ score: e.confidence, ok: isCorrect(e, l) }));
  const pooled = isotonic(points(pairs));
  const byPath = new Map<string, ReturnType<typeof isotonic>>();
  const pathPairs = new Map<string, typeof pairs>();
  for (const p of pairs) pathPairs.set(pathOf(p.e), [...(pathPairs.get(pathOf(p.e)) ?? []), p]);
  for (const [k, ps] of pathPairs) if (ps.length >= MIN_PATH_LABELS) byPath.set(k, isotonic(points(ps)));
  // 3. Ready is decided on a pooled band of calibrated scores across paths, where labels add up: the band
  //    is every score at or above a cut, and the cut is the LOWEST score at which the band's one-sided 95%
  //    lower bound reaches 0.99. The path's own labels in the band must show no error. With no such cut,
  //    nothing is ready. The cut is fitted on these labels and applies unchanged to every element.
  const cut = readyCut(pairs.map(({ e, l }) => ({ score: e.confidence, ok: isCorrect(e, l) })));
  const band = cut ? { lo: cut.cut, n: cut.n, k: cut.k } : undefined;
  const bandLower = cut ? cut.lower : 0;
  const bandReady = Boolean(cut);
  const pathErrorsInBand = new Map<string, number>();
  if (band) for (const p of pairs) if (p.e.confidence >= band.lo && !isCorrect(p.e, p.l)) pathErrorsInBand.set(pathOf(p.e), (pathErrorsInBand.get(pathOf(p.e)) ?? 0) + 1);
  // For the reason text when nothing is ready: the best band there is (the top pooled block).
  const top = pooled.length ? pooled[pooled.length - 1]! : undefined;
  for (const e of evals) {
    if (e.decided) continue;
    const key = pathOf(e);
    const own = byPath.get(key);
    const blocks = own ?? (pairs.length >= MIN_PATH_LABELS ? pooled : undefined);
    if (!blocks || !blocks.length) { e.calibration = { status: 'uncalibrated', path: key }; continue; }
    const b = blockAt(blocks, e.confidence)!;
    const precision = Math.round((b.k / b.n) * 1000) / 1000, lower = Math.round(lowerBound(b.k, b.n) * 1000) / 1000;
    const inBand = Boolean(band && e.confidence >= band.lo);
    const ready = bandReady && inBand && !pathErrorsInBand.get(key);
    const before = e.confidence;
    // Not ready is only "not ready": the block keeps its place in the order, squeezed under the bar.
    e.confidence = ready ? Math.max(threshold, Math.round(Math.min(0.98, band!.k / band!.n) * 1000) / 1000) : squeeze(precision, threshold);
    e.needsHuman = e.confidence < threshold;
    e.calibration = { status: 'calibrated', path: key, n: b.n, precision, lower, ready, ...(own ? {} : { pooled: true }), ...(band ? { band: { from: band.lo, n: band.n, right: band.k, lower: Math.round(bandLower * 1000) / 1000 } } : {}) };
    const why = ready ? '' : !bandReady ? `; no score has a band above it that clears 99% (the top block has ${top?.k ?? 0} of ${top?.n ?? 0} right, lower bound ${Math.round(lowerBound(top?.k ?? 0, top?.n ?? 0) * 1000) / 10}%)` : !inBand ? `, below the ready cut (${band!.lo})` : `; this path has ${pathErrorsInBand.get(key)} error(s) in the ready band`;
    e.reasons.push({ text: `Measured on labels: ${Math.round(precision * 100)}% right at this score (${b.k} of ${b.n}${own ? '' : ', all paths pooled'})${ready ? `; ready: the band at or above ${band?.lo} across paths clears 99% and this path has no error in it` : `, not ready${why}`}.`, delta: Math.round((e.confidence - before) * 100) / 100 });
  }
  return { matched: pairs.length, paths: byPath.size };
}
