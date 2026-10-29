import crypto from 'node:crypto';
import { system } from './system.js';
import { applyHints, type Hint } from './hints.js';
import fs from 'node:fs';
import path from 'node:path';
import { calibrate, classify, systemRoleMap, describe, roleMapFrom, type CalibrationStats, type Evaluation, type Recommendation, type RoleMap } from './classify.js';
import { readRawElements, type Config } from './config.js';
import { globMatch, readJson, targetRelative } from './paths.js';
import type { Lookalike, Target } from './types.js';
import { withPlacement, type PagePlacement, type Region } from './placement.js';
import { asHostCopy, systemIndex, hostCopyOf, isLabFile } from './host-context.js';
import { importedFromSystem } from './scanners/features.js';
import { readAliases } from './modules.js';

/**
 * The element review: every native element the map covers gets an evaluation, with a
 * recommendation, a confidence, the evidence, and (when one exists) a recorded decision.
 *
 * Decisions live in each app's decisions file (the profile's files.decisions), next to the exceptions
 * file, so they travel with the code and are reviewed in pull requests like everything else.
 */

export const DEFAULT_DECISIONS_FILE = 'docs/raw-elements.decisions.json';
export const DEFAULT_THRESHOLD = 0.9;

export interface Decision {
  fingerprint: string;
  file: string;
  line: number;
  element: string;
  decision: Recommendation;
  /** What the evaluator recommended when the decision was made. */
  recommended?: Recommendation & { ruleId: string; confidence: number } | undefined;
  /** Same verdict and component as the recommendation (props aside). */
  agreed?: boolean | undefined;
  /** Agreed on the component but changed a prop (size, variant). */
  propsChanged?: boolean | undefined;
  by: 'human' | 'agent';
  who?: string | undefined;
  note?: string | undefined;
  date: string;
  /**
   * Shared by every decision one answer produced (a pattern, or a whole card decided at once), so
   * calibration counts that answer once. Older pattern decisions carry it only as note "pattern X".
   */
  judgment?: string | undefined;
}

export interface Policy {
  /** Applies to every evaluation matching all given fields. */
  match: { role?: string | undefined; ruleId?: string | undefined; element?: string | undefined; paths?: string[]; styleKey?: string | undefined; styleSig?: string | undefined };
  decision: Recommendation;
  why: string;
  by: 'human' | 'agent';
  who?: string | undefined;
  date: string;
}

export interface DecisionsFile { file: string; decisions: Decision[]; policies: Policy[] }

export interface ElementEval extends Evaluation {
  id: string;
  target: string;
  file: string;
  line: number;
  col: number;
  element: string;
  fingerprint: string;
  needsHuman: boolean;
  /** lab: on a lab page (features/*Lab*), a specimen rather than product UI (host-context.ts). */
  exception?: 'temporary' | 'allow' | 'unused' | 'lab' | undefined;
  /** Can it be seen, and what does it take (reach.ts)? */
  reach?: import('./reach.js').Reach | undefined;
  decided?: { by: 'human' | 'agent' | 'policy'; decision: Recommendation; note?: string | undefined; who?: string | undefined; date?: string | undefined } | undefined;
  snippet: string;
  source: string;
  /** The shared class constant this element is styled by (PLUS_NOUN_LINK), if any. */
  styleKey?: string | undefined;
  /** Hash of the element's visual classes: identical styling clusters even without a constant. */
  styleSig?: string | undefined;
  /** Every class token the element can have (resolved through constants), and those that only apply under a condition. */
  classTokens?: string[] | undefined;
  conditionalTokens?: string[] | undefined;
  /** What screenshots use to find the element in a running app. */
  match: { tag: string; classes: string[]; text: string; ariaLabel?: string | undefined; title?: string | undefined; role?: string | undefined; type?: string | undefined };
  /** Regions it sits in (its file, the render chain, the page), innermost first. */
  regions?: Region[] | undefined;
  /** Scanner hints that changed this evaluation (dsa.hints.json ids). */
  hints?: string[] | undefined;
  /** The component or function it is written in. */
  within?: string | undefined;
  /** When that component is a hand-built copy of a system component (a host AmountInput): the system's name. */
  recipe?: string | undefined;
  /** The wrapper holding this control's parts (a menu surface, a group, buttons side by side). */
  container?: { name: string; line: number } | undefined;
}

