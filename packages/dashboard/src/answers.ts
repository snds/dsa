import type { Label } from '@snds/dsa';
import type { ElementEval, Recommendation } from '@snds/dsa/engine';
import { labelIdentity } from './review.js';

/**
 * One answer, saved once and used twice. A person's answer about where a component goes is both a
 * decision (the app's decisions file, which drives the migration plan) and a label (ground truth the
 * bench scores dsa against). Element Review and Label Review ask the same question, so whichever one a
 * person answers in, both records are written: nobody is asked twice, and every answer counts.
 */

export type How = 'alone' | 'batch' | 'spot-check';

/** The verdicts a label can hold. "ignore" (set aside) and "unclear" aren't answers about the element. */
const TRUTHS = new Set(['replace', 'keep', 'gap']);

const strings = (p?: Record<string, unknown>) => Object.fromEntries(Object.entries(p ?? {}).map(([k, v]) => [k, String(v)]));

/** What dsa proposed for the element, and how sure it was, at the moment of the answer. */
export function proposedOf(e: ElementEval): NonNullable<Label['proposed']> {
  return {
    verdict: e.verdict,
    ...(e.use ? { use: e.use } : {}),
    ...(e.props && Object.keys(e.props).length ? { props: strings(e.props) } : {}),
    confidence: Math.max(0, Math.min(1, e.confidence)),
  };
}

/** The label a decision makes for one element, or null when the decision isn't an answer about it (set aside). */
export function labelForDecision(e: ElementEval, decision: Recommendation, o: { who?: string | undefined; note?: string | undefined; how: How; judgment?: string | undefined; at?: Date | undefined; sourceRef?: string | undefined }): Label | null {
  if (!TRUTHS.has(decision.verdict)) return null;
  if (decision.verdict === 'replace' && !decision.use) return null;
  const truth: Label['truth'] = decision.verdict === 'replace'
    ? { verdict: 'replace', use: decision.use!, ...(decision.props && Object.keys(decision.props).length ? { props: strings(decision.props) } : {}) }
    : { verdict: decision.verdict as 'keep' | 'gap' };
  return {
    id: e.id, ...labelIdentity(e, o.sourceRef), truth, acceptableAlts: [],
    labeler: o.who?.trim() || 'unnamed reviewer', method: 'human', at: (o.at ?? new Date()).toISOString(),
    ...(o.note?.trim() ? { notes: o.note.trim() } : {}),
    how: o.how, ...(o.judgment ? { judgment: o.judgment } : {}), proposed: proposedOf(e),
  };
}

/** The labels one decision makes: one per element it covered, sharing the answer's judgment when it covered several. */
export function labelsForDecision(evals: ElementEval[], decision: Recommendation, o: { ids: string[]; who?: string | undefined; note?: string | undefined; judgment?: string | undefined; at?: Date | undefined }): Label[] {
  const byId = new Map(evals.map((e) => [e.id, e]));
  const how: How = o.ids.length > 1 ? 'batch' : 'alone';
  return o.ids.flatMap((id) => {
    const e = byId.get(id);
    const l = e ? labelForDecision(e, decision, { ...o, how, judgment: how === 'batch' ? o.judgment : undefined }) : null;
    return l ? [l] : [];
  });
}

/**
 * The decision a label makes for its element: the label's answer, with the element's role. When the
 * answer is the component dsa proposed, the decision keeps dsa's own mapping (from) too.
 */
export function decisionForLabel(e: ElementEval, truth: Label['truth']): Recommendation {
  if (truth.verdict !== 'replace') return { verdict: truth.verdict, role: e.role, ...(truth.verdict === 'gap' && e.gap ? { gap: e.gap } : {}) };
  return { verdict: 'replace', role: e.role, use: truth.use, props: truth.props ?? {}, ...(e.use === truth.use && e.from ? { from: e.from } : {}) };
}
