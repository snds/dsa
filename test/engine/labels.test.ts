import { test } from 'vitest';
import './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { applyLabels, isotonic, lowerBound, readLabels, readyCut, squeeze, type Label } from '../../src/engine/labels.js';
import { reactFeatures, visitWithAncestors, resetFeatureCaches, type ElementFeatures } from '../../src/engine/scanners/features.js';
import { classify } from '../../src/engine/classify.js';
import { buildSignatures } from '../../src/engine/signatures.js';
import { systemRoleMap } from '../../src/engine/roles.js';
import { latestEvals } from '../../src/engine/index.js';
import type { ElementEval } from '../../src/engine/elements.js';
import { ACME_UI } from './setup.js';
import { NOW, fixtureCopy, runPipeline } from './fixture.js';

// Review item 20: confidence is measured precision on a label set. Synthetic labels only.

const ev = (i: number, over: Partial<ElementEval> = {}): ElementEval => ({
  id: `E-${i}`, target: 'app', file: `src/F${i}.tsx`, line: 1, col: 1, element: 'button', fingerprint: `fp${i}`, needsHuman: false,
  verdict: 'replace', role: 'button', use: 'Button', props: { variant: 'default' }, ruleId: 'button.styled', confidence: 0.95, prior: 0.92,
  reasons: [], alternatives: [], visualDiffs: [], a11y: [], snippet: '', source: '', match: { tag: 'button', classes: [], text: '' }, ...over,
} as ElementEval);
const truth = (use: string, props: Record<string, string> = { variant: 'default' }): Label['truth'] => ({ verdict: 'replace', role: 'button', use, props });

test('labels: isotonic fit never lets a higher score mean a lower precision', () => {
  const blocks = isotonic([{ score: 0.5, ok: true }, { score: 0.6, ok: false }, { score: 0.7, ok: true }, { score: 0.8, ok: true }, { score: 0.9, ok: true }]);
  for (let i = 1; i < blocks.length; i++) assert.ok(blocks[i]!.k / blocks[i]!.n >= blocks[i - 1]!.k / blocks[i - 1]!.n);
  assert.equal(blocks.reduce((a, b) => a + b.n, 0), 5);
});

test('labels: ready needs about 300 clean labels (one-sided 95% lower bound at 0.99)', () => {
  assert.ok(lowerBound(300, 300) >= 0.99, String(lowerBound(300, 300)));
  assert.ok(lowerBound(100, 100) < 0.99);
  assert.ok(lowerBound(297, 300) < 0.99);
});

test('labels: without labels nothing changes, and confidence says it is uncalibrated', () => {
  const evals = [ev(1), ev(2)];
  applyLabels(evals, [], 0.9);
  assert.deepEqual(evals.map(e => [e.confidence, e.calibration?.status]), [[0.95, 'uncalibrated'], [0.95, 'uncalibrated']]);
});

test('labels: a path right 27 of 30 times shows about 90%, under the bar, and calibrate() runs on the labels', () => {
  const evals = Array.from({ length: 31 }, (_, i) => ev(i));
  const labels: Label[] = evals.slice(0, 30).map((e, i) => ({ id: e.id, truth: truth(i < 27 ? 'Button' : 'Toggle'), method: 'manual', labeler: 'tester' }));
  const r = applyLabels(evals, labels, 0.9);
  assert.equal(r.matched, 30);
  assert.equal(r.paths, 1);
  const unlabelled = evals[30]!;
  assert.equal(unlabelled.calibration?.status, 'calibrated');
  assert.equal(unlabelled.calibration?.path, 'button.styled|replace');
  assert.ok(Math.abs(unlabelled.calibration!.precision! - 0.9) < 0.01, JSON.stringify(unlabelled.calibration));
  assert.equal(unlabelled.calibration?.ready, false);
  assert.ok(unlabelled.confidence < 0.9 && unlabelled.needsHuman);
  assert.ok(unlabelled.calibrated && unlabelled.calibrated.n === 30, 'the rule prior came from the labels');
  assert.ok(unlabelled.reasons.some(r => /Measured on labels: 90% right/.test(r.text)), JSON.stringify(unlabelled.reasons));
});

