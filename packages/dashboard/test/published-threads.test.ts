import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPublishedThreads } from '../src/published-threads.js';

// Redesign stage 9 (D6): a published page carries each thread's summary, not its transcript.

test('summaries only: the question, the last answer, proposals with what people decided, the PR', () => {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-pub-')));
  const agent = path.join(dataDir, 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'threads.json'), JSON.stringify({ threads: {
    'issue:F-1': { anchor: 'issue:F-1', session: 'S-1', title: 'Raw buttons', state: 'in-pr', updatedAt: '2026-11-16T00:00:00Z', turns: 4, openProposals: 0, pr: { url: 'https://github.com/o/r/pull/7', number: 7 } },
    'issue:F-2': { anchor: 'issue:F-2', session: 'S-2', title: 'Opened, never used', state: 'settled', updatedAt: '', turns: 0 },
  } }));
  fs.writeFileSync(path.join(agent, 'sessions', 'S-1.json'), JSON.stringify({ id: 'S-1', messages: [
    { role: 'user', text: 'Can these be Button?' }, { role: 'assistant', text: 'Probably.' }, { role: 'user', text: 'Do it.' }, { role: 'assistant', text: 'Done: Button variant=primary in a.tsx.', tools: [{ name: 'Edit', summary: 'secret detail' }] },
  ] }));
  fs.writeFileSync(path.join(agent, 'proposals.jsonl'), [
    JSON.stringify({ id: 'P-1', kind: 'decision', session: 'S-1', title: '3 element(s) → Button', status: 'open' }),
    JSON.stringify({ type: 'status', id: 'P-1', status: 'accepted' }),
    JSON.stringify({ id: 'P-2', kind: 'hint', session: 'S-9', title: 'other thread', status: 'open' }),
  ].join('\n'));
  const t = readPublishedThreads(dataDir);
  assert.deepEqual(Object.keys(t), ['issue:F-1'], 'a thread nobody used is left out');
  assert.equal(t['issue:F-1']!.asked, 'Can these be Button?');
  assert.equal(t['issue:F-1']!.answer, 'Done: Button variant=primary in a.tsx.');
  assert.deepEqual(t['issue:F-1']!.proposals, [{ id: 'P-1', kind: 'decision', title: '3 element(s) → Button', status: 'accepted' }]);
  assert.equal(t['issue:F-1']!.pr?.number, 7);
  assert.doesNotMatch(JSON.stringify(t), /Probably|Do it|secret detail/, 'no transcript, no tool detail');
  assert.deepEqual(readPublishedThreads(path.join(dataDir, 'nope')), {});
});
