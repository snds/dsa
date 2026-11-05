import type { ElementFeatures } from './scanners/features.js';
import { system } from './system.js';
import { bestMatches, describeDim, normalize, type SignatureSet } from './signatures.js';
import { systemRoleMap, systemRoles, type RoleMap } from './roles.js';
import { buttonCandidates, type Candidate, type RoleFn } from './classify-button.js';
import { isPopupTrigger } from './classify-semantics.js';
import { dangerWords, lookOf, type Look } from './classify-look.js';
import { inputCandidates, tableCandidates } from './classify-fields.js';
import { a11yNotes, noHandler } from './classify-a11y.js';
import { refineParts, requireContainer } from './classify-parts.js';
import { applyConstraints, nearestSize, type DsRules } from './constraints.js';

export { systemRoleMap, systemRoles, NEUTRAL_ROLES, roleMapFrom, type RoleMap } from './roles.js';

/**
 * Turns the mechanical facts about a native element into a recommendation:
 * which design system component (and which variant/size) replaces it, or whether it is a
 * gap the system doesn't cover yet, plus a confidence and the evidence behind it.
 *
 * Confidence is a rule score, not a probability: each rule starts from a prior and every
 * piece of evidence moves it up or down by a stated amount. Once humans have decided enough
 * cases for a rule, calibrate() replaces the prior (not the evidence) with the observed agreement.
 * Below the review threshold (default 90%), an agent must ask a human.
 */

/** ignore: a reviewer set it aside (not migrated, not asked again) until they turn that off. */
export type Verdict = 'replace' | 'gap' | 'keep' | 'unclear' | 'ignore';

export interface Recommendation {
  verdict: Verdict;
  role: string;
  use?: string | undefined;
  from?: string | undefined;
  props?: Record<string, string> | undefined;
  /** For gaps: what is missing from the system. */
  gap?: string | undefined;
  /** When the component isn't a one-for-one swap: how it takes over (a DataTable column option, a group around the set). */
  how?: string | undefined;
  /** How each element's content moves into the component (mapping.ts). Omitted: everything from the source. */
  content?: ContentSpec | undefined;
  /**
   * The container a part only works inside (DropdownMenu for DropdownMenuItem, SidebarProvider for
   * SidebarMenuButton), when the element's code doesn't have it yet: migrate it with its parts.
   */
  parent?: { use: string; from?: string | undefined; props?: Record<string, string>; how: string } | undefined;
}

/**
 * Content per instance: "source" keeps what each element has (its label, its icon); a value sets it for
 * every instance; "none" removes it. iconSize "component" drops an icon's own size so the component sizes it.
 */
export interface ContentSpec {
  label?: 'source' | { text: string } | undefined;
  leading?: 'source' | 'none' | { icon: string } | undefined;
  trailing?: 'source' | 'none' | { icon: string } | undefined;
  iconSize?: 'component' | 'source' | undefined;
}

export interface Evaluation extends Recommendation {
  ruleId: string;
  /** 0..1: how sure, after the close-call cap. Below the review threshold, a human decides. */
  confidence: number;
  /** The winner's ranking score (same scale as alternatives' confidence); ≥ every alternative. */
  score?: number | undefined;
  /** Set when a close call capped confidence below the score; an alternative may then show above `confidence`. */
  capped?: { score: number; closeTo: string } | undefined;
  /** Evidence and adjustments, in order. delta 0 = supporting fact. */
  reasons: { text: string; delta: number }[];
  alternatives: (Recommendation & { confidence: number })[];
  /** Visual differences a migration would introduce (classes the component won't keep). */
  visualDiffs: string[];
  /** Accessibility issues seen on the element, independent of the recommendation. */
  a11y: string[];
  /** The winning rule's starting score, before this element's evidence: what calibration replaces. */
  prior?: number | undefined;
  /** n: independent human judgments (a pattern answer counts once); agree: exact matches (component and props). */
  calibrated?: { n: number; agree: number; prior: number; propFixes?: number | undefined; component?: number | undefined } | undefined;
  /** The resting look read from the classes (classify-look.ts): what screenshot evidence may not overrule. */
  look?: { fill: boolean; border: Look['border']; fromBranch: boolean; toolbar: boolean; danger?: Look['danger'] } | undefined;
  /** Why the classifier abstained (verdict unclear): the inputs it couldn't resolve, or the near tie. */
  unclear?: string[] | undefined;
  /** Signature match behind the recommendation, when the component has one. */
  signature?: { component: string; variant: string; size: string; score: number; matched: string[]; mismatched: string[]; structure: string[]; runnerUp?: { variant: string; size: string; score: number } | undefined } | undefined;
}

