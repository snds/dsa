import fs from "node:fs";

/**
 * The two data files ship next to the package (`data/`), so the same relative
 * path works from `src/` (vitest) and from `dist/` (built).
 */
function readJson<T>(name: string): T {
  const url = new URL(`../../data/${name}`, import.meta.url);
  return JSON.parse(fs.readFileSync(url, "utf8")) as T;
}

export type Family =
  | "Action"
  | "Form"
  | "Navigation"
  | "Feedback"
  | "Data Display"
  | "Layout"
  | "Overlay"
  | "Disclosure"
  | "Content";

export interface ComponentFamiliesData {
  families: Family[];
  components: Record<string, Family>;
  aliases: Record<string, string>;
}

export interface CatalogPattern {
  id: string;
  name: string;
  candidateName: string;
  job: string;
  composition: string;
  components: string[];
  families: Family[];
}

export interface PatternCatalogData {
  patterns: CatalogPattern[];
}

let familiesCache: ComponentFamiliesData | undefined;
let catalogCache: PatternCatalogData | undefined;

export function componentFamilies(): ComponentFamiliesData {
  if (!familiesCache) {
    const raw = readJson<ComponentFamiliesData & { $comment?: string }>("component-families.json");
    const aliases = { ...raw.aliases } as Record<string, string>;
    delete aliases["$comment"];
    familiesCache = { families: raw.families, components: raw.components, aliases };
  }
  return familiesCache;
}

export function patternCatalog(): PatternCatalogData {
  if (!catalogCache) {
    const raw = readJson<PatternCatalogData & { $comment?: string }>("pattern-catalog.json");
    catalogCache = { patterns: raw.patterns };
  }
  return catalogCache;
}

/** "Alert Dialog" / "AlertDialog" / "alert-dialog" / "Dialog.Title" -> "alertdialog" / "dialogtitle". */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface NameIndex {
  byNormalized: Map<string, string>;
  keysByLength: string[];
}

let indexCache: NameIndex | undefined;

function nameIndex(): NameIndex {
  if (!indexCache) {
    const data = componentFamilies();
    const byNormalized = new Map<string, string>();
    for (const canonical of Object.keys(data.components)) byNormalized.set(normalizeName(canonical), canonical);
    for (const [alias, canonical] of Object.entries(data.aliases)) {
      if (!byNormalized.has(normalizeName(alias))) byNormalized.set(normalizeName(alias), canonical);
    }
    const keysByLength = [...byNormalized.keys()].sort((a, b) => b.length - a.length);
    indexCache = { byNormalized, keysByLength };
  }
  return indexCache;
}

/**
 * Map a component name to the canonical catalog component it most likely is.
 * Exact match first, then the longest catalog name that is a prefix of it
 * (DialogContent -> Dialog, AlertDialogAction -> Alert Dialog), then the longest
 * suffix (PrimaryButton -> Button). Returns undefined for names that match nothing.
 */
export function canonicalComponent(name: string): string | undefined {
  const idx = nameIndex();
  const n = normalizeName(name);
  if (n.length === 0) return undefined;
  const exact = idx.byNormalized.get(n);
  if (exact) return exact;
  // Short names (3 chars or fewer) are too ambiguous for partial matching.
  if (n.length <= 3) return undefined;
  for (const key of idx.keysByLength) {
    if (key.length >= 3 && n.startsWith(key)) return idx.byNormalized.get(key);
  }
  for (const key of idx.keysByLength) {
    if (key.length >= 4 && n.endsWith(key)) return idx.byNormalized.get(key);
  }
  return undefined;
}

export function familyOf(name: string): Family | undefined {
  const canonical = canonicalComponent(name);
  return canonical ? componentFamilies().components[canonical] : undefined;
}

/** Canonical names of all 62 components, in catalog order. */
export function catalogComponentNames(): string[] {
  return Object.keys(componentFamilies().components);
}
