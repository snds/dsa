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
});

test('a batch key no review group in this scan has says the scan changed, and asks for the ids', () => {
  const snap = { evals: [], threshold: 0.9 };
  assert.equal(batchForKey(snap, 'E-00000000'), null);
  assert.throws(() => subjectForAnchor('/nonexistent', 'elements:E-00000000', snap), /scan changed since the page was published.*Give the ids instead/);
  assert.deepEqual(subjectForAnchor('/nonexistent', 'elements:E-1,E-2', snap), { kind: 'review', ids: ['E-1', 'E-2'] });
});