export function loadRoleMap(root: string, config: Config): RoleMap {
  if (!config.rawElements) return systemRoleMap();
  return roleMapFrom(readRawElements(root, config.rawElements));
}

export function readDecisions(dir: string, rel = DEFAULT_DECISIONS_FILE): DecisionsFile {
  const file = path.join(dir, rel);
  const raw = readJson<any>(file);
  return { file, decisions: raw?.decisions ?? [], policies: raw?.policies ?? [] };
}

export function writeDecisions(df: DecisionsFile) {
  fs.mkdirSync(path.dirname(df.file), { recursive: true });
  const body = {
    $comment: 'Element review decisions (DS analytics suite). One entry per decided element, keyed by fingerprint; policies apply to every matching element. Edit by hand or with `dsa decide`.',
    decisions: [...df.decisions].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    policies: df.policies,
  };
  fs.writeFileSync(df.file, JSON.stringify(body, null, 2) + '\n');
}

/**
 * Stable id for an element: its file and full source, plus its ordinal among identical twins in
 * that file. Survives line moves and edits elsewhere; changes when the element itself changes
 * (which is when a past decision should be looked at again).
 */
export function fingerprint(target: string, l: Lookalike, ordinal = 0) {
  const h = crypto.createHash('sha1').update([target, l.file, l.element, l.features?.source ?? l.features?.openTag ?? '', String(ordinal)].join('\u0001')).digest('hex');
  return h.slice(0, 12);
}

/** Same verdict and component: the call a rule is calibrated on. Props (size, variant) are a finer pick. */
export const sameComponent = (a: Recommendation, b: Recommendation) =>
  a.verdict === b.verdict && (a.use ?? '') === (b.use ?? '');
export const sameRec = (a: Recommendation, b: Recommendation) =>
  sameComponent(a, b) && JSON.stringify(sortObj(a.props ?? {})) === JSON.stringify(sortObj(b.props ?? {}));
