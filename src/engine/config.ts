import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './paths.js';
import type { ConsumerDef, LibraryDef } from './types.js';

/**
 * The engine's view of the config: the shape the analytics suite read, built from a dsa config and
 * the profile by `engineConfig` (src/engine/from-dsa.ts). Everything is optional except
 * designSystem.core.packages: the engine has to know which packages ARE the design system.
 */
export interface Config {
  designSystem: {
    core: LibraryDef;
    children?: LibraryDef[] | undefined;
  };
  /** Explicit consumers. When omitted, workspaces that depend on a DS package are discovered. */
  consumers?: ConsumerDef[] | undefined;
  /** Additional local repos (paths relative to the host root) scanned as consumers. */
  extraRepos?: ConsumerDef[] | undefined;
  /** Raw elements that imitate DS components: element -> component. Overrides entries from rawElements. */
  lookalikes?: Record<string, string> | undefined;
  /** Path (from the host root) to the design system's element map, e.g. "packages/lint/raw-elements.json". */
  rawElements?: string | undefined;
  /** Where each app keeps its raw-element exceptions, relative to the app's folder. */
  rawElementExceptions?: string | undefined;
  /** Where each app keeps element review decisions, relative to the app's folder. */
  rawElementDecisions?: string | undefined;
  /** Element review: below this confidence an agent must ask a human (0..1, default 0.9). */
  review?: {
    threshold?: number | undefined;
    /** Lab pages (globs relative to each app): specimens, not product UI. Default: folders under features/ named *Lab. */
    labPaths?: string[] | undefined;
  };
  /** Agent workbench (Settings › Agents): which agent the dashboard talks to, and how. */
  agents?: { provider?: 'claude-code' | 'cursor' | undefined; model?: string | undefined; cursorModel?: string | undefined; mode?: 'advise' | 'try' | undefined; timeoutMinutes?: number | undefined } | undefined;
  /** Example screenshots: a running app to crawl. */
  /** Rendered signatures from the design system's Storybook. useStatic: measure storybook-static instead of starting Storybook. */
  rendered?: { /** Start Storybook when `dsa serve` starts, so picker previews are ready (default on). */ autoStart?: boolean | undefined; useStatic?: boolean | undefined; storiesPerComponent?: number | undefined; maxMinutes?: number | undefined } | undefined;
  shots?: { url?: string | undefined; routes?: string[]; maxPages?: number | undefined; waitMs?: number | undefined; /** Take screenshots as part of every run (set by dsa setup). */ auto?: boolean | undefined; perGroup?: number | undefined; /** Examples per group that needs a human decision: every case, up to this many (default 40), so a reviewer can see they really look the same. */ perQuestion?: number | undefined; /** Open menus/popovers/sheets, switch tabs and views, hover rows, and follow what they reveal to find elements (default on). */ reveal?: boolean | undefined; /** Deprecated: use maxActions. */ maxTriggers?: number | undefined; /** Interactions per page (default 40). */ maxActions?: number | undefined; /** How many interactions deep to follow what an interaction reveals (default 3). */ maxDepth?: number | undefined; /** Time budget per app, in minutes (default 12). */ maxMinutes?: number | undefined; /** Reuse a screenshot while its source file is unchanged, up to this many days (default 7). */ maxAgeDays?: number | undefined } | undefined;
  /** Deprecated components: name -> replacement. */
  deprecated?: Record<string, string> | undefined;
  /** Regex sources that count as a token reference in styles. */
  tokenPatterns?: string[] | undefined;
  /** Paths (relative to host root) to skip. */
  exclude?: string[] | undefined;
  /**
   * Optional modules. Off modules keep their code, settings, and stored data; they just don't run or show.
   * figma: design-file crawl. Off by default: on the Organization plan the crawl can only see files in
   * teams you can list, so library-wide usage needs Figma Enterprise (Library Analytics API).
   */
  modules?: { figma?: boolean | undefined } | undefined;
  figma?: {
    teamIds?: string[] | undefined;
    projectIds?: string[] | undefined;
    fileKeys?: string[] | undefined;
    /** Published library files: their component keys define what counts as a DS instance. */
    libraries?: { name: string; fileKey: string; url?: string | undefined }[] | undefined;
    /** Team, project, or file links pasted from Figma. Parsed into ids at crawl time. */
    links?: { url: string; label?: string | undefined }[] | undefined;
    editedWithinDays?: number | undefined;
    maxFiles?: number | undefined;
  };
  github?: {
    /** Repo that receives core and triage findings. */
    defaultRepo?: string | undefined;
    labels?: string[] | undefined;
  };
  /**
   * Tailwind-based systems: className is composition, so only classes that skip the semantic tier
   * count as overrides, and semantic utilities count as token references.
   */
  tailwind?: {
    /** Leak grammar shared with the repo's lint rule, e.g. "packages/lint/tier-leakage.json". */
    tierLeakageSpec?: string | undefined;
    /** CSS file(s) declaring --color-<name> semantic utilities, e.g. "packages/tokens/semantic.css". */
    semanticCss?: string | string[] | undefined;
    /** "leaky" (default when this block exists) or "any". */
    classNameOverrides?: 'leaky' | 'any' | undefined;
    /**
     * Which arbitrary values (bg-[#fff], w-[420px]) count as drift. "color" (default) matches a
     * color-only tier-leakage lint; "all" also flags arbitrary sizing and spacing; "none" ignores them.
     */
    arbitraryValues?: 'color' | 'all' | 'none' | undefined;
  };
  /**
   * Consumers owned by the design system team itself (docs site, Storybook). They are scanned and
   * scored, but don't count toward "N consumers do the same thing" clusters.
   */
  internalConsumers?: string[] | undefined;
  /**
   * Per-app measurement switches, keyed by app/workspace name (e.g. "@acme/storybook").
   * Anything not listed is fully measured. Off measures are left out of metrics and findings.
   */
  apps?: Record<string, AppSettings> | undefined;
  /** Report display options. */
  report?: {
    /** IANA time zone for every date in the report, e.g. "America/Los_Angeles". Default: the viewer's browser. */
    timeZone?: string | undefined;
    /** Name shown in the report header. Default: the host repo folder name. */
    title?: string | undefined;
  };
  /** Overrides on top of catalog settings. */
  settings?: Record<string, unknown> | undefined;
}

