import type { Label } from '@snds/dsa';
import { lowerBound, r4, wilson } from './stats.js';
import { sourceOf, trustRubric, type Source, type TrustScore } from './trust.js';
import type { CardFacts } from './card-dom.js';

/**
 * `dsa bench`: is dsa right, and how sure can we be? Two numbers that are never merged:
 *
 *   presentation  can a person judge each recommendation from its card (the trust rubric);
 *   correctness   is the recommendation the right one (against labels.jsonl).
 *
 * Correctness keeps abstention apart from error. A recommendation under the ready bar is dsa saying "a
 * person decides": not a claim, so not an error. Over the bar it is a claim, right or wrong.
 *
 *   precision   right claims / claims
 *   recall      right claims / labelled elements (what share of the truth dsa claims and gets right)
 *   abstention  labelled elements under the bar / labelled elements
 *   errors      wrong claims / labelled elements
 *
 * With them: the share dsa could claim at 99% precision (and at what confidence), a reliability curve
 * and its expected calibration error (ECE) in 0.05 bins, the one-sided 95% lower bound on precision at
 * the ready bar, and Wilson intervals per app and per evidence source.
 */
export interface Prediction {
  id: string;
  target: string;
  file: string;
  line: number;
  verdict: string;
  use: string | null;
  props: Record<string, string>;
  /** The line its opening tag ends on, when the tag spans lines (a label may name any line of it). */
  openEndLine?: number | undefined;
  /** The scanner's confidence, before the evidence cap. */
  confidence: number;
  /** The confidence the card shows (after the cap): what decides "ready" on the page. */
  shown: number;
  source: Source;
}

