import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_TERMS, capByEvidence, latestEvals, ownKey, ownOf, proposalKey } from '../../src/engine/index.js';
import { NOW, fixtureCopy, runPipeline } from './fixture.js';

// Confidence never outruns what a person can see: nothing is "ready" (at or over the review threshold)
// without a visible photo of it in the app and, for a replacement, the proposal drawn exactly with its own
// content. Held under, it says why; when the evidence arrives the scanner's score comes back.

test('without a photo or an exact render, nothing is ready; each held one says why, plainly', async () => {
  const root = fixtureCopy();
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const held = evals.filter(e => e.evidenceCap);
  assert.ok(held.length > 0, 'the fixture has elements the scanner is sure of');
  for (const e of evals) if (!e.decided && !e.exception) assert.ok(e.confidence < 0.9, `${e.id} is ${e.confidence}`);
  for (const e of held) {
    assert.ok(e.evidenceCap!.from >= 0.9);
    assert.equal(e.confidence, 0.89);
    assert.equal(e.needsHuman, true);
    assert.ok(e.evidenceCap!.why.includes('there is no photo of it in the app'));
    for (const w of e.evidenceCap!.why) assert.ok(!CODE_TERMS.test(w), w);
  }
});

test('evidence brings the score back: a visible photo and the exact proposal with its own content', async () => {
  const root = fixtureCopy();
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const e = (await latestEvals(data)).evals.find(x => x.evidenceCap && x.verdict === 'replace')!;
  const from = e.evidenceCap!.from;
  // A photo that shows something else isn't evidence.
  fs.mkdirSync(path.join(data, 'shots'), { recursive: true });
  // Stamped with this run (fresh.ts): an unstamped photo, or one from an older run, isn't evidence.
  const stamp = { run: 'r1', at: '2026-10-06T12:00:00.000Z' };
  const shots: any = { run: { id: 'r1', ref: 'abc', at: '2026-10-06T11:00:00.000Z' }, shots: { [e.id]: { file: 'a.png', matchScore: 1, covered: true, ...stamp } } };
  fs.writeFileSync(path.join(data, 'shots', 'index.json'), JSON.stringify(shots));
  await capByEvidence(data);
  let now = (await latestEvals(data)).evals.find(x => x.id === e.id)!;
  assert.ok(now.evidenceCap!.why.includes('something else covers it in its photo'));
  assert.ok(now.evidenceCap!.why.some(w => w.startsWith('the proposal')));
  // A visible photo, and the proposal drawn exactly but with the story's sample: still held, for that.
  // A visible photo with no stamp, or from an older run: still no photo.
  shots.shots[e.id] = { file: 'a.png', matchScore: 1 };
  fs.writeFileSync(path.join(data, 'shots', 'index.json'), JSON.stringify(shots));
  await capByEvidence(data);
  assert.ok((await latestEvals(data)).evals.find(x => x.id === e.id)!.evidenceCap!.why.includes('there is no photo of it in the app'), 'unstamped');
  shots.shots[e.id] = { file: 'a.png', matchScore: 1, run: 'r0', at: '2026-10-05T12:00:00.000Z' };
  fs.writeFileSync(path.join(data, 'shots', 'index.json'), JSON.stringify(shots));
  await capByEvidence(data);
  assert.ok((await latestEvals(data)).evals.find(x => x.id === e.id)!.evidenceCap!.why.includes('there is no photo of it in the app'), 'older run');
  shots.shots[e.id] = { file: 'a.png', matchScore: 1, ...stamp };
  fs.writeFileSync(path.join(data, 'shots', 'index.json'), JSON.stringify(shots));
  const own = ownOf(e, shots.shots[e.id]);
  const items: any = { [proposalKey(e.use!, e.props)]: { use: e.use, props: e.props, check: 'exact', shot: 'p.png', content: 'story default' } };
  fs.mkdirSync(path.join(data, 'rendered'), { recursive: true });
  fs.writeFileSync(path.join(data, 'rendered', 'proposals.json'), JSON.stringify({ items }));
  await capByEvidence(data);
  now = (await latestEvals(data)).evals.find(x => x.id === e.id)!;
  if (own) assert.deepEqual(now.evidenceCap!.why, ["the proposal shows the story's sample content, not this element's own"]);
  // Drawn with its own content: nothing held back, the scanner's score returns, and it's ready.
  items[ownKey(e.use!, e.props, own)] = { use: e.use, props: e.props, check: 'exact', shot: 'own.png', own: true };
  if (!own) items[proposalKey(e.use!, e.props)].content = undefined;
  fs.writeFileSync(path.join(data, 'rendered', 'proposals.json'), JSON.stringify({ items }));
  await capByEvidence(data);
  now = (await latestEvals(data)).evals.find(x => x.id === e.id)!;
  assert.equal(now.evidenceCap, undefined);
  assert.equal(now.confidence, from);
  assert.equal(now.needsHuman, false);
  // Twice in a row changes nothing (the cap never compounds).
  await capByEvidence(data);
  assert.equal((await latestEvals(data)).evals.find(x => x.id === e.id)!.confidence, from);
});

test('a decision a person or agent recorded is never held back', async () => {
  const { applyEvidenceCap } = await import('../../src/engine/index.js');
  const data = fs.mkdtempSync(path.join(fixtureCopy(), '.cap-'));
  const ev = (id: string, o: object) => ({ id, target: 'ledger', file: 'a.tsx', line: 1, element: 'button', verdict: 'replace', use: 'Button', props: {}, confidence: 0.95, match: { tag: 'button', classes: [], text: '' }, reasons: [], ...o }) as any;
  const evals = [ev('d', { decided: { by: 'human', decision: { verdict: 'replace', use: 'Button', props: {} } } }), ev('s', {})];
  assert.equal(applyEvidenceCap(data, evals, 0.9), 1);
  assert.equal(evals[0].confidence, 0.95);
  assert.equal(evals[0].evidenceCap, undefined);
  assert.equal(evals[1].confidence, 0.89);
});

test("another element's photo isn't evidence of this one, however alike their classes", async () => {
  const { applyEvidenceCap } = await import('../../src/engine/index.js');
  const data = fs.mkdtempSync(path.join(fixtureCopy(), '.cap-'));
  fs.mkdirSync(path.join(data, 'shots'));
  const at = '2026-10-06T12:00:00.000Z';
  fs.writeFileSync(path.join(data, 'shots', 'index.json'), JSON.stringify({ run: { id: 'r1', ref: 'abc', at }, shots: { a: { file: 'a.png', matchScore: 1, run: 'r1', at } } }));
  const ev = (id: string) => ({ id, target: 'ledger', file: `${id}.tsx`, line: 1, element: 'div', verdict: 'gap', props: {}, confidence: 0.95, styleSig: 's1', match: { tag: 'div', classes: [], text: '' }, reasons: [] }) as any;
  const evals = [ev('a'), ev('b')];
  applyEvidenceCap(data, evals, 0.9);
  assert.equal(evals[0].evidenceCap, undefined, 'its own photo');
  assert.deepEqual(evals[1].evidenceCap?.why, ['there is no photo of it in the app'], 'only its look-alike has one');
});

test('an isolated render (mounted with recorded props) counts as seeing the element', async () => {
  const { seenInApp } = await import('../../src/engine/index.js');
  assert.equal(seenInApp({ source: 'isolated', drawn: 'mount' }), true);
  assert.equal(seenInApp({ source: 'isolated', blank: true }), false);
  assert.equal(seenInApp({ drawn: 'mount' }), false, 'guessed props, not found by its exact tag');
});
