// Shared shapes. Kept deliberately small: every table in the store maps to one of these.

export type Scope = 'core' | 'child' | 'consumer' | 'triage';
export type Severity = 'crit' | 'serious' | 'warn' | 'watch';
export type Framework = 'react' | 'vue' | 'angular' | 'unknown';

/** A library the system ships: core, or a federated child library. */
export interface LibraryDef {
  name: string;
  /** npm package names published by this library (one per framework, plus tokens). */
  packages: string[];
  /** Path to the library's source inside the host repo (optional). */
  path?: string | undefined;
  /**
   * Element tag prefixes this library owns, e.g. "ds-" for <ds-button> (Angular selectors,
   * globally registered Vue components, web components). The rest of the tag becomes the
   * component name: ds-data-table -> DataTable.
   */
  tagPrefixes?: string[] | undefined;
  owner?: string | undefined;
  /** GitHub repo "owner/name" that receives this library's issues. */
  repo?: string | undefined;
  /** Where the code lives when it isn't inside the host repo: a git URL cloned into <data>/remotes. Used when `path` is missing or `--remote` is passed. */
  git?: { url: string; ref?: string | undefined } | undefined;
  /** Import aliases beyond tsconfig "paths", e.g. { "@/": "src/" } (relative to this target). */
  aliases?: Record<string, string> | undefined;
  /** Paths to skip, relative to this target (vendored copies, generated code). */
  exclude?: string[] | undefined;
  /** A file holding the core commit SHA this target is pinned to (e.g. "core.pin"). Currency is then measured in days/commits behind core's main. */
  pin?: { file: string } | undefined;
  /** Core only: the ref treated as "latest" for pin currency (default origin/main, then main). */
  mainRef?: string | undefined;
}

export interface ConsumerDef {
  name: string;
  path: string;
  owner?: string | undefined;
  repo?: string | undefined;
  /** Where the code lives when it isn't inside the host repo: a git URL cloned into <data>/remotes. Used when `path` is missing or `--remote` is passed. */
  git?: { url: string; ref?: string | undefined } | undefined;
  /** Import aliases beyond tsconfig "paths", e.g. { "@/": "src/" } (relative to this target). */
  aliases?: Record<string, string> | undefined;
  /** Paths to skip, relative to this target (vendored copies, generated code). */
  exclude?: string[] | undefined;
  /** A file holding the core commit SHA this target is pinned to (e.g. "core.pin"). Currency is then measured in days/commits behind core's main. */
  pin?: { file: string } | undefined;
}

/** A unit we scan: a consumer app, or a child library (which consumes core). */
export interface Target {
  name: string;
  /** Absolute path. */
  dir: string;
  role: 'consumer' | 'child' | 'core';
  owner?: string | undefined;
  repo?: string | undefined;
  /** Declared dependencies (name -> range) from its package.json. */
  deps: Record<string, string>;
  aliases?: Record<string, string> | undefined;
  /** Absolute paths to skip inside this target. */
  exclude?: string[] | undefined;
  pin?: { file: string } | undefined;
  /** True when the code came from a git clone rather than a local path. */
  remote?: boolean | undefined;
}

export interface Instance {
  target: string;
  library: string;
  pkg: string;
  component: string;
  file: string;
  line: number;
  framework: Framework;
  /** Override kinds present on this instance, e.g. ["className", "spread"]. */
  overrides: string[];
}

export interface Lookalike {
  target: string;
  element: string;
  /** DS component this raw element imitates. */
  component: string;
  file: string;
  line: number;
  col?: number | undefined;
  /** Mechanical facts for the evaluator (not stored as-is). */
  features?: import('./scanners/features.js').ElementFeatures | undefined;
}

export interface VersionRow {
  /** Pin-based currency (SHA pins instead of semver). */
  daysBehind?: number | null | undefined;
  commitsBehind?: number | null | undefined;
  target: string;
  role: Target['role'];
  pkg: string;
  library: string;
  declared: string;
  resolved: string | null;
  latest: string | null;
  majorsBehind: number | null;
}

export interface TokenRow {
  target: string;
  file: string;
  rawValues: number;
  tokenRefs: number;
  /** True when the file changed inside the "new code" window. */
  isNew: boolean;
}

export interface FigmaUsageRow {
  fileKey: string;
  fileName: string;
  project: string;
  library: string;
  component: string;
  instances: number;
  lookalikeFrames: number;
}

export interface Finding {
  id: string;
  rule: string;
  subject: string;
  scope: Scope;
  owner: string;
  repo?: string | undefined;
  family: string;
  severity: Severity;
  score: number;
  title: string;
  why: string;
  evidence: string;
  fix: string;
  exit: string;
  affected: string[];
  /** Settings in force when the finding was raised (so later setting changes don't rewrite history). */
  settingsUsed: Record<string, unknown>;
  status: 'open' | 'resolved' | 'snoozed';
  openedAt: string;
  updatedAt: string;
  resolvedAt?: string | null | undefined;
  snoozeUntil?: string | null | undefined;
  snoozeReason?: string | null | undefined;
  metricValue: number;
}
