import path from "node:path";
import type { DsaConfig } from "../config.js";
import { familyOf } from "../data/index.js";
import type { CompositionGraph, ElementNode, Location } from "../graph/types.js";
import { anatomyId, anatomyNodes, toAnatomy, type AnatomyNode } from "./anatomy.js";
import type { DecisionsFile } from "./decisions.js";
import { suggestName } from "./naming.js";
import { distinctFamilies, nearestCatalogPattern, nearestLocalComponent, round, type Match } from "./similarity.js";

export type Tier = "pattern" | "compound-component" | "variant" | "snowflake";

export interface NearestExisting {
  name: string;
  score: number;
  /** Where the match came from: the framework pattern catalog or a component already named in the repo. */
  source: "catalog" | "local";
}

export interface SuggestionRecord {
  /** Stable hash of the anatomy. */
  id: string;
  /** Candidate name by intent, e.g. FilterBar, FormDialog. */
  name: string;
  anatomy: AnatomyNode;
  occurrences: Location[];
  /** Distinct hosts (files by default). */
  hosts: string[];
  tier: Tier;
  /** 0..1 */
  confidence: number;
  nearestExisting?: NearestExisting;
  /** One plain sentence. */
  reason: string;
}

export interface ParkedRecord {
  id: string;
  name: string;
  ignoredTimes: number;
}

export interface PatternsSummary {
  candidates: number;
  byTier: Record<Tier, number>;
  compositionsSeen: number;
  parked: number;
}

export interface DetectPatternsInput {
  graph: CompositionGraph;
  config: DsaConfig;
  /** Include snowflakes (below the occurrence / host bar). */
  all?: boolean;
  decisions?: DecisionsFile;
}

export interface DetectPatternsOutput {
  candidates: SuggestionRecord[];
  parked: ParkedRecord[];
  summary: PatternsSummary;
}

interface Instance {
  id: string;
  anatomy: AnatomyNode;
  loc: Location;
  host: string;
  ancestorIds: string[];
}

interface Group {
  id: string;
  anatomy: AnatomyNode;
  instances: Instance[];
}

export function detectPatterns(input: DetectPatternsInput): DetectPatternsOutput {
  const { graph, config } = input;
  const p = config.patterns;
  const hostOf = (loc: Location) => (config.hosts.by === "dir" ? path.posix.dirname(loc.file) : loc.file);

  // 1. Every subtree with enough components is a composition instance, keyed by anatomy hash.
  const groups = new Map<string, Group>();
  const visit = (node: ElementNode, ancestorIds: string[]) => {
    if (node.kind === "external") {
      for (const c of node.children) visit(c, ancestorIds);
      return;
    }
    const anatomy = toAnatomy(node)[0]!;
    const componentCount = anatomyNodes(anatomy).filter((n) => n.kind !== "html").length;
    let nextAncestors = ancestorIds;
    if (componentCount >= p.minComponents) {
      const id = anatomyId(anatomy);
      const group = groups.get(id) ?? { id, anatomy, instances: [] };
      group.instances.push({ id, anatomy, loc: node.loc, host: hostOf(node.loc), ancestorIds });
      groups.set(id, group);
      nextAncestors = [...ancestorIds, id];
    }
    for (const c of node.children) visit(c, nextAncestors);
  };
  const consumerFiles = graph.files.filter((f) => f.role === "consumer");
  for (const file of consumerFiles) for (const root of file.roots) visit(root, []);

  // 2. A composition that only ever appears inside one bigger repeated composition
  //    is part of that composition, not a candidate of its own.
  const dominated = new Set<string>();
  for (const g of groups.values()) {
    for (const other of groups.values()) {
      if (other.id === g.id || other.instances.length < g.instances.length) continue;
      if (g.instances.every((i) => i.ancestorIds.includes(other.id))) {
        dominated.add(g.id);
        break;
      }
    }
  }

  // 3. Already-named local components, for nearest-existing matching.
  const locals = consumerFiles.flatMap((f) =>
    f.declared.flatMap((d) => {
      if (!d.root) return [];
      const anatomy = toAnatomy(d.root)[0];
      return anatomy ? [{ name: d.name, anatomy }] : [];
    }),
  );

  const parkedIds = new Map<string, { name?: string; ignoredTimes: number }>();
  for (const [id, d] of Object.entries(input.decisions?.decisions ?? {})) {
    if (d.status === "parked") parkedIds.set(id, { ignoredTimes: d.ignoredTimes, ...(d.name ? { name: d.name } : {}) });
  }

  // 4. Classify.
  const records: SuggestionRecord[] = [];
  const parked: ParkedRecord[] = [];
  for (const g of groups.values()) {
    if (dominated.has(g.id)) continue;
    const occurrences = g.instances.map((i) => i.loc).sort(compareLoc);
    const hosts = [...new Set(g.instances.map((i) => i.host))].sort();
    const qualifies = occurrences.length >= p.minOccurrences && hosts.length >= p.minHosts;
    if (!qualifies && !input.all) continue;
    const record = classify(g.anatomy, g.id, occurrences, hosts, qualifies, config, locals);
    const park = parkedIds.get(g.id);
    if (park) {
      parked.push({ id: g.id, name: park.name ?? record.name, ignoredTimes: park.ignoredTimes });
      continue;
    }
    records.push(record);
  }

  records.sort(compareRecords);
  dedupeNames(records);

  const byTier: Record<Tier, number> = { pattern: 0, "compound-component": 0, variant: 0, snowflake: 0 };
  for (const r of records) byTier[r.tier]++;
  return {
    candidates: records,
    parked,
    summary: { candidates: records.length, byTier, compositionsSeen: groups.size, parked: parked.length },
  };
}

