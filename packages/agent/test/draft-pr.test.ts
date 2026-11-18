import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDraftPr, prText, githubWho, type Run } from '../src/draft-pr.js';
import { addDismissal, readDismissals, undoDismissal } from '../src/dismissals.js';
import { propose } from '../src/proposals.js';
import { readSession, writeSession, type Session } from '../src/sessions.js';
import type { Snapshot } from '../src/snapshot.js';

// Redesign stage 7: the last step up the ladder (a draft PR, the person's own, only on the click),
// and dismissing an issue with a reason. Checked on a scratch clone with a stand-in for `gh`.

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const env = { ...process.env, GIT_AUTHOR_NAME: 'Sample', GIT_AUTHOR_EMAIL: 'sample@example.invalid', GIT_COMMITTER_NAME: 'Sample', GIT_COMMITTER_EMAIL: 'sample@example.invalid' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function scratch() {
  const origin = tmp('dsa-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const top = tmp('dsa-clone-');
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(top, 'a.tsx'), 'export const A = () => <button>Go</button>\n');
  git(top, 'add', '.'); git(top, 'commit', '-qm', 'start'); git(top, 'push', '-q', 'origin', 'main');
  git(top, 'switch', '-qc', 'dsa-agent/raw-button');
  fs.writeFileSync(path.join(top, 'a.tsx'), "import { Button } from 'core'\nexport const A = () => <Button>Go</Button>\n");
  git(top, 'commit', '-qam', 'Use Button'); git(top, 'switch', '-q', 'main');
  const dataDir = tmp('dsa-data-');
  const s: Session = {
    id: 'S-pr01', title: 'Raw button in app-a', subject: { kind: 'issue', key: 'F-ABC123', title: 'Raw buttons in app-a' }, provider: 'claude-code', mode: 'try',
    repo: { name: 'app-a', dir: top, top, sub: '' }, sandbox: null, brief: '', starters: [], createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
    messages: [{ role: 'user', text: 'Can this become Button?', at: '' }, { role: 'assistant', text: 'Yes: Button variant=primary. I changed a.tsx.', at: '' }],
    kept: { branch: 'dsa-agent/raw-button', commit: git(top, 'rev-parse', '--short', 'dsa-agent/raw-button'), at: '' },
  } as any;
  writeSession(dataDir, s);
  return { origin, top, dataDir, s };
}

/** Real git; a stand-in gh that records what it was asked. */
function fakeGh(login: string | null) {
  const calls: { args: string[]; input?: string }[] = [];
  const run: Run = (cmd, args, cwd, input) => {
    if (cmd === 'git') return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    calls.push({ args, input });
    if (args[0] === 'api') { if (!login) throw Object.assign(new Error('not logged in'), { stderr: 'gh auth login' }); return login; }
    if (args[0] === 'pr') return 'https://github.com/sample-org/app-a/pull/7';
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { run, calls };
}
const remoteHas = (origin: string, branch: string) => git(origin, 'branch', '--list', branch) !== '';

test('a draft PR opens only on the call, as the signed-in person, as a draft that links the issue', () => {
  const { origin, dataDir, s } = scratch();
  assert.equal(remoteHas(origin, 'dsa-agent/raw-button'), false, 'nothing is pushed before the click');
  const gh = fakeGh('sample-user');
  assert.deepEqual(githubWho(s.repo.top, gh.run), { login: 'sample-user' });

  const r = openDraftPr(dataDir, s, { issue: { key: 'F-ABC123', title: 'Raw buttons in app-a', url: 'https://github.com/sample-org/app-a/issues/3' } }, gh.run);
  assert.equal(r.url, 'https://github.com/sample-org/app-a/pull/7');
  assert.equal(r.number, 7);
  assert.equal(r.login, 'sample-user');
  assert.equal(remoteHas(origin, 'dsa-agent/raw-button'), true, 'the click pushed the kept branch');

  const create = gh.calls.find(c => c.args[0] === 'pr')!;
  assert.ok(create.args.includes('--draft'), 'always a draft');
  assert.equal(create.args[create.args.indexOf('--head') + 1], 'dsa-agent/raw-button');
  assert.match(create.input!, /by @sample-user/);
  assert.match(create.input!, /F-ABC123: Raw buttons in app-a \(https:\/\/github\.com\/sample-org\/app-a\/issues\/3\)/);
  assert.match(create.input!, /Can this become Button\?/);
  assert.deepEqual(readSession(dataDir, s.id)!.pr, { url: r.url, number: 7 }, 'the thread is In PR');

  // Again: the same PR, no second one.
  const again = openDraftPr(dataDir, readSession(dataDir, s.id)!, {}, gh.run);
  assert.equal(again.url, r.url);
  assert.equal(gh.calls.filter(c => c.args[0] === 'pr').length, 1);
});

test('without a gh sign-in or a kept branch, nothing is pushed and the reason is plain', () => {
  const { origin, dataDir, s } = scratch();
  assert.throws(() => openDraftPr(dataDir, s, {}, fakeGh(null).run), /gh auth login/);
  assert.equal(remoteHas(origin, 'dsa-agent/raw-button'), false);
  assert.throws(() => openDraftPr(dataDir, { ...s, kept: undefined }, {}, fakeGh('sample-user').run), /Keep the change as a branch first/);
});

test('the PR text is short and names who opened it', () => {
  const { s } = scratch();
  const t = prText(s, 'sample-user');
  assert.equal(t.title, 'Raw button in app-a');
  assert.match(t.body, /^Opened as a \*\*draft\*\* by @sample-user/);
  assert.doesNotMatch(t.body, /\n\n\n/);
});

test('a dismissal needs an issue, a known label and a reason; accepted, it is recorded and can be undone', () => {
  const dataDir = tmp('dsa-dismiss-');
  const snap = { evals: [], queue: [] } as unknown as Snapshot;
  assert.throws(() => propose(dataDir, snap, [], { kind: 'dismissal', session: 'S-1', rationale: 'r', payload: { issue: 'nope', label: 'meh' } }), /issue key.*label.*reason/s);
  const p = propose(dataDir, snap, [], { kind: 'dismissal', session: 'S-1', rationale: 'The select is a native one on purpose.', payload: { issue: 'F-ABC123', label: 'intended', reason: 'Native select for mobile.' } });
  assert.equal(p.title, 'Dismiss F-ABC123: Meant to be this way');
  addDismissal(dataDir, 'F-ABC123', { label: 'intended', reason: 'Native select for mobile.', who: 'sample-user', date: '2026-11-16', proposal: p.id });
  assert.equal(readDismissals(dataDir)['F-ABC123']!.label, 'intended');
  assert.equal(fs.existsSync(path.join(dataDir, 'agent', 'dismissals.json')), true, 'where the dashboard reads it');
  assert.equal(undoDismissal(dataDir, 'F-ABC123'), true);
  assert.deepEqual(readDismissals(dataDir), {});
});
