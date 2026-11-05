import fs from 'node:fs';
import path from 'node:path';
import { BLANK_INSET, CODE_TERMS, decodePng, isBlank, seenInApp } from '@snds/dsa/engine';
import type { CardFacts } from './card-dom.js';

/**
 * Can a person trust a recommendation from the card alone? This is the presentation score: it says
 * whether the card shows enough to judge the recommendation, never whether the recommendation is right
 * (that is `dsa bench`'s correctness score, kept apart on purpose).
 *
 * Each check is a pass, a fail, or not applicable. A check that depends on an earlier one is not
 * applicable when that one fails, so one missing photo is counted once, not four times:
 *
 *   shown          Current element shown: its own photo of the live app (found by its source tag, or at
 *                  or over the 80% match the page shows), an isolated render (mounted in the app's build
 *                  with recorded props), or a drawing from the app's code found by its exact tag; painted,
 *                  not covered, and from this run (fresh.ts). Another element's photo doesn't count.
 *   photoLabel     [card] The photo says what it is, the app, file:line and the match.        (needs shown)
 *   opensCode      [card] Its file:line opens the code.                                        (needs shown)
 *   drawable       The system has something to draw the proposal from. "No drawable source" is
 *                  its own class, apart from a drawing that went wrong.                 (replacements only)
 *   exact          The proposal is drawn exactly, with these props.                        (needs drawable)
 *   own            …with the element's own content, where it can be carried. Not applicable to
 *                  containers (their content is other elements); an element with none fails only when
 *                  the drawing adds a story's sample label to it.                          (needs exact)
 *   proposalLabel  [card] The proposal says "Proposed" (or which stand-in it is) and the component.
 *   sameScale      [card] Photo and proposal one above the other at one CSS scale. (needs shown and a proposal)
 *   plain          Reasons and how-lines in plain words: no attribute names, class names, utility classes
 *                  (px-2, size-5) or CSS variables (--radius-md).
 *   confidence     The confidence matches what can be seen: under the ready bar, or shown and drawn exactly
 *                  with its own content.
 *   fallback       Not drawn exactly: a reason and an image in its place.    (when exact fails, not
 *                                                                              when nothing can draw it)
 *
 * [card] checks are read from the rendered card (card-dom.ts). Without it they are "untested": they
 * neither pass nor fail, and the score says so.
 */
export const CRITERIA = ['shown', 'photoLabel', 'opensCode', 'drawable', 'exact', 'own', 'proposalLabel', 'sameScale', 'plain', 'confidence', 'fallback'] as const;
export type Criterion = (typeof CRITERIA)[number];
export const CRITERION_TEXT: Record<Criterion, string> = {
  shown: 'Current element shown',
  photoLabel: 'Photo labelled on the card',
  opensCode: 'Place opens the code',
  drawable: 'The system has something to draw',
  exact: 'Proposal drawn exactly',
  own: 'Own content where it can be carried',
  proposalLabel: 'Proposal labelled on the card',
  sameScale: 'Side by side at one scale',
  plain: 'Reasons in plain words',
  confidence: 'Confidence matches the evidence',
  fallback: 'No render without reason and fallback',
};
/** The checks read from the rendered card. */
export const CARD_CRITERIA: Criterion[] = ['photoLabel', 'opensCode', 'proposalLabel', 'sameScale'];

/** The page shows a photo only at or over this match (Elements.tsx SHOT_MIN). */
export const SHOT_MIN = 0.8;

/** Roles whose element holds other elements: its own content is those, so "own content" doesn't apply. */
export const CONTAINER_ROLES = new Set(['static-table', 'data-table', 'clickable-region', 'native-dialog', 'drop-target', 'selector-card', 'choice-tile']);

/** A proposal nothing can draw: the component isn't in the system's source or stories in a form dsa can find. */
export const NO_SOURCE = /isn't a component dsa found|isn't in the design system's Storybook|has no story to draw it from|there's no Storybook to draw it from/;

export const proposalKey = (use: string, props?: Record<string, unknown> | null) => {
  const p = Object.entries(props ?? {}).filter(([k, v]) => k !== 'render' && k !== 'asChild' && v != null).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(';');
  return p ? `${use}|${p}` : use;
};

export type Outcome = 'pass' | 'fail' | 'na' | 'untested';

/**
 * Where an element's picture came from. live: a photo of the running app. isolated: mounted in the app's
 * build with the props it was recorded with. guessed: drawn from the app's code with guessed props (counts
 * when found by its exact tag). markup: markup only (doesn't count). none: no picture.
 */