// Tokens that only place the element; a component keeps these via className without drift.
const LAYOUT = /^(-?translate-|align-|aspect-|min-h-|inline-grid$|outline-hidden$|-?m[trblxy]?-|w-|min-w|max-w|h-full|flex-1|flex-none|shrink|grow|self-|justify-|items-|place-|gap-|inline-flex$|flex$|inline-block$|block$|grid$|relative$|absolute$|fixed$|sticky$|inset|top-|right-|bottom-|left-|z-|overflow-|truncate$|whitespace-|order-|col-|row-|transition|duration-|ease-|focus-visible:|focus:|disabled:|aria-|data-|cursor-|select-none|pointer-events|opacity-50$|sr-only$|group(\/|$)|peer$|text-left$|text-center$|text-right$|leading-|tracking-|font-medium$|outline-none$)/;
const base = (t: string) => t.replace(/^([a-z-]+:)+/, '');

/** Under this signature fit, confidence is held under the review threshold (review item 20). */
export const FIT_GATE = 0.4;
/** Two different components closer than this are a coin toss: abstain rather than pick. */
export const THIN_MARGIN = 0.02;

export function classify(f: ElementFeatures, map: RoleMap = systemRoleMap(), threshold = 0.9, sigs?: SignatureSet, rules?: DsRules): Evaluation {
  let cands = candidates(f, map);
  // Constraints first: candidates that can't carry the element's state, role or anatomy are out before ranking.
  const ruledOut: string[] = [];
  if (sigs) {
    const { kept, rejected } = applyConstraints(cands, f, sigs, rules);
    for (const r of rejected) ruledOut.push(`${describe(r.candidate)} is ruled out: ${r.why}`);
    if (kept.length) cands = kept;
    else return abstainAll(f, cands, ruledOut, threshold);
  }
  if (f.element === 'button' && isPopupTrigger(f)) for (const c of cands) c.reasons.push({ text: `It opens a ${f.attrs['aria-haspopup'] && f.attrs['aria-haspopup'] !== 'true' ? f.attrs['aria-haspopup'] : 'menu or popover'}, so keep it as the trigger and change only its look.`, delta: 0 });
  const sigInfo = new Map<Candidate, Evaluation['signature']>();
  if (sigs) for (const c of cands) { const s = refineWithSignature(c, f, sigs, rules); if (s) sigInfo.set(c, s); }
  // Shared adjustments: uncertainty about the input itself.
  // look: only matters when a component replaces the element (a gap or keep doesn't depend on the look).
  const shared: { text: string; delta: number; look?: boolean | undefined }[] = [];
  if (f.classes.unresolved.length) shared.push({ text: `Part of the styling comes from outside (${[...new Set(f.classes.unresolved)].slice(0, 3).join(', ')}), so the look may differ from what was read.`, delta: -0.06, look: true });
  // Spreads and class constants: the type checker resolves them when it ran; what it couldn't is a reason to abstain.
  const unresolvedInputs: string[] = [];
  if (f.hasSpread) {
    const t = f.typed;
    if (t?.spread === 'resolved') shared.push({ text: `The type checker resolved its spread ({...${t.spreadText ?? 'props'}}): nothing in it changes what the element is.`, delta: 0 });
    else if (t?.spread === 'unresolved') unresolvedInputs.push(`its spread ({...${t.spreadText ?? 'props'}}) can set ${(t.open ?? []).map(k => (k === 'index' ? 'any attribute' : k === 'any' ? 'anything' : k)).join(', ')}, and the type checker can't say to what`);
    else shared.push({ text: 'Other code passes extra settings in ({...props}); check the callers. (No type checker ran to resolve it.)', delta: -0.05 });
  }
  if (f.typed?.classes?.length) unresolvedInputs.push(`the class constant${f.typed.classes.length === 1 ? '' : 's'} ${f.typed.classes.slice(0, 3).join(', ')} ${f.typed.classes.length === 1 ? "doesn't" : "don't"} resolve to classes`);
  if (f.framework !== 'react') shared.push({ text: 'Template element: no parent or child context available.', delta: -0.1 });
  if (f.classes.viaConst.length) shared.push({ text: `Styled by the shared style ${sharedStyleWords(f.classes.viaConst)}.`, delta: 0 });
  // Migrating a control that does nothing is pointless until someone decides it should exist.
  if (f.element === 'button' && noHandler(f)) shared.push({ text: 'No click handler: the button does nothing yet. Decide whether it should exist before migrating it.', delta: -0.06, look: true });
  // A step in a stepper reads like a button or an icon, but its look is the step's state (StepGlyph draws the mark).
  if ([f.attrs['aria-current'], ...(f.attrLiterals?.['aria-current'] ?? [])].includes('step')) shared.push({ text: 'A step in a stepper (aria-current="step"): its look is the step\'s state. StepGlyph draws the mark; the step control itself may stay product UI.', delta: -0.1, look: true });

  const elLook = lookOf(f);
  const scored = cands.map(c => {
    const reasons = [...c.reasons, ...shared.map(({ look, ...r }) => look && c.verdict !== 'replace' ? { ...r, delta: 0 } : r)];
    // Red is a tone the replacement has to keep; a component that isn't red loses it, whatever else matches.
    if (toneLost(elLook, c)) reasons.push({ text: `Red ${dangerWords(elLook.danger!)}: a danger action. ${describe(c)} isn't red, so the tone would be lost. ${system().label} has no quiet danger tone yet (a tone gap).`, delta: -0.05 });
    // Without a signature, classes the component won't keep cost every replacing candidate the same,
    // before ranking, so the reported winner and alternatives are scored on one scale.
    if (c.verdict === 'replace' && !sigInfo.has(c)) {
      const diffs = visualDifferences(f, c);
      if (diffs.length) {
        // Typography-only differences are minor; boxes, borders, shapes, and colors are not.
        const weight = (t: string) => /^(text-(body|code|caption|label)|font-|tabular-nums|leading-|tracking-|underline-offset|text-\[1[0-2]px\])/.test(base(t)) ? 0.01 : 0.035;
        const d = -Math.min(0.12, diffs.reduce((a, t) => a + weight(t), 0));
        reasons.push({ text: `Styling ${c.use ?? 'the component'} won't keep: ${diffs.slice(0, 5).join(', ')}${diffs.length > 5 ? '…' : ''}.`, delta: d });
      }
    }
    const conf = clamp(c.prior + reasons.reduce((a, r) => a + r.delta, 0));
    return { c, reasons, conf };
  }).sort((a, b) => b.conf - a.conf);

  const top = scored[0]!;
  let confidence = top.conf;
  let capped: Evaluation['capped'];
  const reasons = [...top.reasons, ...ruledOut.map(text => ({ text: `${text}.`, delta: 0 }))];
  const second = scored[1];
  // Abstain third: an input the pick depends on didn't resolve, or a different component is just as close.
  const unclear = [...unresolvedInputs, ...(top.c.abstain ?? [])];
  if (second && round(top.conf - second.conf) < THIN_MARGIN && describe(second.c) !== describe(top.c) && (second.c.use !== top.c.use || second.c.verdict !== top.c.verdict)) {
    unclear.push(`${describe(second.c)} scores ${pct(second.conf)} against ${pct(top.conf)}, too close to call`);
  }
  if (unclear.length) return abstain(f, top, scored, reasons, unclear, threshold, sigInfo.get(top.c));
  // A close call is a reason to ask a human, not a change of ranking: the winner keeps its score and the
  // confidence drops under the review threshold, flagged so a runner-up shown above it isn't a contradiction.
  // It is shown even when the score is already under the threshold: the alternative is part of the question.
  if (second && top.conf - second.conf < 0.1) {
    const cap = Math.min(confidence, Math.max(0.5, threshold - 0.05));
    reasons.push({ text: `Close call with ${describe(second.c)} (${pct(second.conf)}): a person should pick.`, delta: round(cap - confidence) });
    if (cap < confidence) capped = { score: round(top.conf), closeTo: second.c.role };
    confidence = cap;
  }
  const sig = sigInfo.get(top.c);
  // Fit is a gate, not a footnote: a component that matches under FIT_GATE of the element's measured
  // properties would change its look too much to ship without a person.
  if (sig && top.c.verdict === 'replace' && sig.score < FIT_GATE && sig.matched.length + sig.mismatched.length > 0) {
    const cap = Math.min(confidence, Math.max(0.5, threshold - 0.05));
    reasons.push({ text: `Fit gate: ${describe(top.c)} matches ${Math.round(sig.score * 100)}% of its look (under ${Math.round(FIT_GATE * 100)}%). A person should confirm the change of look.`, delta: round(cap - confidence) });
    confidence = cap;
  }
  // With a signature, differences are named per property against the component; otherwise the unexplained classes.
  const visualDiffs = top.c.verdict !== 'replace' ? [] : sig ? [...sig.mismatched] : visualDifferences(f, top.c);
  if (toneLost(elLook, top.c) && !visualDiffs.some(d => /red/.test(d))) visualDiffs.push(`red ${dangerWords(elLook.danger!)} (danger tone)`);
  if (top.c.verdict === 'replace' && top.c.gap) reasons.push({ text: `Gap: ${top.c.gap}`, delta: 0 });
  return requireContainer({
    verdict: top.c.verdict, role: top.c.role, use: top.c.use, from: top.c.from, props: top.c.props, gap: top.c.gap, ...(top.c.how ? { how: top.c.how } : {}),
    ruleId: top.c.ruleId, confidence: round(confidence), score: round(top.conf), prior: round(top.c.prior), capped, reasons,
    alternatives: scored.slice(1, 3).map(s => ({ verdict: s.c.verdict, role: s.c.role, use: s.c.use, from: s.c.from, props: s.c.props, gap: s.c.gap, ...(s.c.how ? { how: s.c.how } : {}), confidence: round(s.conf) })),
    visualDiffs, a11y: a11yNotes(f), signature: sig, look: lookSummary(f, top.c),
  }, f, threshold);
}

