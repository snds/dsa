import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pickElements, routesFor, viteWrapper, visualDir, visualFile } from '../src/visual.js';
import { addWorktree, baseOf, discardSandbox, keepChanges, readSession, sandboxChanges, VITE_WRAPPER, writeSession, type Session } from '../src/sessions.js';
import type { Snapshot } from '../src/snapshot.js';
import { resolveProfile } from '@snds/dsa';
import { useProfile } from '../src/system.js';

// Before/after pictures of a sandbox change: which elements get pictured, where to look, the Vite wrapper
// that lets a worktree serve its linked fonts, and that nothing outside the run's folder can be served.

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-visual-')));
const ev = (id: string, file: string, o: any = {}) => ({ id, target: 'app', file, line: 1, element: 'button', match: { tag: 'button', classes: ['px-2'], text: id }, ...o });

function snap(root: string, evals: any[], shots: Snapshot['shots'] = {}): Snapshot {
  return { generatedAt: '', root, dataDir: root, title: 'T', run: null, threshold: 0.9, targets: [{ name: 'app', role: 'consumer', dir: path.join(root, 'app') }], evals, shots, missingShots: [], queue: [], readiness: [], hints: [] };
}

test('pick: changed files first, one per file before a second from the same file, capped', () => {
  const root = tmp();
  const s = snap(root, [
    ev('E-a1', 'app/src/A.tsx'), ev('E-a2', 'app/src/A.tsx'), ev('E-b1', 'app/src/B.tsx'),
    ev('E-c1', 'app/src/C.tsx'), ev('E-x', 'app/src/Other.tsx', { exception: true }), ev('E-nomatch', 'app/src/A.tsx', { match: undefined }),
  ], { 'E-c1': { file: 'E-c1.png', abs: '', page: '#/c' } });
  const picks = pickElements(s, { repo: { top: path.join(root, 'app') } }, ['src/A.tsx', 'src/B.tsx'], ['E-c1'], 3);
  // Changed files first; the session's own element (another file) still beats a second one from A.
  assert.deepEqual(picks.map(p => p.e.id), ['E-a1', 'E-b1', 'E-c1']);
  assert.equal(picks[0].rel, 'src/A.tsx');
  assert.equal(picks[0].reason, 'in a changed file');
  assert.equal(picks[2].reason, 'part of this session');
  assert.deepEqual(pickElements(s, { repo: { top: path.join(root, 'app') } }, ['src/A.tsx', 'src/B.tsx'], ['E-c1'], 6).map(p => p.e.id), ['E-a1', 'E-b1', 'E-c1', 'E-a2']);
  assert.deepEqual(pickElements(s, { repo: { top: path.join(root, 'app') } }, ['src/A.tsx'], [], 2).map(p => p.e.id), ['E-a1', 'E-a2'], 'a second from the same file fills the room');
});

test('pick: elements outside the session repo are never picked', () => {
  const root = tmp();
  const s = snap(root, [ev('E-a1', 'app/src/A.tsx')]);
  assert.deepEqual(pickElements(s, { repo: { top: path.join(root, 'elsewhere') } }, ['src/A.tsx'], ['E-a1']), []);
});

test('routes: known pages first (origin dropped), then configured, home, discovered; no repeats; capped', () => {
  assert.deepEqual(routesFor(['http://127.0.0.1:5173/#/material/1', undefined, '#/colours', '#/material/1'], ['#/colours', '#/setup'], ['#/a', '#/b'], 6), ['#/material/1', '#/colours', '#/setup', '', '#/a', '#/b']);
  assert.equal(routesFor([], [], Array.from({ length: 50 }, (_, i) => `#/r${i}`)).length, 25);
  assert.deepEqual(routesFor(['/labs/x.html#portal'], [], []), ['/labs/x.html#portal', '']);
});

test('vite wrapper: merges over the app config and allows the linked folders', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'vite.config.ts'), 'export default {}');
  const src = viteWrapper(dir, [dir, '/real/node_modules'], '/cache/x');
  assert.match(src, /import own from '\.\/vite\.config\.ts'/);
  assert.match(src, /"allow":\["[^"]+","\/real\/node_modules"\]/);
  assert.match(src, /"cacheDir":"\/cache\/x"/);
  assert.match(src, /typeof own === 'function'/);
  // An app without its own config still gets the overrides.
  assert.match(viteWrapper(tmp(), [], '/c'), /const own = \{\};/);
});

