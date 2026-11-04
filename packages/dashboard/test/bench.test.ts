import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Label } from '@snds/dsa';
import { ACME_PROFILE, NOW, fixtureCopy, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { loadConfig as loadDsaConfig } from '../../../src/config.js';
import { engineConfig } from '../../../src/engine/from-dsa.js';
import { bench, benchText, correctness, foldOf, heldOut, predictionsOf, repeatability, splitLabels, type Prediction } from '../src/bench.js';
import { historyLabels, isLabelSource, migratedLabels, reviewQueue, sourceFiles, sourceRef } from '../src/labels.js';
import { lowerBound, wilson } from '../src/stats.js';
import { payloadOf } from '../src/bench-cli.js';
import { renderReport } from '../src/report.js';

// dsa bench keeps two numbers apart: can a person judge the card (presentation), and is the answer right
// (correctness, against labels). Under the ready bar dsa abstains: that is never an error.

const label = (id: string, use: string, props: Record<string, string> = {}, o: Partial<Label> = {}): Label => ({
  id, app: 'ledger', file: `src/${id}.tsx`, line: 3, sourceRef: 'abc', elementHash: 'h', truth: { verdict: 'replace', use, props },
  acceptableAlts: [], labeler: 'pat', method: 'human', at: '2026-10-06T12:00:00Z', ...o,
});
const pred = (id: string, use: string, confidence: number, props: Record<string, string> = {}, o: Partial<Prediction> = {}): Prediction => ({
  id, target: 'ledger', file: `ledger/src/${id}.tsx`, line: 3, verdict: 'replace', use, props, confidence, shown: confidence, source: 'live', ...o,
});

test('precision, recall, abstention and errors are kept apart', () => {
  const labels = [label('a', 'Button', { variant: 'ghost' }), label('b', 'Button'), label('c', 'Toggle'), label('d', 'Tabs'), label('e', 'Link'), label('gone', 'Button')];
  const preds = [
    pred('a', 'Button', 0.95, { variant: 'ghost' }), // claimed, right
    pred('b', 'Button', 0.92, { variant: 'default' }), // claimed, right: a default prop is no prop
    pred('c', 'Button', 0.91), // claimed, wrong
    pred('d', 'Tabs', 0.6), // abstained (right, but not claimed)
    pred('e', 'Button', 0.5), // abstained (wrong, but not claimed: not an error)
  ];
  const c = correctness(labels, preds, 0.9);
  assert.deepEqual([c.labels, c.matched, c.unmatched, c.claimed, c.right, c.wrong, c.abstained], [6, 5, 1, 3, 2, 1, 2]);
  assert.equal(c.precision, 0.6667);
  assert.equal(c.recall, 0.3333, 'right claims over every label');
  assert.equal(c.abstention, 0.3333);
  assert.equal(c.errorRate, 0.1667);
  assert.equal(c.precisionLowerBound, Math.round(lowerBound(2, 3) * 1e4) / 1e4);
  assert.deepEqual(c.byMethod, { human: 6 });
});

test('an acceptable alternative is right; matching falls back to app, file and line', () => {
  const l = label('x', 'Toggle', {}, { id: 'L-x', acceptableAlts: [{ use: 'Button', props: { variant: 'ghost' } }] });
  assert.equal(correctness([l], [pred('E-1', 'Button', 0.95, { variant: 'ghost' }, { file: 'ledger/src/x.tsx' })]).right, 1);
  assert.equal(correctness([l], [pred('E-1', 'Button', 0.95, { variant: 'outline' }, { file: 'ledger/src/x.tsx' })]).wrong, 1);
});

test('a label naming any line of a multi-line opening tag matches it; a line past the tag does not', () => {
  const p = pred('E-1', 'Button', 0.95, {}, { file: 'ledger/src/x.tsx', line: 10, openEndLine: 13 });
  assert.equal(correctness([label('x', 'Button', {}, { id: 'L-x', line: 12 })], [p]).right, 1);
  assert.equal(correctness([label('x', 'Button', {}, { id: 'L-x', line: 14 })], [p]).matched, 0);
});

test('coverage at 99% precision, the reliability curve in 0.05 bins and its calibration error', () => {
  // 100 at 0.97 all right; 10 at 0.93, 5 right; 10 at 0.5, none right.
  const labels: Label[] = [], preds: Prediction[] = [];
  for (let i = 0; i < 120; i++) {
    const id = `e${i}`;
    labels.push(label(id, 'Button'));
    const conf = i < 100 ? 0.97 : i < 110 ? 0.93 : 0.5;
    const right = i < 100 || (i < 110 && i % 2 === 0);
    preds.push(pred(id, right ? 'Button' : 'Toggle', conf));
  }
  const c = correctness(labels, preds, 0.9);
  assert.deepEqual(c.coverageAt99, { from: 0.97, claimed: 100, coverage: 0.8333, precision: 1 });
  const bin = (x: number) => c.reliability.find((b) => b.from <= x && x < b.to)!;
  assert.deepEqual([bin(0.97).n, bin(0.97).accuracy], [100, 1]);
  assert.deepEqual([bin(0.93).n, bin(0.93).accuracy], [10, 0.5]);
  assert.deepEqual([bin(0.5).n, bin(0.5).accuracy], [10, 0]);
  assert.equal(c.reliability.length, 20);
  // |1 - .97|·100 + |.5 - .93|·10 + |0 - .5|·10, over 120.
  assert.equal(c.ece, Math.round(((0.03 * 100 + 0.43 * 10 + 0.5 * 10) / 120) * 1e4) / 1e4);
  assert.deepEqual(c.byApp.ledger!.precision.ci, wilson(105, 110).map((x) => Math.round(x * 1e4) / 1e4));
});

test('the bounds: about 300 of 300 right proves 99% at 95%; Wilson brackets the rate', () => {
  assert.ok(lowerBound(300, 300) > 0.99 && lowerBound(298, 298) < 0.99);
  assert.ok(Math.abs(lowerBound(95, 100) - 0.8977) < 1e-4, 'Clopper-Pearson, checked against the exact binomial tail');
  const [lo, hi] = wilson(8, 10);
  assert.ok(lo < 0.8 && hi > 0.8 && Math.abs(lo - 0.4902) < 1e-3 && Math.abs(hi - 0.9433) < 1e-3);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

const shot = { url: 'shots/a.png', match: 1, box: { x: 1, y: 1, w: 10, h: 10, cw: 20, ch: 20 } };
const page = (evals: object[]) => ({ elements: { threshold: 0.9, questions: [], proposals: { 'Button|variant=ghost': { use: 'Button', props: { variant: 'ghost' }, check: 'exact', url: 'r.png' } }, evals } });
const el = (id: string, o: object = {}) => ({ id, target: 'ledger', file: `ledger/src/${id}.tsx`, line: 3, element: 'button', verdict: 'replace', use: 'Button', props: { variant: 'ghost' }, confidence: 0.95, reasons: [], shot, ...o });

test('two numbers, never merged: presentation from the rubric, correctness from labels', () => {
  const p = page([el('a'), el('b', { shot: null, confidence: 0.6 }), el('c', { exception: 'lab' })]);
  const b = bench(p, [label('a', 'Button', { variant: 'ghost' }), label('b', 'Toggle')]);
  assert.equal(b.presentation.passing, 1);
  assert.equal(b.presentation.recommendations, 2);
  assert.deepEqual(b.presentation.excluded, { unused: 0, lab: 1, exception: 0, ignored: 0 });
  assert.deepEqual([b.correctness!.claimed, b.correctness!.right, b.correctness!.abstained], [1, 1, 1]);
  assert.deepEqual(predictionsOf(p).map((x) => x.id), ['a', 'b'], 'excepted elements are not predictions');
  // Held under the bar for want of a photo: still the scanner's claim, at its own score.
  assert.equal(predictionsOf(page([el('h', { confidence: 0.89, evidenceCap: { from: 0.97, why: [] } })]))[0]!.confidence, 0.97);
  const text = benchText(b);
  assert.match(text, /^Presentation .*\n[\s\S]*\nCorrectness /);
  assert.ok(!/overall|combined/i.test(text));
});

test('repeatability: passes and recommendations that flip, confidence spread, crossings of the ready line', () => {
  const r1 = page([el('a'), el('b', { confidence: 0.91 }), el('c', { confidence: 0.5 })]);
  const r2 = page([el('a', { shot: null }), el('b', { confidence: 0.88 }), el('c', { confidence: 0.52, props: { variant: 'outline' } })]);
  const r = repeatability([r1, r2]);
  assert.equal(r.elements, 3);
  assert.equal(r.passFlips, 2, 'a lost its photo; b fell under the bar with its photo');
  assert.equal(r.verdictFlips, 1);
  assert.equal(r.crossings, 1);
  assert.equal(r.scannerCrossings, 1, 'no cap here: the same line either way');
  assert.equal(r.confidenceSpread.max, 0.03);
});

test('the review queue: disagreements, plus a seeded audit of the rest; people are never re-queued', () => {
  const p = page(Array.from({ length: 40 }, (_, i) => el(`e${i}`)));
  const labels = Array.from({ length: 40 }, (_, i) => label(`e${i}`, i === 3 ? 'Toggle' : 'Button', { variant: 'ghost' }, { id: `e${i}`, method: i === 7 ? 'human' : 'migrated' }));
  const judge = [label('e5', 'Link', {}, { id: 'e5', method: 'consensus', labeler: 'judge' })];
  const q = reviewQueue({ labels, payload: p, judge, audit: 0.1, seed: 's1' });
  assert.deepEqual(q.items.filter((x) => x.why === 'disagree').map((x) => x.id).sort(), ['e3', 'e5']);
  assert.ok(!q.items.some((x) => x.id === 'e7'));
  assert.ok(q.audited > 0 && q.audited < 12, `about a tenth of 37 (${q.audited})`);
  assert.deepEqual(reviewQueue({ labels, payload: p, judge, audit: 0.1, seed: 's1' }).items, q.items, 'the same seed, the same audit');
});

test('reading an app\'s revision never rewrites its git index', () => {
  const dir = tmp();
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.tsx'), 'export const A = 1;\n');
  git('add', '.'); git('commit', '-qm', 'one');
  // A stat-only change: git status would refresh and rewrite the index now.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(dir, 'a.tsx'), later, later);
  const index = () => fs.statSync(path.join(dir, '.git', 'index')).mtimeMs;
  const before = index();
  assert.equal(sourceRef(dir), git('rev-parse', 'HEAD').trim(), 'a stat-only change is not a change');
  fs.writeFileSync(path.join(dir, 'a.tsx'), 'export const A = 2;\n');
  assert.equal(sourceRef(dir), 'worktree');
  assert.equal(index(), before);
});

test('migrated labels never come from vendored copies or non-product files (the scanner skips them)', () => {
  const dir = tmp();
  for (const f of ['src/App.tsx', 'src/Panel.jsx', 'vendor/kit/src/Button.tsx', 'stories/review/specs.tsx', 'docs/page.tsx', 'src/demo/Try.tsx', 'src/api.stub.tsx', 'src/App.test.tsx', 'src/x.stories.tsx']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'export {}\n');
  }
  assert.deepEqual(sourceFiles(dir), ['src/App.tsx', 'src/Panel.jsx']);
  assert.deepEqual(['src/App.tsx', 'vendor/kit/src/Button.tsx', 'stories/a.tsx', 'src/x.stories.tsx', 'src/lib/util.ts'].map(isLabelSource), [true, false, false, false, false], 'history labels use the same rules');
});

test('migrated labels: components stripped back to markup in a copy, then scanned and benched', async () => {
  const root = fixtureCopy();
  fs.cpSync(path.resolve(import.meta.dirname, '../../../test/fixtures/review-demo'), root, { recursive: true });
  // An app already on the system: the true answers are what's there.
  fs.writeFileSync(path.join(root, 'apps/checkout/src/Done.tsx'), [
    "import { Button } from '@acme/ds-react';",
    'export function Done({ save }: any) {',
    '  return (',
    '    <section className="toolbar">',
    '      <Button variant="outline" onClick={save}>Export</Button>',
    '      <Button size="sm" onClick={save}>Place order</Button>',
    '    </section>',
    '  );',
    '}',
  ].join('\n'));
  const before = fs.readFileSync(path.join(root, 'apps/checkout/src/Done.tsx'), 'utf8');
  const loaded = loadDsaConfig({ cwd: root });
  const work = path.join(tmp(), 'work');
  const r = migratedLabels({ root, config: engineConfig(loaded.config, ACME_PROFILE), configFile: loaded.configPath!, workDir: work, now: NOW, apps: ['checkout'] });
  assert.equal(fs.readFileSync(path.join(root, 'apps/checkout/src/Done.tsx'), 'utf8'), before, 'the app is only read');
  const done = r.labels.filter((l) => l.file === 'src/Done.tsx');
  assert.ok(r.labels.length > done.length, 'the fixture app already uses the system elsewhere too');
  assert.deepEqual(done.map((l) => [l.file, l.line, l.truth.use, l.truth.props]), [
    ['src/Done.tsx', 5, 'Button', { variant: 'outline', size: 'default' }],
    ['src/Done.tsx', 6, 'Button', { variant: 'default', size: 'sm' }],
  ]);
  assert.ok(r.labels.every((l) => l.method === 'migrated' && l.app === 'checkout'));
  const stripped = fs.readFileSync(path.join(r.root, 'apps/checkout/src/Done.tsx'), 'utf8');
  assert.match(stripped, /<button className="inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium border bg-background h-9 px-4 py-2"/);
  assert.ok(!stripped.includes('<Button'));
  const cfg = JSON.parse(fs.readFileSync(r.config, 'utf8'));
  assert.equal(cfg.output.dir, path.join(work, 'data'));
  assert.equal(cfg.shots.auto, false);
  // Scan the copy and bench it against the labels.
  const data = path.join(work, 'data');
  await runPipeline({ root: r.root, dataDir: data, git: false, now: NOW, readiness: false });
  const html = await renderReport(r.root, engineConfig(loadDsaConfig({ cwd: r.root }).config, ACME_PROFILE), data, ACME_PROFILE);
  fs.writeFileSync(path.join(work, 'report.html'), html);
  const c = correctness(done, predictionsOf(payloadOf(path.join(work, 'report.html'))));
  assert.equal(c.labels, 2);
  assert.equal(c.matched, 2, 'the scanner sees both stripped buttons, on the lines their components were on');
});

test('history labels: a commit that swapped a raw element for a component labels the raw one, at the commit before', () => {
  const dir = path.join(tmp(), 'app');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'pat', GIT_AUTHOR_EMAIL: 'pat@example.com', GIT_COMMITTER_NAME: 'pat', GIT_COMMITTER_EMAIL: 'pat@example.com' } });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'src/Bar.tsx'), 'export const Bar = () => (\n  <div>\n    <button className="px-2 h-7">Save</button>\n  </div>\n);\n');
  git('add', '.'); git('commit', '-qm', 'raw');
  const parent = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'src/Bar.tsx'), "import { Button } from '@acme/ui';\nexport const Bar = () => (\n  <div>\n    <Button variant=\"ghost\" size=\"sm\">Save</Button>\n  </div>\n);\n");
  git('add', '.'); git('commit', '-qm', 'use the system');
  const r = historyLabels({ app: { name: 'ledger', dir, role: 'consumer' } as any, components: new Set(['Button']), now: NOW });
  assert.equal(r.shallow, false);
  assert.deepEqual(r.labels.map((l) => [l.file, l.line, l.sourceRef, l.truth.use, l.truth.props, l.method]), [['src/Bar.tsx', 3, parent, 'Button', { variant: 'ghost', size: 'sm' }, 'history']]);
});