/** Confidence of an abstention: under the review threshold, so a person always picks. */
const abstainConfidence = (score: number, threshold: number) => Math.min(score, Math.max(0.5, threshold - 0.05));
type Scored = { c: Candidate; reasons: { text: string; delta: number }[]; conf: number };
const asAlternative = (s: Scored) => ({ verdict: s.c.verdict, role: s.c.role, use: s.c.use, from: s.c.from, props: s.c.props, gap: s.c.gap, ...(s.c.how ? { how: s.c.how } : {}), confidence: round(s.conf) });

/** The classifier won't pick: verdict unclear, the best guesses offered as alternatives, and why in words. */
function abstain(f: ElementFeatures, top: Scored, scored: Scored[], reasons: Scored['reasons'], why: string[], threshold: number, sig?: Evaluation['signature']): Evaluation {
  const confidence = round(abstainConfidence(top.conf, threshold));
  return {
    verdict: 'unclear', role: top.c.role, ruleId: top.c.ruleId, confidence, score: round(top.conf), prior: round(top.c.prior),
    reasons: [...reasons, { text: `Unclear: ${why.join('; ')}. A person should pick from the alternatives.`, delta: round(confidence - top.conf) }],
    alternatives: scored.slice(0, 3).map(asAlternative), unclear: why,
    visualDiffs: [], a11y: a11yNotes(f), signature: sig,
  };
}

