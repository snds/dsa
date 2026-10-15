import { canonicalComponent, familyOf, patternCatalog, type Family } from "../data/index.js";
import { anatomyNodes, type AnatomyNode } from "./anatomy.js";

/** Family sequence in document order with consecutive repeats collapsed. */
export function familySequence(anatomy: AnatomyNode): Family[] {
  const out: Family[] = [];
  for (const n of anatomyNodes(anatomy)) {
    if (n.kind === "html") continue;
    const fam = familyOf(n.component);
    if (fam && out[out.length - 1] !== fam) out.push(fam);
  }
  return out;
}

export function distinctFamilies(anatomy: AnatomyNode, dsOnly = false): Family[] {
  const set = new Set<Family>();
  for (const n of anatomyNodes(anatomy)) {
    if (n.kind === "html") continue;
    if (dsOnly && n.kind !== "ds") continue;
    const fam = familyOf(n.component);
    if (fam) set.add(fam);
  }
  return [...set];
}

export function canonicalNames(anatomy: AnatomyNode): Set<string> {
  const set = new Set<string>();
  for (const n of anatomyNodes(anatomy)) {
    if (n.kind === "html") continue;
    const c = canonicalComponent(n.component);
    if (c) set.add(c);
  }
  return set;
}

export function lcsLength<T>(a: T[], b: T[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface Match {
  name: string;
  score: number;
  source: "catalog" | "local";
}

/** Nearest catalog pattern by family-sequence similarity plus component overlap. */
export function nearestCatalogPattern(anatomy: AnatomyNode): Match | undefined {
  const seq = familySequence(anatomy);
  const names = canonicalNames(anatomy);
  let best: Match | undefined;
  for (const p of patternCatalog().patterns) {
    const seqScore = seq.length === 0 ? 0 : lcsLength(seq, p.families) / Math.max(seq.length, p.families.length);
    const nameScore = jaccard(names, new Set(p.components));
    const score = round(0.5 * seqScore + 0.5 * nameScore);
    if (!best || score > best.score) best = { name: p.candidateName, score, source: "catalog" };
  }
  return best;
}

function labelBag(anatomy: AnatomyNode): Map<string, number> {
  const bag = new Map<string, number>();
  for (const n of anatomyNodes(anatomy)) {
    const label = `${n.kind}:${canonicalComponent(n.component) ?? n.component}`;
    bag.set(label, (bag.get(label) ?? 0) + 1);
  }
  return bag;
}

/** Bag-of-nodes similarity between two anatomies, with a bonus for the same root. */
export function anatomySimilarity(a: AnatomyNode, b: AnatomyNode): number {
  const ba = labelBag(a);
  const bb = labelBag(b);
  let min = 0;
  let max = 0;
  for (const key of new Set([...ba.keys(), ...bb.keys()])) {
    const x = ba.get(key) ?? 0;
    const y = bb.get(key) ?? 0;
    min += Math.min(x, y);
    max += Math.max(x, y);
  }
  const bag = max === 0 ? 0 : min / max;
  const rootBonus = a.component === b.component && a.kind === b.kind ? 0.2 : 0;
  return round(Math.min(1, 0.8 * bag + rootBonus));
}

export function nearestLocalComponent(
  anatomy: AnatomyNode,
  locals: { name: string; anatomy: AnatomyNode }[],
): Match | undefined {
  let best: Match | undefined;
  for (const l of locals) {
    const score = anatomySimilarity(anatomy, l.anatomy);
    if (!best || score > best.score) best = { name: l.name, score, source: "local" };
  }
  return best;
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
