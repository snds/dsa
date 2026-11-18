import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { badGitRef, badGitUrl, materializeRemotes } from '../../src/engine/remotes.js';

// From the nine-way review (code A C-03, code C C-02 and C-03): a git ref saved from Settings reached
// `git fetch` as an option and ran a command.

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-rin-')));
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

test('refs and URLs that git would read as options, or that run commands, are refused', () => {
  for (const ok of ['main', 'release/1.2', 'v0.4.0', 'feature-x', 'a1b2c3d']) assert.equal(badGitRef(ok), null, ok);
  for (const bad of ['--upload-pack=touch x', '-x', 'a..b', 'main.lock', 'x/', 'a b', '']) assert.ok(badGitRef(bad), bad);
  for (const ok of ['https://github.com/sample-org/ui.git', 'git@github.com:sample-org/ui.git', '/srv/repos/ui', '../ui']) assert.equal(badGitUrl(ok), null, ok);
  for (const bad of ['--upload-pack=touch x', 'ext::sh -c touch% x', 'https://x y', '']) assert.ok(badGitUrl(bad), bad);
});

test('a ref like --upload-pack=… never reaches git: the repo is skipped with a note, and nothing runs', () => {
  const root = tmp(), data = path.join(root, '.dsa'), src = path.join(root, 'ui-src');
  fs.mkdirSync(src);
  execFileSync('git', ['init', '-q', '-b', 'main', src], { env: gitEnv });
  fs.writeFileSync(path.join(src, 'Button.tsx'), 'export const Button = () => null;\n');
  execFileSync('git', ['-C', src, 'add', '-A'], { env: gitEnv });
  execFileSync('git', ['-C', src, 'commit', '-qm', 'x'], { env: gitEnv });
  const proof = path.join(root, 'PWNED');
  const config: any = { designSystem: { core: { name: 'Core', packages: [] }, children: [{ name: 'UI', git: { url: src, ref: `--upload-pack=touch ${proof};git-upload-pack` } }] } };
  const r = materializeRemotes(config, root, data);
  assert.equal(fs.existsSync(proof), false, 'no command ran');
  assert.equal(r.skipped.length, 1);
  assert.match(r.notes.join('\n'), /isn't a branch, tag or commit name/);
  // A normal ref still clones, then fetches.
  config.designSystem.children[0].git.ref = 'main';
  const ok = materializeRemotes(config, root, data);
  assert.equal(ok.skipped.length, 0, ok.notes.join('\n'));
  assert.ok(fs.existsSync(path.join(ok.config.designSystem.children![0]!.path!, 'Button.tsx')));
  const again = materializeRemotes(config, root, data, true);
  assert.equal(again.skipped.length, 0, again.notes.join('\n'));
});