test('held-out precision at the bar: each fold scored against the run calibrated without it', () => {
  const labels = Array.from({ length: 40 }, (_, i) => label(`f${i}`, 'Button', {}, { id: `L-${i}` }));
  const parts = splitLabels(labels, 2);
  assert.equal(parts[0]!.test.length + parts[1]!.test.length, 40);
  assert.ok(parts.every((p, k) => p.test.every((l) => foldOf(l, 2) === k) && p.train.every((l) => foldOf(l, 2) !== k)));
  const payloadOf = (conf: (i: number) => number, use: (i: number) => string) => ({ elements: { threshold: 0.9, evals: labels.map((l, i) => ({ id: `E-${i}`, target: 'ledger', file: `ledger/${l.file}`, line: 3, verdict: 'replace', use: use(i), props: {}, confidence: conf(i) })), questions: [] } });
  // The plain run claims everything; one in ten is wrong. Fold runs only claim what is right.
  const plain = payloadOf(() => 0.95, (i) => (i % 10 === 0 ? 'Toggle' : 'Button'));
  const fold = payloadOf((i) => (i % 10 === 0 ? 0.5 : 0.95), (i) => (i % 10 === 0 ? 'Toggle' : 'Button'));
  const h = heldOut(labels, plain, { folds: 2, threshold: 0.9, foldPayloads: [fold, fold] });
  assert.deepEqual([h.uncalibrated.claimed, h.uncalibrated.right], [40, 36]);
  assert.deepEqual([h.calibrated!.claimed, h.calibrated!.right, h.calibrated!.precision], [36, 36, 1]);
  const b = bench(plain, labels, { folds: 2, foldPayloads: [fold, fold] });
  assert.ok(/Held out \(2-fold by file\)/.test(benchText(b)), benchText(b));
  assert.throws(() => heldOut(labels, plain, { folds: 2, threshold: 0.9, foldPayloads: [fold] }), /one run per fold/);
});
