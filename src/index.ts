/**
 * @snds/dsa — design-system analytics.
 *
Public API: `scan`, `detectPatterns` (alias of `patterns`), `ratchet`, the
 * graph builder, and the types every report is made of.
 */
export { scan, type ScanReport } from "./scan.js";
export { patterns, patterns as detectPatterns, type PatternsOptions, type PatternsReport } from "./patterns.js";
export { ratchet, type RatchetOptions, type RatchetReport, type Baseline, type RatchetAction } from "./ratchet.js";
export { createRunContext, loadRunContext, type RunOptions, type RunContext, type ReportMeta } from "./run.js";
export { scanFromContext } from "./scan.js";
export { patternsFromContext } from "./patterns.js";
export { ratchetFromContext } from "./ratchet.js";
export { migrateSuiteConfig, isSuiteConfig, CONFIG_SCHEMA_URL, type MigrateResult, type MigrateOptions } from "./migrate.js";
export { ConfigSchema, loadConfig, findConfigFile, parseConfig, CONFIG_FILENAME, type DsaConfig, type DsaConfigInput, type LoadedConfig } from "./config.js";
export { buildGraph, listSourceFiles, reactAdapter, adapterFor, type CompositionGraph, type FileGraph, type Framework, type ElementNode, type ElementKind, type Location, type LocalComponentDecl, type ImportBinding, type SourceAdapter, type ReaderContext, type FileReader } from "./graph/index.js";
export { defineProfile, resolveProfile, loadProfile, isProfileSource, NEUTRAL_PROFILE, type DsaProfile, type ResolvedProfile, type ComponentEntry, type RoleOffer, type ProfileFiles, type ReadinessProvider, type ReadinessRow, type AgentProfile } from "./profile.js";
export { detectPatterns as detectPatternsInGraph, type SuggestionRecord, type Tier, type NearestExisting, type ParkedRecord, type PatternsSummary, type DetectPatternsInput, type DetectPatternsOutput } from "./detect/patterns.js";
export { toAnatomy, anatomyId, serializeAnatomy, renderAnatomy, type AnatomyNode, type AnatomyKind } from "./detect/anatomy.js";
export { loadDecisions, saveDecisions, ignoreCandidate, type DecisionsFile, type Decision, type DecisionStatus } from "./detect/decisions.js";
export { computeAdoption, findLookAlikes, type AdoptionMetrics, type Adoption, type Counts, type Inventory, type ComponentUsage, type CorrectUse, type OverrideFinding, type SpreadFinding, type LookAlikeFinding, type RawElementFinding, type AdoptionOptions, type ViolationCounts } from "./metrics/adoption.js";
export { componentFamilies, patternCatalog, canonicalComponent, familyOf, catalogComponentNames, type Family, type CatalogPattern } from "./data/index.js";
export { formatScan, formatPatterns, formatRatchet, table } from "./report/text.js";
export { createProgram, type CliIo } from "./cli.js";
export { dsaVersion } from "./version.js";
export * as schemas from "./schema/index.js";
export { defineAddon, findAddons, loadAddons, runAfterHooks, type DsaAddon, type AddonApi, type FoundAddon, type AfterRunHook, type AfterRunContext, type ServeRequest, type ServeRoute } from "./addons.js";
export { engineContext, useAddons, type EngineGlobals } from "./cli-engine.js";
export { STORE_SCHEMA, STORE_MIGRATIONS, STORE_TABLES, registerStore, openStore, hasStore, MissingStoreError, type Store, type StoreFactory } from "./engine/store.js";
export { runPipeline, reevaluateElements, type PipelineStage, type StageContext, type RunOptions as EngineRunOptions, type RunResult as EngineRunResult } from "./engine/pipeline.js";
export { engineConfig, engineExcludes, loadEngineContext, type EngineContext, type EngineContextOptions } from "./engine/from-dsa.js";
export { useSystem, system, type EngineSystem } from "./engine/system.js";
export { resolveHostRoot } from "./engine/paths.js";
export type { Config as EngineConfig } from "./engine/config.js";
export type { Finding, Target, Instance, Lookalike, VersionRow, TokenRow } from "./engine/types.js";
export type { ElementEval } from "./engine/elements.js";
