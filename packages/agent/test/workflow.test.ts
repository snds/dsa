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

test('the workflow: valid YAML, gated on write access and a daily limit, user text only through env', () => {
  const wf = parse(THREAD_WORKFLOW);
  assert.deepEqual(Object.keys(wf.on).sort(), ['issue_comment', 'issues']);
  const job = wf.jobs.reply;
  assert.match(job.if, /dsa-thread/);
  assert.match(job.if, /sender\.type != 'Bot'/);
  assert.match(job.if, /dsa:thread-reply/, 'its own replies never start it again');
  const steps: any[] = job.steps;
  const gate = steps.find(s => s.id === 'gate');
  assert.match(gate.run, /collaborators\/\$ACTOR\/permission/);
  assert.match(gate.run, /admin\|maintain\|write\) echo "ok=true"/);
  assert.equal(steps.find(s => s.id === 'limit').if, "steps.gate.outputs.ok == 'true'");
  for (const s of steps.filter(s => s.id !== 'gate' && s.id !== 'limit')) assert.equal(s.if?.includes("steps.limit.outputs.ok == 'true'"), true, `${s.name ?? s.uses} runs only past both gates`);
  // Comments and issue text reach scripts as variables, never pasted into a script (no injection).
  for (const s of steps) if (s.run) assert.doesNotMatch(s.run, /\$\{\{/, `${s.name} has no expressions inside its script`);
  assert.equal(job.env.TEXT, '${{ github.event.comment.body || github.event.issue.body }}');
  // The fix is a draft PR; the model key is a secret, never on the page.
  const pr = steps.find(s => s.id === 'pr');
  assert.match(pr.run, /gh pr create .*--draft/);
  assert.doesNotMatch(pr.run, /gh pr merge/);
  assert.equal(steps.find(s => s.name === 'The agent answers').env.ANTHROPIC_API_KEY, '${{ secrets.ANTHROPIC_API_KEY }}');
  assert.match(steps.find(s => s.name === 'Scan and write the brief').run, /npx dsa brief "\$ANCHOR"/);
  assert.match(steps.find(s => s.name === 'Reply').run, /dsa:thread-reply/);
  assert.equal(threadMarker('issue:F-1'), '<!-- dsa:thread issue:F-1 -->');
  assert.equal(REPLY_MARKER, '<!-- dsa:thread-reply -->');
  // The anchor read from the issue body is what the page's marker writes.
  const read = steps.find(s => s.id === 'ask').run as string;
  assert.match(read, /grep -o 'dsa:thread \[A-Za-z0-9:,\._-\]\*'/);
});
