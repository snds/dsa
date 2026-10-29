import { describe, type Recommendation } from './classify.js';
import { DEFAULT_THRESHOLD, type ElementEval } from './elements.js';
import { askOf, controlOf, controlTitle, familyKey, homeOf, recipeNote, titleOf } from './identity.js';

/**
 * What a human actually has to answer, grouped by design identity (identity.ts): first the control an
 * element belongs to (a hand-built copy of a system component, one menu or toggle set), then its design
 * role, tone and recommended component. Never by rule id or a shared utility class.
 *
 * A card is one decision. A control whose parts need different answers (a menu's plain item and its
 * checkbox item) is one card with a part per answer. Already-sure members of the same design role
 * come along as context, so a designer sees the whole family.
 */
export interface QuestionPart { key: string; items: ElementEval[]; ask: string; options: { label: string; decision: Recommendation }[] }
export interface Question {
  key: string;
  kind: 'pattern' | 'group';
  items: ElementEval[];
  /** The decision needed, in plain words ("Replace with Item rendered as a button?"). */
  ask: string;
  options: { label: string; decision: Recommendation }[];
  /** The pattern in designer words ("List rows that open or pick something"). */
  title: string;
  /** Where the answer lands: a system component, "No <system> home yet", or "Keep native". */
  home: string;
  /** One control with parts that need different answers: one decision per part. */
  parts?: QuestionPart[] | undefined;
  /** Said before anything else (a hand-built copy of a system component). */
  note?: string | undefined;
  /** Same design role, already at or above the threshold: shown for context, not decided here. */
  context?: ElementEval[] | undefined;
}

export function questions(evals: ElementEval[], opts: { answered?: boolean | undefined; threshold?: number | undefined } = {}): Question[] {
  // answered: keep questions a human already answered (the review shows them with their answer, reversible).
  const th = opts.threshold ?? DEFAULT_THRESHOLD;
  const live = evals.filter(e => !e.exception);
  const isOpen = (e: ElementEval) => opts.answered ? e.needsHuman || (!!e.decided && e.decided.by !== 'agent' && e.confidence < th) : e.needsHuman && !e.decided;
  const ready = (e: ElementEval) => !e.needsHuman && !e.decided && e.verdict === 'replace';
  const out: Question[] = [];
  const taken = new Set<string>();

  // A card's members split by recommendation: one decision per version.
  const partsOf = (key: string, items: ElementEval[]): QuestionPart[] => {
    const byRec = new Map<string, ElementEval[]>();
    for (const e of items) { const r = describe(e); byRec.set(r, [...(byRec.get(r) ?? []), e]); }
    return [...byRec].sort((a, b) => b[1].length - a[1].length).map(([r, list]) => ({ key: `${key}|${r}`, items: list, ask: askOf(list[0]!), options: optionsOf(list[0]!) }));
  };
  const card = (key: string, items: ElementEval[], title: string, extra: Partial<Question> = {}, control = false): Question => {
    const parts = partsOf(key, items);
    const style = parts.length === 1 ? sharedStyle(items, live) : undefined;
    return {
      key: style ?? key, kind: style ? 'pattern' : 'group', items, title, home: homeOf(parts[0]!.items[0]!),
      // A control's parts differ by design (a swatch and its number fields); a family's versions shouldn't.
      ask: parts.length === 1 ? parts[0]!.ask : control ? `Its parts need ${parts.length} different answers. Decide each.` : `${parts.length} versions of the same thing today. Decide each, or make them the same.`,
      options: parts[0]!.options, ...(parts.length > 1 ? { parts } : {}), ...extra,
    };
  };

  // 1. Controls: every undecided part of a control with at least one open part, sure parts included.
  const byControl = new Map<string, ElementEval[]>();
  for (const e of live) { const k = controlOf(e); if (k && (isOpen(e) || ready(e))) byControl.set(k, [...(byControl.get(k) ?? []), e]); }
  for (const [k, items] of byControl) {
    if (items.length < 2 || !items.some(isOpen)) continue;
    items.sort((a, b) => a.line - b.line).forEach(i => taken.add(i.id));
    out.push(card(k, items, controlTitle(items), items[0]!.recipe ? { note: recipeNote(items[0]!.recipe) } : {}, true));
  }

  // 2–3. Design role, what it does, tone; the already-sure members of the family come along as context.
  const byFamily = new Map<string, ElementEval[]>();
  for (const e of live) if (isOpen(e) && !taken.has(e.id)) byFamily.set(familyKey(e), [...(byFamily.get(familyKey(e)) ?? []), e]);
  for (const [k, items] of byFamily) {
    const context = live.filter(e => ready(e) && !taken.has(e.id) && familyKey(e) === k);
    out.push(card(k, items, titleOf(items[0]!), context.length ? { context } : {}));
  }
  return out.sort((a, b) => b.items.length - a.items.length);
}

/**
 * A shared style that can carry the answer as a policy: every member has it, it names a component
 * rather than a utility (HOVER_WASH is a hover effect, not an identity), and no element outside this
 * card has it, so the policy can't reach an unlike element later.
 */
function sharedStyle(items: ElementEval[], all: ElementEval[]): string | undefined {
  for (const k of [items[0]!.styleKey, items[0]!.styleSig]) {
    if (!k || items.length < 2 || UTILITY_STYLE.test(k)) continue;
    if (!items.every(i => i.styleKey === k || i.styleSig === k)) continue;
    const ids = new Set(items.map(i => i.id));
    if (all.every(e => (e.styleKey !== k && e.styleSig !== k) || ids.has(e.id))) return k;
  }
  return undefined;
}
const UTILITY_STYLE = /(HOVER|WASH|FOCUS|RING|TRANSITION|ACTIVE|STATE|INTERACT|BASE|RESET|SR_ONLY)/;

const recOf = (r: Recommendation): Recommendation => ({ verdict: r.verdict, role: r.role, use: r.use, from: r.from, props: r.props, gap: r.gap, ...(r.how ? { how: r.how } : {}), ...(r.parent ? { parent: r.parent } : {}) });
/** The recommendation, every alternative the scanner scored, then keep native: a reviewer can always pick the right home. */
const optionsOf = (e: ElementEval) => {
  const opts = [recOf(e), ...e.alternatives.map(recOf), { verdict: 'keep' as const, role: e.role }];
  const seen = new Set<string>();
  return opts.map(d => ({ label: describe(d), decision: d })).filter(o => !seen.has(o.label) && seen.add(o.label));
};