test('pictures: only files from the last run, never a path out of its folder', () => {
  const dataDir = tmp();
  const s: any = { id: 'S-1', visual: { key: 'k1' } };
  const f = path.join(visualDir(dataDir, 'S-1'), 'k1', 'before', 'E-1.png');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'png');
  assert.equal(visualFile(dataDir, s, 'k1/before/E-1.png'), f);
  for (const bad of ['k0/before/E-1.png', 'k1/../../x.png', 'k1/before/E-1.json', '/etc/passwd', 'k1/sideways/E-1.png']) assert.equal(visualFile(dataDir, s, bad), null, bad);
  assert.equal(visualFile(dataDir, { id: 'S-1' } as any, 'k1/before/E-1.png'), null, 'no run, no pictures');
});

test('throw away: removes the sandbox, the before copy, and the pictures', () => {
  const repo = tmp();
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const dataDir = tmp();
  const s: Session = { id: `S-t${process.pid}`, subject: { kind: 'scan' }, title: 't', provider: 'claude-code', mode: 'try', repo: { name: 'r', dir: repo, top: repo, sub: '' }, sandbox: null, brief: '', starters: [], messages: [], createdAt: '', updatedAt: '' };
  const base = baseOf(s);
  try {
    addWorktree(s, base, 'HEAD');
    assert.ok(fs.existsSync(path.join(base, '.git')));
    s.visual = { key: 'k', at: '', base: 'abc', target: 'app', diffHash: '', pairs: [], notes: [], seconds: 1 };
    fs.mkdirSync(visualDir(dataDir, s.id), { recursive: true });
    writeSession(dataDir, s);
    discardSandbox(dataDir, s);
    assert.ok(!fs.existsSync(base));
    assert.ok(!fs.existsSync(visualDir(dataDir, s.id)));
    assert.equal(readSession(dataDir, s.id)?.visual, undefined);
    assert.ok(!g('worktree', 'list').includes(base));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('sandbox changes: a repo that ignores node_modules and vendor/ still lists its changes (and keeps them)', () => {
  const repo = tmp();
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nvendor\n');
  fs.writeFileSync(path.join(repo, 'App.tsx'), 'export const A = 1;\n');
  g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(repo, 'node_modules'));
  fs.mkdirSync(path.join(repo, 'vendor', 'acme'), { recursive: true });
  // A system vendored into the repo: the profile asks for it to be linked into sandboxes too.
  useProfile(resolveProfile({ name: 'acme', agent: { sandboxLinks: [path.join('vendor', 'acme')] } }));
  const dataDir = tmp();
  const s: Session = { id: `S-i${process.pid}`, subject: { kind: 'scan' }, title: 'Ignored links', provider: 'claude-code', mode: 'try', repo: { name: 'r', dir: repo, top: repo, sub: '' }, sandbox: null, brief: '', starters: [], messages: [], createdAt: '', updatedAt: '' };
  const sb = path.join(tmp(), 'sb');
  try {
    addWorktree(s, sb, 'HEAD');
    s.sandbox = sb;
    assert.ok(fs.lstatSync(path.join(sb, 'node_modules')).isSymbolicLink(), 'dependencies linked in');
    fs.writeFileSync(path.join(sb, 'App.tsx'), 'export const A = 2;\n');
    fs.writeFileSync(path.join(sb, VITE_WRAPPER), '// ours');
    const ch = sandboxChanges(s);
    assert.deepEqual(ch?.files, [{ status: 'M', file: 'App.tsx' }], 'the change, and nothing of ours');
    assert.match(ch!.diff, /A = 2/);
    const kept = keepChanges(dataDir, s);
    assert.match(kept.branch, /^dsa-agent\/ignored-links/);
    assert.equal(g('show', '--name-only', '--format=', kept.branch).trim(), 'App.tsx');
    assert.ok(fs.lstatSync(path.join(sb, 'vendor', 'acme')).isSymbolicLink(), 'the vendored system linked in');
  } finally { try { g('worktree', 'remove', '--force', sb); } catch { /* gone */ } useProfile(resolveProfile({ name: 'neutral' })); }
});
