import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const CONFIG_FILENAME = "dsa.config.json";

const nonNegativeInt = (fallback: number) => z.number().int().min(0).default(fallback);

// Sections below without defaults are read by features that land later (repo
// discovery, findings, element review, add-ons). They stay absent from the parsed
// config when a file leaves them out, so older configs parse exactly as before.

/** Where a library's or consumer's code lives, and who owns it. Shared by `system`, `system.children`, `consumers`, `extraRepos`. */
const sourceFields = {
  path: z.string().optional().describe("Folder of its code, relative to the config root (another checkout may be outside it, e.g. ../prototype)."),
  git: z
    .object({ url: z.string(), ref: z.string().optional() })
    .optional()
    .describe("Clone from here when `path` is missing (or when runs are told to use remotes). Only ever read."),
  aliases: z.record(z.string(), z.string()).optional().describe('Import aliases beyond tsconfig paths, e.g. { "@/": "src/" }, relative to this folder.'),
  exclude: z.array(z.string()).optional().describe("Paths to skip inside this folder (vendored copies, generated code)."),
  pin: z
    .object({ file: z.string() })
    .optional()
    .describe("A file holding the core commit SHA this code is pinned to; currency is then days and commits behind core's main."),
  owner: z.string().optional().describe("Team that owns it; findings about it are routed here."),
  repo: z.string().optional().describe('GitHub repo "owner/name" that receives its issues.'),
};

const LibrarySchema = z.object({
  name: z.string().describe("Library name."),
  packages: z.array(z.string()).default([]).describe("Packages it publishes."),
  localAliases: z.array(z.string()).optional().describe("In-repo import sources that are this library."),
  tagPrefixes: z.array(z.string()).optional().describe('Element tag prefixes it owns ("ck-" maps <ck-card> to Card): Angular selectors, global Vue components, web components.'),
  ...sourceFields,
});

const ConsumerSchema = z.object({
  name: z.string().describe("Consumer name (an app)."),
  ...sourceFields,
});

const FlowStepSchema = z.union([
  z.object({ click: z.string(), nth: z.number().int().optional(), within: z.string().optional() }),
  z.object({ dblclick: z.string(), nth: z.number().int().optional(), within: z.string().optional() }),
  z.object({ hover: z.string(), nth: z.number().int().optional(), within: z.string().optional() }),
  z.object({ check: z.string(), nth: z.number().int().optional(), within: z.string().optional() }),
  z.object({ fill: z.object({ label: z.string(), text: z.string() }), nth: z.number().int().optional(), within: z.string().optional() }),
  z.object({ press: z.string() }),
  z.object({ upload: z.string(), nth: z.number().int().optional(), within: z.string().optional() }),
  z.object({ wait: z.number() }),
]);

const AppSchema = z.object({
  versions: z.boolean().optional().describe("Measure package versions and pin currency (default on)."),
  components: z.boolean().optional().describe("Measure component use and overrides (default on)."),
  lookalikes: z.boolean().optional().describe("Measure native look-alikes (default on). Usually off for Storybook."),
  tokens: z.boolean().optional().describe("Measure token compliance (default on)."),
  tokenSkip: z.array(z.string()).optional().describe("Files left out of token compliance, globs relative to the app."),
  start: z.string().optional().describe('How to start the app for screenshots, e.g. "npm run dev -- --port {port}".'),
  url: z.string().optional().describe("URL once started; {port} is filled in."),
  routes: z.array(z.string()).optional().describe("Pages to visit; replaces the routes found in the source."),
  extraRoutes: z.array(z.string()).optional().describe("Pages visited first, added to the ones found in the source."),
  flows: z
    .array(
      z.object({
        name: z.string(),
        route: z.string(),
        steps: z.array(FlowStepSchema),
        reveals: z.array(z.string()).optional(),
        notes: z.string().optional(),
      }),
    )
    .optional()
    .describe("Written-down UI sequences that reveal elements only a filled field or an upload shows."),
  screenshots: z.boolean().optional().describe("false: never start this app for screenshots."),
});

const SystemSchema = z
  .object({
    name: z.string().default("design-system").describe("Human name of the design system being measured."),
    packages: z
      .array(z.string())
      .default([])
      .describe("Import sources that count as design-system components (exact name or package prefix)."),
    localAliases: z
      .array(z.string())
      .default([])
      .describe("In-repo import sources that are the design system (shadcn-style owned source), e.g. @/components/ui."),
    tagPrefixes: LibrarySchema.shape.tagPrefixes,
    mainRef: z.string().optional().describe("Ref treated as the latest core for pin currency (default origin/main, then main)."),
    children: z
      .array(LibrarySchema)
      .optional()
      .describe("Child libraries built on the core (a product kit, a prototype). Scored on their own; they consume the core."),
    ...sourceFields,
  })
  .prefault({});

