import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ACME_PROFILE, NOW, fixtureCopy, loadConfig, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { renderReport } from '../src/report.js';
import { buildIssues, certaintyOfRule, needsCheck, READINESS_PASS } from '../src/issues.js';

// Stage 1 of the redesign: one list of issues across Actions, Element Review, System and readiness.

const payloadOf = (html: string) => JSON.parse(html.match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)![1]!);

test('each source maps to issues with one certainty word', () => {
  const issues = buildIssues({
    queue: { items: [
      { id: 'F-AAAAAA', kind: 'finding', rule: 'deprecated', subject: 'Select', title: 'Deprecated Select', owner: 'core', affected: ['app-a'], status: 'open' },
      { id: 'F-BBBBBB', kind: 'finding', rule: 'lookalike', subject: 'select', title: 'Look-alike', owner: 'core', affected: ['app-b'], status: 'done' },
      { id: 'A-CCCCCC', kind: 'approval', rule: 'approval', title: 'Replace 3 <button>', owner: 'app-a', affected: ['app-a'], status: 'open', decision: { use: 'Button' }, target: 'app-a' },
    ] },
    elements: {
      questions: [{ key: 'q1', title: 'Is this a Button?', ids: ['e1', 'e2'], options: [{ decision: { use: 'Button' } }] }],
      evals: [{ id: 'e1', target: 'app-a' }, { id: 'e2', target: 'app-b' }],
    },
    model: { components: [
      { name: 'Select', uses: { consumer: 4 }, evidence: { tier: 'export' } },
      { name: 'Button', uses: { consumer: 9 }, evidence: { tier: 'export' } },
      { name: 'Ghost', uses: { consumer: 0 }, evidence: { tier: 'convention' } },
    ] },
    readiness: [{ subject: 'app-a', checks: [{ id: 'rules', title: 'Agent rules', score: 40 }, { id: 'types', title: 'Types', score: 95 }] }],
  });
  const by = (k: string) => issues.filter(i => i.kind === k);
  assert.equal(by('finding').length, 2);
  assert.equal(issues.find(i => i.key === 'F-AAAAAA')!.certainty, 'measured');
  assert.equal(issues.find(i => i.key === 'F-BBBBBB')!.certainty, 'inferred');
  assert.equal(issues.find(i => i.key === 'F-BBBBBB')!.component, 'Select', 'component names match without case');
  assert.equal(issues.find(i => i.key === 'F-BBBBBB')!.status, 'done');
  assert.equal(by('approval')[0]!.component, 'Button');
  assert.equal(by('approval')[0]!.certainty, 'measured');
  const q = by('question')[0]!;
  assert.equal(q.certainty, 'needs-person');
  assert.deepEqual(q.apps.sort(), ['app-a', 'app-b']);
  assert.equal(by('component-check').map(i => i.component).join(), 'Ghost');
  assert.equal(by('component-unused').map(i => i.component).join(), 'Ghost');
  assert.equal(by('readiness').length, 1, 'only checks below the pass mark');
  assert.equal(new Set(issues.map(i => i.key)).size, issues.length, 'keys are unique');
  assert.equal(certaintyOfRule(undefined), 'inferred');
  assert.ok(READINESS_PASS > 0 && needsCheck({ inferred: true }) && !needsCheck({ evidence: { tier: 'export' } }));
});

test('on the fixture: every queue item, question and System flag is exactly one issue, and keys hold across scans', async () => {
  const root = fixtureCopy();
  const data = tmp();
  const { config } = loadConfig(root);
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const p1 = payloadOf(await renderReport(root, config, data, ACME_PROFILE));
  const issues: any[] = p1.issues;
  assert.ok(Array.isArray(issues) && issues.length > 0, 'the fixture has issues');
  assert.equal(new Set(issues.map(i => i.key)).size, issues.length, 'keys are unique');
  for (const i of issues) assert.ok(['measured', 'inferred', 'needs-person'].includes(i.certainty), `${i.key} has one certainty word`);

  const count = (pred: (i: any) => boolean) => issues.filter(pred).length;
  for (const item of p1.queue?.items ?? []) assert.equal(count(i => i.source.type === 'queue' && i.source.id === item.id), 1, `queue ${item.id}`);
  for (const q of p1.elements?.questions ?? []) assert.equal(count(i => i.source.type === 'question' && i.source.key === q.key), 1, `question ${q.key}`);
  for (const c of p1.model?.components ?? []) {
    assert.equal(count(i => i.kind === 'component-check' && i.component === c.name), needsCheck(c) ? 1 : 0, `check ${c.name}`);
    assert.equal(count(i => i.kind === 'component-unused' && i.component === c.name), c.uses?.consumer ? 0 : 1, `unused ${c.name}`);
  }

  // A second scan of the same code: the same issues under the same keys.
  await runPipeline({ root, dataDir: data, git: false, now: new Date(NOW.getTime() + 86_400_000) });
  const p2 = payloadOf(await renderReport(root, config, data, ACME_PROFILE));
  const keyOf = (i: any) => `${i.kind}|${JSON.stringify(i.source)}`;
  const second = new Map<string, string>(p2.issues.map((i: any) => [keyOf(i), i.key]));
  for (const i of issues) if (second.has(keyOf(i))) assert.equal(second.get(keyOf(i)), i.key, `${keyOf(i)} keeps its key`);
  assert.ok(issues.filter(i => second.has(keyOf(i))).length >= issues.length * 0.9, 'nearly every issue is found again');
});

test('a report with no scan yet has an empty issue list', async () => {
  const root = fixtureCopy();
  const p = payloadOf(await renderReport(root, loadConfig(root).config, tmp(), ACME_PROFILE));
  assert.deepEqual(p.issues, []);
});
