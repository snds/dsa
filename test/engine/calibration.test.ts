import { test } from 'vitest';
import { ACME_UI } from './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_DIR } from '../../src/engine/paths.js';
import { calibrate, classify, type Evaluation, type Recommendation } from '../../src/engine/classify.js';
import { recordDecision, ruleStats, statsWithout, type Decision, type DecisionsFile, type ElementEval } from '../../src/engine/elements.js';
import { buildSignatures } from '../../src/engine/signatures.js';

// The PLUS_NOUN_LINK case (a host app, 2026-10): the scanner picked Button link at the
// default size and humans chose link xs. Calibration first read that as 0 of 52 (8%), then, after
// #103, as 52 of 52 (99%). Both were wrong: it was two answers, each a props miss.
const PLUS_NOUN_LINK = 'plus-noun-link inline-flex items-center gap-1 text-sm text-primary font-medium border-b border-transparent hover:border-current';
const linkDefault: Recommendation = { verdict: 'replace', role: 'link-button', use: 'Button', from: '@acme/ui/button', props: { variant: 'link' } };
const linkXs: Recommendation = { ...linkDefault, props: { variant: 'link', size: 'xs' } };

const decision = (i: number, d: Recommendation, rec: Recommendation, extra: Partial<Decision> = {}): Decision => ({
  fingerprint: `fp${i}`, file: 'x.tsx', line: i, element: 'button', decision: d,
  recommended: { ...rec, ruleId: 'button.link', confidence: 0.91 }, agreed: false, by: 'human', date: '2026-10-08', ...extra,
});
const file = (decisions: Decision[]): DecisionsFile => ({ file: 'mem', decisions, policies: [] });

const evalOf = (rec: Recommendation, extra: Partial<Evaluation> = {}): Evaluation => ({ ...rec, ruleId: 'button.link', confidence: 0.91, prior: 0.91, reasons: [], alternatives: [], visualDiffs: [], a11y: [], ...extra });

test('calibration: a size-only correction is a props miss, and the fix is offered', () => {
  // Stored agreed: true, as #103 wrote it; agreement is recomputed. 52 separate decisions here.
  const stats = ruleStats([file(Array.from({ length: 52 }, (_, i) => decision(i, linkXs, linkDefault, { agreed: true, propsChanged: true })))]).get('button.link')!;
  assert.deepEqual({ n: stats.n, agree: stats.agree, componentAgree: stats.componentAgree, propFixes: stats.propFixes }, { n: 52, agree: 0, componentAgree: 52, propFixes: 52 });
  assert.deepEqual(stats.fixes, { 'size=xs': 52 });
  const e = calibrate(evalOf(linkDefault), stats);
  assert.ok(e.confidence < 0.9, `the size was wrong every time, so the call as given isn't ready; got ${e.confidence}`);
  assert.deepEqual(e.alternatives[0]!.props, { variant: 'link', size: 'xs' }, 'the learned size is the first alternative');
  assert.ok(e.reasons.some(r => /set size=xs in 52 of 52/.test(r.text)), JSON.stringify(e.reasons));
  assert.match(e.reasons.at(-1)!.text, /as given in 0 of 52.*changed a prop in 52 more/);
});

test('calibration: one pattern answer is one judgment, however many elements it covered', () => {
  // The 2026-10-08 file: CRUMB_LINK (11) and PLUS_NOUN_LINK (41), two answers recorded per member.
  const ds = [
    ...Array.from({ length: 11 }, (_, i) => decision(i, linkXs, linkDefault, { note: 'pattern CRUMB_LINK' })),
    ...Array.from({ length: 41 }, (_, i) => decision(100 + i, linkXs, linkDefault, { judgment: 'pattern:PLUS_NOUN_LINK', note: 'pattern PLUS_NOUN_LINK' })),
  ];
  const stats = ruleStats([file(ds)]).get('button.link')!;
  assert.equal(stats.n, 2, 'two answers, not 52');
  assert.equal(stats.agree, 0);
  assert.deepEqual(stats.fixes, { 'size=xs': 2 });
  // Too few judgments to replace the prior, enough to offer the size both answers chose.
  const e = calibrate(evalOf(linkDefault), stats);
  assert.equal(e.calibrated, undefined);
  assert.equal(e.confidence, 0.86);
  assert.equal(e.alternatives[0]!.props?.size, 'xs');
});

test('calibration: a different component or verdict is a disagreement; a variant change is a props miss', () => {
  const ghost: Recommendation = { verdict: 'replace', role: 'button', use: 'Button', props: { variant: 'ghost' } };
  const objectName: Recommendation = { verdict: 'replace', role: 'record-link', use: 'ObjectName' };
  const keep: Recommendation = { verdict: 'keep', role: 'link-button' };
  const stats = ruleStats([file([
    decision(1, objectName, linkDefault), decision(2, keep, linkDefault), decision(3, linkDefault, linkDefault),
    decision(4, ghost, linkDefault),
    decision(5, linkXs, linkDefault, { by: 'agent' }),
  ])]).get('button.link')!;
  assert.deepEqual({ n: stats.n, agree: stats.agree, componentAgree: stats.componentAgree, propFixes: stats.propFixes }, { n: 4, agree: 1, componentAgree: 2, propFixes: 1 });
  assert.deepEqual(stats.fixes, { 'variant=ghost': 1 });
});

