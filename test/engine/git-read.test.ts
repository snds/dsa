import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { changedFiles, isDirty } from '../../src/engine/git-read.js';
import { gitTouchedFiles } from '../../src/engine/scanners/tokens.js';
import { compareTree } from '../../src/deploy/revision.js';

// dsa reads checkouts it doesn't own. `git status` refreshes and rewrites their index; these reads must not.

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-gitread-')));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.tsx'), 'export const A = 1;\n');
  git('add', '.'); git('commit', '-qm', 'one');
  // A stat change with the same content: a refreshing command (git status) would rewrite the index now.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(dir, 'a.tsx'), later, later);
  return dir;
}
const indexTime = (dir: string) => fs.statSync(path.join(dir, '.git', 'index')).mtimeMs;

test('read-only git: dirtiness, changed files, touched files and the live check never write the index', () => {
  const dir = repo();
  const before = indexTime(dir);
  assert.equal(isDirty(dir), false, 'a stat-only change is not a change');
  fs.writeFileSync(path.join(dir, 'b.tsx'), 'export const B = 2;\n');
  assert.deepEqual(changedFiles(dir), ['b.tsx'], 'untracked files count as changed');
  assert.ok(gitTouchedFiles(dir, 30)?.has(path.join(dir, 'b.tsx')));
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(compareTree(dir, { sha: head } as any).state, 'live');
  fs.writeFileSync(path.join(dir, 'a.tsx'), 'export const A = 3;\n');
  assert.equal(isDirty(dir), true);
  assert.equal(compareTree(dir, { sha: head } as any).state, 'modified');
  assert.equal(indexTime(dir), before, 'the index was rewritten');
});

test('read-only git: the test catches a refreshing command', () => {
  const dir = repo();
  const before = indexTime(dir);
  execFileSync('git', ['-C', dir, 'status', '--porcelain'], { stdio: 'ignore' });
  assert.notEqual(indexTime(dir), before, 'git status rewrites the index (what the other test guards against)');
});
