import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { REPLY_MARKER, THREAD_WORKFLOW, subjectForAnchor, threadMarker } from '../src/workflow.js';
import { writeSession } from '../src/sessions.js';
import { writeThreadIndex } from '../src/threads.js';

// Redesign stage 9: the GitHub route for a published page, and `dsa brief <anchor>`.

test('anchors read back to the subject the brief needs; a thread on record wins', () => {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-wf-')));
  assert.deepEqual(subjectForAnchor(dataDir, 'issue:F-ABC123'), { kind: 'queue', id: 'F-ABC123' });
  assert.deepEqual(subjectForAnchor(dataDir, 'issue:C-5E1413'), { kind: 'issue', key: 'C-5E1413' });
  assert.deepEqual(subjectForAnchor(dataDir, 'component:select'), { kind: 'component', name: 'select' });
  assert.deepEqual(subjectForAnchor(dataDir, 'group:app:app-a'), { kind: 'readiness', subject: 'app-a' });
  assert.deepEqual(subjectForAnchor(dataDir, 'group:component:select'), { kind: 'group', by: 'component', value: 'select' });
  assert.deepEqual(subjectForAnchor(dataDir, 'elements:E-1,E-2'), { kind: 'review', ids: ['E-1', 'E-2'] });
  assert.deepEqual(subjectForAnchor(dataDir, 'scan'), { kind: 'scan' });
  assert.throws(() => subjectForAnchor(dataDir, 'elements:E-ABA86594'), /Give the ids instead/);
  assert.throws(() => subjectForAnchor(dataDir, 'nonsense'), /Not an anchor/);

  writeSession(dataDir, { id: 'S-1', subject: { kind: 'review', ids: ['E-2', 'E-1'] }, messages: [] } as any);
  writeThreadIndex(dataDir, { 'elements:E-ABA86594': { anchor: 'elements:E-ABA86594', session: 'S-1', title: 't', state: 'settled', updatedAt: '', scanId: null, pr: null, openProposals: 0, turns: 1, previous: [] } });
  assert.deepEqual(subjectForAnchor(dataDir, 'elements:E-ABA86594'), { kind: 'review', ids: ['E-2', 'E-1'] });
});

test('the workflow: valid YAML, gated, least privilege, user text only through env', () => {
  const wf = parse(THREAD_WORKFLOW);
  assert.deepEqual(Object.keys(wf.on).sort(), ['issue_comment', 'issues']);
  assert.deepEqual(wf.permissions, {}, 'nothing by default; each job asks for its own');
  assert.equal(wf.concurrency['cancel-in-progress'], false);
  const { gate, reply, fix } = wf.jobs;
  assert.match(gate.if, /dsa-thread/);
  // The label may not exist on the repo (a new-issue link drops it), so the page's marker counts too.
  assert.match(gate.if, /contains\(github\.event\.issue\.body, 'dsa:thread '\)/);
  assert.match(gate.if, /sender\.type != 'Bot'/);
  assert.match(gate.if, /dsa:thread-reply/, 'its own replies never start it again');
  assert.deepEqual(gate.permissions, { issues: 'write' });
  // Replying needs no write access to the code; only a draft fix does.
  assert.deepEqual(reply.permissions, { contents: 'read', issues: 'write' });
  assert.deepEqual(fix.permissions, { contents: 'write', issues: 'write', 'pull-requests': 'write' });
  assert.match(reply.if, /needs\.gate\.outputs\.mode == 'reply'/);
  assert.match(fix.if, /needs\.gate\.outputs\.mode == 'fix'/);
  for (const job of [reply, fix]) {
    const steps: any[] = job.steps;
    assert.equal(steps[0].uses, 'actions/checkout@v4');
    assert.equal(steps[0].with['persist-credentials'], false, 'no token left in .git/config');
    const agent = steps.find(s => s.id === 'agent');
    assert.equal(agent.env.ANTHROPIC_API_KEY, '${{ secrets.ANTHROPIC_API_KEY }}');
    assert.equal(agent.env.GH_TOKEN, undefined, 'the agent step never holds a GitHub token');
    assert.match(agent.run, /unset GH_TOKEN GITHUB_TOKEN/);
    assert.match(agent.run, /claude -p --settings/);
    assert.doesNotMatch(agent.run, /claude-code"?\s*$/m, 'Claude Code is pinned');
    assert.match(agent.run, /@anthropic-ai\/claude-code@\$CC_VERSION/);
    assert.equal(steps.find(s => s.name === 'Reply').if, 'always()', 'every failure still gets a reply');
    const commands = steps.filter(s => s.run).flatMap(s => s.run.split('\n')).filter((l: string) => !l.trim().startsWith('#'));
    assert.equal(commands.some((l: string) => /\bnpx\s+dsa\b/.test(l)), false, 'never npx dsa: an unrelated package has that name');
  }
  const pr = fix.steps.find((s: any) => s.id === 'pr');
  assert.match(pr.run, /gh pr create .*--draft/);
  assert.doesNotMatch(pr.run, /gh pr merge/);
  assert.match(pr.run, /core\.hooksPath=\/dev\/null/);
  assert.equal(reply.steps.find((s: any) => s.id === 'pr'), undefined);
  // Comments and issue text reach scripts as variables, never pasted into a script (no injection).
  for (const job of Object.values<any>(wf.jobs)) for (const s of job.steps) if (s.run) assert.doesNotMatch(s.run, /\$\{\{/, `${s.name} has no expressions inside its script`);
  assert.equal(gate.env.TEXT, '${{ github.event.comment.body || github.event.issue.body }}');
  assert.equal(threadMarker('issue:F-1'), '<!-- dsa:thread issue:F-1 -->');
  assert.equal(REPLY_MARKER, '<!-- dsa:thread-reply -->');
});
