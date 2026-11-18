import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ACME_PROFILE, NOW, fixtureCopy, loadConfig, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { renderReport } from '../../dashboard/src/report.js';
import { buildBrief } from '../src/context.js';
import { writeSnapshot } from '../src/snapshot.js';
import { anchorKey, anchorOf, idsKey } from '../src/threads.js';
import { batchForKey, subjectForAnchor } from '../src/workflow.js';

// Every anchor a published page writes into Discuss on GitHub can be briefed from the scan data alone:
// a clean checkout in a workflow has no thread index, and a review group's key is a hash of its ids.

const payloadOf = (html: string) => JSON.parse(html.match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)![1]!);

/** The anchors the published page emits, the way the page builds them (Inbox subjectOf, Components, group headers). */
function pageAnchors(p: any): string[] {
  const out = new Set<string>(['scan']);
  for (const i of p.issues ?? []) {
    const q = i.source?.type === 'question' ? (p.elements?.questions ?? []).find((x: any) => x.key === i.source.key) : null;
    out.add(q?.ids?.length ? `elements:${idsKey(q.ids)}` : `issue:${i.key}`);
    if (i.component) { out.add(anchorKey(anchorOf({ kind: 'component', name: i.component }))); out.add(anchorKey(anchorOf({ kind: 'group', by: 'component', value: i.component }))); }
    for (const a of i.apps ?? []) out.add(anchorKey(anchorOf({ kind: 'group', by: 'app', value: a })));
  }
  return [...out];
}

test('on the fixture: every anchor the published page emits briefs with no thread index', async () => {
  const root = fixtureCopy();
  const dataDir = tmp();
  const { config } = loadConfig(root);
  await runPipeline({ root, dataDir, git: false, now: NOW });
  const page = payloadOf(await renderReport(root, config, dataDir, ACME_PROFILE, { site: true } as any));
  const snap = await writeSnapshot({ root, config, dataDir, configDir: root, profile: ACME_PROFILE } as any);
  assert.equal(fs.existsSync(path.join(dataDir, 'agent', 'threads.json')), false, 'no thread index, as on a clean checkout');

  const anchors = pageAnchors(page);
  const batches = anchors.filter(a => a.startsWith('elements:'));
  assert.ok(batches.length > 0, 'the fixture has review groups, so batch keys are exercised');
  for (const kind of ['issue:', 'component:', 'group:component:', 'group:app:']) assert.ok(anchors.some(a => a.startsWith(kind)), `the fixture emits ${kind} anchors`);

  for (const a of anchors) {
    const s = subjectForAnchor(dataDir, a, snap);
    assert.ok(buildBrief(snap, s).markdown.length > 0, `${a} briefs`);
    // The subject lands back on the same anchor, so the brief is about what the page showed.
    if (a.startsWith('elements:') || a.startsWith('issue:') || a.startsWith('group:component:')) assert.equal(anchorKey(anchorOf(s)), a, `${a} round-trips`);
  }
  // The batch is the question's own places.
  for (const q of page.elements?.questions ?? []) assert.deepEqual((subjectForAnchor(dataDir, `elements:${idsKey(q.ids)}`, snap) as any).ids, q.ids);
  // Every issue the page lists briefs as that issue, not the whole scan: component checks (C-…), readiness (R-…) too.
  for (const i of page.issues ?? []) {
    const subj = subjectForAnchor(dataDir, `issue:${i.key}`, snap) as any;
    assert.notEqual(buildBrief(snap, subj).markdown.includes('The scan at a glance') && !/^[FA]-/.test(i.key), true, `issue:${i.key} briefs its own subject`);
    if (/^[CR]-/.test(i.key)) assert.ok(subj.source, `issue:${i.key} carries its source`);
  }
  // Anchors lowercase names; the brief gets them back as the scan spells them.
  const comp = (page.issues ?? []).map((i: any) => i.component).find((c: any) => c && c !== c.toLowerCase());
  assert.ok(comp, 'the fixture has a mixed-case component');
  assert.deepEqual(subjectForAnchor(dataDir, `component:${comp.toLowerCase()}`, snap), { kind: 'component', name: comp });
  assert.deepEqual(subjectForAnchor(dataDir, `group:component:${comp.toLowerCase()}`, snap), { kind: 'group', by: 'component', value: comp });
});

test('a batch key no review group in this scan has says the scan changed, and asks for the ids', () => {
  const snap = { evals: [], threshold: 0.9 };
  assert.equal(batchForKey(snap, 'E-00000000'), null);
  assert.throws(() => subjectForAnchor('/nonexistent', 'elements:E-00000000', snap), /scan changed since the page was published.*Give the ids instead/);
  assert.deepEqual(subjectForAnchor('/nonexistent', 'elements:E-1,E-2', snap), { kind: 'review', ids: ['E-1', 'E-2'] });
});

test('component-check and readiness issues brief as themselves; names come back as the scan spells them', () => {
  const snap: any = {
    evals: [{ id: 'E-1', use: 'DataTable' }], threshold: 0.9, queue: [], readiness: [{ subject: 'Commerce kit' }],
    targets: [{ name: 'Commerce kit', role: 'consumer', dir: '/x' }],
    issues: [
      { key: 'C-E9AD5B', kind: 'component-check', title: 'Confirm DataTable is a system component', component: 'DataTable', source: { type: 'component', name: 'DataTable' } },
      { key: 'R-123ABC', kind: 'readiness', title: 'Docs (Commerce kit)', component: null, source: { type: 'readiness', subject: 'Commerce kit' } },
    ],
  };
  assert.deepEqual(subjectForAnchor('/nonexistent', 'issue:C-E9AD5B', snap), { kind: 'issue', key: 'C-E9AD5B', title: 'Confirm DataTable is a system component', source: { type: 'component', name: 'DataTable' } });
  assert.deepEqual((subjectForAnchor('/nonexistent', 'issue:R-123ABC', snap) as any).source, { type: 'readiness', subject: 'Commerce kit' });
  assert.deepEqual(subjectForAnchor('/nonexistent', 'component:datatable', snap), { kind: 'component', name: 'DataTable' });
  assert.deepEqual(subjectForAnchor('/nonexistent', 'group:app:commerce kit', snap), { kind: 'readiness', subject: 'Commerce kit' });
  assert.deepEqual(subjectForAnchor('/nonexistent', 'component:@acme/ds-react', snap), { kind: 'component', name: '@acme/ds-react' }, 'a name the scan lacks stays as written, colons and slashes too');
  assert.deepEqual(subjectForAnchor('/nonexistent', 'issue:C-000000', snap), { kind: 'issue', key: 'C-000000' }, 'an unknown key still briefs, without a source');
});
