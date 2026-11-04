import fs from 'node:fs';
import path from 'node:path';
import { cardPicks, ownKey, ownOf } from './autopick.js';
import { freshShots } from './fresh.js';
import type { ElementEval } from './elements.js';
import { proposalKey, readProposals } from './rendered.js';
import { openStore } from './store.js';

/** A photo the review shows: matched well enough, and checked to show the element (crawler 7). */
export const PHOTO_MIN_MATCH = 0.8;

/**
 * Confidence never outruns what a person can see. Nothing reaches the "ready" band (the review
 * threshold, 90% by default) without a visible photo of it in the app and, for a replacement, the
 * proposal drawn exactly, with its own content. Missing either, it stops just under the band and says
 * why in plain words; when the evidence arrives (a screenshot, a render), the scanner's score returns.
 * A decision a person or agent recorded is never capped: it isn't a guess anymore.
 */
export interface EvidenceCap { from: number; why: string[] }

interface Evidence { shots: Record<string, any>; proposals: Record<string, any>; picks: Map<string, any> }

function evidenceOf(dataDir: string, evals: ElementEval[], threshold: number): Evidence {
  // Only this run's photos count (fresh.ts): one from an older run, or unstamped, is missing.
  let shots: Record<string, any> = {};
  try { shots = freshShots(JSON.parse(fs.readFileSync(path.join(dataDir, 'shots', 'index.json'), 'utf8'))).shots; } catch { /* no screenshots */ }
  const picks = new Map<string, any>();
  // Uncapped, so the cap doesn't decide which questions exist and from them what's proposed.
  for (const c of cardPicks(dataDir, evals.map(uncapped), threshold)) for (const id of c.ids) picks.set(id, c.auto);
  return { shots, proposals: readProposals(dataDir), picks };
}

/** The element with its scanner score back (a copy). */
const uncapped = (e: ElementEval): ElementEval => ((e as any).evidenceCap ? { ...e, confidence: (e as any).evidenceCap.from } : e);

/**
 * Is this capture evidence of the element, as a person would see it? A photo of the live app is. So is a
 * drawing from the app's own code (Sean's call, "count it, labelled"): its component mounted through the
 * app's own Vite server and styles, found by its exact source tag, and not blank. It runs the real
 * component with the real styles, so it shows how the element looks, though not that it's reachable live
 * (placement still ignores it). Static markup doesn't count. An isolated render (the shot index's
 * `source: "isolated"`) counts ahead of a drawing with guessed props.
 */
export function seenInApp(s: any): boolean {
  if (!s || s.blank || s.covered) return false;
  // An isolated render: mounted in the app's own build with the props it was recorded with. It draws the
  // element as the app does, so it counts, labelled as such (not as a live photo).
  if (s.source === 'isolated') return true;
  if (s.drawn) return s.drawn === 'mount' && Boolean(s.exact);
  return Boolean(s.tagged || (s.matchScore ?? 0) >= PHOTO_MIN_MATCH);
}
const visible = seenInApp;

/** What's missing for a person to see this recommendation, in plain words; empty when nothing is. */
export function evidenceGaps(e: ElementEval, ev: Evidence, evals: ElementEval[]): string[] {
  const why: string[] = [];
  const own = ev.shots[e.id];
  // Its own photo only. A photo of another element with the same classes isn't evidence of this one: the
  // same classes can still draw differently (other words, another parent, a state), and the card labels
  // that photo with the other element's file and line. The trust rubric applies the same rule.
  void evals;
  if (!visible(own)) {
    why.push(!own || (own.drawn && !seenInApp({ ...own, blank: false })) ? 'there is no photo of it in the app'
      : own.blank ? "its photo shows nothing (it may need a state the crawler couldn't set)"
      : own.covered ? 'something else covers it in its photo'
      : 'its photo may be a different element');
  }
  const r = ev.picks.get(e.id) ?? e;
  if (r?.verdict === 'replace' && r.use) {
    const content = ownOf(e, own);
    const p = (content && ev.proposals[ownKey(r.use, r.props, content)]) || ev.proposals[proposalKey(r.use, r.props)];
    if (!p || p.check !== 'exact' || !p.shot) why.push(`the proposal (${[r.use, ...Object.entries(r.props ?? {}).filter(([k]) => k !== 'render').map(([k, v]) => `${k} ${v}`)].join(', ')}) isn't drawn exactly yet`);
    else if (content && !p.own) why.push("the proposal shows the story's sample content, not this element's own");
  }
  return why;
}

/** Cap each evaluation by its evidence (in place). Returns how many are capped. */
export function applyEvidenceCap(dataDir: string, evals: ElementEval[], threshold: number): number {
  const ev = evidenceOf(dataDir, evals, threshold);
  let n = 0;
  for (const e of evals as any[]) {
    if (e.evidenceCap) { e.confidence = e.evidenceCap.from; delete e.evidenceCap; }
    if (e.decided || e.exception || e.confidence < threshold) { e.needsHuman = !e.decided && e.confidence < threshold; continue; }
    const why = evidenceGaps(e, ev, evals);
    if (why.length) {
      e.evidenceCap = { from: e.confidence, why } satisfies EvidenceCap;
      e.confidence = Math.round((threshold - 0.01) * 100) / 100;
      n++;
    }
    e.needsHuman = !e.decided && e.confidence < threshold;
  }
  return n;
}

/** Re-cap the latest run's stored evaluations, after screenshots or renders change what can be seen. */
export async function capByEvidence(dataDir: string, threshold = 0.9): Promise<number> {
  const store = await openStore(dataDir, 'evidence cap');
  try {
    const run = await store.latestRunId();
    if (!run) return 0;
    const rows = await store.all<any>('select id, data from element_evals where run_id=$1', [run]);
    const evals = rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data)) as ElementEval[];
    const n = applyEvidenceCap(dataDir, evals, threshold);
    for (const e of evals) {
      await store.exec('update element_evals set data=$3, confidence=$4, needs_human=$5 where run_id=$1 and id=$2', [run, e.id, JSON.stringify(e), e.confidence, e.needsHuman]);
    }
    return n;
  } finally { store.close(); }
}