/** Every candidate was ruled out by a hard constraint: nothing to rank, so abstain and say what was tried. */
function abstainAll(f: ElementFeatures, cands: Candidate[], ruledOut: string[], threshold: number): Evaluation {
  const top = [...cands].sort((a, b) => b.prior - a.prior)[0]!;
  const confidence = round(abstainConfidence(top.prior, threshold));
  return {
    verdict: 'unclear', role: top.role, ruleId: top.ruleId, confidence, score: round(top.prior), prior: round(top.prior),
    reasons: [...top.reasons, ...ruledOut.map(text => ({ text: `${text}.`, delta: 0 })), { text: 'Unclear: every candidate was ruled out. A person should pick, or the system needs a component for this.', delta: round(confidence - top.prior) }],
    alternatives: [], unclear: ruledOut, visualDiffs: [], a11y: a11yNotes(f),
  };
}

/**
 * Pick variant/size by matching the element against the component's generated signatures, and fold
 * the match quality into the candidate's prior. The role (link, icon, ghost…) is a structural call
 * made by the rules; within it, the signature decides the props and says how close the fit is.
 */
function refineWithSignature(c: Candidate, f: ElementFeatures, sigs: SignatureSet, rules?: DsRules): Evaluation['signature'] | undefined {
  if (c.verdict !== 'replace' || !c.use) return;
  const comp = sigs.components.get(c.use);
  if (!comp || !comp.sigs.length) return;
  const hasIconSizes = comp.sigs.some(s => s.iconOnly);
  const iconRole = c.role === 'icon-button' || c.role === 'disclosure-icon';
  // The rules decide the role (structure); variant comes from the rule when the role or rule implies it
  // (link → link, icon → ghost/outline/toolbar, a quiet text button → ghost). Otherwise the element's
  // resting box decides which variants are plausible: hover and pressed fills are not a resting fill.
  const fixedVariant = c.props?.variant && (c.role === 'link-button' || iconRole || STRUCTURAL_VARIANT.test(c.ruleId)) ? c.props.variant : undefined;
  // A condition's "on" side is a plain button's look (enabled, armed); on a set member it is the chosen look.
  const look = lookOf(f, { branch: PLAIN_ROLE.test(c.role) });
  // A neutral surface inside a full border (bg-card border) is an outlined button, not a filled one.
  const surface = look.rest.some(t => /^bg-(card|background|white|popover)$/.test(t));
  const linkText = look.rest.some(t => /^(text-primary|text-link|underline)$/.test(t));
  const variants = comp.axes.variant ?? [];
  // The card surface inside a border is the toolbar look (a system toolbar variant: border-border bg-card).
  const cardChrome = look.border === 'box' && look.rest.includes('bg-card') && variants.includes('toolbar');
  const plausible = (v: string) => fixedVariant ? v === fixedVariant
    : !comp.axes.variant ? true
    : (look.toolbar || cardChrome) && variants.includes('toolbar') ? v === 'toolbar'
    // Joined segments: the one-side border is the divider an outlined ToggleGroup draws.
    : look.border === 'side' && SET_ROLE.test(c.role) ? v === 'outline'
    : look.border === 'box' && (surface || !look.fill) ? /^(outline|toolbar)$/.test(v)
    : look.fill ? !/^(ghost|link|outline|toolbar)$/.test(v)
    // No box at rest: a hover fill is ghost; link-coloured text with no hover fill may be a link. The
    // fallback rule can't tell (the colour may sit on a child), so it keeps both.
    : linkText && !look.hoverFill || c.ruleId === 'button.fallback' ? /^(ghost|link)$/.test(v) : v === 'ghost';
  if (look.border === 'side' && SET_ROLE.test(c.role)) c.reasons.push({ text: 'Joined segments with a divider between them: ToggleGroup variant "outline" draws the dividers.', delta: 0 });
  // A look read from the "on" branch is compared as if it were at rest.
  if (look.fromBranch) {
    f = { ...f, classes: { ...f.classes, tokens: [...f.classes.tokens, ...(f.classes.onBranch ?? [])] } };
    c.reasons.push({ text: 'Its fill or border is set by a condition; read the look from the condition\'s "on" side.', delta: 0 });
  }
  // With no size information on the element, the rule's size stands (from the icon's size prop, padding…)
  // and the signatures don't get to pretend they can tell sizes apart.
  const elProps = normalize(f.classes.tokens, sigs.aliases);
  const elHasSize = ['height', 'width'].some(k => elProps.has(k));
  const ruleSize = !elHasSize && c.props?.size && comp.axes.size?.includes(c.props.size) ? c.props.size : undefined;
  // A square box with no side padding (size-7, or h-7 w-7) is an icon-sized control even when its content is
  // passed in ({children}): it takes an icon size, never a text size of the same height.
  const squareBox = elProps.has('height') && elProps.get('height') === elProps.get('width') && (!elProps.has('px') || /^0(rem|px)?$/.test(elProps.get('px')!));
  const iconSized = iconRole || (squareBox && !f.children.text && c.role !== 'link-button');
  if (squareBox && !iconRole && iconSized && hasIconSizes) c.reasons.push({ text: 'A square box with no side padding: an icon-sized control, so an icon size.', delta: 0 });
  let matches = bestMatches(f, comp, sigs, s => plausible(s.variant) && (!hasIconSizes || (iconSized ? s.iconOnly : !s.iconOnly)) && (!ruleSize || s.size === ruleSize));
  if (!matches.length) matches = bestMatches(f, comp, sigs);
  if (!matches.length) return;
  // Size by distance in resolved pixels, height then width as hard limits: a 20px button is never given
  // the 32px size because its colours happen to match it better. What doesn't resolve, or sits exactly
  // between two sizes, is a reason to abstain.
  if (comp.axes.size) {
    const fit = nearestSize(matches, elProps, sigs.values, rules?.controlScale);
    matches = fit.matches;
    for (const w of [fit.unresolved, fit.tie]) if (w) (c.abstain ??= []).push(w);
    for (const d of fit.dims) {
      if (Math.abs(d.element - d.nearest) <= 0.5 || c.reasons.some(r => r.text.includes(`${d.element}px`))) continue;
      c.reasons.push({ text: `It is ${d.element}px ${d.dim === 'height' ? 'high' : 'wide'}; the nearest ${c.use} size is ${d.nearest}px. Approve the change, or ask for a size that fits.`, delta: -0.02 });
    }
  }
  // The runner-up is the closest signature the element can tell apart from the best: Button link
  // default, lg and toolbar look the same to an element with no height, so naming lg says nothing.
  const best = matches[0]!;
  const tellsApart = (m: (typeof matches)[number]) => [...new Set([...best.sig.props.keys(), ...m.sig.props.keys()])].some(k => best.sig.props.get(k) !== m.sig.props.get(k) && elProps.has(k));
  const second = matches.slice(1).find(m => m.structure.ok === best.structure.ok && tellsApart(m)) ?? matches[1];
  const props: Record<string, string> = { ...(c.props ?? {}) };
  if (comp.axes.variant) props.variant = best.sig.variant;
  if (comp.axes.size) { if (best.sig.size !== (comp.defaults.size ?? 'default')) props.size = best.sig.size; else delete props.size; }
  c.props = props;
  const ok = best.dims.filter(d => d.ok), bad = best.dims.filter(d => !d.ok);
  const label = `${c.use}${props.variant ? ` ${props.variant}` : ''}${best.sig.size !== 'default' ? `/${best.sig.size}` : ''}`;
  // Fit says how much the look will change, not whether the call is right: a house-styled button
  // becoming the system's Button is the point. So fit is reported; only the margin and structure move confidence.
  // Nothing compared is not a 0% match: say nothing rather than a number that drives designers away.
  if (best.dims.length) c.reasons.push({ text: `Closest ${system().label} look: ${label} (${ok.length} of ${best.dims.length} properties match).`, delta: 0 });
  const sameKind = /^(button|icon-button|link-button|cell-icon-button|text-input|search-input|textarea|toggle|segmented|chip-toggle|disclosure|disclosure-icon|sidebar-toggle|nav-item)$/.test(c.role);
  if (sameKind && !best.structure.ok) c.reasons.push({ text: `Structure doesn't fit the component: ${best.structure.notes.join('; ')}.`, delta: -0.1 });
  if (second && (second.sig.variant !== best.sig.variant || second.sig.size !== best.sig.size)) {
    const margin = best.score - second.score;
    // Only an ambiguity if the element actually has a value where the two candidates differ.
    const differing = [...new Set([...best.sig.props.keys(), ...second.sig.props.keys()])].filter(k => best.sig.props.get(k) !== second.sig.props.get(k));
    const informed = differing.some(k => elProps.has(k));
    if (margin < 0.05 && informed) c.reasons.push({ text: `${c.use} ${second.sig.variant} ${second.sig.size} is almost as close: check the variant and size.`, delta: -0.06 });
    else if (margin >= 0.15) c.reasons.push({ text: `Clearly closer than ${c.use} ${second.sig.variant} ${second.sig.size}.`, delta: 0.03 });
  }
  return {
    component: c.use, variant: best.sig.variant, size: best.sig.size, score: Math.round(best.score * 100) / 100,
    matched: ok.map(describeDim), mismatched: bad.map(describeDim), structure: best.structure.notes,
    runnerUp: second ? { variant: second.sig.variant, size: second.sig.size, score: Math.round(second.score * 100) / 100 } : undefined,
  };
}