export const DEFAULT_LOOKALIKES: Record<string, string> = {
  button: 'Button',
  select: 'Select',
  dialog: 'Modal',
  table: 'DataTable',
  textarea: 'TextField',
  input: 'TextField',
};
const DEFAULT_INPUT_TYPES: Record<string, string> = { checkbox: 'Checkbox', radio: 'Radio' };
const DEFAULT_ALLOW_TYPES = ['hidden', 'submit', 'file', 'image', 'reset'];

/** Where a host keeps its raw-element exceptions when neither the config nor the profile says. */
export const DEFAULT_EXCEPTIONS_FILE = 'docs/raw-elements.exceptions.json';

/**
 * The look-alike map. When config.rawElements points at the design system's element map
 * (the profile's files.elementMap, or correctUse.elementMap), that file is the source, so the suite counts
 * exactly what the lint rule blocks. config.lookalikes still overrides single entries.
 * Legacy keys "input[checkbox]" etc. in config.lookalikes set input types.
 */
export function lookalikeMap(root: string, config: Config): { lookalikes: Record<string, string>; inputTypes: Record<string, string>; allowTypes: string[] } {
  let lookalikes = { ...DEFAULT_LOOKALIKES };
  let inputTypes = { ...DEFAULT_INPUT_TYPES };
  let allowTypes = [...DEFAULT_ALLOW_TYPES];
  if (config.rawElements) {
    const map = readRawElements(root, config.rawElements);
    if (!map.elements) throw new Error(`rawElements: ${config.rawElements} has no "elements" map.`);
    lookalikes = {};
    for (const [el, e] of Object.entries<any>(map.elements)) {
      lookalikes[el] = e.use;
      if (el === 'input') {
        inputTypes = Object.fromEntries(Object.entries<any>(e.types ?? {}).map(([t, r]) => [t, r.use]));
        allowTypes = e.allowTypes ?? [];
      }
    }
  }
  for (const [k, v] of Object.entries(config.lookalikes ?? {})) {
    const m = k.match(/^input\[(\w+)\]$/);
    if (m) inputTypes[m[1]!] = v; else lookalikes[k] = v;
  }
  return { lookalikes, inputTypes, allowTypes };
}

