import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBrief, legacyOf } from '../src/context.js';
import { createSession, listSessions, readSession, writeSession } from '../src/sessions.js';
import { anchorKey, anchorOf, idsKey, readThreadIndex, threadIndex, threadState, writeThreadIndex } from '../src/threads.js';
import type { Proposal } from '../src/proposals.js';
import type { Snapshot } from '../src/snapshot.js';

// Stage 2 of the redesign: every session is a thread pinned to an anchor, with a state from stored facts.

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-threads-')));
const snap = (dataDir: string): Snapshot => ({
  generatedAt: '2026-11-16T00:00:00Z', root: dataDir, dataDir, title: 'sample', run: { id: 'run-41', takenAt: '2026-11-16T00:00:00Z' }, threshold: 0.8,
  targets: [{ name: 'app-a', role: 'consumer', dir: dataDir }], shots: {}, missingShots: [], hints: [], readiness: [],
  evals: [{ id: 'E-1', target: 'app-a', file: 'a.tsx', line: 1, element: 'button', verdict: 'replace', use: 'Button', confidence: 0.9, reasons: [] }],
  queue: [{ id: 'F-ABC123', kind: 'finding', rule: 'lookalike', subject: 'Select', title: '15 overrides on Select', owner: 'app-a', affected: ['app-a'], why: 'w', evidence: 'e', fix: 'f', exit: 'x' }],
});
const proposal = (session: string, status: Proposal['status']): Proposal => ({ id: `P-${session}-${status}`, kind: 'issue', session, title: 't', rationale: 'r', payload: {}, status, createdAt: '2026-11-16T00:00:00Z' });

test("anchors: today's subjects land on the right anchor, the same ids always make the same one", () => {
  assert.equal(anchorKey(anchorOf({ kind: 'queue', id: 'F-ABC123' })), 'issue:F-ABC123');
  assert.equal(anchorKey(anchorOf({ kind: 'issue', key: 'F-ABC123' })), 'issue:F-ABC123', 'a queue item and its issue share a thread');
  assert.equal(anchorKey(anchorOf({ kind: 'review', ids: ['E-2', 'E-1'] })), anchorKey(anchorOf({ kind: 'review', ids: ['E-1', 'E-2', 'E-1'] })));
  assert.equal(anchorKey(anchorOf({ kind: 'readiness', subject: 'app-a' })), 'group:app:app-a');
  assert.equal(anchorKey(anchorOf({ kind: 'component', name: 'Select' })), 'component:select');
  assert.equal(anchorKey(anchorOf({ kind: 'group', by: 'component', value: 'Select' })), 'group:component:select');
  assert.equal(anchorKey(anchorOf({ kind: 'scan' })), 'scan');
  assert.match(idsKey(['E-1']), /^E-[0-9A-F]{8}$/);
  // Pinned: the browser computes the same key (ui/src/agent/store.tsx).
  assert.equal(idsKey(['E-2', 'E-1']), 'E-ABA86594');
});

test('state comes out of the stored facts, most urgent first', () => {
  const t = { id: 'S-1', subject: { kind: 'scan' as const }, updatedAt: '2026-11-16T00:00:00Z' };
  assert.equal(threadState(t, { running: true, proposals: [proposal('S-1', 'open')] }), 'working');
  assert.equal(threadState({ ...t, pr: { url: 'https://example.test/pr/1' } }, { proposals: [proposal('S-1', 'open')] }), 'in-pr');
  assert.equal(threadState(t, { proposals: [proposal('S-1', 'open')] }), 'waiting-on-you');
  assert.equal(threadState(t, { changedFiles: 2 }), 'changes-ready');
  assert.equal(threadState({ ...t, kept: { branch: 'dsa-agent/x' } }, { changedFiles: 2 }), 'on-a-branch');
  assert.equal(threadState(t, { evidenceChanged: true }), 'out-of-date');
  assert.equal(threadState(t, { proposals: [proposal('S-1', 'accepted')] }), 'settled');
  assert.equal(threadState({ ...t, settledAt: '2026-11-16T00:00:00Z' }), 'settled');
  assert.equal(threadState(t, { proposals: [proposal('S-other', 'open')] }), 'waiting-on-you', "another session's proposals don't count");
});

test('sessions: new ones carry their anchor and scan; old files without them still land on the right issue', () => {
  const data = tmp();
  const s = createSession(snap(data), { kind: 'queue', id: 'F-ABC123' }, { provider: 'claude-code', mode: 'advise' });
  assert.deepEqual(s.anchor, { kind: 'issue', key: 'F-ABC123' });
  assert.equal(s.scanId, 'run-41');
  // A session file written before threads existed: no anchor, no scanId.
  const old = { ...readSession(data, s.id)!, id: 'S-old', updatedAt: '2026-01-01T00:00:00Z' } as any;
  delete old.anchor; delete old.scanId;
  writeSession(data, old);
  const raw = JSON.parse(fs.readFileSync(path.join(data, 'agent', 'sessions', 'S-old.json'), 'utf8'));
  raw.updatedAt = '2026-01-01T00:00:00Z';
  fs.writeFileSync(path.join(data, 'agent', 'sessions', 'S-old.json'), JSON.stringify(raw));

  const index = threadIndex(listSessions(data) as any[], [proposal(s.id, 'open')]);
  const t = index['issue:F-ABC123']!;
  assert.equal(t.session, s.id, 'the newest session is the thread');
  assert.deepEqual(t.previous, ['S-old'], 'the older one is kept as a previous thread');
  assert.equal(t.state, 'waiting-on-you');
  assert.equal(t.openProposals, 1);
  writeThreadIndex(data, index);
  assert.equal(readThreadIndex(data)['issue:F-ABC123']!.session, s.id);
});

test('briefs: issue, component and group subjects reuse the brief that fits', () => {
  const data = tmp();
  const sn = snap(data);
  assert.deepEqual(legacyOf({ kind: 'issue', key: 'F-ABC123' }), { kind: 'queue', id: 'F-ABC123' });
  assert.deepEqual(legacyOf({ kind: 'issue', key: 'Q-1', source: { type: 'question', ids: ['E-1'] }, title: 'Is it a Button?' }), { kind: 'review', ids: ['E-1'], title: 'Is it a Button?' });
  const issue = buildBrief(sn, { kind: 'issue', key: 'F-ABC123', source: { type: 'queue', id: 'F-ABC123' } });
  assert.match(issue.markdown, /15 overrides on Select/);
  const comp = buildBrief(sn, { kind: 'component', name: 'Select' });
  assert.match(comp.markdown, /F-ABC123: 15 overrides on Select/, 'the component brief lists its open work');
  assert.equal(comp.title, 'Component: Select');
  const group = buildBrief(sn, { kind: 'group', by: 'component', value: 'Button' });
  assert.match(group.markdown, /1 element\(s\) in 1 app\(s\)/);
  assert.ok(fs.existsSync(group.file));
});