const PLAIN_ROLE = /^(button|icon-button|link-button)$/;
const SET_ROLE = /^(segmented|chip-toggle)$/;
/** Rules whose variant comes from structure, not from a class (a ghost text button's resting look is no box). */
const STRUCTURAL_VARIANT = /^button\.(ghost|quiet-ghost|hover-link-ghost|unstyled|destructive-text)$/;

function candidates(f: ElementFeatures, map: RoleMap): Candidate[] {
  const role = (r: string, ruleId: string, prior: number, reasons: Candidate['reasons'], props?: Record<string, string>): Candidate => {
    const def = map.roles[r] ?? systemRoles()[r] ?? { use: r };
    return { verdict: def.verdict ?? 'replace', role: r, use: def.use || undefined, from: def.from, props: { ...(def.props ?? {}), ...(props ?? {}) }, gap: def.gap, ...(def.how ? { how: def.how } : {}), ruleId, prior, reasons };
  };
  switch (f.element) {
    case 'button': return refineParts(f, buttonCandidates(f, map, role), role);
    case 'input': return inputCandidates(f, role, map);
    case 'table': return tableCandidates(f, role);
    case 'select': return selectCandidates(f, role);
    case 'textarea': return [role('textarea', 'textarea', 0.94, [{ text: 'Plain multi-line text field.', delta: 0 }])];
    case 'dialog': return f.fileUsesShowModal
      ? [role('native-dialog', 'dialog.imperative', 0.92, [{ text: 'File drives the dialog with showModal().', delta: 0 }]), role('dialog', 'dialog.declarative', 0.6, [])]
      : [role('dialog', 'dialog.declarative', 0.88, [{ text: 'Native <dialog> without showModal(): declarative Dialog fits.', delta: 0 }])];
    case 'div': case 'span':
      if (f.classes.tokens.includes('animate-pulse') && !f.children.text && !f.children.dynamicText && !f.children.elements.length && !f.children.icons)
        return [role('skeleton', 'skeleton', 0.93, [{ text: 'A pulsing, muted, empty box: a loading placeholder (Skeleton).', delta: 0 }])];
      return [role(f.element, 'unknown', 0.5, [{ text: `No rule for <${f.element}>.`, delta: 0 }])];
    case 'label':
      return [role('label', f.attrs.htmlFor !== undefined ? 'label.for' : 'label.wraps', f.attrs.htmlFor !== undefined ? 0.92 : 0.88, [{ text: f.attrs.htmlFor !== undefined ? 'A <label> pointing at a field (htmlFor): Label.' : 'A <label> wrapping a text field: Label.', delta: 0 }])];
    default: return [role(f.element, 'unknown', 0.5, [{ text: `No rule for <${f.element}>.`, delta: 0 }])];
  }
}