function classify(
  anatomy: AnatomyNode,
  id: string,
  occurrences: Location[],
  hosts: string[],
  qualifies: boolean,
  config: DsaConfig,
  locals: { name: string; anatomy: AnatomyNode }[],
): SuggestionRecord {
  const p = config.patterns;
  const nodes = anatomyNodes(anatomy);
  const componentNodes = nodes.filter((n) => n.kind !== "html");
  const dsNodes = nodes.filter((n) => n.kind === "ds");
  const allDs = anatomy.kind === "ds" && componentNodes.length === dsNodes.length && nodes.every((n) => n.kind === "ds");
  const families = distinctFamilies(anatomy);
  const rootFamily = anatomy.kind === "html" ? undefined : familyOf(anatomy.component);
  const hostWord = config.hosts.by === "dir" ? "directories" : "files";
  const occ = occurrences.length;

  // Tier heuristic, as the contract states it.
  let tier: Tier;
  let reason: string;
  if (!qualifies) {
    tier = "snowflake";
    reason = `Seen ${occ} time${occ === 1 ? "" : "s"} in ${hosts.length} ${hosts.length === 1 ? "file" : hostWord}; a candidate needs ${p.minOccurrences}+ occurrences across ${p.minHosts}+ hosts, so this stays host-local.`;
  } else if (families.length >= 2) {
    tier = "pattern";
    reason = `${componentNodes.length} components from ${families.length} families (${families.join(", ")}) repeat ${occ} times across ${hosts.length} ${hostWord}.`;
  } else if (nodes.length <= 3) {
    tier = "compound-component";
    reason = `${anatomy.component} with ${nodes.length - 1} ${families[0] ?? "related"} child${nodes.length === 2 ? "" : "ren"} repeats ${occ} times across ${hosts.length} ${hostWord}: small and single-family, so a compound component.`;
  } else if (allDs) {
    tier = "variant";
    reason = `${anatomy.component} with only design-system children in one family (${families[0] ?? rootFamily ?? "unknown"}) repeats ${occ} times across ${hosts.length} ${hostWord}: a variant or usage of ${anatomy.component}, not a new pattern.`;
  } else {
    tier = "pattern";
    reason = `${componentNodes.length} components in one family (${families[0] ?? "unknown"}) under a ${anatomy.kind} ${anatomy.component} repeat ${occ} times across ${hosts.length} ${hostWord}.`;
  }

  // Nearest existing: the framework catalog or a component the repo already named.
  const catalog = nearestCatalogPattern(anatomy);
  const local = nearestLocalComponent(anatomy, locals);
  const best = [catalog, local].filter((m): m is Match => m !== undefined).sort((a, b) => b.score - a.score)[0];
  const nearest = best && best.score >= 0.35 ? best : undefined;

  // Naming: an anatomy identical to a component the repo already named keeps
  // that name; a close catalog match takes the catalog's name; otherwise derive one.
  let name: string;
  if (local && local.score >= 1) name = local.name;
  else if (catalog && catalog.score >= 0.6) name = catalog.name;
  else name = suggestName(anatomy);

  const occScore = Math.min(occ / (p.minOccurrences * 2), 1);
  const hostScore = Math.min(hosts.length / (p.minHosts * 2), 1);
  const dsShare = componentNodes.length === 0 ? 0 : dsNodes.length / componentNodes.length;
  const sizeScore = Math.min(componentNodes.length / 4, 1);
  let confidence = round(0.3 * occScore + 0.25 * hostScore + 0.3 * dsShare + 0.15 * sizeScore);
  if (tier === "snowflake") confidence = Math.min(confidence, 0.3);

  const record: SuggestionRecord = { id, name, anatomy, occurrences, hosts, tier, confidence, reason };
  if (nearest) record.nearestExisting = { name: nearest.name, score: nearest.score, source: nearest.source };
  return record;
}

const TIER_ORDER: Record<Tier, number> = { pattern: 0, "compound-component": 1, variant: 2, snowflake: 3 };

function compareRecords(a: SuggestionRecord, b: SuggestionRecord): number {
  return (
    TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
    b.occurrences.length - a.occurrences.length ||
    b.hosts.length - a.hosts.length ||
    b.confidence - a.confidence ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

function compareLoc(a: Location, b: Location): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
}

/** Two different anatomies can earn the same name; number the later ones. */
function dedupeNames(records: SuggestionRecord[]): void {
  const seen = new Map<string, number>();
  for (const r of records) {
    const n = seen.get(r.name) ?? 0;
    seen.set(r.name, n + 1);
    if (n > 0) r.name = `${r.name}${n + 1}`;
  }
}