const sortObj = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/** "size=xs" for each prop the decision set differently from the recommendation. */
export function propChanges(decision: Recommendation, recommended: Recommendation): string[] {
  const a = decision.props ?? {}, b = recommended.props ?? {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort().map(k => `${k}=${a[k] ?? 'unset'}`);
}

/**
 * Per rule: how many independent human judgments, and how many accepted the call exactly.
 *
 * One answer is one judgment however many elements it covered: a pattern decision over 41 buttons
 * is one person's call, not 41 agreements. A judgment that kept the component but changed a prop
 * (Button link → link xs) is a props miss: the recommendation as given was wrong. It is tracked
 * apart (componentAgree, fixes) so calibration can offer the fix. Older files that stored
 * agreed: true for a size change are read the same way, since agreement is recomputed here.
 */
export interface Judgment { ruleId: string; fingerprints: string[]; agree: number; component: number; fixes: Record<string, number> }
export interface RuleStats extends Required<Omit<CalibrationStats, 'fixes'>> { fixes: Record<string, number>; judgments: Judgment[] }

export function judgmentOf(d: Decision): string {
  if (d.judgment) return d.judgment;
  const pattern = /^pattern (\S+)$/.exec(d.note ?? '')?.[1];
  return pattern ? `pattern:${pattern}` : `fp:${d.fingerprint}`;
}

export function ruleStats(files: DecisionsFile[]): Map<string, RuleStats> {
  const groups = new Map<string, Decision[]>();
  for (const f of files) for (const d of f.decisions) {
    if (d.by !== 'human' || !d.recommended) continue;
    const k = `${d.recommended.ruleId}\u0001${judgmentOf(d)}`;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const byRule = new Map<string, Judgment[]>();
  for (const ds of groups.values()) {
    const ruleId = ds[0]!.recommended!.ruleId, share = 1 / ds.length;
    const j: Judgment = { ruleId, fingerprints: ds.map(d => d.fingerprint), agree: 0, component: 0, fixes: {} };
    for (const d of ds) {
      if (!sameComponent(d.decision, d.recommended!)) continue;
      j.component += share;
      const changed = propChanges(d.decision, d.recommended!);
      if (!changed.length) j.agree += share;
      for (const c of changed) j.fixes[c] = (j.fixes[c] ?? 0) + share;
    }
    byRule.set(ruleId, [...(byRule.get(ruleId) ?? []), j]);
  }
  return new Map([...byRule].map(([r, js]) => [r, tally(js)]));
}

function tally(judgments: Judgment[]): RuleStats {
  const sum = (f: (j: Judgment) => number) => Math.round(judgments.reduce((a, j) => a + f(j), 0) * 100) / 100;
  const fixes: Record<string, number> = {};
  for (const j of judgments) for (const [k, v] of Object.entries(j.fixes)) fixes[k] = Math.round(((fixes[k] ?? 0) + v) * 100) / 100;
  const agree = sum(j => j.agree), componentAgree = sum(j => j.component);
  return { n: judgments.length, agree, componentAgree, propFixes: Math.round((componentAgree - agree) * 100) / 100, fixes, judgments };
}

/** A rule's stats without the judgment this element was part of: an element never calibrates itself. */
export function statsWithout(stats: RuleStats | undefined, fingerprint: string): RuleStats | undefined {
  if (!stats || !stats.judgments.some(j => j.fingerprints.includes(fingerprint))) return stats;
  return tally(stats.judgments.filter(j => !j.fingerprints.includes(fingerprint)));
}

export function evaluateRows(opts: {
  root: string; target: Target; rows: Lookalike[]; exceptionOf: Map<Lookalike, 'temporary' | 'allow' | 'unused'>; reachOf?: Map<Lookalike, import('./reach.js').Reach>;
  map: RoleMap; decisions: DecisionsFile; stats: Map<string, RuleStats>; threshold: number; sigs?: import('./signatures.js').SignatureSet | undefined;
  /** What the crawler saw around each element last time (shots/index.json), by element id. */
  pageOf?: (id: string) => PagePlacement | undefined;
  /** Scanner hints (dsa.hints.json): reviewed corrections applied after the rules. */
  hints?: Hint[] | undefined;
  /** Lab pages (globs relative to the app): specimens, kept out of Ready (dsa.config.json review.labPaths). */
  labPaths?: string[] | undefined;
}): ElementEval[] {
  const { root, target, rows, map, decisions, stats, threshold } = opts;
  const byFp = new Map(decisions.decisions.map(d => [d.fingerprint, d]));
  const sysIdx = systemIndex(root);
  const aliases = readAliases(target.dir, target.aliases);
  const out: ElementEval[] = [];
  const twins = new Map<string, number>();
  for (const r of rows) {
    if (!r.features) continue;
    const twinKey = `${r.file}\u0001${r.features.source}`;
    const ordinal = twins.get(twinKey) ?? 0;
    twins.set(twinKey, ordinal + 1);
    const fp = fingerprint(target.name, r, ordinal);
    // Where it sits (the components above it, and the page) is evidence too: fold it in before the rules run.
    const placed = withPlacement(r.features, opts.reachOf?.get(r)?.placement, opts.pageOf?.(`E-${fp}`));
    const f = placed.f;
    let e = classify(f, map, threshold, opts.sigs);
    if (placed.reasons.length) e.reasons.splice(1, 0, ...placed.reasons);
    e = calibrate(e, statsWithout(stats.get(e.ruleId), fp));
    const rel = targetRelative(root, r.file, target.dir);
    let ev: ElementEval = {
      ...e,
      id: `E-${fp}`,
      target: target.name, file: r.file, line: r.line, col: r.col ?? f.col, element: r.element, fingerprint: fp,
      needsHuman: e.confidence < threshold,
      exception: opts.exceptionOf.get(r) ?? (isLabFile(rel, opts.labPaths) ? 'lab' : undefined),
      reach: opts.reachOf?.get(r),
      snippet: f.openTag, source: f.source,
      styleKey: styleKeyOf(f.classes.viaConst),
      styleSig: styleSigOf(f.classes.tokens),
      classTokens: f.classes.tokens,
      conditionalTokens: f.classes.conditional,
      regions: f.context.regions?.length ? f.context.regions : undefined,
      ...(f.context.within ? { within: f.context.within } : {}),
      ...(f.context.container ? { container: f.context.container } : {}),
      match: {
        tag: f.element,
        classes: f.classes.tokens.filter(t => !/[:[\]()]/.test(t)).slice(0, 12),
        text: f.children.text.slice(0, 80),
        ariaLabel: literal(f.attrs['aria-label']), title: literal(f.attrs.title), role: literal(f.attrs.role), type: literal(f.attrs.type),
      },
    };
    // A host copy of a system component is decided by the parent first: import the system's component.
    const abs = path.join(target.dir, rel);
    const copy = f.framework === 'react' ? hostCopyOf(abs, f.context.within, sysIdx, n => importedFromSystem(abs, n, aliases)) : undefined;
    if (copy) { ev = asHostCopy(ev, copy, threshold); ev.needsHuman = ev.confidence < threshold; }
    if (opts.hints?.length) applyHints(ev, rel, opts.hints, threshold);
    const d = byFp.get(fp);
    const pol = decisions.policies.find(p =>
      (!p.match.role || p.match.role === e.role) && (!p.match.ruleId || p.match.ruleId === e.ruleId) &&
      (!p.match.element || p.match.element === r.element) && (!p.match.paths || p.match.paths.some(g => globMatch(g, rel))) &&
      (!p.match.styleKey || p.match.styleKey === ev.styleKey) && (!p.match.styleSig || p.match.styleSig === ev.styleSig));
    if (d) ev.decided = { by: d.by, decision: d.decision, note: d.note, who: d.who, date: d.date };
    else if (pol) ev.decided = { by: 'policy', decision: pol.decision, note: pol.why, who: pol.who, date: pol.date };
    if (ev.decided) ev.needsHuman = false;
    out.push(ev);
  }
  // A house style used many times that the component won't reproduce is a design decision, not a
  // mechanical swap: hold the whole pattern for one human answer (adopt the system's look, or propose a variant).
  const uses = new Map<string, number>();
  for (const e of out) if (e.styleKey) uses.set(e.styleKey, (uses.get(e.styleKey) ?? 0) + 1);
  for (const e of out) {
    const n = e.styleKey ? uses.get(e.styleKey)! : 0;
    if (n >= 5 && e.signature && e.signature.score < 0.6 && !e.decided && e.confidence >= threshold) {
      const capped = Math.round((threshold - 0.02) * 100) / 100;
      e.reasons.push({ text: `The shared style ${e.styleKey} (${n} uses) looks different from ${e.use}. Adopt the ${system().label} look everywhere, or propose a variant: one decision covers all ${n}.`, delta: Math.round((capped - e.confidence) * 100) / 100 });
      e.confidence = capped;
      e.needsHuman = true;
    }
  }
  return out;
}

/** "../lib/hoverWash#CRUMB_LINK" or "MATERIAL_WU_JUMP_LINK=PLUS_NOUN_LINK" → the constant that actually holds the classes. */
export function styleKeyOf(via: string[]): string | undefined {
  const v = via.find(x => !x.endsWith(')'));
  if (!v) return undefined;
  const last = v.split('=').pop()!;
  return last.split('#').pop();
}
export const LAYOUT_ONLY = /^(-?m[trblxy]?-|w-|min-w|max-w|flex-1|shrink|grow|self-|z-|relative$|absolute$|top-|right-|bottom-|left-|truncate$|overflow-|min-w-0$)/;
export function styleSigOf(tokens: string[]): string | undefined {
  const visual = tokens.filter(t => !LAYOUT_ONLY.test(t)).sort();
  if (visual.length < 2) return undefined;
  return crypto.createHash('sha1').update(visual.join(' ')).digest('hex').slice(0, 8);
}

const literal = (v?: string) => (v && v !== '\u0000dynamic' ? v : undefined);

/** Record a decision for one evaluation (by id or fingerprint). */
export function recordDecision(df: DecisionsFile, ev: ElementEval, decision: Recommendation, by: 'human' | 'agent', who?: string, note?: string, now = new Date(), judgment?: string) {
  const entry: Decision = {
    fingerprint: ev.fingerprint, file: ev.file, line: ev.line, element: ev.element, decision,
    recommended: { verdict: ev.verdict, role: ev.role, use: ev.use, from: ev.from, props: ev.props, gap: ev.gap, ruleId: ev.ruleId, confidence: ev.confidence },
    agreed: sameComponent(decision, ev), ...(sameComponent(decision, ev) && !sameRec(decision, ev) ? { propsChanged: true } : {}), by, who, note, date: now.toISOString().slice(0, 10),
    ...(judgment ? { judgment } : {}),
  };
  df.decisions = [...df.decisions.filter(d => d.fingerprint !== ev.fingerprint), entry];
  writeDecisions(df);
  return entry;
}

/** A readable one-liner for an evaluation. */
export const summary = (e: ElementEval) => `${e.file}:${e.line} <${e.element}> → ${describe(e)} (${Math.round(e.confidence * 100)}%${e.needsHuman ? ', needs a human' : ''})`;
