import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * A profile is everything dsa needs to know about one design system that config
 * values can't say: where its component list comes from, what it offers for each
 * UI role, the files its own lint and docs keep, its agent tools, and its name in
 * the report's wording. dsa ships a neutral default; a system keeps its profile in
 * its own repo and points `dsa.config.json` at it.
 */
export interface DsaProfile {
  /** Profile name, shown in reports and notes. */
  name: string;
  /** Short name of the system for report wording ("No <label> component fits"). */
  label?: string;
  /**
   * Import-source prefixes that are the system, beyond `system.packages`
   * (a package scope such as "@acme/", matched as a prefix).
   */
  sources?: string[];
  /** The system's component names and where each is imported from. Called once per run. */
  components?: (root: string) => ComponentEntry[];
  /** What the system offers for each UI role (button, icon-button, toggle, disclosure…). */
  roles?: Record<string, RoleOffer>;
  /** Files the system keeps for its own tooling, relative to each app's folder unless noted. */
  files?: ProfileFiles;
  /** Globs (relative to each app) of specimen pages that aren't product UI. */
  labPaths?: string[];
  /** Agent-readiness checks the system ships (its own audit tool). */
  readiness?: ReadinessProvider;
  /**
   * Import sources whose exports are all icons, beyond the common icon libraries (exact source),
   * and "source#Name" for one icon export of a wider package.
   */
  icons?: string[];
  /**
   * Button evidence for the element review, as regex sources over class tokens: which classes show
   * each variant and each size (strongest first), and the icon-button size prop for each size.
   */
  buttonTokens?: { variants?: Record<string, string>; sizes?: Record<string, string>; iconSizes?: Record<string, string> };
  /** Custom properties the system sizes controls with, without "--", and their height in px: { "acme-control-h": 32 }. */
  controlHeights?: Record<string, number>;
  /** Extra regex sources whose classes mark a navigation row (a sidebar item token). */
  navTokens?: string[];
  /**
   * Where the system's container components are imported from, by name: the element review names the
   * container a part needs (a menu row needs DropdownMenu). { DropdownMenu: "@acme/ui/dropdown-menu" }.
   */
  containers?: Record<string, string>;
  /** Metrics the system adds to the catalog (the same shape as data/metric-catalog.yaml entries). */
  metrics?: Record<string, unknown>[];
  /** The system's own usage summary (tokens and components per library) for the dashboard's Usage view. */
  usage?: (root: string) => unknown;
  /** The system's icon font (a .woff2 file), for icon previews in the dashboard's component picker. */
  iconFont?: (root: string) => string | null;
  /** What agents get from the system beyond the scan (used by @snds/dsa-agent). */
  agent?: AgentProfile;
}

/** The system's own agent tooling: its docs, MCP server and checker. Every part is optional. */
export interface AgentProfile {
  /** The system's checkout (its docs and agent tools); agents may read it. */
  root?: string;
  /** A component's entry for briefs: import path, variants, docs. */
  component?(name: string): { import?: string; variants?: Record<string, string[]>; docs?: { description?: string; path?: string } } | null;
  /** Lines (markdown list items) pointing at the system's intent: its contract, decision records. */
  intent?(repoDir: string): string[];
  /** The system's MCP server for an agent working in `repoDir` (a sandbox copy when `sandbox` is set). */
  mcpServer?(repoDir: string, sandbox?: string): { name: string; command: string; args: string[]; env?: Record<string, string> } | null;
  /** One line naming the system's MCP tools, for briefs. */
  tools?: string;
  /** Run the system's usage checker on one file of a repo; returns its report as text. */
  checkFile?(root: string, relPath: string): Promise<string>;
  /** Folders (relative to a repo) a sandbox links to the real checkout besides node_modules, such as a vendored copy of the system. */
  sandboxLinks?: string[];
}

export interface ComponentEntry {
  name: string;
  /** Import path, e.g. "@acme/ui/button". */
  from: string;
  /** "wrap" for a thin re-skin of a third-party primitive; "own" for the system's own component. */
  kind?: "own" | "wrap";
}

export interface RoleOffer {
  /** Component that takes the role, e.g. "Button". */
  use: string;
  from?: string;
  props?: Record<string, string>;
  /** Set when the system has no real home for the role yet: what's missing. */
  gap?: string;
  /** One line on how the component takes over when it isn't a one-for-one swap. */
  how?: string;
  /** "gap" when the system has no home for the role; "keep" when the native element is right. */
  verdict?: "replace" | "gap" | "keep" | "unclear" | "ignore";
}

