import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import semver from 'semver';
import { execFileSync } from 'node:child_process';
import { readJson } from '../paths.js';
import { libraryOfPackage, allDsPackages, type Config } from '../config.js';
import type { Target, VersionRow } from '../types.js';

/** Reads whichever lockfile the host repo uses and answers "which version of pkg does dir get?". */
export class LockfileResolver {
  private npm: Record<string, any> | null = null;
  private pnpm: Record<string, any> | null = null;
  private yarn: Map<string, string> | null = null;
  readonly kind: 'npm' | 'pnpm' | 'yarn' | 'none';

  constructor(private root: string) {
    const npmLock = readJson<any>(path.join(root, 'package-lock.json'));
    if (npmLock?.packages) {
      this.npm = npmLock.packages;
      this.kind = 'npm';
      return;
    }
    const pnpmFile = path.join(root, 'pnpm-lock.yaml');
    if (fs.existsSync(pnpmFile)) {
      // A lockfile can hold several YAML documents (pnpm's env lockfile, then the project's); read them all.
      // One that can't be read costs the version rows, never the run.
      try {
        const docs = YAML.parseAllDocuments(fs.readFileSync(pnpmFile, 'utf8'));
        if (!Array.isArray(docs) || docs.some(d => d.errors.length)) throw new Error('unreadable lockfile');
        this.pnpm = Object.assign({}, ...docs.map(d => (d.toJS() as any)?.importers ?? {}));
        this.kind = 'pnpm';
      } catch {
        this.kind = 'none';
      }
      return;
    }
    const yarnFile = path.join(root, 'yarn.lock');
    if (fs.existsSync(yarnFile)) {
      this.yarn = parseYarnV1(fs.readFileSync(yarnFile, 'utf8'));
      this.kind = 'yarn';
      return;
    }
    this.kind = 'none';
  }

  resolve(dir: string, pkg: string, range: string): string | null {
    const rel = path.relative(this.root, dir).split(path.sep).join('/');
    if (this.npm) {
      // Node resolution: nearest node_modules walking up from the workspace.
      const parts = rel ? rel.split('/') : [];
      for (let i = parts.length; i >= 0; i--) {
        const prefix = parts.slice(0, i).join('/');
        const key = (prefix ? prefix + '/' : '') + 'node_modules/' + pkg;
        const hit = this.npm[key];
        if (hit?.version) return hit.version;
        if (hit?.link && hit.resolved) return this.npm[hit.resolved]?.version ?? null;
      }
      return null;
    }
    if (this.pnpm) {
      const imp = this.pnpm[rel || '.'];
      const d = imp?.dependencies?.[pkg] ?? imp?.devDependencies?.[pkg] ?? imp?.peerDependencies?.[pkg];
      const v = typeof d === 'string' ? d : d?.version;
      if (!v || String(v).startsWith('link:')) return null;
      return String(v).split('(')[0]!;
    }
    if (this.yarn) return this.yarn.get(`${pkg}@${range}`) ?? null;
    return null;
  }
}

/** Minimal yarn v1 lockfile reader: maps every "name@range" spec to its resolved version. */
function parseYarnV1(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let specs: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(' ') && line.trim().endsWith(':') && !line.startsWith('#')) {
      specs = line.slice(0, -1).split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    } else {
      const m = line.match(/^\s+version:?\s+"?([^"\s]+)"?/);
      if (m) for (const s of specs) map.set(s, m[1]!);
    }
  }
  return map;
}

export function scanVersions(root: string, config: Config, targets: Target[], latest: Record<string, string | null>): { rows: VersionRow[]; lockfile: string } {
  const lock = new LockfileResolver(root);
  const ds = new Set(allDsPackages(config));
  const rows: VersionRow[] = [];
  for (const t of targets) {
    if (t.role === 'core') continue; // core doesn't consume itself
    for (const [pkg, range] of Object.entries(t.deps)) {
      if (!ds.has(pkg)) continue;
      const lib = libraryOfPackage(config, pkg);
      if (t.role === 'child' && lib && lib.name === t.name) continue; // a child's own packages
      const lv = latest[pkg] ?? null;
      let resolved: string | null;
      if (/^(workspace:|link:|file:)/.test(range)) resolved = lv; // linked locally: always current
      else resolved = lock.resolve(t.dir, pkg, range) ?? semver.minVersion(range)?.version ?? null;
      const majorsBehind = resolved && lv && semver.valid(resolved) && semver.valid(lv) ? Math.max(0, semver.major(lv) - semver.major(resolved)) : null;
      rows.push({ target: t.name, role: t.role, pkg, library: lib?.name ?? 'unknown', declared: range, resolved, latest: lv, majorsBehind });
    }
  }
  return { rows, lockfile: lock.kind };
}

/**
 * SHA-pinned consumption (no published versions): a target names a file holding the core commit it
 * consumes. Currency = how far that commit trails core's main, in days and commits. Read-only git calls.
 */
export function scanPins(root: string, config: Config, targets: Target[]): { rows: VersionRow[]; notes: string[] } {
  const rows: VersionRow[] = [];
  const notes: string[] = [];
  const core = config.designSystem.core;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let mainRef: string | null = null;
  for (const ref of [core.mainRef, 'origin/main', 'main', 'HEAD'].filter(Boolean) as string[]) {
    try { git('rev-parse', '--verify', '--quiet', ref + '^{commit}'); mainRef = ref; break; } catch { /* next */ }
  }
  for (const t of targets) {
    if (!t.pin) continue;
    const file = path.join(t.dir, t.pin.file);
    let sha = '';
    try { sha = fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0]!; } catch { notes.push(`${t.name}: pin file ${t.pin.file} not found.`); continue; }
    if (!mainRef) { notes.push(`${t.name}: core has no git history here, so pin currency can't be measured.`); continue; }
    try {
      const head = git('rev-parse', mainRef);
      const pinTime = Number(git('log', '-1', '--format=%ct', sha));
      const headTime = Number(git('log', '-1', '--format=%ct', head));
      const commits = Number(git('rev-list', '--count', `${sha}..${head}`));
      rows.push({ target: t.name, role: t.role, pkg: `pin:${t.pin.file}`, library: core.name, declared: sha, resolved: sha.slice(0, 7), latest: `${mainRef}@${head.slice(0, 7)}`,
        majorsBehind: null, daysBehind: Math.max(0, Math.round((headTime - pinTime) / 86400)), commitsBehind: commits });
    } catch {
      notes.push(`${t.name}: pinned commit ${sha.slice(0, 7)} isn't in core's history here (fetch core, or the pin points at an unpushed commit).`);
    }
  }
  return { rows, notes };
}
