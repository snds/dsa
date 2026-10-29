import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { globMatch } from './paths.js';
import type { Recommendation } from './classify.js';
import type { ElementEval } from './elements.js';

/**
 * Scanner hints: reviewed corrections to how the scanner reads elements, kept in dsa.hints.json next to
 * dsa.config.json (committed, so they go through review like code).
 *
 * A hint is not a decision. A decision (or a policy) answers "what does this element become" for one app.
 * A hint changes the scanner's reasoning everywhere it matches: "a button inside a sidebar with a nav
 * label is a navigation item, not a toggle". The element is still scored, the hint shows up as a reason,
 * and a human still confirms anything that lands below the review threshold.
 */
export interface HintMatch {
  element?: string | undefined;
  role?: string | undefined;
  ruleId?: string | undefined;
  /** The recommendation the scanner made (before the hint), e.g. "ToggleGroup". */
  use?: string | undefined;
  /** Any region the element sits in: sidebar, dialog, toolbar, table, aside… */
  region?: string | undefined;
  /** Regular expression over the visible text, aria-label, and title. */
  text?: string | undefined;
  /** Every one of these class tokens is present. */
  classes?: string[] | undefined;
  /** Globs over the app-relative file path. */
  paths?: string[] | undefined;
  styleKey?: string | undefined;
  styleSig?: string | undefined;
}
export interface Hint {
  id: string;
  when: HintMatch;
  /** Recommend this instead. */
  prefer?: Recommendation | undefined;
  /** Never recommend these components for a match: fall back to the best remaining alternative. */
  avoid?: string[] | undefined;
  /** Confidence after a `prefer` (default 0.92). Under the review threshold, a human still confirms. */
  confidence?: number | undefined;
  why: string;
  by: 'human' | 'agent';
  who?: string | undefined;
  date: string;
  /** Where it came from: the agent session and the element ids it was shown on. */
  source?: { session?: string | undefined; examples?: string[] } | undefined;
}
export interface HintsFile { file: string; hints: Hint[] }

/** dsa.hints.json sits next to dsa.config.json (`dir` is the config's folder, or the repo root without one). */
export function hintsPath(dir: string): string {
  return path.join(dir, 'dsa.hints.json');
}

export function loadHints(root: string): HintsFile {
  const file = hintsPath(root);
  try { return { file, hints: (JSON.parse(fs.readFileSync(file, 'utf8')).hints ?? []) as Hint[] }; } catch { return { file, hints: [] }; }
}

export function addHint(root: string, h: Omit<Hint, 'id' | 'date'> & { date?: string | undefined }): Hint {
  const hf = loadHints(root);
  const id = 'H-' + crypto.createHash('sha1').update(JSON.stringify(h.when) + (h.prefer?.use ?? '') + (h.avoid ?? []).join()).digest('hex').slice(0, 6).toUpperCase();
  const hint: Hint = { id, ...h, date: h.date ?? new Date().toISOString().slice(0, 10) };
  const i = hf.hints.findIndex(x => x.id === hint.id);
  if (i >= 0) hf.hints[i] = hint; else hf.hints.push(hint);
  fs.writeFileSync(hf.file, JSON.stringify({ $comment: 'Scanner hints (dsa.hints.json): reviewed corrections the classifier applies on every scan. See docs/agent-workbench.md.', hints: hf.hints }, null, 2) + '\n');
  return hint;
}

export function removeHint(root: string, id: string): boolean {
  const hf = loadHints(root);
  const n = hf.hints.length;
  hf.hints = hf.hints.filter(h => h.id !== id);
  if (hf.hints.length === n) return false;
  fs.writeFileSync(hf.file, JSON.stringify({ hints: hf.hints }, null, 2) + '\n');
  return true;
}