function selectCandidates(f: ElementFeatures, role: RoleFn): Candidate[] {
  if ('multiple' in f.attrs) return [role('multi-select', 'select.multiple', 0.8, [{ text: 'Native multi-select.', delta: 0 }])];
  const n = f.optionCount ?? 0;
  if (n === -1) return [role('select', 'select.mapped', 0.74, [{ text: 'Options come from data; length unknown (long lists want a searchable Combobox).', delta: 0 }]), role('combobox', 'select.mapped-long', 0.66, [])];
  if (n > 12) return [role('combobox', 'select.long', 0.86, [{ text: `${n} options: searchable list.`, delta: 0 }]), role('select', 'select.long-plain', 0.62, [])];
  return [role('select', 'select.short', 0.92, [{ text: `${n} literal option(s).`, delta: 0 }])];
}

/** Classes a component won't keep: anything that isn't layout or explained by the chosen variant/size. */
function visualDifferences(f: ElementFeatures, c: Candidate): string[] {
  const explained = /^(border-collapse$|bg-primary|text-primary-foreground|bg-destructive|text-destructive|border$|border-input$|border-border$|bg-secondary|bg-muted|bg-foreground|text-background|hover:bg-|active:bg-|hover:text-|text-foreground$|text-muted-foreground$|text-primary$|underline$|hover:underline$|rounded(-sm|-md)?$|px-|py-|p-|h-|size-|text-(xs|sm)$|shadow-sm$|bg-card$|bg-background$|bg-transparent$)/;
  // Red text is only explained by a red variant; anything else drops the danger tone.
  const red = (t: string) => /(^|:)text-(destructive|red-\d+)/.test(t) && !RED_VARIANT.test(c.props?.variant ?? '');
  return f.classes.tokens.filter(t => red(t) || !LAYOUT.test(base(t)) && !LAYOUT.test(t) && !explained.test(t) && !explained.test(base(t))).slice(0, 12);
}

