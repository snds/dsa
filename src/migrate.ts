import { parseConfig, type DsaConfigInput } from "./config.js";

/**
 * Convert a config written for the earlier analytics suite (`designSystem.core`,
 * top-level `lookalikes`, `rawElements` as a file path, …) into this package's
 * format. Every key either moves to its new home or is listed as not carried
 * over; nothing is dropped silently.
 */
export interface MigrateResult {
  /** The converted config, as it would be written (only keys that had a value). */
  config: DsaConfigInput;
  /** One line per key that moved: "designSystem.core.packages -> system.packages". */
  moved: string[];
  /** Keys with no home here, left out. */
  dropped: string[];
  /** Things a person should look at. */
  notes: string[];
}

export interface MigrateOptions {
  /** Set `profile` in the output (a path relative to the new config, or a package name). */
  profile?: string;
  /** `$schema` for the output; default the published config schema. */
  schemaUrl?: string;
}

export const CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/snds/dsa/main/schema/config.json";

/** Keys that keep their name and shape. */
const SAME = ["consumers", "extraRepos", "internalConsumers", "tailwind", "apps", "rendered", "shots", "modules", "figma", "github", "agents", "report", "settings"] as const;

/** Fields of a suite library def and where each lands on a dsa library. */
const LIBRARY_FIELDS = ["packages", "tagPrefixes", "path", "git", "aliases", "exclude", "pin", "owner", "repo"] as const;

/** True when a parsed JSON value looks like a suite config rather than a dsa one. */
export function isSuiteConfig(raw: unknown): boolean {
  return isObject(raw) && isObject(raw.designSystem);
}

export function migrateSuiteConfig(raw: unknown, options: MigrateOptions = {}): MigrateResult {
  if (!isSuiteConfig(raw)) throw new Error('Not a suite config: it has no "designSystem" section.');
  const src = { ...(raw as Record<string, unknown>) };
  const out: Record<string, unknown> = { $schema: options.schemaUrl ?? CONFIG_SCHEMA_URL };
  const moved: string[] = [];
  const dropped: string[] = [];
  const notes: string[] = [];
  const take = (key: string) => {
    const v = src[key];
    delete src[key];
    return v;
  };

  if (options.profile) out.profile = options.profile;

  // designSystem.core -> system, designSystem.children -> system.children
  const ds = take("designSystem") as Record<string, unknown>;
  const core = isObject(ds.core) ? ds.core : {};
  const system: Record<string, unknown> = {};
  if (typeof core.name === "string") {
    system.name = core.name;
    moved.push("designSystem.core.name -> system.name");
  }
  for (const f of [...LIBRARY_FIELDS, "mainRef"] as const) {
    if (core[f] === undefined) continue;
    system[f] = core[f];
    moved.push(`designSystem.core.${f} -> system.${f}`);
  }
  for (const k of Object.keys(core)) {
    if (k !== "name" && k !== "mainRef" && !(LIBRARY_FIELDS as readonly string[]).includes(k)) dropped.push(`designSystem.core.${k}`);
  }
  if (Array.isArray(ds.children) && ds.children.length) {
    system.children = ds.children;
    moved.push("designSystem.children -> system.children");
  }
  for (const k of Object.keys(ds)) if (k !== "core" && k !== "children") dropped.push(`designSystem.${k}`);
  out.system = system;

  // Host-root paths to skip -> scan.exclude globs, on top of the defaults.
  const exclude = take("exclude");
  if (Array.isArray(exclude) && exclude.length) {
    const defaults = parseConfig({}).scan.exclude;
    const extra = exclude.filter((p): p is string => typeof p === "string").map((p) => `${p.replace(/\/+$/, "")}/**`);
    out.scan = { exclude: [...defaults, ...extra] };
    moved.push("exclude -> scan.exclude (as folder/** globs, after the defaults)");
  }

  // Element map, native look-alikes, exceptions, deprecated -> correctUse
  const correctUse: Record<string, unknown> = {};
  const toCorrectUse: [string, string][] = [
    ["rawElements", "elementMap"],
    ["lookalikes", "nativeLookalikes"],
    ["rawElementExceptions", "exceptionsFile"],
    ["deprecated", "deprecated"],
  ];
  for (const [from, to] of toCorrectUse) {
    const v = take(from);
    if (v === undefined) continue;
    correctUse[to] = v;
    moved.push(`${from} -> correctUse.${to}`);
  }
  if (Object.keys(correctUse).length) out.correctUse = correctUse;

  const tokenPatterns = take("tokenPatterns");
  if (tokenPatterns !== undefined) {
    out.tokens = { patterns: tokenPatterns };
    moved.push("tokenPatterns -> tokens.patterns");
  }

  // review keeps its keys; rawElementDecisions joins it.
  const rawReview = take("review");
  const decisions = take("rawElementDecisions");
  const review: Record<string, unknown> = {};
  if (isObject(rawReview)) {
    Object.assign(review, rawReview);
    moved.push("review -> review");
  } else if (rawReview !== undefined) dropped.push("review");
  if (decisions !== undefined) {
    review.decisionsFile = decisions;
    moved.push("rawElementDecisions -> review.decisionsFile");
  }
  if (Object.keys(review).length) out.review = review;

  for (const key of SAME) {
    const v = take(key);
    if (v === undefined) continue;
    out[key] = v;
    moved.push(`${key} -> ${key}`);
  }

  for (const k of Object.keys(src)) dropped.push(k);

  if (!system.packages || !(system.packages as unknown[]).length) notes.push("system.packages is empty: dsa won't know which imports are the system.");
  if (!options.profile) notes.push("No profile set. System-specific knowledge (component list, role map, file conventions) needs one: --profile <path>.");
  notes.push("scan.include keeps dsa's default (**/*.tsx, **/*.jsx). Vue and Angular files are read once their readers land.");

  // The output must be a valid dsa config. Keys inside moved sections that the
  // schema doesn't know would be stripped on load: list them, then leave them out.
  const parsed = parseConfig(out, "migrated config");
  for (const lost of strippedKeys(out, parsed)) {
    dropped.push(lost);
    removePath(out, lost);
  }
  return { config: out as DsaConfigInput, moved, dropped, notes };
}

/** Dotted paths present in `input` that parsing removed. Records keep every key, so only schema-unknown keys show up. */
function strippedKeys(input: unknown, parsed: unknown, prefix = ""): string[] {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    return input.flatMap((v, i) => strippedKeys(v, parsed[i], `${prefix}[${i}]`));
  }
  if (!isObject(input) || !isObject(parsed)) return [];
  return Object.keys(input).flatMap((k) => {
    const p = prefix ? `${prefix}.${k}` : k;
    return k in parsed ? strippedKeys(input[k], parsed[k], p) : [p];
  });
}

function removePath(obj: Record<string, unknown>, dotted: string): void {
  const parts = dotted.split(/\.|\[(\d+)\]/).filter((s) => s !== undefined && s !== "");
  let cur: unknown = obj;
  for (const part of parts.slice(0, -1)) cur = (cur as Record<string, unknown>)[part];
  if (isObject(cur) || Array.isArray(cur)) delete (cur as Record<string, unknown>)[parts[parts.length - 1]!];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
