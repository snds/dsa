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
  score: number;
  tier: string;
  /** The system's agent kit is installed in that repo. */
  kit: boolean;
  checks: { id: string; title: string; score: number; weight: number; evidence: string[]; fixes: string[] }[];
}

export interface ReadinessProvider {
  /** Shown in notes, e.g. "acme-bench". */
  id: string;
  /** False when the tool isn't installed; the run then notes it and skips readiness. */
  available(root: string): boolean;
  /** Never throws for one bad repo: push a line to `notes` and leave it out. */
  collect(repos: { subject: string; dir: string }[], notes: string[]): Promise<ReadinessRow[]>;
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