test('labels: acceptable alternatives count as right; unreadable lines are skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-labels-'));
  const file = path.join(dir, 'labels.jsonl');
  const lines = [
    JSON.stringify({ id: 'E-1', app: 'app', file: 'src/F1.tsx', line: 1, sourceRef: 'abc', elementHash: 'fp1', truth: truth('Button', { variant: 'ghost' }), acceptableAlts: [truth('Button')], labeler: 'tester', method: 'manual', at: '2026-11-04', notes: '' }),
    '',
    '{ not json',
    JSON.stringify({ app: 'app', file: 'F2.tsx', line: 1, elementHash: 'h2', truth: truth('Button', { variant: 'default', size: 'default' }) }),
  ];
  fs.writeFileSync(file, lines.join('\n'));
  const { labels, skipped } = readLabels(file);
  assert.equal(labels.length, 2);
  assert.equal(skipped, 1);
  const evals = [ev(1), ev(2)];
  const r = applyLabels(evals, labels, 0.9);
  assert.equal(r.matched, 2, 'matched by id, and by app, line and a file path missing its leading folder');
});

test('fit gate: a component matching under 40% of the element\'s look stays under the bar', () => {
  resetFeatureCaches();
  const code = `export const A = () => <button onClick={go} className="h-8 px-3 rounded-none bg-[#123456] text-[#abcdef] border-4 border-dotted font-black shadow-2xl">Go</button>;`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-fit-')), 'x.tsx');
  fs.writeFileSync(file, code);
  let f!: ElementFeatures;
  visitWithAncestors(parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }).program, (n: any, anc: any[]) => { if (n.type === 'JSXElement' && n.openingElement.name.name === 'button') f = reactFeatures(n, [...anc], code, file, []); });
  const sigs = buildSignatures([{ dir: path.join(ACME_UI, 'ui'), name: '@acme/ui' }, { dir: path.join(ACME_UI, 'tokens'), name: '@acme/tokens' }]);
  const e = classify(f, systemRoleMap(), 0.9, sigs);
  assert.ok(e.signature && e.signature.score < 0.4, JSON.stringify(e.signature));
  assert.ok(e.confidence < 0.9);
  assert.ok(e.reasons.some(r => /^Fit gate:/.test(r.text)), JSON.stringify(e.reasons.map(r => r.text)));
});

test('labels: a run reads them from the option and says so', async () => {
  const root = fixtureCopy();
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const first = (await latestEvals(data)).evals[0]!;
  const file = path.join(root, 'labels.jsonl');
  fs.writeFileSync(file, JSON.stringify({ id: first.id, truth: { verdict: first.verdict, role: first.role, use: first.use, props: first.props }, method: 'manual' }) + '\n');
  const res = await runPipeline({ root, dataDir: data, git: false, now: NOW, labels: file });
  assert.ok(res.notes.some(n => /^Labels: 1 read, 1 matched/.test(n)), JSON.stringify(res.notes));
  const again = (await latestEvals(data)).evals.find(e => e.id === first.id)!;
  assert.equal(again.calibration?.status, 'uncalibrated', 'one label is too few for a fit: still uncalibrated, and says so');
});

test('labels: blocks that are not ready keep their order under the bar (no flattening to one value)', () => {
  // Two paths' worth of scores: low scores mostly wrong, high scores mostly right; nothing reaches ready.
  const evals = Array.from({ length: 60 }, (_, i) => ev(i, { confidence: i < 30 ? 0.6 : 0.95, ruleId: 'button.styled' }));
  const labels: Label[] = evals.map((e, i) => ({ id: e.id, truth: truth(i < 30 ? (i < 10 ? 'Button' : 'Toggle') : (i < 58 ? 'Button' : 'Toggle')) }));
  applyLabels(evals, labels, 0.9);
  const low = evals[0]!, high = evals[59]!;
  assert.equal(low.calibration?.ready, false);
  assert.equal(high.calibration?.ready, false);
  assert.ok(high.confidence < 0.9 && low.confidence < high.confidence, `${low.confidence} < ${high.confidence} < 0.9`);
  assert.equal(high.confidence, squeeze(high.calibration!.precision!, 0.9), 'the measured precision, squeezed under the bar');
});

test('labels: a label naming any line of a multi-line opening tag matches the element', () => {
  const e = ev(1, { file: 'app/src/Panel.tsx', line: 10, openEndLine: 14 } as Partial<ElementEval>);
  const r = applyLabels([e], [{ app: 'app', file: 'src/Panel.tsx', line: 12, truth: truth('Button') }], 0.9);
  assert.equal(r.matched, 1);
  const outside = applyLabels([ev(2, { file: 'app/src/Panel.tsx', line: 10, openEndLine: 14 } as Partial<ElementEval>)], [{ app: 'app', file: 'src/Panel.tsx', line: 15, truth: truth('Button') }], 0.9);
  assert.equal(outside.matched, 0);
});

test('labels: equal neighbours pool into one block, so a clean top band is counted whole', () => {
  const pts = [...Array.from({ length: 300 }, (_, i) => ({ score: 0.93 + (i % 3) * 0.01, ok: true })), { score: 0.5, ok: false }];
  const blocks = isotonic(pts);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1]!.n, 300);
  assert.ok(lowerBound(blocks[1]!.k, blocks[1]!.n) >= 0.99);
});

