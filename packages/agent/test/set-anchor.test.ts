import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { subjectForAnchor } from '../src/workflow.js';
import { readPublishedThreads } from '../../dashboard/src/published-threads.js';

// The published path for issues discussed together: Discuss on GitHub writes set:<keys>; the workflow
// briefs those issues; the published copy names them in its summaries.

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-setanchor-')));
const snap: any = { evals: [], threshold: 0.8, issues: [
  { key: 'F-AAA111', kind: 'finding', title: 'Select overrides', component: 'Select', source: { type: 'queue', id: 'F-AAA111' } },
  { key: 'Q-BBB222', kind: 'question', title: 'Dropdown selects', component: 'Select', source: { type: 'question', ids: ['E-1'] } },
] };

test('set:<keys> is the issues themselves, with their titles and sources; one key is that issue', () => {
  const s = subjectForAnchor(tmp(), 'set:Q-BBB222,F-AAA111,F-AAA111', snap) as any;
  assert.equal(s.kind, 'set');
  assert.deepEqual(s.items.map((i: any) => [i.key, i.title, i.source.type]), [['Q-BBB222', 'Dropdown selects', 'question'], ['F-AAA111', 'Select overrides', 'queue']]);
  assert.deepEqual(subjectForAnchor(tmp(), 'set:F-AAA111', snap), { kind: 'issue', key: 'F-AAA111', title: 'Select overrides', source: { type: 'queue', id: 'F-AAA111' } });
  assert.throws(() => subjectForAnchor(tmp(), 'set:S-0A1B2C3D', snap), /Give the issues instead/);
});

test("a published summary names a conversation's issues and their apps", () => {
  const dataDir = tmp();
  const dir = path.join(dataDir, 'agent');
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'threads.json'), JSON.stringify({ threads: { 'set:S-1': { session: 'S-1', title: 'Two', state: 'settled', updatedAt: 'x', turns: 2 } } }));
  fs.writeFileSync(path.join(dir, 'sessions', 'S-1.json'), JSON.stringify({ id: 'S-1', subject: { kind: 'set', items: [{ key: 'F-1', title: 'One', app: 'app-a' }, { key: 'F-2' }] }, messages: [{ role: 'user', text: 'Q' }, { role: 'assistant', text: 'A' }] }));
  assert.deepEqual(readPublishedThreads(dataDir)['set:S-1']!.about, [{ key: 'F-1', label: 'One', app: 'app-a' }, { key: 'F-2', label: 'F-2' }]);
});
