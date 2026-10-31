import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Config } from './config.js';

/**
 * Child libraries and consumers can live in other repos. Two ways to reach them:
 *  - `path`: a checkout already on disk (e.g. a sibling folder that syncs). Read in place, never modified.
 *  - `git`:  a URL cloned into <data>/remotes/<name> and fetched on every run. Used when `path`
 *            doesn't exist, or always with --remote. The suite only reads these clones.
 * Returns a config copy with paths pointing at what will actually be scanned, and the repos it had
 * to skip (not fetched, no local checkout to fall back on).
 */
export interface SkippedRepo { name: string; url: string; why: string }

export function materializeRemotes(config: Config, root: string, dataDir: string, force = false, log: (m: string) => void = () => {}): { config: Config; notes: string[]; skipped: SkippedRepo[] } {
  const notes: string[] = [];
  const skipped: SkippedRepo[] = [];
  const copy: Config = JSON.parse(JSON.stringify(config));
  const defs: any[] = [...(copy.designSystem.children ?? []), ...(copy.consumers ?? []), ...(copy.extraRepos ?? [])];
  for (const d of defs) {
    if (!d.git?.url) continue;
    const local = d.path ? path.resolve(root, d.path) : null;
    if (local && fs.existsSync(local) && !force) continue;
    const dest = path.join(dataDir, 'remotes', d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    const ref = d.git.ref ?? 'main';
    try {
      if (fs.existsSync(path.join(dest, '.git'))) {
        execFileSync('git', ['-C', dest, 'fetch', '--quiet', '--depth', '500', 'origin', ref], { stdio: 'pipe' });
        execFileSync('git', ['-C', dest, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], { stdio: 'pipe' });
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        execFileSync('git', ['clone', '--quiet', '--depth', '500', '--branch', ref, d.git.url, dest], { stdio: 'pipe' });
      }
      const sha = execFileSync('git', ['-C', dest, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      log(`Remote ${d.name}: ${d.git.url}@${ref} (${sha})`);
      d.path = dest;
      d.remote = true;
    } catch (e: any) {
      const why = String(e.stderr ?? e.message).split('\n')[0];
      const fallback = local && fs.existsSync(local);
      notes.push(`Could not fetch ${d.name} from ${d.git.url} (${why}). ${fallback ? `Scanned the local checkout at ${d.path} instead.` : 'Skipped it this run.'} Check git credentials for that URL.`);
      if (!fallback) { d.path = undefined; skipped.push({ name: String(d.name), url: String(d.git.url), why: why ?? "" }); }
    }
  }
  // Drop defs that resolve to nothing so they don't become phantom targets.
  const reached = (c: any) => !c.git || c.path;
  if (copy.designSystem.children) copy.designSystem.children = copy.designSystem.children.filter(reached);
  if (copy.consumers) copy.consumers = copy.consumers.filter(reached);
  if (copy.extraRepos) copy.extraRepos = copy.extraRepos.filter(reached);
  return { config: copy, notes, skipped };
}
