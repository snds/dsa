import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBrief, titleOf, type Subject } from '../src/context.js';
import { anchorKey, anchorOf, setKey, threadIndex } from '../src/threads.js';
import { evidenceOf } from '../src/knows.js';
import type { Snapshot } from '../src/snapshot.js';

// The agentic Inbox: issues ticked together are one conversation (a "set"). Its brief carries each issue's
// evidence; the same issues always make the same anchor; each issue's row can find the conversation.

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-set-')));
const snap = (dataDir: string): Snapshot => ({
  generatedAt: new Date().toISOString(), root: dataDir, dataDir, title: 'sample', run: { id: 'run-1', takenAt: new Date().toISOString() }, threshold: 0.8,
  targets: [{ name: 'app-a', role: 'consumer', dir: dataDir }, { name: 'app-b', role: 'consumer', dir: dataDir }], shots: {}, missingShots: [], hints: [], readiness: [],
  evals: [{ id: 'E-1', target: 'app-a', file: 'a.tsx', line: 1, element: 'select', verdict: 'replace', use: 'Select', confidence: 0.6, reasons: [] }],
  queue: [
    { id: 'F-AAA111', kind: 'finding', rule: 'lookalike', subject: 'Select', title: 'Select overrides', evidence: 'fifteen overrides', places: [{ file: 'a.tsx', line: 1 }], status: 'open' },
    { id: 'F-BBB222', kind: 'finding', rule: 'override', subject: 'DataTable|className', title: 'DataTable className', evidence: 'three consumers', places: [], status: 'open' },
  ],
} as any);
const set: Subject = { kind: 'set', items: [
  { key: 'F-AAA111', title: 'Select overrides', source: { type: 'queue', id: 'F-AAA111' }, app: 'app-a' },
  { key: 'F-BBB222', title: 'DataTable className', source: { type: 'queue', id: 'F-BBB222' }, app: 'app-b' },
] };

test("a set's brief lists the issues with their apps, then each one's own evidence, with starters about them together", () => {
  const b = buildBrief(snap(tmp()), set);
  assert.match(b.markdown, /1\. Select overrides \(F-AAA111 · app-a\)/);
  assert.match(b.markdown, /2\. DataTable className \(F-BBB222 · app-b\)/);
  assert.match(b.markdown, /## 1\. Select overrides[\s\S]*fifteen overrides[\s\S]*## 2\. DataTable className[\s\S]*three consumers/);
  assert.deepEqual(b.starters.map(s => s.label), ['What do these share?', 'Which first?']);
  assert.equal(titleOf(snap(tmp()), set), '2 issues: Select overrides and 1 more');
  assert.match(b.key, /^set-S-[0-9A-F]{8}$/);
});

test('the same issues make the same anchor in any order; one issue is its own issue anchor', () => {
  const swapped: Subject = { kind: 'set', items: [...(set as any).items].reverse() };
  assert.equal(anchorKey(anchorOf(set)), anchorKey(anchorOf(swapped)));
  assert.equal(anchorKey(anchorOf(set)), `set:${setKey(['F-BBB222', 'F-AAA111'])}`);
  assert.equal(anchorKey(anchorOf({ kind: 'set', items: [(set as any).items[0]] })), 'issue:F-AAA111');
});

test("the thread index names a set's issues, so each row can show the conversation", () => {
  const idx = threadIndex([{ id: 'S-1', subject: set, title: 'Two issues', updatedAt: '2026-11-18T00:00:00Z', messages: [{ role: 'user' }] } as any], []);
  const t = idx[anchorKey(anchorOf(set))]!;
  assert.deepEqual(t.members, ['F-AAA111', 'F-BBB222']);
});

test("a set's evidence changes when any of its issues' evidence changes", () => {
  const sn = snap(tmp());
  const a = evidenceOf(sn, set);
  (sn.queue[1] as any).evidence = 'five consumers';
  assert.notEqual(evidenceOf(sn, set), a);
});
