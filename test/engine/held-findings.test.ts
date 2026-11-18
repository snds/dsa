import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyObservations } from '../../src/engine/evaluate.js';
import { loadConfig } from '../../src/config.js';

// From the nine-way review (code C C-05): a finding the run couldn't check (its app unreachable or not
// fully read, or a stage failed) was resolved, and its GitHub issue closed, until the next good run.

function store(findings: any[]) {
  const events: any[] = [];
  return {
    events,
    findings,
    all: async () => findings,
    exec: async (sql: string, args: any[]) => { if (/status='resolved'/.test(sql)) findings.find(f => f.id === args[0]).status = 'resolved'; },
    insertMany: async (_t: string, _c: string[], rows: any[][]) => { events.push(...rows.map(r => ({ id: r[0], event: r[3], detail: JSON.parse(r[4]) }))); },
  } as any;
}
const finding = (id: string, owner: string) => ({ id, owner, repo: null, affected: JSON.stringify([owner]), status: 'open' });

test('an unobserved finding in an app the run could not read is held, not resolved', async () => {
  const s = store([finding('F-1', 'app-a'), finding('F-2', 'app-b')]);
  const sum = await applyObservations(s, 'r1', [], new Date(), { targets: ['app-a'], stageFailed: false });
  assert.deepEqual(sum.held, ['F-1']);
  assert.deepEqual(sum.resolved, ['F-2']);
  assert.equal(s.findings[0].status, 'open');
  assert.equal(s.events.find((e: any) => e.id === 'F-1').event, 'held');
});

test('when a stage failed, nothing unobserved is resolved', async () => {
  const s = store([finding('F-1', 'app-a'), finding('F-2', 'app-b')]);
  const sum = await applyObservations(s, 'r1', [], new Date(), { targets: [], stageFailed: true });
  assert.deepEqual(sum.held.sort(), ['F-1', 'F-2']);
  assert.deepEqual(sum.resolved, []);
});

test('a misspelt config key is reported, not silently dropped (code review C C-17)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-cfg-'));
  fs.writeFileSync(path.join(dir, 'dsa.config.json'), JSON.stringify({ $schema: 'x', system: { name: 'S', packages: ['@s/ui'] }, scan: { exlude: ['x'] }, nonsense: 1 }));
  assert.deepEqual(loadConfig({ cwd: dir }).unknownKeys?.sort(), ['nonsense', 'scan.exlude']);
});