export const ConfigSchema = z
  .object({
    $schema: z.string().optional().describe("JSON Schema URL for editor support."),
    profile: z
      .string()
      .optional()
      .describe("The design system's profile module: a path relative to this file, or a package name. See docs/architecture.md."),
    system: SystemSchema,
    consumers: z
      .array(ConsumerSchema)
      .optional()
      .describe("Consumers, listed explicitly. When absent, workspaces that depend on a system package are found."),
    extraRepos: z.array(ConsumerSchema).optional().describe("Consumers in other checkouts, added to the ones found."),
    internalConsumers: z
      .array(z.string())
      .optional()
      .describe("Consumers the system team owns (docs, Storybook): scored, but not counted toward cross-consumer clusters."),
    scan: z
      .object({
        include: z.array(z.string()).default(["**/*.tsx", "**/*.jsx"]).describe("Glob patterns of files to scan, relative to the config root."),
        exclude: z
          .array(z.string())
          .default(["**/node_modules/**", "**/dist/**", "**/*.test.tsx", "**/*.spec.tsx", "**/*.stories.tsx"])
          .describe("Glob patterns to leave out."),
      })
      .prefault({}),
    hosts: z
      .object({
        by: z.enum(["file", "dir"]).default("file").describe("What counts as one host when counting pattern spread: a file or its directory."),
      })
      .prefault({}),
    patterns: z
      .object({
        minOccurrences: z.number().int().min(1).default(3).describe("Occurrences needed before a composition is more than a snowflake (rule of three)."),
        minHosts: z.number().int().min(1).default(2).describe("Distinct hosts needed before a composition is more than a snowflake."),
        minComponents: z.number().int().min(1).default(2).describe("Minimum design-system or local components in a composition for it to be considered."),
        ignoreIgnoredTimes: nonNegativeInt(3).describe("A candidate ignored this many times is parked and no longer raised."),
      })
      .prefault({}),
    correctUse: z
      .object({
        rawElements: z
          .array(z.string())
          .default(["button"])
          .describe(
            "Plain HTML tags that bypass the design system when written in a consumer (counted as rawElements). An element handed to a component through a prop, e.g. render={<button />}, is the system's element and isn't counted.",
          ),
        elementMap: z
          .string()
          .optional()
          .describe("The system's element map (which native elements it replaces, and with what), relative to the config root. Overrides the profile's."),
        nativeLookalikes: z
          .record(z.string(), z.string())
          .optional()
          .describe('Native elements that imitate a component: { "select": "Select" }. "input[checkbox]" keys set input types. Overrides entries from the element map.'),
        exceptionsFile: z.string().optional().describe("Each app's element-map exceptions, relative to the app. Overrides the profile's."),
        deprecated: z.record(z.string(), z.string()).optional().describe("Deprecated components and their replacements: { OldModal: Modal }."),
      })
      .prefault({}),
    tokens: z
      .object({
        patterns: z.array(z.string()).optional().describe("Regex sources that count as a token reference in styles."),
      })
      .optional(),
    tailwind: z
      .object({
        tierLeakageSpec: z.string().optional().describe("Leak grammar shared with the repo's lint rule. Overrides the profile's."),
        semanticCss: z.union([z.string(), z.array(z.string())]).optional().describe("CSS declaring --color-<name> semantic utilities. Overrides the profile's."),
        classNameOverrides: z.enum(["leaky", "any"]).optional().describe('"leaky" (default): className counts as an override only when it carries drift.'),
        arbitraryValues: z.enum(["color", "all", "none"]).optional().describe("Which arbitrary values count as drift (default color)."),
      })
      .optional()
      .describe("Tailwind / shadcn-style systems: read classes the way the repo's own lint does."),
    apps: z.record(z.string(), AppSchema).optional().describe("Per-app switches, keyed by app or workspace name. Anything not listed is fully measured."),
    review: z
      .object({
        threshold: z.number().min(0).max(1).optional().describe("Below this confidence a human decides (default 0.9)."),
        labPaths: z.array(z.string()).optional().describe("Specimen pages, globs relative to each app. Overrides the profile's."),
        decisionsFile: z.string().optional().describe("Each app's review decisions, relative to the app. Overrides the profile's."),
      })
      .optional()
      .describe("Element review (the review add-on)."),
    rendered: z
      .object({
        autoStart: z.boolean().optional(),
        useStatic: z.boolean().optional().describe("Measure the static Storybook build instead of starting Storybook."),
        storiesPerComponent: z.number().int().min(1).optional(),
        maxMinutes: z.number().min(0).optional(),
      })
      .optional()
      .describe("Rendered signatures measured in the system's Storybook (the review add-on)."),
    shots: z
      .object({
        url: z.string().optional(),
        routes: z.array(z.string()).optional(),
        auto: z.boolean().optional().describe("Take screenshots on every run."),
        reveal: z.boolean().optional().describe("Open menus, tabs and sheets to find hidden elements (default on)."),
        perGroup: z.number().int().min(0).optional(),
        maxPages: z.number().int().min(1).optional(),
        maxActions: z.number().int().min(0).optional(),
        maxDepth: z.number().int().min(0).optional(),
        maxMinutes: z.number().min(0).optional(),
        maxAgeDays: z.number().min(0).optional(),
        waitMs: z.number().int().min(0).optional(),
      })
      .optional()
      .describe("App screenshots for element review (the review add-on)."),
    modules: z
      .object({ figma: z.boolean().optional() })
      .optional()
      .describe("Optional modules. Off modules keep their settings; they just don't run."),
    figma: z
      .object({
        teamIds: z.array(z.string()).optional(),
        projectIds: z.array(z.string()).optional(),
        fileKeys: z.array(z.string()).optional(),
        libraries: z.array(z.object({ name: z.string(), fileKey: z.string(), url: z.string().optional() })).optional(),
        links: z.array(z.object({ url: z.string(), label: z.string().optional() })).optional(),
        editedWithinDays: z.number().int().min(0).optional(),
        maxFiles: z.number().int().min(1).optional(),
      })
      .optional()
      .describe("Figma library usage (the figma add-on)."),
    github: z
      .object({
        defaultRepo: z.string().optional().describe("Repo that receives findings whose owner has none."),
        labels: z.array(z.string()).optional(),
      })
      .optional(),
    agents: z
      .object({
        provider: z.enum(["claude-code", "cursor"]).optional(),
        model: z.string().optional(),
        cursorModel: z.string().optional(),
        mode: z.enum(["advise", "try"]).optional(),
        timeoutMinutes: z.number().min(0).optional(),
      })
      .optional()
      .describe("Agent workbench (the agent add-on)."),
    report: z
      .object({
        title: z.string().optional(),
        timeZone: z.string().optional().describe('IANA time zone for dates in the report, e.g. "America/Los_Angeles".'),
      })
      .optional(),
    settings: z.record(z.string(), z.unknown()).optional().describe("Rule settings on top of the metric catalog's defaults."),
    ratchet: z
      .object({
        baseline: z.string().default(".dsa/baseline.json").describe("Path of the correct-use baseline, relative to the config root."),
      })
      .prefault({}),
    output: z
      .object({
        dir: z.string().default(".dsa").describe("Directory the CLI writes JSON reports to, relative to the config root."),
      })
      .prefault({}),
  })
  .describe("dsa.config.json — configuration for @snds/dsa.");

