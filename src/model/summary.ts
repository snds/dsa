import path from "node:path";
import type { DsaConfig } from "../config.js";
import { discoverSources } from "./discover.js";
import type { RepoReading } from "./index.js";
import type { Tier } from "./types.js";

/**
 * What the dashboard shows about the system itself: where its code was found and how sure that is, its
 * inventory (components only; parts and icons counted apart), each component's kind, variants, parts,
 * tokens and uses, and how each fact was established. Written once per scan beside the run's data.
 */
export interface ModelSummary {
  sources: { how: string; threshold: number; read: string[]; candidates: { dir: string; confidence: number; because?: string | undefined; why: string[] }[] };
  counts: { components: number; parts: number; icons: number; styles: number; tokens: number };
  components: {
    key: string; name: string; library?: string | undefined;
    kind?: { kind: string; confidence: number; ambiguous?: boolean | undefined } | undefined;
    axes: { name: string; values: string[] }[]; parts: string[]; tokens: number;
    /** The most reliable way it was found, and where. */
    evidence: { tier: Tier; extractor: string; file: string; line?: number | undefined };
    /** Known only because consumers write it; nothing in the system's source declares it. */
    inferred: boolean;
    uses: { consumer: number; internal: number; files: number; byTarget?: Record<string, { consumer: number; files: number }> | undefined };
  }[];
  tokens: { byGroup: Record<string, number>; byTier: Record<string, number>; boundComponents: number };
}

const TIER_ORDER: Tier[] = ["manifest", "declaration", "export", "style", "convention"];

/**
 * `targets` (the apps and child libraries, with their folders) splits each component's consumer uses by
 * app, so the dashboard's app selector can show one app's uses. A file outside every target is in no app.
 */
export function modelSummary(reading: RepoReading, root: string, config: DsaConfig, targets: { name: string; dir: string }[] = []): ModelSummary {
  let sources: ModelSummary["sources"];
  try {
    const d = discoverSources(root, config);
    // Package names dsa filled in from discovery read as "expected": say it was found.
    const how = (config.system as { discovered?: boolean }).discovered && d.how === "expected" ? "discovered" : d.how;
    sources = { how, threshold: d.threshold, read: reading.sources, candidates: d.candidates.slice(0, 10).map((c) => ({ dir: c.dir, confidence: c.confidence, because: c.because, why: c.signals.filter((s) => s.score > 0).sort((a, b) => b.weight * b.score - a.weight * a.score).slice(0, 3).map((s) => s.detail) })) };
  } catch {
    sources = { how: "unknown", threshold: 0.9, read: reading.sources, candidates: [] };
  }
  // Uses per concept, a part's uses counted for its component.
  const owner = new Map(reading.concepts.map((c) => [c.key, c.role === "part" && c.partOf ? c.partOf : c.key]));
  const uses = new Map<string, { consumer: number; internal: number; files: Set<string>; byTarget: Map<string, { consumer: number; files: Set<string> }> }>();
  // The deepest target folder holding a file names its app (a child library inside the root is its own).
  const dirs = targets.map((t) => ({ name: t.name, dir: path.resolve(root, t.dir) })).filter((t) => t.dir !== path.resolve(root)).sort((a, b) => b.dir.length - a.dir.length);
  const appOf = (file: string) => { const abs = path.resolve(root, file); return dirs.find((t) => abs === t.dir || abs.startsWith(t.dir + path.sep))?.name; };
  for (const f of reading.files) {
    const app = appOf(f.file);
    for (const e of f.elements) for (const u of e.uses) {
      const k = owner.get(u.concept) ?? u.concept;
      const x = uses.get(k) ?? { consumer: 0, internal: 0, files: new Set<string>(), byTarget: new Map() };
      if (u.internal) x.internal++;
      else {
        x.consumer++; x.files.add(f.file);
        if (app) { const t = x.byTarget.get(app) ?? { consumer: 0, files: new Set<string>() }; t.consumer++; t.files.add(f.file); x.byTarget.set(app, t); }
      }
      uses.set(k, x);
    }
  }
  const components = reading.concepts.filter((c) => c.role === "component").map((c) => {
    const best = [...c.realizations].sort((a, b) => TIER_ORDER.indexOf(a.evidence.tier) - TIER_ORDER.indexOf(b.evidence.tier))[0]!;
    const u = uses.get(c.key);
    return {
      key: c.key, name: c.name, library: c.library,
      ...(c.kind ? { kind: { kind: c.kind.kind, confidence: c.kind.confidence, ...(c.kind.ambiguous ? { ambiguous: true } : {}) } } : {}),
      axes: (c.axes ?? []).map((a) => ({ name: a.name, values: a.values })),
      parts: (c.parts ?? []).map((p) => p.name),
      tokens: c.tokens?.length ?? 0,
      evidence: { tier: best.evidence.tier, extractor: best.evidence.extractor, file: best.evidence.file, line: best.evidence.line },
      inferred: c.realizations.every((r) => r.evidence.file.startsWith("(")),
      uses: { consumer: u?.consumer ?? 0, internal: u?.internal ?? 0, files: u?.files.size ?? 0, byTarget: Object.fromEntries([...(u?.byTarget ?? [])].map(([n, t]) => [n, { consumer: t.consumer, files: t.files.size }])) },
    };
  }).sort((a, b) => b.uses.consumer - a.uses.consumer || a.name.localeCompare(b.name));
  const byGroup: Record<string, number> = {}, byTier: Record<string, number> = {};
  for (const t of reading.tokens) { byGroup[t.group] = (byGroup[t.group] ?? 0) + 1; byTier[t.tier] = (byTier[t.tier] ?? 0) + 1; }
  const count = (role: string) => reading.concepts.filter((c) => c.role === role).length;
  return {
    sources,
    counts: { components: components.length, parts: count("part"), icons: count("icon"), styles: count("style"), tokens: reading.tokens.length },
    components,
    tokens: { byGroup, byTier, boundComponents: reading.concepts.filter((c) => c.role === "component" && c.tokens?.length).length },
  };
}
