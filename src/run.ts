import fs from "node:fs";
import path from "node:path";
import { loadConfig, type DsaConfig, type DsaConfigInput, type LoadedConfig } from "./config.js";
import { buildGraph, type CompositionGraph } from "./graph/index.js";
import { dsaVersion } from "./version.js";

export interface RunOptions {
  /** Directory to scan. Config discovery starts here (default: process.cwd()). */
  dir?: string;
  /** Working directory used when `dir` is relative (default: process.cwd()). */
  cwd?: string;
  /** Explicit config file; skips upward discovery. */
  configPath?: string;
  /** Overrides merged on top of the discovered config. */
  config?: DsaConfigInput;
}

export interface ReportMeta {
  dsaVersion: string;
  generatedAt: string;
  config: DsaConfig;
  configPath: string | null;
}

export interface RunContext {
  loaded: LoadedConfig;
  /** Absolute directory relative paths in the config resolve against. */
  root: string;
  /** Absolute directory being scanned (root, or a subdirectory of it). */
  scanDir: string;
  graph: CompositionGraph;
  meta: ReportMeta;
  outputDir: string;
}

/**
 * Resolve config, pick the scan root and build the composition graph once, so
 * scan / patterns / ratchet all look at the same files.
 */
export function createRunContext(options: RunOptions = {}): RunContext {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const scanDir = path.resolve(cwd, options.dir ?? ".");
  if (!fs.existsSync(scanDir) || !fs.statSync(scanDir).isDirectory()) {
    throw new Error(`Not a directory: ${scanDir}`);
  }
  const loadOpts: Parameters<typeof loadConfig>[0] = { cwd: scanDir };
  if (options.configPath) loadOpts.configPath = options.configPath;
  if (options.config) loadOpts.overrides = options.config;
  const loaded = loadConfig(loadOpts);
  // When the config sits above the scan directory, globs stay relative to the
  // config root but only files under the scan directory are kept.
  const root = loaded.root;
  const within = scanDir === root || !scanDir.startsWith(root + path.sep) ? undefined : scanDir;
  const graphOpts: Parameters<typeof buildGraph>[0] = { root, config: loaded.config };
  if (within) graphOpts.within = within;
  const graph = buildGraph(graphOpts);
  return {
    loaded,
    root,
    scanDir,
    graph,
    outputDir: path.resolve(root, loaded.config.output.dir),
    meta: { dsaVersion: dsaVersion(), generatedAt: new Date().toISOString(), config: loaded.config, configPath: loaded.configPath },
  };
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