export type DsaConfig = z.output<typeof ConfigSchema>;
export type DsaConfigInput = z.input<typeof ConfigSchema>;

export interface LoadedConfig {
  config: DsaConfig;
  /** Absolute path of the config file, or null when defaults are in use. */
  configPath: string | null;
  /** Directory every relative path in the config resolves against. */
  root: string;
}

/** Walk upward from `startDir` until a `dsa.config.json` is found. */
export function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function parseConfig(raw: unknown, source = "config"): DsaConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid ${source}:\n${issues}`);
  }
  return result.data;
}

export interface LoadConfigOptions {
  /** Directory to start discovery from (default: process.cwd()). */
  cwd?: string;
  /** Explicit config path; skips discovery. */
  configPath?: string;
  /** In-memory overrides merged on top of the file (shallow per section). */
  overrides?: DsaConfigInput;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = options.configPath ? path.resolve(options.configPath) : findConfigFile(cwd);
  let raw: Record<string, unknown> = {};
  if (configPath) {
    if (!fs.existsSync(configPath)) throw new Error(`Config file not found: ${configPath}`);
    raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  }
  if (options.overrides) raw = mergeSections(raw, options.overrides as Record<string, unknown>);
  const config = parseConfig(raw, configPath ?? "default config");
  return { config, configPath, root: configPath ? path.dirname(configPath) : cwd };
}

function mergeSections(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const prev = out[key];
    out[key] =
      isPlainObject(prev) && isPlainObject(value) ? { ...prev, ...value } : value;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
