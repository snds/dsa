import { spawnSync } from 'node:child_process';

/**
 * Read-only git for checkouts dsa doesn't own (a consumer's, the system's). `git status` and `git diff`
 * refresh stat info and rewrite the index, which is a write into someone else's repo, even with
 * GIT_OPTIONAL_LOCKS=0. These use plumbing only: `git diff-index --name-only HEAD --` never writes, and
 * because it also lists files whose mtime changed but whose content didn't, each one is confirmed by
 * comparing `git hash-object` of the file with the blob at HEAD.
 */

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

export function gitRead(dir: string, args: string[], maxBuffer = 64 * 1024 * 1024): { ok: boolean; status: number | null; out: string } {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: ENV, maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] });
  return { ok: r.status === 0, status: r.status, out: (r.stdout ?? '').trim() };
}

/** Tracked files whose content differs from HEAD (optionally under some paths), relative to the repo's top. */
export function trackedChanges(dir: string, paths: string[] = []): string[] | undefined {
  const top = gitRead(dir, ['rev-parse', '--show-toplevel']);
  const listed = gitRead(dir, ['diff-index', '--name-only', 'HEAD', '--', ...paths]);
  if (!top.ok || !listed.ok) return undefined;
  return listed.out.split('\n').map(s => s.trim()).filter(Boolean).filter(f => {
    const now = gitRead(top.out, ['hash-object', '--', f]);
    const then = gitRead(top.out, ['rev-parse', `HEAD:${f}`]);
    return !now.ok || !then.ok || now.out !== then.out;
  });
}

/** Tracked changes against HEAD: true, false, or undefined when git can't say. */
export function isDirty(dir: string, paths: string[] = []): boolean | undefined {
  const c = trackedChanges(dir, paths);
  return c === undefined ? undefined : c.length > 0;
}

/** Changed tracked files and untracked files git doesn't ignore, relative to the repo's top. */
export function changedFiles(dir: string): string[] {
  const untracked = gitRead(dir, ['ls-files', '--others', '--exclude-standard', '--full-name']).out.split('\n');
  return [...(trackedChanges(dir) ?? []), ...untracked].map(s => s.trim()).filter(Boolean);
}
