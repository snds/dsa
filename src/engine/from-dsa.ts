import fs from 'node:fs';
import path from 'node:path';
import { discoverSources } from '../model/discover.js';
import { loadConfig, parseConfig, type DsaConfig, type LoadedConfig } from '../config.js';
import { loadProfile, NEUTRAL_PROFILE, type ResolvedProfile } from '../profile.js';
import type { Config } from './config.js';
import type { ConsumerDef, LibraryDef } from './types.js';

/**
 * The engine reads the config in the shape the analytics suite used (designSystem.core, top-level
 * lookalikes, …). This builds that shape from a dsa config and the profile, the inverse of
 * `dsa config migrate`. A config value wins over the profile's: an element map path, the exceptions
 * and decisions files, lab pages, the Tailwind spec files.
 */
export function engineConfig(c: DsaConfig, profile: ResolvedProfile = NEUTRAL_PROFILE): Config {
  const sys = c.system;
  const core: LibraryDef = clean({
    name: sys.name, packages: sys.packages, path: sys.path, tagPrefixes: sys.tagPrefixes, owner: sys.owner, repo: sys.repo,
    git: sys.git, aliases: sys.aliases, exclude: sys.exclude, pin: sys.pin, mainRef: sys.mainRef,
  });
  const out: Config = { designSystem: { core } };
  if (sys.children) out.designSystem.children = sys.children.map(ch => clean({
    name: ch.name, packages: ch.packages, path: ch.path, tagPrefixes: ch.tagPrefixes, owner: ch.owner, repo: ch.repo,
    git: ch.git, aliases: ch.aliases, exclude: ch.exclude, pin: ch.pin,
  }) as LibraryDef);
  const consumer = (x: NonNullable<DsaConfig['consumers']>[number]): ConsumerDef => clean({ ...x, path: x.path }) as ConsumerDef;
  if (c.consumers) out.consumers = c.consumers.map(consumer);
  if (c.extraRepos) out.extraRepos = c.extraRepos.map(consumer);
  if (c.internalConsumers) out.internalConsumers = c.internalConsumers;
  const cu = c.correctUse;
  if (cu.nativeLookalikes) out.lookalikes = cu.nativeLookalikes;
  const elementMap = cu.elementMap ?? profile.files.elementMap;
  if (elementMap) out.rawElements = elementMap;
  const exceptions = cu.exceptionsFile ?? profile.files.exceptions;
  if (exceptions) out.rawElementExceptions = exceptions;
  const decisions = c.review?.decisionsFile ?? profile.files.decisions;
  if (decisions) out.rawElementDecisions = decisions;
  if (cu.deprecated) out.deprecated = cu.deprecated;
  if (c.tokens?.patterns) out.tokenPatterns = c.tokens.patterns;
  const review = clean({ threshold: c.review?.threshold, labPaths: c.review?.labPaths });
  if (Object.keys(review).length) out.review = review;
  const tw = c.tailwind ? { ...c.tailwind } : profile.files.tierLeakage || profile.files.semanticCss ? {} : undefined;
  if (tw) {
    if (!tw.tierLeakageSpec && profile.files.tierLeakage) tw.tierLeakageSpec = profile.files.tierLeakage;
    if (!tw.semanticCss && profile.files.semanticCss) tw.semanticCss = profile.files.semanticCss;
    out.tailwind = tw;
  }
  const exclude = engineExcludes(c.scan.exclude);
  if (exclude.length) out.exclude = exclude;
  for (const k of ['apps', 'rendered', 'shots', 'modules', 'figma', 'github', 'agents', 'report', 'settings'] as const) {
    if (c[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = c[k];
  }
  return out;
}

/**
 * The engine skips whole folders, relative to the repo root. From scan.exclude it takes the entries
 * the defaults don't have that name one folder ("legacy/**"); other globs only shape the graph scan.
 */
export function engineExcludes(scanExclude: string[]): string[] {
  const defaults = new Set(parseConfig({}).scan.exclude);
  return scanExclude.filter(e => !defaults.has(e) && /^[^*?[\]{}]+\/\*\*$/.test(e)).map(e => e.slice(0, -3));
}

export interface EngineContextOptions {
  /** Where the command runs from. */
  cwd: string;
  /** The repo to measure; relative paths in the config resolve against it (default: the config's folder). */
  root?: string;
  /** dsa.config.json to use; skips discovery. */
  configPath?: string;
  /** A profile module (path from cwd, or package name); takes the place of the config's `profile`. */
  profile?: string;
  /** Data folder (default: the config's output.dir). */
  dataDir?: string;
}

export interface EngineContext {
  loaded: LoadedConfig;
  root: string;
  dataDir: string;
  /** Where dsa.hints.json lives. */
  configDir: string;
  profile: ResolvedProfile;
  /** The --profile given on the command line (a resolved path or a package name); unset when the config names it. */
  profileSpec?: string | undefined;
  config: Config;
}

/** Load config and profile the way every engine command does. */
export async function loadEngineContext(o: EngineContextOptions): Promise<EngineContext> {
  const cwd = path.resolve(o.cwd);
  const start = o.root ? path.resolve(cwd, o.root) : cwd;
  const loaded = loadConfig({ cwd: start, ...(o.configPath ? { configPath: path.resolve(cwd, o.configPath) } : {}) });
  const root = o.root ? path.resolve(cwd, o.root) : loaded.root;
  let profile: ResolvedProfile = NEUTRAL_PROFILE;
  if (o.profile) profile = await loadProfile(o.profile, cwd);
  else if (loaded.config.profile) profile = await loadProfile(loaded.config.profile, loaded.root);
  const dataDir = o.dataDir ? path.resolve(cwd, o.dataDir) : path.resolve(loaded.root, loaded.config.output.dir);
  const profileSpec = o.profile ? (o.profile.startsWith('.') || path.isAbsolute(o.profile) ? path.resolve(cwd, o.profile) : o.profile) : undefined;
  // No package names in the config: take them from the folders dsa finds (or the user pinned), so a config
  // with only a name runs end to end.
  if (!loaded.config.system.packages.length) {
    try {
      const found = discoverSources(root, loaded.config);
      const names = found.accepted.map((d) => { try { return JSON.parse(fs.readFileSync(path.join(root, d, 'package.json'), 'utf8')).name as string | undefined; } catch { return undefined; } }).filter((n): n is string => Boolean(n));
      if (names.length) { loaded.config.system.packages = names; (loaded.config.system as { discovered?: boolean }).discovered = true; }
    } catch { /* leave it to requirePackages */ }
  }
  return { loaded, root, dataDir, configDir: loaded.configPath ? path.dirname(loaded.configPath) : root, profile, profileSpec, config: engineConfig(loaded.config, profile) };
}

/** Throw the suite's error when the config doesn't name the system's packages. */
export function requirePackages(ctx: EngineContext): void {
  if (!ctx.config.designSystem.core.packages.length) {
    throw new Error(`${ctx.loaded.configPath ?? 'The config'} needs system.packages (the package names of the design system), and no folder in the repo reached the confidence bar to find them. Run "dsa sources" to see the candidates and "dsa sources --pin <folder>" to choose one.`);
  }
}

function clean<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