export type Source = 'live' | 'isolated' | 'guessed' | 'markup' | 'none';
export const sourceOf = (s: any): Source => (!s ? 'none' : s.source === 'isolated' ? 'isolated' : s.drawn === 'mount' ? 'guessed' : s.drawn ? 'markup' : 'live');

export interface TrustRow {
  id: string;
  target: string;
  pass: boolean;
  failed: Criterion[];
  untested: Criterion[];
  outcomes: Record<Criterion, Outcome>;
  source: Source;
  /** Held "ready" only because an element with the same classes has a photo (the engine's old rule). */
  siblingPhoto: boolean;
}

export interface TrustScore {
  recommendations: number;
  passing: number;
  /** Passing as a percentage of recommendations (one decimal). */
  rate: number;
  criteria: Record<Criterion, { pass: number; fail: number; na: number; untested: number; rate: number }>;
  /** Each criterion with how many recommendations fail it, most first. */
  blocking: { criterion: Criterion; text: string; failing: number }[];
  rows: TrustRow[];
  /** Where each element's picture came from, so a report can say "N live, M isolated, K drawn from code". */
  sources: Record<Source, number>;
  /** Left out of the score: unused code, lab pages, exceptions, ignored. */
  excluded: { unused: number; lab: number; exception: number; ignored: number };
  /** The card checks that weren't read from a rendered card. */
  untested: Criterion[];
  /** Photos set aside as not from this run, and the oldest that counts, per app (when the page carries it). */
  freshness: any | null;
}

/**
 * Score every recommendation in a report payload. `dir` is where the published page sits, to read the
 * photos for "painted" (without it, a photo with a box counts as painted unless the capture flagged it
 * blank). `cards` is what the rendered card showed (card-dom.ts); without it the card checks are untested.
 */
