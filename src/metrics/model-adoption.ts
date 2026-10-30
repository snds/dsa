import path from "node:path";
import type { DsaConfig } from "../config.js";
import { canonicalComponent, componentFamilies, normalizeName } from "../data/index.js";
import type { Concept, Element, RepoReading } from "../model/index.js";
import type { AdoptionMetrics, ComponentUsage, Counts, Inventory, LookAlikeFinding, OverrideFinding, RawElementFinding, SpreadFinding } from "./adoption.js";

/**
 * Adoption and correct use from the system model, in the scan report's shape. Every element in a
 * consumer file is one of:
 *   ds        it is a use of a system concept (by import, tag, attribute, class or macro)
 *   local     a component tag the file declares or imports from inside the repo
 *   external  a component tag or custom element from somewhere else
 *   html      a native element with no system marker
 * Files in the system's own source (other than stories, examples, docs and tests) are composition,
 * not adoption, and are left out, as are elements written as a prop's value.
 */
export function adoptionFromReading(reading: RepoReading, config: DsaConfig): AdoptionMetrics {
  const rawTags = new Set(config.correctUse.rawElements);
  const component = new Map(reading.concepts.map((c) => [c.key, c]));
  const nameOf = (key: string, part?: string) => `${component.get(key)?.name ?? key}${part ? `.${part}` : ""}`;
  const total = empty();
  const byFile: Record<string, Counts> = {};
  const byDir: Record<string, Counts> = {};
  const inventory: Inventory = { ds: {}, local: {}, external: {}, html: {} };
  const overrides: OverrideFinding[] = [];
  const spreadProps: SpreadFinding[] = [];
  const rawElements: RawElementFinding[] = [];
  const localUsage = new Map<string, number>();
  const consumerFiles: string[] = [];

  const record = (bucket: Record<string, ComponentUsage>, name: string, file: string, source?: string) => {
    const e = (bucket[name] ??= { count: 0, files: [], sources: [] });
    e.count++;
    if (!e.files.includes(file)) e.files.push(file);
    if (source && !e.sources.includes(source)) e.sources.push(source);
  };

  for (const f of reading.files) {
    if (f.internal) continue;
    consumerFiles.push(f.file);
    const file = f.file.replace(/\\/g, "/");
    const fc = (byFile[file] ??= empty());
    const dc = (byDir[path.posix.dirname(file)] ??= empty());
    const declaredHere = new Set(f.declared.map((d) => d.name));
    for (const { element: el, uses } of f.elements) {
      if (el.inAttribute) continue;
      const loc = { file, line: el.line, column: el.column ?? 1 };
      const kind = uses.some((u) => component.get(u.concept)?.role !== "style") ? "ds" : kindOf(el, declaredHere);
      for (const c of [total, fc, dc]) bump(c, kind);
      if (kind === "ds") {
        for (const u of uses) {
          if (component.get(u.concept)?.role === "style") continue;
          const name = nameOf(u.concept, u.part);
          record(inventory.ds, name, file, el.importSource ?? u.form);
          // Overrides on a component written as a component (a class-based use is styled by its classes).
          if (u.form !== "class" && u.form !== "macro") {
            if ("className" in el.attributes || ("class" in el.attributes && u.form !== "selector")) overrides.push({ ...loc, component: name, prop: "className" });
            if ("style" in el.attributes || "sx" in el.attributes || "css" in el.attributes) overrides.push({ ...loc, component: name, prop: "style" });
          }
          if (el.spread) spreadProps.push({ ...loc, component: name });
        }
      } else if (kind === "html") {
        inventory.html[el.tag] = (inventory.html[el.tag] ?? 0) + 1;
        if (rawTags.has(el.tag)) rawElements.push({ ...loc, element: el.tag });
      } else {
        record(inventory[kind], el.tag, file, el.importSource);
        if (kind === "local") localUsage.set(el.tag.split(".")[0]!, (localUsage.get(el.tag.split(".")[0]!) ?? 0) + 1);
      }
    }
  }
  for (const c of [total, ...Object.values(byFile), ...Object.values(byDir)]) finalize(c);

  const lookAlikes = findModelLookAlikes(reading, localUsage);
  return {
    files: consumerFiles,
    dsSourceFiles: reading.files.filter((f) => f.internal).map((f) => f.file),
    adoption: { definition: "imports", total, byFile, byDir },
    inventory,
    correctUse: {
      overrides,
      spreadProps,
      lookAlikes,
      rawElements,
      counts: {
        classNameOverrides: overrides.filter((o) => o.prop === "className").length,
        styleOverrides: overrides.filter((o) => o.prop === "style").length,
        spreadProps: spreadProps.length,
        lookAlikes: lookAlikes.length,
        rawElements: rawElements.length,
      },
    },
  };
}