/** Problems that make a hint unsafe to apply (too broad, or says nothing). */
export function hintProblems(h: Pick<Hint, 'when' | 'prefer' | 'avoid' | 'why'>): string[] {
  const p: string[] = [];
  const w = h.when ?? {};
  const narrowing = ['role', 'ruleId', 'use', 'region', 'text', 'classes', 'paths', 'styleKey', 'styleSig'].filter(k => (w as any)[k] != null && (w as any)[k] !== '' && !(Array.isArray((w as any)[k]) && !(w as any)[k].length));
  if (!w.element) p.push('A hint needs the element it applies to (button, a, input…).');
  if (!narrowing.length) p.push('A hint needs at least one condition besides the element (region, text, classes, the current pick…), or it would rewrite every one.');
  if (!h.prefer && !h.avoid?.length) p.push('A hint needs `prefer` (what to recommend) or `avoid` (what never to recommend).');
  if (h.prefer && h.prefer.verdict === 'replace' && !h.prefer.use) p.push('`prefer` with verdict "replace" needs `use` (the component).');
  if (w.text) { try { new RegExp(w.text, 'i'); } catch { p.push(`\`text\` is not a valid regular expression: ${w.text}`); } }
  if (!String(h.why ?? '').trim()) p.push('A hint needs `why`, in a sentence a reviewer can check.');
  return p;
}

export function hintMatches(w: HintMatch, e: ElementEval, rel: string): boolean {
  if (w.element && w.element !== e.element) return false;
  if (w.role && w.role !== e.role) return false;
  if (w.ruleId && w.ruleId !== e.ruleId) return false;
  if (w.use && w.use !== e.use) return false;
  if (w.region && !(e.regions ?? []).includes(w.region as any)) return false;
  if (w.styleKey && w.styleKey !== e.styleKey) return false;
  if (w.styleSig && w.styleSig !== e.styleSig) return false;
  if (w.classes?.length && !w.classes.every(c => (e.classTokens ?? []).includes(c))) return false;
  if (w.paths?.length && !w.paths.some(g => globMatch(g, rel))) return false;
  if (w.text) {
    const hay = [e.match?.text, e.match?.ariaLabel, e.match?.title].filter(Boolean).join(' ');
    try { if (!new RegExp(w.text, 'i').test(hay)) return false; } catch { return false; }
  }
  return true;
}

/** Apply every matching hint, in file order. Returns the ids applied. */
export function applyHints(e: ElementEval, rel: string, hints: Hint[], threshold: number): string[] {
  const applied: string[] = [];
  for (const h of hints) {
    if (!hintMatches(h.when, e, rel)) continue;
    applied.push(h.id);
    if (h.prefer) {
      const before = e.use ?? e.verdict;
      const conf = Math.min(1, h.confidence ?? 0.92);
      e.alternatives = [{ verdict: e.verdict, role: e.role, use: e.use, from: e.from, props: e.props, confidence: e.confidence }, ...e.alternatives.filter(a => a.use !== h.prefer!.use)].filter(a => a.use || a.verdict !== 'replace');
      Object.assign(e, { verdict: h.prefer.verdict, use: h.prefer.use, from: h.prefer.from ?? e.from, props: h.prefer.props, gap: h.prefer.gap, content: h.prefer.content });
      e.reasons.push({ text: `Scanner hint ${h.id}: ${h.why} (was ${before}).`, delta: Math.round((conf - e.confidence) * 100) / 100 });
      e.confidence = conf;
    } else if (h.avoid?.length && e.use && h.avoid.includes(e.use)) {
      const next = e.alternatives.find(a => !a.use || !h.avoid!.includes(a.use));
      const before = e.use;
      if (next) Object.assign(e, { verdict: next.verdict, use: next.use, from: next.from, props: next.props, role: next.role ?? e.role });
      else Object.assign(e, { verdict: 'keep', use: undefined, props: undefined });
      e.alternatives = e.alternatives.filter(a => a !== next);
      // A fallback is a guess: keep it under the threshold so a human looks.
      const conf = Math.min(e.confidence, (next?.confidence ?? 0.5), threshold - 0.02);
      e.reasons.push({ text: `Scanner hint ${h.id}: never ${h.avoid.join(' or ')} here. ${h.why} (was ${before}).`, delta: Math.round((conf - e.confidence) * 100) / 100 });
      e.confidence = Math.round(conf * 100) / 100;
    }
  }
  if (applied.length) { e.hints = applied; e.needsHuman = e.confidence < threshold; }
  return applied;
}