function lookSummary(f: ElementFeatures, c: Candidate): Evaluation['look'] {
  if (c.verdict !== 'replace') return undefined;
  const l = lookOf(f, { branch: PLAIN_ROLE.test(c.role) });
  return { fill: l.fill, border: l.border, fromBranch: l.fromBranch, toolbar: l.toolbar, ...(l.danger ? { danger: l.danger } : {}) };
}

const RED_VARIANT = /^(destructive|danger)$/;
/** The element is red and the candidate replaces it with something that isn't (ghost, link, a menu item without variant=destructive). */
function toneLost(look: Look, c: Candidate): boolean {
  return Boolean(look.danger) && c.verdict === 'replace' && Boolean(c.use) && !RED_VARIANT.test(c.props?.variant ?? '');
}

export interface CalibrationStats {
  /** Independent human judgments on this rule. One answer that covered a whole pattern is one judgment. */
  n: number;
  /** Judgments that kept the component and every prop. A changed prop is a miss, not an agreement. */
  agree: number;
  /** Judgments that kept the component (props aside). */
  componentAgree?: number | undefined;
  /** Judgments that kept the component but changed a prop. */
  propFixes?: number | undefined;
  /** "size=xs" → how many judgments made that change. */
  fixes?: Record<string, number> | undefined;
}

