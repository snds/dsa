import fs from 'node:fs';
import path from 'node:path';
import { BLANK_INSET, CODE_TERMS, decodePng, isBlank, seenInApp } from '@snds/dsa/engine';

/**
 * Can a person trust a recommendation from the card alone? Ten checks, all of which must hold on the
 * card where the person approves it (the review QA rubric):
 *
 *   C1  the current element is shown: a photo of the live app (matched by its source tag, or at or over the
 *       80% match the page shows), or a drawing from the app's code (its component mounted with the app's
 *       styles, found by its exact tag). Markup only doesn't count.
 *   C2  …and it is visible (the ringed box has painted pixels)
 *   C3  …and labelled (in the app, which app, file:line, match)
 *   C4  the proposal is rendered with the exact props and the element's own content
 *   C5  …and labelled (a render, the component and its props)
 *   C6  both side by side at the same scale
 *   C7  the reasons are in plain words (no attribute names, .map(), role=, braces, class names)
 *   C8  the place (file:line) opens the code
 *   C9  the stated confidence matches what can be seen: under the "ready" bar, or both C2 and C4
 *   C10 nothing is "not renderable" without a reason and a fallback image
 *
 * Data decides C1, C2, C4, C9 and part of C7 and C10. What the card draws decides the rest; `card` says
 * what this version's card shows (CARD, kept true by the card's own tests), so an older card can be
 * scored on the same data.
 */
export interface CardShows {
  /** "In the app", the app, a clickable file:line and the match beside each photo. */
  photoLabels: boolean;
  /** A render with the component name and its props. */
  proposalLabels: boolean;
  /** The photo and the proposal at one CSS scale. */
  sameScale: boolean;
  /** The element's file:line opens the code viewer. */
  placeOpens: boolean;
  /** Reasons and "how" lines in plain words on the face, the scanner's own words in Technical details. */
  plainReasons: boolean;
  /** Where the exact proposal isn't rendered, a reason and an image in its place (closest variant, or the story as written). */
  fallback: boolean;
}

/** What this version's card shows. */
export const CARD: CardShows = { photoLabels: true, proposalLabels: true, sameScale: true, placeOpens: true, plainReasons: true, fallback: true };

export const CRITERIA = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10'] as const;
export type Criterion = (typeof CRITERIA)[number];
export const CRITERION_TEXT: Record<Criterion, string> = {
  C1: 'Current element shown', C2: '…and visible', C3: '…and labelled', C4: 'Proposal rendered exactly, own content', C5: '…and labelled',
  C6: 'Same scale, side by side', C7: 'Reasons in plain words', C8: 'Place opens the code', C9: 'Confidence matches the evidence', C10: 'No render without reason and fallback',
};

/** The page shows a photo only at or over this match (Elements.tsx SHOT_MIN). */
export const SHOT_MIN = 0.8;

const proposalKey = (use: string, props?: Record<string, unknown> | null) => {
  const p = Object.entries(props ?? {}).filter(([k, v]) => k !== 'render' && k !== 'asChild' && v != null).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(';');
  return p ? `${use}|${p}` : use;
};

export interface TrustScore {
  recommendations: number;
  passing: number;
  rate: number;
  criteria: Record<Criterion, { pass: number; rate: number }>;
  /** Each criterion with how many recommendations fail it, most first. */
  blocking: { criterion: Criterion; text: string; failing: number }[];
  rows: { id: string; target: string; pass: boolean; failed: Criterion[]; source: Source }[];
  /** Where each element's picture came from, so a report can say "N live, M drawn from code". */
  sources: Record<Source, number>;
}

/** live: a photo of the running app. code: drawn from the app's code (counts). markup: markup only, or a drawing shown outlined because it had no size (doesn't). none: no picture. */
export type Source = 'live' | 'code' | 'markup' | 'none';
const sourceOf = (s: any): Source => (!s ? 'none' : s.drawn === 'mount' && !s.placeholder ? 'code' : s.drawn ? 'markup' : 'live');

/**
 * Score every recommendation in a report payload. `dir` is where the published page sits, to read the
 * photos for C2 (without it, a photo with a box counts as visible unless the capture flagged it blank).
 */
