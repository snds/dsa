import { DYNAMIC, type ElementFeatures } from './scanners/features.js';
import type { Candidate } from './classify-button.js';
import type { Props, SigMatch, SignatureSet } from './signatures.js';

/**
 * Hard constraints, applied before any ranking (review item 16): constraints first, nearest match
 * second, abstain third.
 *
 * - State: an element that announces a state (aria-pressed, aria-current, a selected state) can only
 *   become a component that can carry that state: a prop for it (pressed, isActive, value) or the data-*
 *   attribute it writes (data-state). A Button with aria-pressed passed through is a different contract.
 * - Role and anatomy: a component that renders a fixed role can't take an element with another one, and
 *   a component that renders a <button> can't hold another control inside it.
 * - Size: variant and size are picked by distance in resolved pixels (the system's token values), with
 *   height and width as hard limits: nothing farther away than the nearest size is ever picked.
 *
 * Anything these checks can't resolve (a height token with no pixel value, two sizes equally near, every
 * candidate ruled out) is a reason to abstain: the classifier emits `unclear` instead of a guess.
 */

export type StateNeed = 'pressed' | 'current' | 'selected';

/** The props (or data-* attributes) that carry each state. */
export const STATE_CARRIERS: Record<StateNeed, string[]> = {
  pressed: ['pressed', 'defaultPressed', 'data-state'],
  current: ['isActive', 'active', 'current', 'aria-current', 'value', 'data-active', 'data-state'],
  selected: ['value', 'selected', 'isSelected', 'checked', 'data-state', 'data-selected', 'aria-selected'],
};

const STATE_WORDS: Record<StateNeed, string> = { pressed: 'a pressed state (aria-pressed)', current: 'a current state (aria-current)', selected: 'a selected state' };

/** The states the element announces in its markup. */
export function stateNeeds(f: ElementFeatures): StateNeed[] {
  const a = f.attrs, out: StateNeed[] = [];
  if (a['aria-pressed'] !== undefined) out.push('pressed');
  const current = a['aria-current'] === undefined ? [] : a['aria-current'] === DYNAMIC ? (f.attrLiterals?.['aria-current'] ?? ['true']) : [a['aria-current']];
  if (current.length && !current.includes('step') && !current.every(v => v === 'false')) out.push('current');
  if (a['aria-selected'] !== undefined || /^(on|active|selected|checked)$/.test(a['data-state'] ?? '')) out.push('selected');
  return out;
}

const literalRole = (f: ElementFeatures) => (f.attrs.role && f.attrs.role !== DYNAMIC ? f.attrs.role : undefined);
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);

export interface Rejection { candidate: Candidate; why: string }

/**
 * Rule candidates out on what they can't be. Candidates whose component isn't in the signature set are
 * kept (nothing to check against); for an element with a state, that unchecked pick is unresolved, so
 * the classifier abstains if it wins.
 */
