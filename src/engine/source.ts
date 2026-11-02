import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { isInside, targetRelative } from './paths.js';
import type { Target } from './types.js';
import { resolveTargets } from './workspaces.js';

/**
 * The code behind a review card, for the code viewer. `dsa serve` reads whole files on request
 * (/api/source); a published or saved page can't, so it carries excerpts around each element,
 * merged per file. Every read stays inside the element's target folder.
 */

export interface SourceFile {
  /** owner/name on GitHub, when the target says, and the commit the scan read: for "Open on GitHub". */
  repo?: string | undefined;
  ref?: string | undefined;
  /** Path inside the repo (the target folder's own path, not the display path). */
  rel: string;
  chunks: { start: number; lines: string[] }[];
}

const MAX_LINES = 6000;

/**
 * Files never shown, whatever cites them: environment files, keys and credentials, and dsa's own data
 * folder (secrets.json lives there).
 */
export function isSecretPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/)
  const base = parts[parts.length - 1] ?? ''
  return /^\.env(\..*)?$/i.test(base) || /^(secrets?|credentials?)(\.[\w-]+)?\.(json|ya?ml|toml)$/i.test(base) || /\.(pem|key|p12|pfx|keystore)$/i.test(base)
    || /^id_(rsa|dsa|ecdsa|ed25519)/.test(base) || /^\.?npmrc$|^\.netrc$|^\.pgpass$/.test(base) || parts.includes('.dsa') || parts.includes('.git')
}

/**
 * The target that owns a displayed file, and the file on disk. Null when it isn't readable, escapes its
 * target, or is a secret. Without a target name (evidence from older reports), the first target that
 * holds the file.
 */
export function locate(root: string, targets: Target[], target: string, file: string): { abs: string; rel: string; t: Target } | null {
  const pool = target ? targets.filter(x => x.name === target) : targets
  for (const t of pool) {
    const rel = targetRelative(root, file, t.dir);
    const abs = path.resolve(t.dir, rel);
    if (!isInside(abs, t.dir) || isSecretPath(rel) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    return { abs, rel, t };
  }
  return null;
}

/** The commit a target folder is at, when it's a git checkout. */
function headOf(dir: string): string | undefined {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { return undefined; }
}

/** A whole file, for `dsa serve`. */
export function readSource(root: string, config: Config, target: string, file: string): (SourceFile & { total: number }) | null {
  let targets: Target[] = [];
  try { targets = resolveTargets(root, config); } catch { return null; }
  const at = locate(root, targets, target, file);
  if (!at) return null;
  const all = fs.readFileSync(at.abs, 'utf8').split('\n');
  return { repo: at.t.repo, ref: headOf(at.t.dir), rel: at.rel, chunks: [{ start: 1, lines: all.slice(0, MAX_LINES) }], total: all.length };
}

/**
 * Excerpts for a static page: each element's lines plus `context` lines either side, merged per file.
 * `span` is how many lines the element's own source covers.
 */
export function sourceExcerpts(root: string, config: Config, els: { target: string; file: string; line: number; span?: number | undefined }[], context = 12): Record<string, SourceFile> {
  let targets: Target[] = [];
  try { targets = resolveTargets(root, config); } catch { return {}; }
  const heads = new Map<string, string | undefined>();
  const byFile = new Map<string, { at: NonNullable<ReturnType<typeof locate>>; ranges: [number, number][] }>();
  for (const e of els) {
    const key = e.file;
    let entry = byFile.get(key);
    if (!entry) {
      const at = locate(root, targets, e.target, e.file);
      if (!at) continue;
      entry = { at, ranges: [] };
      byFile.set(key, entry);
    }
    entry.ranges.push([Math.max(1, e.line - context), e.line + (e.span ?? 1) - 1 + context]);
  }
  const out: Record<string, SourceFile> = {};
  for (const [file, { at, ranges }] of byFile) {
    const all = fs.readFileSync(at.abs, 'utf8').split('\n');
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    if (!heads.has(at.t.dir)) heads.set(at.t.dir, headOf(at.t.dir));
    out[file] = { repo: at.t.repo, ref: heads.get(at.t.dir), rel: at.rel, chunks: merged.map(([a, b]) => ({ start: a, lines: all.slice(a - 1, Math.min(b, all.length)) })) };
  }
  return out;
}

/** Caps for evidence excerpts carried in a static page: cited lines only, and bounded in total. */
export const EXCERPT_LIMITS = { context: 12, maxLineChars: 400, maxFiles: 200, maxLines: 6000 }

/**
 * Excerpts around each cited place, for the evidence code reader on a static page: the lines either
 * side of each place (merged per file), long lines cut, and the whole set capped. Places that can't be
 * read (outside the scanned targets, secret files) are left out.
 */
export function placeExcerpts(root: string, config: Config, places: { target?: string | undefined; file: string; line: number }[], limits = EXCERPT_LIMITS): Record<string, SourceFile> {
  const seen = new Set<string>()
  const els = places.filter(p => { const k = `${p.file}:${p.line}`; if (seen.has(k)) return false; seen.add(k); return true })
    .map(p => ({ target: p.target ?? '', file: p.file, line: p.line }))
  const files = [...new Set(els.map(e => e.file))].slice(0, limits.maxFiles)
  const out = sourceExcerpts(root, config, els.filter(e => files.includes(e.file)), limits.context)
  let budget = limits.maxLines
  for (const [file, src] of Object.entries(out)) {
    src.chunks = src.chunks.flatMap(c => {
      if (budget <= 0) return []
      const lines = c.lines.slice(0, budget).map(l => (l.length > limits.maxLineChars ? l.slice(0, limits.maxLineChars) + ' …' : l))
      budget -= lines.length
      return [{ start: c.start, lines }]
    })
    if (!src.chunks.length) delete out[file]
  }
  return out
}
