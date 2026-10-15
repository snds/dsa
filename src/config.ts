import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const CONFIG_FILENAME = "dsa.config.json";

const nonNegativeInt = (fallback: number) => z.number().int().min(0).default(fallback);

export const ConfigSchema = z
  .object({
    $schema: z.string().optional().describe("JSON Schema URL for editor support."),
    system: z
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
      })
      .prefault({}),
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