export function applyConstraints(cands: Candidate[], f: ElementFeatures, sigs: SignatureSet): { kept: Candidate[]; rejected: Rejection[] } {
  const needs = stateNeeds(f);
  const role = literalRole(f);
  const kept: Candidate[] = [], rejected: Rejection[] = [];
  for (const c of cands) {
    if (c.verdict !== 'replace' || !c.use) { kept.push(c); continue; }
    const comp = sigs.components.get(c.use);
    if (!comp) {
      // Unchecked is unresolved: a state-bearing element can't go to a component nobody could read.
      if (needs.length) (c.abstain ??= []).push(`couldn't check that ${c.use} carries ${needs.map(n => STATE_WORDS[n]).join(' and ')}: it isn't in the system's signatures`);
      kept.push(c);
      continue;
    }
    const why: string[] = [];
    const props = comp.props ?? [];
    for (const n of needs) if (!props.some(p => STATE_CARRIERS[n].includes(p))) why.push(`it has ${STATE_WORDS[n]}, and ${c.use} has no prop for it (${STATE_CARRIERS[n].slice(0, 3).join(', ')})`);
    if (role && comp.role && comp.role !== role) why.push(`it has role="${role}", and ${c.use} renders role="${comp.role}"`);
    if (f.element === 'button' && FIELD_TAGS.has(comp.tag)) why.push(`it is a <button>, and ${c.use} renders <${comp.tag}>`);
    if (f.element === 'button' && comp.tag === 'button' && f.children.interactive > 0) why.push(`it holds another control, and ${c.use} renders a <button>, which can't`);
    // The system's prop unions are the only allowed values (the checker's, else the cva axes).
    const allowed = { ...comp.axes, ...(comp.allowed ?? {}) };
    for (const [k, v] of Object.entries(c.props ?? {})) {
      const ok = allowed[k];
      if (ok && ok.length && !ok.includes(v)) (c.abstain ??= []).push(`${k}="${v}" isn't a value ${c.use} allows (${ok.slice(0, 6).join(', ')}${ok.length > 6 ? '…' : ''})`);
    }
    if (why.length) rejected.push({ candidate: c, why: why.join('; ') });
    else kept.push(c);
  }
  return { kept, rejected };
}

/**
 * A resolved size in pixels: "1.25rem", "20px", "[20px]", or a token ("var:control-h") followed to its
 * literal value. Undefined when it can't be resolved (calc(), an unknown token).
 */
export function pxOf(v: string | undefined, values: Map<string, string>, depth = 0): number | undefined {
  if (!v || depth > 8) return undefined;
  const s = v.trim().replace(/^\[(.+)\]$/, '$1');
  if (s.startsWith('var:')) return pxOf(values.get(s.slice(4)), values, depth + 1);
  const ref = /^var\(--([\w-]+)\)$/.exec(s);
  if (ref) return pxOf(values.get(ref[1]!), values, depth + 1);
  const m = /^(-?\d*\.?\d+)(rem|px)?$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === 'rem' ? n * 16 : n;
}

export interface SizeFit {
  matches: SigMatch[];
  /** Per dimension: the element's px and the nearest size's px. */
  dims: { dim: 'height' | 'width'; element: number; nearest: number }[];
  /** A dimension the element sets that doesn't resolve to pixels. */
  unresolved?: string | undefined;
  /** Two sizes equally near (30px between 28 and 32): the size can't be told. */
  tie?: string | undefined;
}

/**
 * Keep only the signatures whose height (then width) is nearest the element's, in resolved pixels. A size
 * farther away than the nearest is never picked, however well its colours match.
 */
export function nearestSize(matches: SigMatch[], el: Props, values: Map<string, string>): SizeFit {
  const out: SizeFit = { matches, dims: [] };
  for (const dim of ['height', 'width'] as const) {
    const ev = el.get(dim);
    if (!ev || !out.matches.length) continue;
    const epx = pxOf(ev, values);
    if (epx === undefined) { out.unresolved = `its ${dim} (${ev.replace(/^var:/, '--')}) doesn't resolve to pixels`; continue; }
    const pxs = out.matches.map(m => pxOf(m.sig.props.get(dim), values));
    if (pxs.every(p => p === undefined)) continue; // the component doesn't set it (a text button's width)
    const dist = pxs.map(p => (p === undefined ? Infinity : Math.abs(p - epx)));
    const min = Math.min(...dist);
    const kept = out.matches.filter((_, i) => dist[i] === min);
    const nearPx = [...new Set(kept.map(m => pxOf(m.sig.props.get(dim), values)!))];
    if (nearPx.length > 1) out.tie = `it is ${round(epx)}px ${dim === 'height' ? 'high' : 'wide'}, exactly between ${nearPx.sort((a, b) => a - b).map(p => `${round(p)}px`).join(' and ')}`;
    out.dims.push({ dim, element: round(epx), nearest: round(nearPx[0]!) });
    out.matches = kept;
  }
  return out;
}

const round = (x: number) => Math.round(x * 100) / 100;
