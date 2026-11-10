import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LabelSchema } from '@snds/dsa';
import { decideMany, judgmentFor, latestEvals, type ElementEval } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { decisionForLabel, labelsForDecision } from '../src/answers.js';
import { appendHumanLabels, decideLabels, humanLabelsFile, labelDecision } from '../src/server.js';

// One answer, saved once and used twice: a decision in Element Review is also a label for the bench, and
// a label in Label Review is also the element's decision. Each label says how it was given.

const el = (id: string, o: Partial<ElementEval> = {}) => ({ id, target: 'ledger', file: `ledger/src/${id}.tsx`, line: 3, element: 'button', role: 'button', verdict: 'replace', use: 'Button', from: 'button', props: { variant: 'outline' }, confidence: 0.72, source: `<button>${id}</button>`, ...o }) as unknown as ElementEval;
const replace = { verdict: 'replace' as const, role: 'button', use: 'Button', props: { variant: 'ghost', size: 'sm' } };

test('a decision over several elements makes one label each, marked as a batch that shares one judgment', () => {
  const evals = [el('a'), el('b'), el('c')];
  const ids = ['a', 'b'];
  const labels = labelsForDecision(evals, replace, { ids, who: 'pat', note: 'toolbar actions', judgment: judgmentFor({ ids }) });
  assert.deepEqual(labels.map(l => l.id), ['a', 'b']);
  assert.ok(labels.every(l => l.how === 'batch' && l.judgment === labels[0]!.judgment && l.judgment!.startsWith('card:')));
  assert.deepEqual(labels[0]!.truth, { verdict: 'replace', use: 'Button', props: { variant: 'ghost', size: 'sm' } });
  assert.deepEqual(labels[0]!.proposed, { verdict: 'replace', use: 'Button', props: { variant: 'outline' }, confidence: 0.72 }, 'what dsa proposed, and how sure it was');
  assert.equal(labels[0]!.notes, 'toolbar actions');
  for (const l of labels) assert.ok(LabelSchema.safeParse(l).success, 'every label meets the schema');
});

test('a single answer is marked alone; a set-aside decision makes no label; a missing name still says it was a person', () => {
  const [one] = labelsForDecision([el('a')], { verdict: 'keep', role: 'button' }, { ids: ['a'], judgment: judgmentFor({ ids: ['a'] }) });
  assert.equal(one!.how, 'alone');
  assert.equal(one!.judgment, undefined);
  assert.equal(one!.labeler, 'unnamed reviewer');
  assert.deepEqual(one!.truth, { verdict: 'keep' });
  assert.deepEqual(labelsForDecision([el('a')], { verdict: 'ignore', role: 'button' }, { ids: ['a'] }), [], 'setting aside is not an answer about the element');
  assert.deepEqual(labelsForDecision([el('a')], replace, { ids: ['gone'] }), [], 'an element no longer in the run has nothing to label');
});

test("a label's answer becomes the element's decision, keeping dsa's own mapping when the component is the same", () => {
  const e = el('a');
  assert.deepEqual(decisionForLabel(e, { verdict: 'replace', use: 'Button', props: { variant: 'ghost' } }), { verdict: 'replace', role: 'button', use: 'Button', props: { variant: 'ghost' }, from: 'button' });
  assert.deepEqual(decisionForLabel(e, { verdict: 'replace', use: 'Toggle' }), { verdict: 'replace', role: 'button', use: 'Toggle', props: {} });
  assert.deepEqual(decisionForLabel(el('b', { gap: 'no color input' } as any), { verdict: 'gap' }), { verdict: 'gap', role: 'button', gap: 'no color input' });
});

test('in dsa serve, either screen writes both records: decisions become labels, and labels become decisions', async () => {
  const root = fixtureCopy();
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { config } = loadConfig(root);
  const { evals } = await latestEvals(data);
  const pick = evals.filter(e => e.verdict === 'replace' && e.use && !e.exception).slice(0, 3);
  assert.equal(pick.length, 3, 'fixture has replaceable elements');

  // Element Review: one answer for two elements.
  const decision = { verdict: 'replace' as const, role: pick[0]!.role, use: pick[0]!.use, props: pick[0]!.props ?? {} };
  const ids = [pick[0]!.id, pick[1]!.id];
  await decideMany(root, config, data, { ids }, decision, 'Sean', 'same toolbar');
  assert.equal(await labelDecision(data, { ids }, decision, 'Sean', 'same toolbar'), 2);
  const rows = fs.readFileSync(humanLabelsFile(data), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(r => r.id).sort(), [...ids].sort());
  assert.ok(rows.every(r => r.how === 'batch' && r.judgment === judgmentFor({ ids }) && r.labeler === 'Sean' && r.notes === 'same toolbar'));

  // Label Review: one answer for the third element, saved as a label, then recorded as its decision.
  const [label] = labelsForDecision(evals, { verdict: 'keep', role: pick[2]!.role }, { ids: [pick[2]!.id], who: 'Sean', note: 'host-only control' });
  const saved = appendHumanLabels(data, [{ ...label!, how: 'spot-check' }]);
  assert.equal(saved.saved, 1);
  const d = await decideLabels(root, config, data, saved.labels);
  assert.deepEqual(d.notDecided, []);
  assert.deepEqual(d.decided.map(x => x.id), [pick[2]!.id]);
  const after = (await latestEvals(data)).evals.find(e => e.id === pick[2]!.id)!;
  assert.equal(after.decided?.decision.verdict, 'keep', 'Element Review sees it as decided, so it is not asked again');
  assert.equal(after.decided?.who, 'Sean');
  const all = fs.readFileSync(humanLabelsFile(data), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(all.length, 3, 'the earlier batch labels are kept');
  assert.equal(all.find(r => r.id === pick[2]!.id).how, 'spot-check');

  // A label about an element the latest run no longer has stays a label only.
  assert.deepEqual((await decideLabels(root, config, data, [{ ...label!, id: 'E-gone' }])).notDecided, ['E-gone']);
});
