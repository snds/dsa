/**
 * @snds/dsa — design-system analytics.
 *
 * Public API: `scan`, `detectPatterns` (alias of `patterns`), `ratchet`, the
 * graph builder, and the types every report is made of.
 */
export { scan, type ScanReport } from "./scan.js";
export { patterns, patterns as detectPatterns, type PatternsOptions, type PatternsReport } from "./patterns.js";
export { ratchet, type RatchetOptions, type RatchetReport, type Baseline, type RatchetAction } from "./ratchet.js";
export { createRunContext, type RunOptions, type RunContext, type ReportMeta } from "./run.js";
export { ConfigSchema, loadConfig, findConfigFile, parseConfig, CONFIG_FILENAME, type DsaConfig, type DsaConfigInput, type LoadedConfig } from "./config.js";
export { buildGraph, listSourceFiles, reactAdapter, adapterFor, type CompositionGraph, type FileGraph, type Framework, type ElementNode, type ElementKind, type Location, type LocalComponentDecl, type ImportBinding, type SourceAdapter, type ReaderContext, type FileReader } from "./graph/index.js";
export { defineProfile, resolveProfile, loadProfile, isProfileSource, NEUTRAL_PROFILE, type DsaProfile, type ResolvedProfile, type ComponentEntry, type RoleOffer, type ProfileFiles, type ReadinessProvider, type ReadinessRow } from "./profile.js";
export { detectPatterns as detectPatternsInGraph, type SuggestionRecord, type Tier, type NearestExisting, type ParkedRecord, type PatternsSummary, type DetectPatternsInput, type DetectPatternsOutput } from "./detect/patterns.js";
export { toAnatomy, anatomyId, serializeAnatomy, renderAnatomy, type AnatomyNode, type AnatomyKind } from "./detect/anatomy.js";
export { loadDecisions, saveDecisions, ignoreCandidate, type DecisionsFile, type Decision, type DecisionStatus } from "./detect/decisions.js";
export { computeAdoption, findLookAlikes, type AdoptionMetrics, type Adoption, type Counts, type Inventory, type ComponentUsage, type CorrectUse, type OverrideFinding, type SpreadFinding, type LookAlikeFinding, type RawElementFinding, type AdoptionOptions, type ViolationCounts } from "./metrics/adoption.js";
export { componentFamilies, patternCatalog, canonicalComponent, familyOf, catalogComponentNames, type Family, type CatalogPattern } from "./data/index.js";
export { formatScan, formatPatterns, formatRatchet, table } from "./report/text.js";
export { createProgram, type CliIo } from "./cli.js";
export { dsaVersion } from "./version.js";
export * as schemas from "./schema/index.js";