function kindOf(el: Element, declaredHere: Set<string>): "local" | "external" | "html" {
  const componentTag = /^[A-Z]/.test(el.tag) || el.tag.includes(".");
  if (!componentTag) return el.tag.includes("-") || el.macro ? "external" : "html";
  if (el.importSource === undefined) return declaredHere.has(el.tag.split(".")[0]!) ? "local" : "external";
  return /^(\.|@\/|~\/|#|\$lib)/.test(el.importSource) ? "local" : "external";
}

/**
 * A local component stands in for a system component when it has the same or a near-identical name,
 * is a thin wrapper whose name contains the system's name and renders that component, is a small
 * from-scratch rebuild under such a name, or carries a well-known synonym (Modal for Dialog).
 */
function findModelLookAlikes(reading: RepoReading, localUsage: Map<string, number>): LookAlikeFinding[] {
  const concepts = reading.concepts.filter((c) => c.role !== "style");
  const byNorm = new Map<string, Concept>();
  for (const c of concepts) for (const n of [c.name, c.key]) if (!byNorm.has(normalizeName(n))) byNorm.set(normalizeName(n), c);
  const canonical = new Map<string, Concept>();
  for (const c of concepts) { const k = canonicalComponent(c.name); if (k && !canonical.has(k)) canonical.set(k, c); }
  const aliases = componentFamilies().aliases;

  const out: LookAlikeFinding[] = [];
  const seen = new Set<string>();
  for (const f of reading.files) {
    if (f.inSource) continue;
    for (const d of f.declared) {
      if (seen.has(d.name)) continue;
      seen.add(d.name);
      const n = normalizeName(d.name);
      const rootUses = d.root ? reading.match(d.root, f.file).filter((u) => byNorm.has(u.concept) || concepts.some((c) => c.key === u.concept)) : [];
      const rootIsSystem = rootUses.length > 0;
      let best: { c: Concept; score: number } | undefined;
      const exact = byNorm.get(n);
      if (exact) best = { c: exact, score: 1 };
      else for (const c of concepts) {
        const dn = normalizeName(c.name);
        if (dn.length < 4) continue;
        let score = 0;
        const sim = similarity(n, dn);
        if (sim >= 0.85) score = Math.round(sim * 100) / 100;
        else if (n.endsWith(dn) || n.startsWith(dn)) {
          if (rootIsSystem && rootUses.some((u) => u.concept === c.key) && d.size <= 2) score = 0.8; // thin wrapper
          else if (!rootIsSystem && d.size <= 3) score = 0.7; // small rebuild
        }
        if (score > 0 && (!best || score > best.score)) best = { c, score };
      }
      if (!best) {
        const hit = Object.entries(aliases).find(([alias]) => normalizeName(alias) === n);
        const c = hit ? canonical.get(hit[1]) : undefined;
        if (c && !rootIsSystem) best = { c, score: 0.7 };
      }
      if (best) out.push({ name: d.name, dsComponent: best.c.name, score: best.score, usages: localUsage.get(d.name) ?? 0, declaredIn: { file: d.file.replace(/\\/g, "/"), line: d.line, column: 1 } });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function empty(): Counts {
  return { ds: 0, local: 0, html: 0, external: 0, total: 0, customRatio: 0 };
}
function bump(c: Counts, kind: "ds" | "local" | "external" | "html") {
  c[kind]++;
  c.total++;
}
// Same definition as the graph's: share of elements that aren't system or external components.
function finalize(c: Counts) {
  c.customRatio = c.total === 0 ? 0 : Math.round(((c.local + c.html) / c.total) * 1000) / 1000;
}
function similarity(a: string, b: string): number {
  const m = a.length, n = b.length;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[n]! / Math.max(m, n, 1);
}