export function trustRubric(payload: any, opts: { dir?: string; cards?: CardFacts[] | null } = {}): TrustScore {
  const E = payload.elements;
  const th = E?.threshold ?? 0.9;
  const all: any[] = E?.evals ?? [];
  const excluded = { unused: 0, lab: 0, exception: 0, ignored: 0 };
  const evals = all.filter((e: any) => {
    if (e.reach?.status === 'unused' || e.exception === 'unused') { excluded.unused++; return false; }
    if (e.exception === 'lab') { excluded.lab++; return false; }
    if (e.exception) { excluded.exception++; return false; }
    if (e.verdict === 'ignore') { excluded.ignored++; return false; }
    return true;
  });
  // What each card proposes: a question's (or part's) auto-pick, else the element's own recommendation.
  const proposes = new Map<string, any>();
  for (const q of E?.questions ?? []) {
    for (const p of q.parts ?? []) for (const id of p.ids) proposes.set(id, p.auto);
    for (const id of q.ids) if (!proposes.has(id)) proposes.set(id, q.auto);
  }
  const painted = new Map<string, boolean>();
  const isPainted = (e: any) => {
    if (e.shot?.blank) return false;
    if (!opts.dir) return Boolean(e.shot?.box);
    const f = path.join(opts.dir, e.shot.url);
    if (!painted.has(f)) {
      let v = false;
      try { v = !isBlank(decodePng(fs.readFileSync(f)), e.shot.box, 2, BLANK_INSET); } catch { v = false; }
      painted.set(f, v);
    }
    return painted.get(f)!;
  };
  // The rendered card's facts, by element id, else by app and place (pages from before ids were written).
  const byId = new Map<string, CardFacts>(), byPlace = new Map<string, CardFacts>();
  for (const c of opts.cards ?? []) {
    if (c.id) { if (!byId.has(c.id) || byId.get(c.id)!.thumb) byId.set(c.id, c); }
    if (c.target && c.place) { const k = `${c.target}\u0001${c.place}`; if (!byPlace.has(k) || byPlace.get(k)!.thumb) byPlace.set(k, c); }
  }
  const factsOf = (e: any): CardFacts | null => byId.get(e.id) ?? byPlace.get(`${e.target}\u0001${String(e.file).replace(/^[^/]+\//, '')}:${e.line}`) ?? null;
  const tested = Boolean(opts.cards);
  const shownOf = (e: any) => Boolean(e.shot && seenInApp({ ...e.shot, matchScore: e.shot.match }) && isPainted(e));
  const bySig = new Map<string, any[]>();
  for (const e of evals) if (e.styleSig) bySig.set(e.styleSig, [...(bySig.get(e.styleSig) ?? []), e]);

  const rows: TrustRow[] = evals.map((e) => {
    const r = proposes.get(e.id) ?? (e.decided ? e.decided.decision : e);
    const replace = r?.verdict === 'replace' && Boolean(r.use);
    const key = replace ? proposalKey(r.use, r.props) : '';
    const p = replace ? (e.ownHash && E.proposals?.[`${key}#${e.ownHash}`]) || E.proposals?.[key] || null : null;
    const o = {} as Record<Criterion, Outcome>;
    const card = factsOf(e);
    const fromCard = (ok: boolean | null | undefined): Outcome => (!tested ? 'untested' : ok ? 'pass' : 'fail');

    const shown = shownOf(e);
    o.shown = shown ? 'pass' : 'fail';
    o.photoLabel = !shown ? 'na' : fromCard(card?.photoLabel);
    o.opensCode = !shown ? 'na' : fromCard(card?.opensCode);

    // Nothing to draw from (not in the system's source or stories): its own class. A proposal never drawn
    // at all (no entry) is a drawing still to do, not a missing source.
    const noSource = replace && Boolean(p && p.check === 'none' && !p.url && (p.noSource || NO_SOURCE.test(p.note ?? '')));
    o.drawable = !replace ? 'na' : noSource ? 'fail' : 'pass';
    const exact = replace && !noSource && p?.check === 'exact' && Boolean(p.url);
    o.exact = !replace || noSource ? 'na' : exact ? 'pass' : 'fail';
    // Its own words or icon to show: the proposal must carry them, not a story's sample. (Older reports
    // carry no ownHash; an element with a label has content of its own.)
    const hasOwn = e.ownHash !== undefined ? Boolean(e.ownHash) : Boolean(e.label);
    const container = CONTAINER_ROLES.has(e.role) || CONTAINER_ROLES.has(r?.role);
    o.own = !exact || container || !hasOwn ? 'na' : p.own ? 'pass' : 'fail';
    if (exact && !container && !hasOwn && p.content) o.own = 'fail';

    const proposalShown = replace && Boolean(p?.url || p?.fallback || e.rendered?.systemShot || e.systemPreview);
    o.proposalLabel = !replace || !proposalShown ? 'na' : !shown ? 'na' : fromCard(card?.proposalLabel);
    o.sameScale = !shown || !replace || !proposalShown ? 'na' : fromCard(card?.sameScale);

    const face = [...(e.reasons ?? []).map((x: any) => (x.plain !== undefined ? x.plain : x.text)), e.how].filter(Boolean);
    o.plain = face.every((t: string) => !CODE_TERMS.test(t)) ? 'pass' : 'fail';

    const seenAndDrawn = shown && (!replace || (exact && o.own !== 'fail'));
    o.confidence = e.confidence < th || seenAndDrawn ? 'pass' : 'fail';

    const fallback = Boolean(e.rendered?.systemShot || e.systemPreview || p?.fallback || (p?.url && (p.check !== 'exact' || p.content)));
    o.fallback = !replace || noSource || o.exact === 'pass' ? 'na' : fallback && Boolean(p?.note || p?.content || !p?.url || p.check !== 'exact') ? 'pass' : 'fail';

    const failed = CRITERIA.filter((k) => o[k] === 'fail');
    const untested = CRITERIA.filter((k) => o[k] === 'untested');
    const siblingPhoto = o.confidence === 'fail' && !shown && Boolean(e.styleSig) && (bySig.get(e.styleSig) ?? []).some((x) => x.id !== e.id && shownOf(x));
    return { id: e.id, target: e.target, pass: !failed.length, failed, untested, outcomes: o, source: sourceOf(e.shot), siblingPhoto };
  });
  const n = rows.length;
  const pct = (k: number, of: number) => (of ? Math.round((1000 * k) / of) / 10 : 0);
  const criteria = Object.fromEntries(CRITERIA.map((k) => {
    const c = { pass: 0, fail: 0, na: 0, untested: 0 };
    for (const r of rows) c[r.outcomes[k]]++;
    return [k, { ...c, rate: pct(c.pass, c.pass + c.fail) }];
  })) as TrustScore['criteria'];
  const passing = rows.filter((r) => r.pass).length;
  const sources = { live: 0, isolated: 0, guessed: 0, markup: 0, none: 0 } as Record<Source, number>;
  for (const r of rows) sources[r.source]++;
  return {
    recommendations: n, passing, rate: pct(passing, n), criteria,
    blocking: CRITERIA.map((k) => ({ criterion: k, text: CRITERION_TEXT[k], failing: criteria[k].fail })).filter((b) => b.failing).sort((a, b) => b.failing - a.failing),
    rows, sources, excluded,
    untested: tested ? [] : CARD_CRITERIA,
    freshness: E?.freshness ?? null,
  };
}
