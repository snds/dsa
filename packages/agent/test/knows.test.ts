import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBrief } from '../src/context.js';
import { evidenceOf, pastDecisions, whatTheAgentKnows } from '../src/knows.js';
import { createHandler } from '../src/mcp.js';
import { setStatus, propose } from '../src/proposals.js';
import type { Snapshot } from '../src/snapshot.js';

// Stage 6 of the redesign: what the agent knows, in layers, and when its evidence goes out of date.

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-knows-')));
const snap = (dataDir: string, over: Partial<Snapshot> = {}): Snapshot => ({
  generatedAt: new Date().toISOString(), root: dataDir, dataDir, title: 'sample', run: { id: 'run-41', takenAt: new Date().toISOString() }, threshold: 0.8,
  targets: [{ name: 'app-a', role: 'consumer', dir: dataDir }], shots: { 'E-1': { file: 'e1.png', abs: path.join(dataDir, 'e1.png') } }, missingShots: [], hints: [], readiness: [],
  evals: [
    { id: 'E-1', target: 'app-a', file: 'a.tsx', line: 1, element: 'select', verdict: 'replace', use: 'Select', confidence: 0.6, reasons: [] },
    { id: 'E-2', target: 'app-a', file: 'b.tsx', line: 4, element: 'select', verdict: 'replace', use: 'Select', confidence: 0.9, reasons: [], decided: { by: 'human', who: 'sample-user', date: '2026-11-01', decision: { verdict: 'replace', use: 'Select' }, note: 'Billing uses the outline look' } },
  ],
  queue: [{ id: 'F-ABC123', kind: 'finding', rule: 'lookalike', subject: 'Select', title: '15 overrides on Select', evidence: 'e', places: [{ file: 'a.tsx', line: 1 }], status: 'open' }],
  ...over,
});

test('the layers say what is included and what is missing, plainly', () => {
  const data = tmp();
  const src = whatTheAgentKnows(snap(data), { kind: 'review', ids: ['E-1', 'E-2'] });
  const by = (n: string) => src.find(s => s.name === n)!;
  assert.deepEqual([...new Set(src.map(s => s.layer))], ['rules', 'system', 'evidence', 'memory', 'repo']);
  assert.equal(by('Photos').status, 'included');
  assert.match(by('Photos').detail, /1 of 2/);
  assert.equal(by('Past decisions').status, 'included');
  assert.equal(by('Usage guidelines').status, 'missing', 'no profile entry: the gap is shown, not hidden');
  assert.match(by('Usage guidelines').detail, /No guidelines found for Select/);
  assert.equal(by('Rejected proposals').status, 'missing');
  assert.equal(by('The code').status, 'included');
  const old = whatTheAgentKnows(snap(data, { run: { id: 'run-1', takenAt: '2026-01-01T00:00:00Z' } }), { kind: 'scan' });
  assert.equal(old.find(s => s.name === 'The code')!.status, 'stale');
});

test('memory: past decisions carry their notes; rejected proposals reach the brief so they are not repeated', () => {
  const data = tmp();
  const sn = snap(data);
  assert.deepEqual(pastDecisions(sn, 'select').map(p => p.note), ['Billing uses the outline look']);
  const p = propose(data, sn, [], { kind: 'issue', session: 'S-1', rationale: 'r', payload: { title: 'Make a Select outline variant', body: 'b' } });
  setStatus(data, p.id, 'rejected', 'sample-user', 'app-b needs its own look');
  const b = buildBrief(sn, { kind: 'queue', id: 'F-ABC123' });
  assert.match(b.markdown, /## What you were given/);
  assert.match(b.markdown, /Billing uses the outline look/);
  assert.match(b.markdown, /Proposals people rejected[\s\S]*Make a Select outline variant: "app-b needs its own look"/);
});

test("the evidence fingerprint changes when the scan changes what a thread rests on, and only then", () => {
  const data = tmp();
  const subject = { kind: 'review' as const, ids: ['E-1'] };
  const a = evidenceOf(snap(data), subject);
  assert.equal(evidenceOf(snap(data, { run: { id: 'run-42', takenAt: new Date().toISOString() } }), subject), a, 'a new scan with the same evidence');
  const changed = snap(data);
  changed.evals[0].confidence = 0.95;
  assert.notEqual(evidenceOf(changed, subject), a);
  const q = evidenceOf(snap(data), { kind: 'queue', id: 'F-ABC123' });
  assert.notEqual(evidenceOf(snap(data, { queue: [{ ...snap(data).queue[0], places: [{ file: 'a.tsx', line: 1 }, { file: 'c.tsx', line: 9 }] }] }), { kind: 'queue', id: 'F-ABC123' }), q);
});

test('MCP: the four new read-only tools answer from the scan', async () => {
  const data = tmp();
  fs.mkdirSync(path.join(data, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(data, 'agent', 'snapshot.json'), JSON.stringify(snap(data)));
  fs.writeFileSync(path.join(data, 'signatures.json'), JSON.stringify([{ component: 'Select', axes: { variant: ['default', 'outline'] }, defaults: { variant: 'default' } }]));
  const h = createHandler({ dataDir: data });
  const list = await h({ method: 'tools/list' });
  for (const n of ['past_decisions', 'component_guidelines', 'tokens_for', 'related_threads']) {
    const t = list.tools.find((x: any) => x.name === n);
    assert.ok(t && t.annotations.readOnlyHint === true, `${n} is listed and read-only`);
  }
  const call = async (name: string, args: any = {}) => (await h({ method: 'tools/call', params: { name, arguments: args } })).content[0].text;
  assert.match(await call('past_decisions', { component: 'Select' }), /Billing uses the outline look/);
  assert.match(await call('component_guidelines', { component: 'Select' }), /No guidelines found for Select/);
  assert.match(await call('tokens_for', { component: 'Select' }), /outline/);
  assert.match(await call('related_threads'), /No related threads/);
});