test('calibration: never erases the element\'s own doubts, never passes 0.98, and keeps a close call', () => {
  const stats = ruleStats([file(Array.from({ length: 40 }, (_, i) => decision(i, linkDefault, linkDefault)))]).get('button.link')!;
  assert.deepEqual({ n: stats.n, agree: stats.agree }, { n: 40, agree: 40 });
  // Prior 0.91, own evidence −0.06 (→ 0.85). Humans always agreed, so the rule's base rises; the −0.06 stays.
  const doubt = { text: 'Nearly as close to link/xs.', delta: -0.06 };
  const e = calibrate(evalOf(linkDefault, { confidence: 0.85, reasons: [doubt] }), stats);
  assert.ok(e.reasons.includes(doubt));
  const base = (0.91 * 5 + 40) / 45;
  assert.equal(e.confidence, Math.round((base - 0.06) * 100) / 100, 'base rate minus the element\'s own doubt');
  assert.ok(e.confidence < base);
  // A clean element can't go past the cap.
  const clean = calibrate(evalOf(linkDefault, { prior: 0.97, confidence: 0.97 }), stats);
  assert.ok(clean.confidence <= 0.98, String(clean.confidence));
  // A close call is about this element: other elements' agreement doesn't lift it.
  const close = calibrate(evalOf(linkDefault, { confidence: 0.85, capped: { score: 0.93, closeTo: 'breadcrumb-link' } }), stats);
  assert.ok(close.confidence <= 0.85, String(close.confidence));
});

test('calibration: an element is never part of its own calibration', () => {
  const stats = ruleStats([file([
    ...Array.from({ length: 5 }, (_, i) => decision(i, linkDefault, linkDefault)),
    decision(9, linkXs, linkDefault),
  ])]).get('button.link')!;
  assert.equal(stats.n, 6);
  const without = statsWithout(stats, 'fp9')!;
  assert.deepEqual({ n: without.n, agree: without.agree, propFixes: without.propFixes }, { n: 5, agree: 5, propFixes: 0 });
  assert.equal(statsWithout(stats, 'nobody'), stats);
  // A pattern member drops the whole pattern answer it belonged to.
  const p = ruleStats([file([decision(1, linkXs, linkDefault, { judgment: 'pattern:P' }), decision(2, linkXs, linkDefault, { judgment: 'pattern:P' }), decision(3, linkDefault, linkDefault)])]).get('button.link')!;
  assert.equal(statsWithout(p, 'fp2')!.n, 1);
});

test('recordDecision: a size change agrees on the component and flags the prop change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-'));
  const df = file([]);
  df.file = path.join(dir, 'decisions.json');
  const ev = { ...linkDefault, ruleId: 'button.link', confidence: 0.91, fingerprint: 'abc', file: 'x.tsx', line: 1, element: 'button' } as ElementEval;
  const changed = recordDecision(df, ev, linkXs, 'human');
  assert.equal(changed.agreed, true);
  assert.equal(changed.propsChanged, true);
  const same = recordDecision(df, ev, linkDefault, 'human');
  assert.equal(same.agreed, true);
  assert.equal(same.propsChanged, undefined);
  const other = recordDecision(df, ev, { verdict: 'keep', role: 'link-button' }, 'human');
  assert.equal(other.agreed, false);
});

test('signatures: Button link compares every size, xs included, and names an informative runner-up', async () => {
  const { parse } = await import('@babel/parser');
  const { reactFeatures, visitWithAncestors, resetFeatureCaches } = await import('../../src/engine/scanners/features.js');
  const pkgs = ACME_UI;
  const sigs = buildSignatures([{ dir: path.join(pkgs, 'ui'), name: '@acme/ui' }, { dir: path.join(pkgs, 'tokens'), name: '@acme/tokens' }]);
  const button = sigs.components.get('Button')!;
  assert.ok(button.axes.size?.includes('xs'), 'Button has an xs size');
  assert.ok(button.sigs.some(s => s.variant === 'link' && s.size === 'xs'), 'a link/xs signature is generated');

  resetFeatureCaches();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-'));
  const code = `const PLUS_NOUN_LINK = '${PLUS_NOUN_LINK}';\nexport const A = () => <button className={PLUS_NOUN_LINK}><Icon name="add" /> Link</button>;`;
  const src = path.join(dir, 'x.tsx');
  fs.writeFileSync(src, code);
  let hit: any = null;
  visitWithAncestors(parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }).program, (n: any, anc: any[]) => {
    if (!hit && n.type === 'JSXElement' && n.openingElement.name.name === 'button') hit = reactFeatures(n, [...anc], code, src, []);
  });
  const e = classify(hit, undefined, 0.9, sigs);
  assert.equal(e.ruleId, 'button.link');
  assert.equal(e.signature?.variant, 'link');
  // text-sm with no height: xs (text-xs) is compared and loses on font size. The runner-up is a
  // size the element can tell apart, not lg, which only differs in a height the element doesn't set.
  assert.notEqual(e.signature?.runnerUp?.size, 'lg');
  assert.equal(e.signature?.runnerUp?.size, 'xs');
});
