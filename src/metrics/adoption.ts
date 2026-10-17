import path from "node:path";
import { canonicalComponent, componentFamilies, normalizeName } from "../data/index.js";
import type { CompositionGraph, ElementKind, ElementNode, LocalComponentDecl, Location } from "../graph/types.js";
import { countNodes, walk } from "../graph/types.js";

export interface Counts {
  ds: number;
  local: number;
  html: number;
  external: number;
  total: number;
  /** (local + html) / total — the share of UI not drawn from the design system. 0 when total is 0. */
  customRatio: number;
}

export interface ComponentUsage {
  count: number;
  files: string[];
  sources: string[];
}

export interface Inventory {
  ds: Record<string, ComponentUsage>;
  local: Record<string, ComponentUsage>;
  external: Record<string, ComponentUsage>;
  html: Record<string, number>;
}

export interface OverrideFinding extends Location {
  component: string;
  prop: "className" | "style";
}

export interface SpreadFinding extends Location {
  component: string;
}

export interface LookAlikeFinding {
  /** The local component's name. */
  name: string;
  /** The design-system name it resembles. */
  dsComponent: string;
  /** 1 = same name; lower = near match. */
  score: number;
  declaredIn?: Location;
  usages: number;
}

export interface ViolationCounts {
  classNameOverrides: number;
  styleOverrides: number;
  spreadProps: number;
  lookAlikes: number;
  /** Plain HTML controls (correctUse.rawElements) written where a design-system control belongs. */
  rawElements: number;
}

export interface RawElementFinding extends Location {
  /** The tag, e.g. `button`. */
  element: string;
}

export interface AdoptionOptions {
  /** Tags counted as raw elements (default: `["button"]`). */
  rawElements?: string[];
}

export interface CorrectUse {
  overrides: OverrideFinding[];
  spreadProps: SpreadFinding[];
  lookAlikes: LookAlikeFinding[];
  rawElements: RawElementFinding[];
  counts: ViolationCounts;
}

export interface Adoption {
  /** Definition 1 of the measurement model: imports and instances, counted per element. */
  definition: "imports";
  total: Counts;
  byFile: Record<string, Counts>;
  byDir: Record<string, Counts>;
}

export interface AdoptionMetrics {
  /** Consumer files that were counted. */
  files: string[];
  /** Design-system source files that were parsed but not counted. */
  dsSourceFiles: string[];
  adoption: Adoption;
  inventory: Inventory;
  correctUse: CorrectUse;
}

function emptyCounts(): Counts {
  return { ds: 0, local: 0, html: 0, external: 0, total: 0, customRatio: 0 };
}

function bump(c: Counts, kind: ElementKind): void {
  c[kind]++;
  c.total++;
}

function finalize(c: Counts): Counts {
  c.customRatio = c.total === 0 ? 0 : Math.round(((c.local + c.html) / c.total) * 1000) / 1000;
  return c;
}

export function computeAdoption(graph: CompositionGraph, options: AdoptionOptions = {}): AdoptionMetrics {
  const rawTags = new Set(options.rawElements ?? ["button"]);
  const rawElements: RawElementFinding[] = [];
  const total = emptyCounts();
  const byFile: Record<string, Counts> = {};
  const byDir: Record<string, Counts> = {};
  const inventory: Inventory = { ds: {}, local: {}, external: {}, html: {} };
  const overrides: OverrideFinding[] = [];
  const spreadProps: SpreadFinding[] = [];
  const localUsage = new Map<string, number>();

  const record = (bucket: Record<string, ComponentUsage>, node: ElementNode) => {
    const entry = bucket[node.component] ?? { count: 0, files: [], sources: [] };
    entry.count++;
    if (!entry.files.includes(node.loc.file)) entry.files.push(node.loc.file);
    if (node.source && !entry.sources.includes(node.source)) entry.sources.push(node.source);
    bucket[node.component] = entry;
  };

  for (const file of graph.files) {
    if (file.role === "ds-source") continue;
    const fc = (byFile[file.file] ??= emptyCounts());
    const dir = path.posix.dirname(file.file);
    const dc = (byDir[dir] ??= emptyCounts());
    for (const root of file.roots) {
      walk(root, (node) => {
        bump(total, node.kind);
        bump(fc, node.kind);
        bump(dc, node.kind);
        // Only elements written as JSX children are walked: one passed in a prop
        // (render={<button />}) belongs to the component that renders it.
        if (node.kind === "html" && rawTags.has(node.component)) rawElements.push({ ...node.loc, element: node.component });
        if (node.kind === "html") inventory.html[node.component] = (inventory.html[node.component] ?? 0) + 1;
        else record(inventory[node.kind], node);
        if (node.kind === "local") localUsage.set(node.component, (localUsage.get(node.component) ?? 0) + 1);
        if (node.kind === "ds") {
          if (node.overrides.className) overrides.push({ ...node.loc, component: node.component, prop: "className" });
          if (node.overrides.style) overrides.push({ ...node.loc, component: node.component, prop: "style" });
          if (node.spread) spreadProps.push({ ...node.loc, component: node.component });
        }
      });
    }
  }
  finalize(total);
  for (const c of Object.values(byFile)) finalize(c);
  for (const c of Object.values(byDir)) finalize(c);

  const lookAlikes = findLookAlikes(graph, Object.keys(inventory.ds), localUsage);
  const counts: ViolationCounts = {
    classNameOverrides: overrides.filter((o) => o.prop === "className").length,
    styleOverrides: overrides.filter((o) => o.prop === "style").length,
    spreadProps: spreadProps.length,
    lookAlikes: lookAlikes.length,
    rawElements: rawElements.length,
  };

  return {
    files: graph.files.filter((f) => f.role === "consumer").map((f) => f.file),
    dsSourceFiles: graph.files.filter((f) => f.role === "ds-source").map((f) => f.file),
    adoption: { definition: "imports", total, byFile, byDir },
    inventory,
    correctUse: { overrides, spreadProps, lookAlikes, rawElements, counts },
  };
}