export function trustRubric(payload: any, opts: { card?: CardShows; dir?: string } = {}): TrustScore {
  const card = opts.card ?? CARD;
  const E = payload.elements;
  const th = E?.threshold ?? 0.9;
  const evals: any[] = (E?.evals ?? []).filter((e: any) => !e.exception && e.reach?.status !== 'unused' && e.verdict !== 'ignore');
  // What each card proposes: a question's (or part's) auto-pick, else the element's own recommendation.
  const proposes = new Map<string, any>();
  for (const q of E?.questions ?? []) {
    for (const p of q.parts ?? []) for (const id of p.ids) proposes.set(id, p.auto);
    for (const id of q.ids) if (!proposes.has(id)) proposes.set(id, q.auto);
  }
  const visible = new Map<string, boolean>();
  const seen = (e: any) => {
    if (e.shot?.blank) return false;
    if (!opts.dir) return Boolean(e.shot?.box);
    const f = path.join(opts.dir, e.shot.url);
    if (!visible.has(f)) {
      let v = false;
      try { v = !isBlank(decodePng(fs.readFileSync(f)), e.shot.box, 2, BLANK_INSET); } catch { v = false; }
      visible.set(f, v);
    }
    return visible.get(f)!;
  };
  const rows = evals.map((e) => {
    const r = proposes.get(e.id) ?? (e.decided ? e.decided.decision : e);
    const replace = r?.verdict === 'replace' && Boolean(r.use);
    const key = replace ? proposalKey(r.use, r.props) : '';
    const p = replace ? (e.ownHash && E.proposals?.[`${key}#${e.ownHash}`]) || E.proposals?.[key] || null : null;
    const fallback = Boolean(e.rendered?.systemShot || e.systemPreview || p?.fallback || (p?.url && (p.check !== 'exact' || p.content)));
    // A blank or covered photo isn't shown on the card (it says so instead). A source tag is proof of place:
    // the photo is of the node that line made, whatever any score says.
    const shown = Boolean(e.shot && seenInApp({ ...e.shot, matchScore: e.shot.match }));
    // Its own words or icon to show: the proposal must carry them, not a story's sample. (Older reports
    // carry no ownHash; an element with a label has content of its own.)
    const hasOwn = e.ownHash !== undefined ? Boolean(e.ownHash) : Boolean(e.label);
    const c: Record<Criterion, boolean> = {} as any;
    c.C1 = shown;
    c.C2 = shown && seen(e);
    c.C3 = shown && card.photoLabels;
    c.C4 = !replace || (p?.check === 'exact' && Boolean(p.url) && (hasOwn ? Boolean(p.own) : !p.content));
    c.C5 = !replace || (Boolean(p?.url) && card.proposalLabels);
    c.C6 = !replace ? shown : shown && Boolean(p?.url) && card.sameScale;
    const face = [...(e.reasons ?? []).map((x: any) => (card.plainReasons && x.plain !== undefined ? x.plain : x.text)), card.plainReasons ? e.how : e.howRaw ?? e.how].filter(Boolean);
    c.C7 = face.every((t: string) => !CODE_TERMS.test(t));
    c.C8 = card.placeOpens;
    c.C9 = e.confidence < th || (c.C2 && c.C4);
    c.C10 = c.C4 || (card.fallback && fallback && Boolean(p?.note || p?.content || !p?.url || p.check !== 'exact'));
    const failed = CRITERIA.filter((k) => !c[k]);
    return { id: e.id, target: e.target, pass: !failed.length, failed, source: sourceOf(e.shot) };
  });
  const n = rows.length;
  const rate = (k: number) => (n ? Math.round((1000 * k) / n) / 10 : 0);
  const criteria = Object.fromEntries(CRITERIA.map((k) => { const pass = rows.filter((r) => !r.failed.includes(k)).length; return [k, { pass, rate: rate(pass) }]; })) as TrustScore['criteria'];
  const passing = rows.filter((r) => r.pass).length;
  return {
    recommendations: n, passing, rate: rate(passing), criteria,
    blocking: CRITERIA.map((k) => ({ criterion: k, text: CRITERION_TEXT[k], failing: n - criteria[k].pass })).filter((b) => b.failing).sort((a, b) => b.failing - a.failing),
    rows,
    sources: { live: rows.filter((r) => r.source === 'live').length, code: rows.filter((r) => r.source === 'code').length, markup: rows.filter((r) => r.source === 'markup').length, none: rows.filter((r) => r.source === 'none').length },
  };
}
