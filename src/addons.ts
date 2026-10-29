import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Command } from "commander";
import type { PipelineStage } from "./engine/pipeline.js";
import type { StoreFactory } from "./engine/store.js";
import { APP_DIR } from "./engine/paths.js";

/**
 * An add-on is an optional package (@snds/dsa-<name>) that adds commands to the one `dsa` CLI,
 * stages to `dsa run`, or the run-history store. Its package.json says where its add-on module is:
 *
 *   "dsa": { "addon": "./dist/index.js" }
 *
 * and that module's default export is `defineAddon({...})`. The CLI finds every installed add-on
 * next to the repo it runs on and next to dsa itself.
 */
export interface DsaAddon {
  /** Package name, shown in `dsa where` and in notes. */
  name: string;
  /** Opens the run history. The last add-on that offers one wins. */
  store?: StoreFactory;
  /** Steps added to `dsa run`. */
  stages?: PipelineStage[];
  /** Add commands (or options) to the CLI. */
  commands?: (program: Command, api: AddonApi) => void;
}

/** What the CLI hands an add-on's `commands`. */
export interface AddonApi {
  /** The directory the CLI runs from. */
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Identity helper so an add-on module gets type checking. */
export function defineAddon(addon: DsaAddon): DsaAddon {
  return addon;
}

export interface FoundAddon {
  /** Package name. */
  name: string;
  /** Package folder. */
  dir: string;
  /** Module file the add-on loads from. */
  entry: string;
}

/** Where installed add-ons are looked for: node_modules/@snds next to `dirs` and their parents, and this checkout's packages/ folder. */
export function findAddons(dirs: string[]): FoundAddon[] {
  const seen = new Map<string, FoundAddon>();
  const consider = (dir: string) => {
    const pj = readJson(path.join(dir, "package.json")) as { name?: string; dsa?: { addon?: string } } | null;
    const name = pj?.name;
    if (!name || !/^@snds\/dsa-/.test(name) || seen.has(name) || !pj?.dsa?.addon) return;
    const entry = path.resolve(dir, pj.dsa.addon);
    if (fs.existsSync(entry)) seen.set(name, { name, dir, entry });
  };
  const roots = new Set<string>();
  for (const d of dirs) {
    let cur = path.resolve(d);
    for (;;) {
      roots.add(path.join(cur, "node_modules", "@snds"));
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  for (const r of roots) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(r);
    } catch {
      continue;
    }
    for (const n of names.sort()) if (n.startsWith("dsa-")) consider(fs.realpathSync(path.join(r, n)));
  }
  // A dsa checkout: its own workspace packages.
  const local = path.join(APP_DIR, "packages");
  if (fs.existsSync(path.join(APP_DIR, "pnpm-workspace.yaml")) && fs.existsSync(local)) {
    for (const n of fs.readdirSync(local).sort()) consider(path.join(local, n));
  }
  return [...seen.values()];
}

/** Import every found add-on. One that fails to load is reported in `notes`, never fatal. */
export async function loadAddons(dirs: string[], notes: string[] = []): Promise<DsaAddon[]> {
  const out: DsaAddon[] = [];
  for (const f of findAddons(dirs)) {
    try {
      const mod = (await import(pathToFileURL(f.entry).href)) as { default?: DsaAddon };
      if (mod.default && typeof mod.default === "object") out.push({ ...mod.default, name: mod.default.name || f.name });
      else notes.push(`${f.name}: its add-on module has no default export.`);
    } catch (e) {
      notes.push(`${f.name} didn't load: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
    }
  }
  return out;
}

/** Resolve a package from a directory, for messages about what is installed. */
export function isInstalled(pkg: string, fromDir: string): boolean {
  try {
    createRequire(path.join(path.resolve(fromDir), "noop.js")).resolve(`${pkg}/package.json`);
    return true;
  } catch {
    return false;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