/** Props as compared: strings, without the ones that only route rendering, without defaults. */
const norm = (props: Record<string, unknown> | null | undefined) =>
  Object.fromEntries(Object.entries(props ?? {}).filter(([k, v]) => !['render', 'asChild', 'children'].includes(k) && v != null && v !== '' && v !== 'default').map(([k, v]) => [k, String(v)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
const sameProps = (a: Record<string, unknown> | undefined | null, b: Record<string, unknown> | undefined | null) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/**
 * What each card recommends, as a prediction: the question's (or part's) pick, else the element's own, at
 * the scanner's confidence before the evidence cap. Decided and excepted elements are not predictions.
 */
export function predictionsOf(payload: any): Prediction[] {
  const E = payload.elements;
  const proposes = new Map<string, any>();
  for (const q of E?.questions ?? []) {
    for (const p of q.parts ?? []) for (const id of p.ids) proposes.set(id, p.auto);
    for (const id of q.ids) if (!proposes.has(id)) proposes.set(id, q.auto);
  }
  return (E?.evals ?? []).filter((e: any) => !e.exception && !e.decided && e.reach?.status !== 'unused').map((e: any) => {
    const r = proposes.get(e.id) ?? e;
    // The scanner's own score, before the evidence cap: the cap holds a card under the bar until a person
    // can see it, which is presentation. Scoring correctness on the capped number would merge the two.
    return { id: e.id, target: e.target, file: e.file, line: e.line, ...(e.openEndLine > e.line ? { openEndLine: e.openEndLine } : {}), verdict: r?.verdict ?? e.verdict, use: r?.use ?? null, props: norm(r?.props), confidence: e.evidenceCap?.from ?? e.confidence, shown: e.confidence, source: sourceOf(e.shot) };
  });
}

/** Is the prediction one of the label's right answers? */
export function isCorrect(l: Label, p: Prediction): boolean {
  if (p.verdict !== l.truth.verdict) return false;
  if (l.truth.verdict !== 'replace') return true;
  if (p.use === l.truth.use && sameProps(p.props, l.truth.props)) return true;
  return l.acceptableAlts.some((a) => a.use === p.use && (a.props === undefined || sameProps(p.props, a.props)));
}

/** The prediction a label is about: by id, else by app, file and line (either path may carry a leading folder the other doesn't), or any line of a multi-line opening tag. */
export function matchLabels(labels: Label[], preds: Prediction[]): { label: Label; pred: Prediction | null }[] {
  const byId = new Map(preds.map((p) => [p.id, p]));
  const byLine = new Map<string, Prediction[]>();
  for (const p of preds) byLine.set(`${p.target}\u0001${p.line}`, [...(byLine.get(`${p.target}\u0001${p.line}`) ?? []), p]);
  const sameFile = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  // A multi-line opening tag: the label may name any line of it, not only the first.
  const spanning = preds.filter((p) => p.openEndLine !== undefined && p.openEndLine > p.line);
  const inSpan = (label: Label) => spanning.find((p) => p.target === label.app && label.line > p.line && label.line <= p.openEndLine! && sameFile(p.file, label.file));
  return labels.map((label) => ({ label, pred: byId.get(label.id) ?? (byLine.get(`${label.app}\u0001${label.line}`) ?? []).find((p) => sameFile(p.file, label.file)) ?? inSpan(label) ?? null }));
}

export interface RateCI { n: number; k: number; rate: number | null; ci: [number, number] }
const rateCI = (k: number, n: number): RateCI => ({ n, k, rate: n ? r4(k / n) : null, ci: wilson(k, n).map(r4) as [number, number] });

export interface Correctness {
  threshold: number;
  labels: number;
  /** Labels with no element in the scan (the code moved, or the scanner didn't see it): misses, never errors. */
  unmatched: number;
  matched: number;
  claimed: number;
  abstained: number;
  right: number;
  wrong: number;
  precision: number | null;
  recall: number | null;
  abstention: number | null;
  errorRate: number | null;
  /** One-sided 95% lower bound on precision at the ready bar. */
  precisionLowerBound: number;
  /** The most dsa could claim with precision at or over 0.99: the confidence to claim from, and what share of labels that covers. */
  coverageAt99: { from: number | null; claimed: number; coverage: number; precision: number | null };
  reliability: { from: number; to: number; n: number; confidence: number | null; accuracy: number | null }[];
  ece: number | null;
  byApp: Record<string, { precision: RateCI; accuracy: RateCI }>;
  bySource: Record<string, { precision: RateCI; accuracy: RateCI }>;
  /** Labels per method, so a reader sees how much is migrated or history and how much a person checked. */
  byMethod: Record<string, number>;
}

/** Score predictions against labels. */
export function correctness(labels: Label[], preds: Prediction[], threshold = 0.9): Correctness {
  const pairs = matchLabels(labels, preds);
  const seen = pairs.filter((x): x is { label: Label; pred: Prediction } => Boolean(x.pred));
  const rows = seen.map(({ label, pred }) => ({ label, pred, right: isCorrect(label, pred), claim: pred.confidence >= threshold }));
  const claimed = rows.filter((r) => r.claim);
  const right = claimed.filter((r) => r.right).length;
  const N = labels.length;
  // Coverage at 99%: claim from the lowest confidence that keeps precision over everything above it ≥ 0.99.
  const sorted = [...rows].sort((a, b) => b.pred.confidence - a.pred.confidence);
  let best = { from: null as number | null, claimed: 0, coverage: 0, precision: null as number | null };
  let k = 0;
  for (let i = 0; i < sorted.length; i++) {
    k += sorted[i]!.right ? 1 : 0;
    // Only at a boundary between confidences: a cut can't split equal scores.
    if (i + 1 < sorted.length && sorted[i + 1]!.pred.confidence === sorted[i]!.pred.confidence) continue;
    if (k / (i + 1) >= 0.99) best = { from: sorted[i]!.pred.confidence, claimed: i + 1, coverage: r4((i + 1) / (N || 1)), precision: r4(k / (i + 1)) };
  }
  // Reliability: 20 bins of 0.05; the last holds 1.0.
  const bins = Array.from({ length: 20 }, (_, i) => ({ from: r4(i * 0.05), to: r4((i + 1) * 0.05), xs: [] as { c: number; ok: boolean }[] }));
  for (const r of rows) bins[Math.min(19, Math.floor(r.pred.confidence / 0.05 + 1e-9))]!.xs.push({ c: r.pred.confidence, ok: r.right });
  const reliability = bins.map((b) => ({ from: b.from, to: b.to, n: b.xs.length, confidence: b.xs.length ? r4(b.xs.reduce((a, x) => a + x.c, 0) / b.xs.length) : null, accuracy: b.xs.length ? r4(b.xs.filter((x) => x.ok).length / b.xs.length) : null }));
  const ece = rows.length ? r4(reliability.reduce((a, b) => a + (b.n ? (b.n / rows.length) * Math.abs(b.accuracy! - b.confidence!) : 0), 0)) : null;
  const group = (key: (r: (typeof rows)[number]) => string) => {
    const out: Record<string, { precision: RateCI; accuracy: RateCI }> = {};
    for (const g of new Set(rows.map(key))) {
      const rs = rows.filter((r) => key(r) === g), cl = rs.filter((r) => r.claim);
      out[g] = { precision: rateCI(cl.filter((r) => r.right).length, cl.length), accuracy: rateCI(rs.filter((r) => r.right).length, rs.length) };
    }
    return out;
  };
  const byMethod: Record<string, number> = {};
  for (const l of labels) byMethod[l.method] = (byMethod[l.method] ?? 0) + 1;
  return {
    threshold, labels: N, unmatched: N - seen.length, matched: seen.length,
    claimed: claimed.length, abstained: rows.length - claimed.length, right, wrong: claimed.length - right,
    precision: claimed.length ? r4(right / claimed.length) : null,
    recall: N ? r4(right / N) : null,
    abstention: N ? r4((rows.length - claimed.length) / N) : null,
    errorRate: N ? r4((claimed.length - right) / N) : null,
    precisionLowerBound: r4(lowerBound(right, claimed.length)),
    coverageAt99: best, reliability, ece,
    byApp: group((r) => r.pred.target),
    bySource: group((r) => r.pred.source),
    byMethod,
  };
}

/** The presentation side, as the bench prints it: the trust rubric's pass rate and what blocks it. */
export function presentation(t: TrustScore) {
  return { recommendations: t.recommendations, passing: t.passing, rate: t.rate, blocking: t.blocking, untested: t.untested, sources: t.sources, excluded: t.excluded, freshness: t.freshness };
}

export interface BenchResult {
  presentation: ReturnType<typeof presentation>;
  correctness: Correctness | null;
}

/** Both numbers for one published page (or report payload). */
export function bench(payload: any, labels: Label[] | null, opts: { cards?: CardFacts[] | null; dir?: string; threshold?: number } = {}): BenchResult {
  const th = opts.threshold ?? payload.elements?.threshold ?? 0.9;
  const t = trustRubric(payload, { ...(opts.dir ? { dir: opts.dir } : {}), cards: opts.cards ?? null });
  return { presentation: presentation(t), correctness: labels ? correctness(labels, predictionsOf(payload), th) : null };
}

/**
 * The same build scored several times: what changes between runs that should agree. Per element in
 * every run: does its rubric pass flip, does its recommendation (verdict, component, props) flip, how far
 * apart are its confidences, and does it cross the ready line?
 */
export function repeatability(payloads: any[], opts: { cards?: (CardFacts[] | null)[]; dirs?: (string | undefined)[]; threshold?: number } = {}) {
  const th = opts.threshold ?? payloads[0]?.elements?.threshold ?? 0.9;
  const runs = payloads.map((p, i) => ({
    trust: new Map(trustRubric(p, { ...(opts.dirs?.[i] ? { dir: opts.dirs[i]! } : {}), cards: opts.cards?.[i] ?? null }).rows.map((r) => [r.id, r.pass])),
    preds: new Map(predictionsOf(p).map((x) => [x.id, x])),
  }));
  const ids = [...(runs[0]?.preds.keys() ?? [])].filter((id) => runs.every((r) => r.preds.has(id)));
  let passFlips = 0, verdictFlips = 0, crossings = 0, scannerCrossings = 0, passCompared = 0;
  const spreads: number[] = [];
  for (const id of ids) {
    const ps = runs.map((r) => r.preds.get(id)!);
    const passes = runs.map((r) => r.trust.get(id)).filter((x): x is boolean => x !== undefined);
    if (passes.length === runs.length) { passCompared++; if (new Set(passes).size > 1) passFlips++; }
    if (new Set(ps.map((p) => `${p.verdict}|${p.use}|${JSON.stringify(p.props)}`)).size > 1) verdictFlips++;
    // The ready line as the page shows it (after the cap), and the scanner's own score apart.
    const cs = ps.map((p) => p.shown);
    const lo = Math.min(...cs), hi = Math.max(...cs);
    spreads.push(hi - lo);
    if (lo < th && hi >= th) crossings++;
    const raw = ps.map((p) => p.confidence);
    if (Math.min(...raw) < th && Math.max(...raw) >= th) scannerCrossings++;
  }
  spreads.sort((a, b) => a - b);
  const q = (p: number) => (spreads.length ? r4(spreads[Math.min(spreads.length - 1, Math.floor(p * spreads.length))]!) : null);
  const n = ids.length;
  return {
    runs: payloads.length, elements: n,
    passFlips, passFlipRate: passCompared ? r4(passFlips / passCompared) : null,
    verdictFlips, verdictFlipRate: n ? r4(verdictFlips / n) : null,
    crossings, crossingRate: n ? r4(crossings / n) : null,
    scannerCrossings,
    confidenceSpread: { mean: n ? r4(spreads.reduce((a, x) => a + x, 0) / n) : null, p90: q(0.9), max: q(1) },
    threshold: th,
  };
}

/** The bench in plain lines. Presentation and correctness are printed apart, never as one number. */
export function benchText(b: BenchResult, rep?: ReturnType<typeof repeatability> | null): string {
  const pct = (x: number | null | undefined) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const P = b.presentation, C = b.correctness;
  const lines = [
    `Presentation (can a person judge it from the card): ${P.passing} of ${P.recommendations} pass (${P.rate}%).${P.untested.length ? ` Card checks untested: ${P.untested.join(', ')}.` : ''}`,
    `  Blocked by: ${P.blocking.map((x) => `${x.text} ${x.failing}`).join('; ') || 'nothing'}.`,
    `  Pictures: ${Object.entries(P.sources).map(([k, v]) => `${k} ${v}`).join(', ')}. Left out: ${Object.entries(P.excluded).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
  ];
  if (P.freshness?.byApp) for (const [app, f] of Object.entries<any>(P.freshness.byApp)) lines.push(`  ${app}: ${f.kept} photos count; ${f.olderRun} from an older run and ${f.unstamped} unstamped set aside; oldest that counts ${f.oldestHours ?? '—'} h before the run.`);
  if (!C) lines.push('Correctness: no labels (pass --labels).');
  else {
    lines.push(
      `Correctness (is it the right answer), at the ${C.threshold} ready bar, over ${C.labels} labels (${Object.entries(C.byMethod).map(([k, v]) => `${k} ${v}`).join(', ')}):`,
      `  precision ${pct(C.precision)} (${C.right} of ${C.claimed} claims; 95% lower bound ${pct(C.precisionLowerBound)}), recall ${pct(C.recall)}, abstained ${pct(C.abstention)} (${C.abstained}), errors ${pct(C.errorRate)} (${C.wrong}), not in the scan ${C.unmatched}.`,
      `  At 99% precision dsa could claim ${C.coverageAt99.claimed} (${pct(C.coverageAt99.coverage)}) from confidence ${C.coverageAt99.from ?? '—'}. ECE ${C.ece ?? '—'}.`,
      ...Object.entries(C.byApp).map(([k, v]) => `  ${k}: precision ${pct(v.precision.rate)} [${pct(v.precision.ci[0])}, ${pct(v.precision.ci[1])}] of ${v.precision.n}; accuracy ${pct(v.accuracy.rate)} of ${v.accuracy.n}.`),
      ...Object.entries(C.bySource).map(([k, v]) => `  ${k} pictures: precision ${pct(v.precision.rate)} [${pct(v.precision.ci[0])}, ${pct(v.precision.ci[1])}] of ${v.precision.n}; accuracy ${pct(v.accuracy.rate)} of ${v.accuracy.n}.`),
    );
  }
  if (rep) lines.push(`Repeatability over ${rep.runs} runs, ${rep.elements} elements: passes flip ${rep.passFlips} (${pct(rep.passFlipRate)}), recommendations flip ${rep.verdictFlips} (${pct(rep.verdictFlipRate)}), ${rep.crossings} cross the ${rep.threshold} line as shown (${pct(rep.crossingRate)}; ${rep.scannerCrossings} on the scanner's own score); shown confidence spread mean ${rep.confidenceSpread.mean}, p90 ${rep.confidenceSpread.p90}, max ${rep.confidenceSpread.max}.`);
  return lines.join('\n');
}