test('labels: ready is decided on the pooled top band; a path with an error in the band stays under the bar', () => {
  const a = Array.from({ length: 700 }, (_, i) => ev(i, { ruleId: 'button.styled', confidence: 0.98 }));
  const b = Array.from({ length: 100 }, (_, i) => ev(1000 + i, { ruleId: 'button.ghost', confidence: 0.98, props: { variant: 'ghost' } }));
  const labels: Label[] = [
    ...a.map(e => ({ id: e.id, truth: truth('Button') })),
    ...b.map((e, i) => ({ id: e.id, truth: truth('Button', { variant: i === 0 ? 'link' : 'ghost' }) })),
  ];
  const fresh = [ev(5000, { ruleId: 'button.styled', confidence: 0.98 }), ev(5001, { ruleId: 'button.ghost', confidence: 0.98, props: { variant: 'ghost' } })];
  // Scores at the clamp (0.98), so per-rule calibration leaves every element in one band.
  applyLabels([...a, ...b, ...fresh], labels, 0.9);
  const [okPath, errPath] = fresh;
  assert.ok(okPath!.calibration!.band!.lower >= 0.99, JSON.stringify(okPath!.calibration));
  assert.equal(okPath!.calibration!.ready, true);
  assert.ok(okPath!.confidence >= 0.9);
  assert.equal(errPath!.calibration!.ready, false, 'its own labels in the band have an error');
  assert.ok(errPath!.confidence < 0.9);
});

test('labels: a top band too small for the bound makes nothing ready', () => {
  const evals = Array.from({ length: 150 }, (_, i) => ev(i, { confidence: 0.95 }));
  applyLabels(evals, evals.map(e => ({ id: e.id, truth: truth('Button') })), 0.9);
  assert.ok(evals.every(e => !e.calibration!.ready && e.confidence < 0.9));
  assert.ok(evals[0]!.reasons.some(r => /no score has a band above it that clears 99% \(the top block has 150 of 150 right/.test(r.text)), JSON.stringify(evals[0]!.reasons));
});

test('labels: points that share a score are one block, whatever order they came in', () => {
  const blocks = isotonic([{ score: 0.9, ok: true }, { score: 0.9, ok: false }, { score: 0.9, ok: true }]);
  assert.equal(blocks.length, 1);
  assert.deepEqual([blocks[0]!.k, blocks[0]!.n], [2, 3]);
});

test('labels: the ready cut is the lowest score whose band clears 0.99, and it applies unchanged to unlabelled elements', () => {
  // 280 clean labels from 0.95 up, then 20 at 0.90 with 3 wrong: a cut at 0.90 drags the bound under 0.99.
  const pts = [...Array.from({ length: 280 }, (_, i) => ({ score: 0.95 + (i % 3) * 0.01, ok: true })), ...Array.from({ length: 20 }, (_, i) => ({ score: 0.9, ok: i >= 3 }))];
  const c = readyCut(pts)!;
  assert.equal(c.cut, 0.95);
  assert.equal(c.n, 280);
  assert.ok(c.lower >= 0.99);
  assert.equal(readyCut(pts.slice(0, 200)), undefined, 'too few clean labels: no cut');
});

test('labels: held-out elements at or above the cut are ready; below it, or on a path with an error in the band, they are not', () => {
  const train = Array.from({ length: 700 }, (_, i) => ev(i, { ruleId: i < 650 ? 'button.styled' : 'button.ghost', confidence: 0.98, ...(i >= 650 ? { props: { variant: 'ghost' } } : {}) }));
  const labels: Label[] = train.map((e, i) => ({ id: e.id, truth: truth('Button', i === 660 ? { variant: 'link' } : e.props as Record<string, string>) }));
  const held = [ev(900, { ruleId: 'button.styled', confidence: 0.98 }), ev(901, { ruleId: 'button.styled', confidence: 0.5 }), ev(902, { ruleId: 'button.ghost', confidence: 0.98, props: { variant: 'ghost' } })];
  applyLabels([...train, ...held], labels, 0.9);
  const [inBand, below, errPath] = held;
  assert.ok(inBand!.calibration!.band, JSON.stringify(inBand!.calibration));
  assert.equal(inBand!.calibration!.ready, true);
  assert.ok(inBand!.confidence >= 0.9);
  assert.equal(below!.calibration!.ready, false);
  assert.equal(errPath!.calibration!.ready, false, 'its path has an error in the band, measured on the labels');
});
