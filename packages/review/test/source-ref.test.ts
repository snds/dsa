import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceRef } from '../src/shots.js';

// The run stamp reads the checkout's commit without writing to it: `git status` (and `git diff`) refresh
// the index, and a checkout dsa only reads must stay as it was.

test("the source ref reads a checkout's commit and changes without touching its index", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-ref-'));
  const g = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q');
  fs.writeFileSync(path.join(d, 'a.txt'), 'one');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'one');
  const head = g('rev-parse', 'HEAD');
  const idx = path.join(d, '.git', 'index');
  const old = Date.now() / 1000 - 100;
  fs.utimesSync(idx, old, old);
  // Touched, same content: still the commit.
  fs.utimesSync(path.join(d, 'a.txt'), Date.now() / 1000, Date.now() / 1000);
  const before = fs.statSync(idx).mtimeMs;
  assert.equal(sourceRef(d), head);
  fs.writeFileSync(path.join(d, 'a.txt'), 'two');
  assert.equal(sourceRef(d), 'worktree');
  assert.equal(fs.statSync(idx).mtimeMs, before);
  assert.equal(sourceRef(os.tmpdir()), '');
});