/**
 * The design system's element map named by config.rawElements. A configured file that is missing or
 * unreadable is an error, the same one for every loader (look-alike counts and the evaluator's roles):
 * silently falling back to built-in defaults would score against a map nobody chose.
 */
export function readRawElements(root: string, rel: string): any {
  const file = path.resolve(root, rel);
  if (!fs.existsSync(file)) throw new Error(`rawElements: ${rel} not found (looked at ${file}). Fix "rawElements" in dsa.config.json, or remove it to use the built-in map.`);
  const map = readJson<any>(file);
  if (!map || typeof map !== 'object') throw new Error(`rawElements: ${rel} is not valid JSON (${file}).`);
  return map;
}

export interface RawElementExceptions {
  file: string;
  temporary: { paths: string[]; reason?: string | undefined; owner?: string | undefined; added?: string | undefined; review?: string | undefined }[];
  allow: { paths: string[]; why?: string | undefined }[];
}

/** A target's exceptions file, or null when it has none. Paths in it are relative to the target's folder. */
export function readExceptions(dir: string, rel = DEFAULT_EXCEPTIONS_FILE): RawElementExceptions | null {
  const file = path.join(dir, rel);
  const raw = readJson<any>(file);
  if (!raw) return null;
  return { file, temporary: raw.temporary ?? [], allow: raw.allow ?? [] };
}

export const DEFAULT_TOKEN_PATTERNS = ['var\\(--ds-', '\\$ds-', '\\btokens\\.'];

/** Map an npm package name to the library that publishes it. */
export function libraryOfPackage(config: Config, pkg: string): LibraryDef | null {
  const libs = [config.designSystem.core, ...(config.designSystem.children ?? [])];
  return libs.find(l => l.packages.includes(pkg)) ?? null;
}

export function allDsPackages(config: Config): string[] {
  return [config.designSystem.core, ...(config.designSystem.children ?? [])].flatMap(l => l.packages);
}

/** Figma tracking is opt-in (see Config.modules). */
export const figmaEnabled = (c: Config) => c.modules?.figma === true;

export interface AppSettings {
  /** DS package versions and pin currency. */
  versions?: boolean | undefined;
  /** DS component instances and whether they're used as intended. */
  components?: boolean | undefined;
  /** Raw elements that imitate DS components. */
  lookalikes?: boolean | undefined;
  /** Token compliance in styles. */
  tokens?: boolean | undefined;
  /** Files left out of token compliance, as globs relative to the app's folder (e.g. reference sheets that show raw values on purpose). */
  tokenSkip?: string[] | undefined;
  /** How to start the app for screenshots, e.g. "npm run dev -- --port {port}" (detected when omitted). */
  start?: string | undefined;
  /** URL once started; {port} is filled in. Default http://127.0.0.1:{port}/ */
  url?: string | undefined;
  /** Pages to visit for screenshots (hash or path routes). Found in the source when omitted; when set, replaces those. */
  routes?: string[] | undefined;
  /** Routes visited first and added to the ones found in the source (deep links into sheets, drawers, view modes). */
  extraRoutes?: string[] | undefined;
  /** Written-down UI sequences for elements only a filled field, an upload, or a post reveals (flows.ts). */
  flows?: unknown[] | undefined;
  /** false = never start this app for screenshots. */
  screenshots?: boolean | undefined;
}
export const MEASURES = ['versions', 'components', 'lookalikes', 'tokens'] as const;
export type Measure = typeof MEASURES[number];

/** Effective switches for one app: everything on unless the config says otherwise. */
export function appSettings(c: Config, name: string): { [K in keyof AppSettings]-?: NonNullable<AppSettings[K]> } {
  const a = c.apps?.[name] ?? {};
  return { versions: a.versions !== false, components: a.components !== false, lookalikes: a.lookalikes !== false, tokens: a.tokens !== false, tokenSkip: a.tokenSkip ?? [], start: a.start ?? '', url: a.url ?? '', routes: a.routes ?? [], extraRoutes: a.extraRoutes ?? [], flows: a.flows ?? [], screenshots: a.screenshots !== false };
}