/**
 * Fold what reviewers decided on earlier elements of the same rule into this one.
 *
 * - Once a rule has minN judgments, the observed agreement replaces the rule's starting score (the
 *   prior). The element's own evidence still applies on top, so its doubts are never erased.
 * - A prop fix most reviewers made (size=xs) is offered as an alternative and costs confidence until
 *   the rule learns it, so the element goes to a person instead of shipping the wrong size.
 * - A close call stays a close call, and nothing calibrates above 0.98.
 */
export function calibrate(e: Evaluation, stats: CalibrationStats | undefined, minN = 5): Evaluation {
  if (!stats || stats.n <= 0) return e;
  let out: Evaluation = e;
  const fix = dominantFix(e, stats);
  if (fix) {
    const props = { ...(e.props ?? {}) };
    if (fix.value === 'unset') delete props[fix.prop]; else props[fix.prop] = fix.value;
    const alt = { verdict: e.verdict, role: e.role, use: e.use, from: e.from, props, gap: e.gap, confidence: e.confidence };
    out = {
      ...out,
      confidence: round(clamp(out.confidence - 0.05)),
      alternatives: [alt, ...out.alternatives.filter(a => JSON.stringify(a.props ?? {}) !== JSON.stringify(props) || a.use !== e.use)],
      reasons: [...out.reasons, { text: `Reviewers kept ${e.use} but set ${fix.prop}=${fix.value} in ${count(fix.n)} of ${count(stats.n)} earlier decisions like this. Check the ${fix.prop}.`, delta: -0.05 }],
    };
  }
  if (stats.n < minN) return out;
  // Beta prior centered on the rule's own starting score, worth 5 judgments.
  const prior = e.prior ?? e.confidence;
  const base = (prior * 5 + stats.agree) / (5 + stats.n);
  let confidence = clamp(out.confidence + (base - prior));
  // Agreement on other elements can't settle this element's close call, or supply a missing container.
  if (e.capped || e.parent) confidence = Math.min(confidence, out.confidence);
  confidence = round(confidence);
  const kept = stats.componentAgree !== undefined && stats.componentAgree > stats.agree ? ` They kept ${e.use ?? 'the component'} but changed a prop in ${count(stats.componentAgree - stats.agree)} more.` : '';
  return {
    ...out, confidence,
    calibrated: { n: stats.n, agree: stats.agree, prior, ...(stats.propFixes ? { propFixes: stats.propFixes } : {}), ...(stats.componentAgree !== undefined ? { component: stats.componentAgree } : {}) },
    reasons: [...out.reasons, { text: `Reviewers accepted this call as given in ${count(stats.agree)} of ${count(stats.n)} earlier decisions.${kept}`, delta: round(confidence - out.confidence) }],
  };
}

/** The prop change most judgments on this rule made, when it's a majority of at least two and this element doesn't have it yet. */
function dominantFix(e: Evaluation, stats: CalibrationStats): { prop: string; value: string; n: number } | undefined {
  if (e.verdict !== 'replace' || !e.use || stats.n < 2) return;
  const top = Object.entries(stats.fixes ?? {}).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 2 || top[1] <= stats.n / 2) return;
  const [prop, value] = top[0].split('=') as [string, string];
  if ((e.props?.[prop] ?? 'unset') === value) return;
  return { prop, value, n: top[1] };
}
const count = (x: number) => String(Math.round(x * 10) / 10);

/** "PLUS (via JUMP)" from "JUMP=./styles#PLUS": the constant that holds the classes, and the alias it came through. */
function sharedStyleWords(via: string[]): string {
  const v = via[0]!;
  const last = v.split('=').pop()!.split('#').pop()!;
  const alias = v.includes('=') ? v.split('=')[0]!.split('#').pop() : undefined;
  return `${last}${alias && alias !== last ? ` (via ${alias})` : ''}`;
}

export const describe = (r: Recommendation) => r.verdict === 'ignore' ? 'Ignored' : r.verdict === 'gap' ? `gap (${r.role})` : r.verdict === 'keep' ? 'Keep native' : `${r.use}${r.props && Object.keys(r.props).length ? ' ' + Object.entries(r.props).map(([k, v]) => `${k}="${v}"`).join(' ') : ''}`;
const clamp = (x: number) => Math.max(0.2, Math.min(0.98, x));
const round = (x: number) => Math.round(x * 100) / 100;
const pct = (x: number) => `${Math.round(x * 100)}%`;