export interface ProfileFiles {
  /** Element map: which native elements the system replaces (relative to the config root). */
  elementMap?: string;
  /** Per-app exceptions to the element map. */
  exceptions?: string;
  /** Per-app review decisions. */
  decisions?: string;
  /** Tailwind tier-leakage spec (relative to the config root). */
  tierLeakage?: string;
  /** Semantic token CSS (relative to the config root). */
  semanticCss?: string;
}

export interface ReadinessRow {
  subject: string;
  dir: string;
  /** "host" for a repo that consumes the system; anything else (the provider's own word) is the system's repo. */
  mode: string;
  score: number;
  tier: string;
  /** The system's agent kit is installed in that repo. */
  kit: boolean;
  checks: { id: string; title: string; score: number; weight: number; evidence: string[]; fixes: string[] }[];
  /** More metric rows for this repo (a usage checker's error count), stored as they are. */
  metrics?: { metric_id: string; value: number; detail: unknown }[];
}

export interface ReadinessProvider {
  /** Shown in notes, e.g. "acme-bench". */
  id: string;
  /** False when the tool isn't installed; the run then notes it and skips readiness. */
  available(root: string): boolean;
  /** Never throws for one bad repo: push a line to `notes` and leave it out. */
  collect(repos: { subject: string; dir: string }[], notes: string[]): Promise<ReadinessRow[]>;
  /** True when the host root is the system's own repo, so it is audited too. */
  isSystemRepo?(root: string): boolean;
  /** Said in a finding when no check names a fix: how to install the agent kit. */
  setupHint?: string;
  /** Said when `available` is false. */
  missingNote?: string;
  /** The metric (one of `ReadinessRow.metrics`) whose detail is a usage checker's per-file errors, shown with each repo. */
  usageMetric?: string;
  /** Say where the usage checker's raw-element count and the scan's look-alikes differ, and why. */
  reconcile?(usage: any, lookalikes: { file: string }[], hostDir: string, root: string): { note: string; [k: string]: unknown } | null;
  /** Benchmark runs of agents building with the system, newest first, for the dashboard. */
  benchRuns?(dirs: string[]): Promise<unknown[]>;
}

/** A profile with its defaults filled in. */
export type ResolvedProfile = DsaProfile & Required<Pick<DsaProfile, "label" | "sources" | "roles" | "files" | "labPaths">>;

export const NEUTRAL_PROFILE: ResolvedProfile = {
  name: "neutral",
  label: "design system",
  sources: [],
  roles: {},
  files: {},
  labPaths: [],
};

/** Identity helper so a profile file gets type checking. */
export function defineProfile(profile: DsaProfile): DsaProfile {
  return profile;
}

/** Fill a profile's gaps from the neutral default. */
export function resolveProfile(profile?: DsaProfile): ResolvedProfile {
  if (!profile) return NEUTRAL_PROFILE;
  if (typeof profile.name !== "string" || !profile.name) throw new Error("A dsa profile needs a name.");
  return {
    ...profile,
    label: profile.label ?? profile.name,
    sources: profile.sources ?? [],
    roles: profile.roles ?? {},
    files: profile.files ?? {},
    labPaths: profile.labPaths ?? [],
  };
}

/**
 * Load a profile module and resolve it. `spec` is a path (relative to `fromDir`)
 * or a package name resolved from `fromDir`. The module's default export, or its
 * `profile` export, is the profile.
 */
export async function loadProfile(spec: string, fromDir: string): Promise<ResolvedProfile> {
  const file = resolveSpec(spec, fromDir);
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; profile?: unknown };
  const profile = mod.default ?? mod.profile;
  if (!profile || typeof profile !== "object") {
    throw new Error(`dsa profile ${spec} has no default export (or "profile" export).`);
  }
  return resolveProfile(profile as DsaProfile);
}

function resolveSpec(spec: string, fromDir: string): string {
  if (spec.startsWith(".") || path.isAbsolute(spec)) {
    const file = path.resolve(fromDir, spec);
    if (!fs.existsSync(file)) throw new Error(`dsa profile not found: ${file}`);
    return file;
  }
  try {
    return createRequire(path.join(path.resolve(fromDir), "noop.js")).resolve(spec);
  } catch {
    throw new Error(`dsa profile package ${spec} can't be resolved from ${fromDir}.`);
  }
}

/**
 * True when an import source belongs to the system by one of the profile's
 * sources: a scope ending in "/" matches as a prefix ("@acme/" → "@acme/ui");
 * anything else matches as the entry or a subpath ("@acme/ui" → "@acme/ui/button").
 */
export function isProfileSource(profile: ResolvedProfile, source: string): boolean {
  return profile.sources.some((s) => (s.endsWith("/") ? source.startsWith(s) : source === s || source.startsWith(s + "/")));
}