/**
 * A local component is a look-alike when it stands in for a design-system
 * component: the same name outside the DS (`Badge` next to the DS `Badge`), a
 * near-identical name, a thin wrapper whose name contains the DS name
 * (`PrimaryButton` rendering `<Button/>`), a small from-scratch rebuild under
 * such a name, or a well-known synonym (`Modal` when the DS has `Dialog`).
 * Compositions that merely use a DS component (`RenameDialog`, `StatCard`) are
 * not look-alikes.
 */
export function findLookAlikes(graph: CompositionGraph, dsNames: string[], localUsage: Map<string, number>): LookAlikeFinding[] {
  const dsRoots = new Set(dsNames.map((n) => n.split(".")[0]!));
  const dsNormalized = new Map<string, string>();
  for (const n of dsRoots) dsNormalized.set(normalizeName(n), n);
  const dsCanonical = new Map<string, string>();
  for (const n of dsRoots) {
    const c = canonicalComponent(n);
    if (c && !dsCanonical.has(c)) dsCanonical.set(c, n);
  }

  const declared = new Map<string, LocalComponentDecl>();
  for (const f of graph.files) {
    if (f.role === "ds-source") continue;
    for (const d of f.declared) if (!declared.has(d.name)) declared.set(d.name, d);
  }
  const localNames = new Set<string>([...declared.keys(), ...[...localUsage.keys()].map((n) => n.split(".")[0]!)]);

  const findings: LookAlikeFinding[] = [];
  for (const name of [...localNames].sort()) {
    const match = matchLookAlike(name, declared.get(name), dsNormalized, dsCanonical);
    if (!match) continue;
    const finding: LookAlikeFinding = { name, dsComponent: match.dsComponent, score: match.score, usages: localUsage.get(name) ?? 0 };
    const loc = declared.get(name)?.loc;
    if (loc) finding.declaredIn = loc;
    findings.push(finding);
  }
  return findings;
}

function matchLookAlike(
  name: string,
  decl: LocalComponentDecl | undefined,
  dsNormalized: Map<string, string>,
  dsCanonical: Map<string, string>,
): { dsComponent: string; score: number } | undefined {
  const n = normalizeName(name);
  const exact = dsNormalized.get(n);
  if (exact) return { dsComponent: exact, score: 1 };

  const root = decl?.root ?? null;
  const rootCanonical = root && root.kind !== "html" ? canonicalComponent(root.component) : undefined;
  const size = root ? countNodes(root) : Infinity;

  let best: { dsComponent: string; score: number } | undefined;
  for (const [dn, original] of dsNormalized) {
    if (dn.length < 4) continue;
    let score = 0;
    const sim = similarity(n, dn);
    if (sim >= 0.85) score = Math.round(sim * 100) / 100;
    else if (n.endsWith(dn) || n.startsWith(dn)) {
      const dsCanon = canonicalComponent(original);
      // Thin wrapper: renders that DS component directly (at most one child).
      if (root && root.kind === "ds" && rootCanonical !== undefined && rootCanonical === dsCanon && size <= 2) score = 0.8;
      // Rebuilt from scratch: a small tree of html / local elements under a DS-like name.
      else if (root && root.kind !== "ds" && size <= 3 && !hasDsNode(root)) score = 0.7;
    }
    if (score > 0 && (!best || score > best.score)) best = { dsComponent: original, score };
  }
  if (best) return best;

  // The whole name is a known synonym (Modal -> Dialog) and the DS has that component.
  const aliases = componentFamilies().aliases;
  const aliasHit = Object.entries(aliases).find(([alias]) => normalizeName(alias) === n);
  if (aliasHit) {
    const dsName = dsCanonical.get(aliasHit[1]);
    if (dsName && root && root.kind !== "ds") return { dsComponent: dsName, score: 0.7 };
  }
  return undefined;
}

function hasDsNode(node: ElementNode): boolean {
  let found = false;
  walk(node, (n) => {
    if (n.kind === "ds") found = true;
  });
  return found;
}

function similarity(a: string, b: string): number {
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length, 1);
}

function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}
