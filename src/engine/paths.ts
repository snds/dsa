import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The dsa package folder (src/engine or dist/engine, two levels down). */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Find the host repo root.
 *
 * The app is meant to be cloned INTO another repo (e.g. <repo>/tools/ds-analytics-suite).
 * That clone has its own .git, so a naive walk-up would stop at the app itself.
 * Rule: start from the cwd; if the cwd is inside the app folder, start from the app's parent.
 * Then walk up to the nearest folder holding .git, or a package.json with workspaces,
 * or a pnpm-workspace.yaml. Falls back to the starting folder.
 */
export function resolveHostRoot(explicit?: string, cwd = process.cwd()): string {
  if (explicit) return path.resolve(cwd, explicit);
  let start = path.resolve(cwd);
  if (isInside(start, APP_DIR)) start = path.dirname(APP_DIR);
  let dir = start;
  // First pass: prefer a workspace root (monorepo), then a git root.
  let gitRoot: string | null = null;
  while (true) {
    if (hasWorkspaces(dir)) return dir;
    if (!gitRoot && fs.existsSync(path.join(dir, '.git'))) gitRoot = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot ?? start;
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function hasWorkspaces(dir: string): boolean {
  if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return true;
  const pj = path.join(dir, 'package.json');
  if (!fs.existsSync(pj)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
    return Boolean(j.workspaces);
  } catch {
    return false;
  }
}

/**
 * Path shown in findings and the report. Files inside the host repo are relative to it; files in a
 * sibling repo read as "<repo-folder>/src/..." rather than "../<repo-folder>/src/...".
 */
export function displayPath(root: string, file: string, targetDir?: string): string {
  const rel = path.relative(root, file);
  if (!rel.startsWith('..') || !targetDir) return rel.split(path.sep).join('/');
  return path.join(path.basename(targetDir), path.relative(targetDir, file)).split(path.sep).join('/');
}

/** Inverse of displayPath: a reported file path, relative to its target's own folder. */
export function targetRelative(root: string, file: string, targetDir: string): string {
  const fromRoot = path.relative(root, targetDir);
  const base = path.basename(targetDir) + '/';
  // Targets outside the host root are displayed as "<folder>/<path>" (see displayPath).
  if (fromRoot.startsWith('..') && file.startsWith(base)) return file.slice(base.length);
  return path.relative(targetDir, path.resolve(root, file)).split(path.sep).join('/');
}

export function readJson<T = any>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Directories never scanned. The app's own folder is always excluded too. */
export const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.dsa', '.next', '.nuxt', '.angular', 'out', '.turbo', '.cache', '__tests__', '__mocks__', 'storybook-static']);
/** Test files render components in ways product code doesn't; they are not usage. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Paths to exclude for a given host root. The app's own folder is excluded whenever the
 * host root sits outside it (the normal "cloned into a repo" case). When the root is inside
 * the app (the bundled fixtures), nothing extra is excluded.
 */
export function defaultExcludes(hostRoot: string): string[] {
  return isInside(hostRoot, APP_DIR) ? [] : [APP_DIR];
}

/** Recursive file walk honoring IGNORE_DIRS and excluded absolute paths. */
export function walk(dir: string, exts: Set<string>, exclude: string[] = [], includeTests = false): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    if (exclude.some(e => isInside(d, e))) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase()) && (includeTests || !TEST_FILE.test(e.name))) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/**
 * Minimal glob: `**` spans folders, `*` and `?` stay within one. A pattern without "/" matches
 * the file name anywhere ("before-tokens.css"); otherwise it matches from the base folder.
 */
export function globMatch(pattern: string, rel: string): boolean {
  const p = pattern.trim().replace(/^\.\//, '');
  if (!p) return false;
  const target = rel.split(path.sep).join('/');
  const esc = (seg: string) => seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  // '**/' may also match zero folders.
  const re = p.split('**/').map(part => part.split('**').map(esc).join('.*')).join('(?:.*/)?');
  return p.includes('/') ? new RegExp(`^${re}$`).test(target) : new RegExp(`(^|/)${re}$`).test(target);
}
