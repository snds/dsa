import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { execFileSync } from 'node:child_process';
import { APP_DIR, expandSources, isInside, readJson } from './paths.js';
import { allDsPackages, type Config } from './config.js';
import type { Target } from './types.js';

export interface Workspace {
  dir: string;
  name: string;
  version?: string | undefined;
  deps: Record<string, string>;
}

/** Expand workspace globs. Supports exact paths, "dir/*" and "dir/**" — what real repos use. */
function expand(root: string, pattern: string): string[] {
  const clean = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  if (clean.startsWith('!')) return [];
  const m = clean.match(/^(.*?)\/(\*\*?)$/);
  if (!m) return [path.join(root, clean)];
  const base = path.join(root, m[1]!);
  const deep = m[2] === '**';
  const out: string[] = [];
  const visit = (d: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (fs.existsSync(path.join(full, 'package.json'))) out.push(full);
      if (deep && depth < 4) visit(full, depth + 1);
    }
  };
  visit(base, 0);
  return out;
}

function workspacePatterns(root: string): string[] {
  const pj = readJson<any>(path.join(root, 'package.json'));
  const fromPkg = Array.isArray(pj?.workspaces) ? pj.workspaces : pj?.workspaces?.packages ?? [];
  let fromPnpm: string[] = [];
  const pnpm = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpm)) {
    try { fromPnpm = YAML.parse(fs.readFileSync(pnpm, 'utf8'))?.packages ?? []; } catch { /* ignore */ }
  }
  return [...fromPkg, ...fromPnpm];
}

export function discoverWorkspaces(root: string): Workspace[] {
  const dirs = new Set<string>();
  for (const p of workspacePatterns(root)) for (const d of expand(root, p)) dirs.add(d);
  const out: Workspace[] = [];
  for (const dir of [...dirs].sort()) {
    // Never treat this app (or its bundled fixtures) as part of the host repo.
    if (!isInside(root, APP_DIR) && isInside(dir, APP_DIR)) continue;
    const pj = readJson<any>(path.join(dir, 'package.json'));
    if (!pj?.name) continue;
    out.push({ dir, name: pj.name, version: pj.version, deps: { ...pj.peerDependencies, ...pj.devDependencies, ...pj.dependencies } });
  }
  return out;
}

/**
 * Turn the host repo into scan targets.
 * Providers (core, children) come from config paths or from workspaces whose package name is a DS package.
 * Consumers come from config, or are discovered: any workspace (or the root itself) that depends on a DS package.
 */
export function resolveTargets(root: string, config: Config): Target[] {
  const ws = discoverWorkspaces(root);
  const ds = new Set(allDsPackages(config));
  const targets: Target[] = [];
  const seen = new Set<string>();
  const add = (t: Target) => { if (!seen.has(t.dir)) { seen.add(t.dir); targets.push(t); } };
  const depsOf = (dir: string) => {
    const pj = readJson<any>(path.join(dir, 'package.json'));
    return { ...pj?.peerDependencies, ...pj?.devDependencies, ...pj?.dependencies } as Record<string, string>;
  };

  // Per-target options carried from config: aliases, excludes (made absolute), pin file, remote flag.
  const extras = (def: { aliases?: Record<string, string> | undefined; exclude?: string[] | undefined; pin?: { file: string } | undefined } & { remote?: boolean | undefined }, dir: string) => ({
    aliases: def.aliases, pin: def.pin, remote: def.remote,
    exclude: (def.exclude ?? []).map(e => path.resolve(dir, e)),
  });

  const libs: [typeof config.designSystem.core, 'core' | 'child'][] = [
    [config.designSystem.core, 'core'],
    ...(config.designSystem.children ?? []).map(c => [c, 'child'] as [typeof c, 'child']),
  ];
  for (const [lib, role] of libs) {
    const dirs = libraryDirs(root, lib, ws);
    // A library may span several packages (one per framework); scan each as part of the same target name.
    for (const dir of dirs) add({ name: lib.name, dir, role, owner: lib.owner, repo: lib.repo, deps: depsOf(dir), ...extras(lib, dir) });
  }

  if (config.consumers?.length) {
    for (const c of config.consumers) {
      const dir = path.resolve(root, c.path);
      add({ name: c.name, dir, role: 'consumer', owner: c.owner, repo: c.repo, deps: depsOf(dir), ...extras(c, dir) });
    }
  } else {
    for (const w of ws) {
      if (ds.has(w.name)) continue;
      if (Object.keys(w.deps).some(d => ds.has(d))) add({ name: w.name, dir: w.dir, role: 'consumer', deps: w.deps });
    }
    if (!ws.length) {
      const deps = depsOf(root);
      if (Object.keys(deps).some(d => ds.has(d))) {
        const pj = readJson<any>(path.join(root, 'package.json'));
        add({ name: pj?.name ?? path.basename(root), dir: root, role: 'consumer', deps });
      }
    }
  }
  for (const c of config.extraRepos ?? []) {
    const dir = path.resolve(root, c.path);
    add({ name: c.name, dir, role: 'consumer', owner: c.owner, repo: c.repo, deps: depsOf(dir), ...extras(c, dir) });
  }
  return targets;
}

/**
 * The folders that are one library: `sources` (several folders or package globs; inside the clone
 * when it came from git), with `path` too when both are set; else `path`; else the host's
 * workspaces published under its package names.
 */
export function libraryDirs(root: string, lib: Config['designSystem']['core'] & { remote?: boolean | undefined }, ws: { name: string; dir: string }[] = discoverWorkspaces(root)): string[] {
  if (lib.sources?.length) {
    // A clone: its sources are folders inside it, and the clone's root is just the container.
    if (lib.remote && lib.path) return expandSources(path.resolve(root, lib.path), lib.sources);
    return [...(lib.path ? [path.resolve(root, lib.path)] : []), ...expandSources(root, lib.sources)].filter((d, i, a) => a.indexOf(d) === i);
  }
  if (lib.path) return [path.resolve(root, lib.path)];
  return ws.filter(w => lib.packages.includes(w.name)).map(w => w.dir);
}

/** Latest known version of each DS package: its workspace version, else the registry (opt-in), else null. */
export function latestVersions(root: string, config: Config, useRegistry = false): Record<string, string | null> {
  const ws = discoverWorkspaces(root);
  const out: Record<string, string | null> = {};
  const libs = [config.designSystem.core, ...(config.designSystem.children ?? [])];
  for (const lib of libs) {
    for (const pkg of lib.packages) {
      let v = ws.find(w => w.name === pkg)?.version ?? null;
      if (!v && (lib.path || lib.sources?.length)) {
        for (const d of libraryDirs(root, lib, ws)) {
          const pj = readJson<any>(path.join(d, 'package.json'));
          if (pj?.name === pkg) { v = pj.version ?? null; break; }
        }
      }
      if (!v && useRegistry) {
        try { v = execFileSync('npm', ['view', pkg, 'version'], { encoding: 'utf8', timeout: 20000 }).trim() || null; } catch { v = null; }
      }
      out[pkg] = v;
    }
  }
  return out;
}
