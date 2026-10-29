import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig as loadDsaConfig } from "../../src/config.js";
import { engineConfig, type EngineContext } from "../../src/engine/from-dsa.js";
import { runPipeline as runEngine, type RunOptions } from "../../src/engine/pipeline.js";
import { openStore } from "../../src/engine/store.js";
import { ACME_PROFILE, ACME_ROOT, FIXTURES } from "./setup.js";

/**
 * The fixture as the suite's tests used it, for the add-on tests: the engine config of a repo (its
 * analytics-suite config, converted), a run with the acme-suite profile and the DuckDB store, and the
 * run context a command would get.
 */
export { ACME_PROFILE, ACME_ROOT, FIXTURES };
export const NOW = new Date("2026-10-06T12:00:00Z");
export const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsa-")));

/** A copy of the fixture monorepo to change. */
export function fixtureCopy(): string {
  const root = path.join(tmp(), "repo");
  fs.cpSync(ACME_ROOT, root, { recursive: true });
  return root;
}

export const loadConfig = (root: string) => ({ config: engineConfig(loadDsaConfig({ cwd: root }).config, ACME_PROFILE) });

export const runPipeline = (o: Omit<RunOptions, "config" | "profile" | "store">) =>
  runEngine({ ...o, config: loadConfig(o.root).config, profile: ACME_PROFILE, store: (d) => openStore(d) });

/** What `api.context(cmd)` gives a command for this repo and data folder. */
export function contextFor(root: string, dataDir: string): EngineContext {
  const loaded = loadDsaConfig({ cwd: root });
  return { loaded, root, dataDir, configDir: loaded.configPath ? path.dirname(loaded.configPath) : root, profile: ACME_PROFILE, config: engineConfig(loaded.config, ACME_PROFILE) };
}
