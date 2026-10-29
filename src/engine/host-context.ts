import path from 'node:path';
import type { ElementEval } from './elements.js';
import { globMatch } from './paths.js';
import { system } from './system.js';

/**
 * Context the element rules can't see:
 *
 *  - Lab pages (the profile's labPaths) are specimens and experiments, not product UI. Their elements
 *    are tagged as such and stay out of Ready and out of the questions.
 *  - A host copy of a system component (the host's own version of one) is answered by importing the
 *    system's component, not by migrating its insides one by one. The parent decides first: each
 *    element inside reports "host copy of <system> X: import <system>".
 */

/** Lab pages, relative to the app's folder: the profile's, unless dsa.config.json review.labPaths replaces them. */
export const defaultLabPaths = (): string[] => system().profile.labPaths;

export const isLabFile = (rel: string, globs: string[] = defaultLabPaths()) => globs.some(g => globMatch(g, rel));

// ---------- host copies ----------

export interface SystemIndex {
  /** Every system component name, with its import path. */
  exact: Map<string, string>;
  /** The system's own components (not thin wraps) with a two-word-or-longer name: found inside longer host names too. */
  partial: { name: string; words: string[]; from: string }[];
}

const indexCache = new Map<string, SystemIndex>();

/** System component names from the profile's component list. */
export function systemIndex(root: string): SystemIndex {
  const hit = indexCache.get(root);
  if (hit) return hit;
  const idx: SystemIndex = { exact: new Map(), partial: [] };
  for (const c of system().components(root)) {
    if (typeof c.name !== 'string' || !/^[A-Z][A-Za-z]+$/.test(c.name)) continue;
    if (!idx.exact.has(c.name)) idx.exact.set(c.name, c.from);
    const words = wordsOf(c.name);
    if (words.length >= 2 && c.kind === 'own' && !idx.partial.some(p => p.name === c.name)) idx.partial.push({ name: c.name, words, from: c.from });
  }
  indexCache.set(root, idx);
  return idx;
}

/** Forget cached component lists (a new run, or a test with another profile). */
export function resetSystemIndex() { indexCache.clear(); }

const wordsOf = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_-]+/).filter(Boolean).map(w => w.toLowerCase());
/** Words after the system's name that still mean the same thing (makeGroupRowRenderer); any other noun makes it something else (DataTableSection). */
const SAME_THING = /^(render(er)?|impl|inner|base|root|legacy|copy|fork|v\d+)$/;
/** The host name ends with the system name's words: RichGroupRow, renderKindGroupRow, makeStandardGroupRowRenderer. */
const hasRun = (hay: string[], run: string[]) => hay.some((_, i) => run.every((w, j) => hay[i + j] === w) && hay.slice(i + run.length).every(w => SAME_THING.test(w)));

export interface HostCopy { name: string; from: string; via: string }

/**
 * The system component a host file or function rebuilds: the function is named like a system component
 * (function AmountInput), or the function or file holds one of the system's own longer names
 * (RichOptionList.tsx, renderRichGroupRow → GroupRow). A file named after a generic one-word part
 * (Table.tsx) is a feature, not a copy. Not a copy either when the file imports that component:
 * then it composes the system rather than rebuilding it.
 */
export function hostCopyOf(file: string, within: string, idx: SystemIndex, importsSystem: (name: string) => boolean): HostCopy | undefined {
  const base = path.basename(file).replace(/\.[jt]sx?$/, '');
  const from = within ? idx.exact.get(within) : undefined;
  if (from && !importsSystem(within)) return { name: within, from, via: `${within}()` };
  const names: [string, string][] = [[within, `${within}()`], [base, path.basename(file)]].filter(([n]) => n) as [string, string][];
  for (const [n, via] of names) {
    const words = wordsOf(n);
    const p = idx.partial.filter(x => hasRun(words, x.words)).sort((a, b) => b.words.length - a.words.length)[0];
    if (p && !importsSystem(p.name)) return { name: p.name, from: p.from, via };
  }
  return undefined;
}

/**
 * The element is inside a host copy of a system component: the answer is the system's component itself. The
 * element's own reading stays as the first alternative, for when importing isn't possible yet.
 */
export function asHostCopy(ev: ElementEval, copy: HostCopy, threshold: number): ElementEval {
  const own = { verdict: ev.verdict, role: ev.role, use: ev.use, from: ev.from, props: ev.props, gap: ev.gap, ...(ev.how ? { how: ev.how } : {}), confidence: ev.confidence };
  const confidence = Math.round((threshold - 0.05) * 100) / 100;
  return {
    ...ev,
    verdict: 'replace', role: 'host-copy', use: copy.name, from: copy.from, props: {}, gap: undefined, parent: undefined,
    how: `Import ${copy.name} from ${copy.from} and delete the host's copy; its parts, this one included, go with it.`,
    recipe: copy.name, confidence,
    reasons: [{ text: `Host copy of ${system().label} ${copy.name}: ${copy.via} rebuilds it instead of importing it. Import ${system().label} ${copy.name}; this element is one of its insides, so it isn't migrated on its own.`, delta: Math.round((confidence - ev.confidence) * 100) / 100 }, ...ev.reasons],
    alternatives: [own, ...ev.alternatives].slice(0, 3),
  };
}
