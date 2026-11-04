import { test } from 'vitest';
import './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { reactFeatures, visitWithAncestors, resetFeatureCaches, type ElementFeatures } from '../../src/engine/scanners/features.js';
import { classify } from '../../src/engine/classify.js';
import { buildSignatures, type SignatureSet } from '../../src/engine/signatures.js';
import { pxOf, stateNeeds } from '../../src/engine/constraints.js';
import { isNonProduct } from '../../src/engine/scanners/code.js';
import { systemRoleMap } from '../../src/engine/roles.js';
import { ACME_UI } from './setup.js';

// Review item 16: constraints first, nearest match second, abstain third. Synthetic snippets only.

function features(code: string): ElementFeatures {
  resetFeatureCaches();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-constraints-')), 'x.tsx');
  fs.writeFileSync(file, code);
  const hits: ElementFeatures[] = [];
  visitWithAncestors(parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }).program, (n: any, anc: any[]) => {
    if (n.type === 'JSXElement' && n.openingElement.name.name === 'button') hits.push(reactFeatures(n, [...anc], code, file, []));
  });
  assert.ok(hits[0], 'snippet has a button');
  return hits[0]!;
}

const acmeSigs = (): SignatureSet => buildSignatures([{ dir: path.join(ACME_UI, 'ui'), name: '@acme/ui' }, { dir: path.join(ACME_UI, 'tokens'), name: '@acme/tokens' }]);

/** A tiny system package with the given component sources. */
function system(files: Record<string, string>): SignatureSet {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-sys-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@acme/kit' }));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return buildSignatures([{ dir, name: '@acme/kit' }]);
}

test('constraints: pixels resolve through rem, px, brackets and token chains', () => {
  const values = new Map([['control-h', '2rem'], ['alias-h', 'var(--control-h)'], ['odd', 'calc(1rem + 2px)']]);
  assert.equal(pxOf('1.25rem', values), 20);
  assert.equal(pxOf('[30px]', values), 30);
  assert.equal(pxOf('var:control-h', values), 32);
  assert.equal(pxOf('var:alias-h', values), 32);
  assert.equal(pxOf('var:odd', values), undefined, 'calc() is not guessed');
  assert.equal(pxOf('var:missing', values), undefined);
});

test('constraints: a 20px icon button gets the nearest size (24px), never the 32px one its colours match', () => {
  const e = classify(features(`export const A = () => <button aria-label="Close" onClick={close} className="size-5 hover:bg-accent"><Icon name="close" /></button>;`), systemRoleMap(), 0.9, acmeSigs());
  assert.equal(e.use, 'Button');
  assert.equal(e.props?.size, 'icon-xs', JSON.stringify(e.props));
  assert.ok(e.reasons.some(r => /20px/.test(r.text)), 'the reason names its real size');
});

test('constraints: an icon button exactly between two sizes is unclear, not a guess', () => {
  const e = classify(features(`export const A = () => <button aria-label="Close" onClick={close} className="h-[30px] w-[30px] hover:bg-accent"><Icon name="close" /></button>;`), systemRoleMap(), 0.9, acmeSigs());
  assert.equal(e.verdict, 'unclear');
  assert.ok(e.unclear?.some(w => /between 28px and 32px/.test(w)), JSON.stringify(e.unclear));
  assert.ok(e.confidence < 0.9);
  assert.ok(e.alternatives.some(a => a.use === 'Button'), 'the best guess is still offered');
});

test('constraints: a height token with no pixel value is unresolved input: unclear', () => {
  const e = classify(features(`export const A = () => <button aria-label="Close" onClick={close} className="size-(--mystery-h) hover:bg-accent"><Icon name="close" /></button>;`), systemRoleMap(), 0.9, acmeSigs());
  assert.equal(e.verdict, 'unclear');
  assert.ok(e.unclear?.some(w => /doesn't resolve to pixels/.test(w)), JSON.stringify(e.unclear));
});

test('constraints: a Tailwind step off the size map (h-5) reads as the nearest size, said as off the scale', () => {
  const e = classify(features(`export const A = () => <button onClick={save} className="h-5 px-2 rounded bg-primary text-primary-foreground">Save</button>;`));
  assert.equal(e.use, 'Button');
  assert.equal(e.props?.size, 'xs');
  assert.ok(e.reasons.some(r => /20px, h-5\) isn't on the button size scale/.test(r.text)), JSON.stringify(e.reasons));
});

test('constraints: aria-pressed only maps to a component that can carry it', () => {
  const code = `export const B = () => <button aria-pressed={on} onClick={() => setOn(!on)} className="px-2 hover:bg-accent">Bold</button>;`;
  const f = features(code);
  assert.deepEqual(stateNeeds(f), ['pressed']);
  const plain = system({ 'src/toggle.tsx': `export function Toggle({ className, ...props }: { className?: string }) { return <button data-slot="toggle" className={className} {...props} />; }\n` });
  const ruled = classify(f, systemRoleMap(), 0.9, plain);
  assert.equal(ruled.verdict, 'unclear', 'nothing can carry the pressed state');
  assert.ok(ruled.reasons.some(r => /Toggle is ruled out: it has a pressed state .* no prop for it/.test(r.text)), JSON.stringify(ruled.reasons));
  assert.ok(ruled.unclear?.some(w => /couldn't check that Button carries a pressed state/.test(w)), 'the fallback Button is unchecked, so no guess');

  const able = system({ 'src/toggle.tsx': `export function Toggle({ className, pressed, ...props }: { className?: string; pressed?: boolean }) { return <button data-slot="toggle" data-state={pressed ? 'on' : 'off'} className={className} {...props} />; }\n` });
  assert.ok(able.components.get('Toggle')!.props!.includes('pressed'));
  const kept = classify(features(code), systemRoleMap(), 0.9, able);
  assert.equal(kept.use, 'Toggle');
  assert.notEqual(kept.verdict, 'unclear');
});

test('constraints: a primitive brings its state props (a toggle primitive carries pressed)', () => {
  const sigs = system({ 'src/toggle.tsx': `import * as TogglePrimitive from "@acme/primitives/toggle";\nexport function Toggle(props: any) { return <TogglePrimitive.Root data-slot="toggle" {...props} />; }\n` });
  assert.ok(sigs.components.get('Toggle')!.props!.includes('pressed'), JSON.stringify(sigs.components.get('Toggle')!.props));
});

test('item 21: tests, stories, fixtures, stubs and docs are not product code', () => {
  for (const p of ['src/a.test.tsx', 'src/__tests__/a.tsx', 'src/a.stories.tsx', 'src/fixtures/a.tsx', 'src/__stubs__/a.tsx', 'src/api.stub.tsx', 'docs/page.tsx', 'src/demo/a.tsx', 'src/__mocks__/a.tsx'])
    assert.ok(isNonProduct(p), p);
  for (const p of ['src/App.tsx', 'src/features/docsPanel/Panel.tsx', 'src/components/Stubborn.tsx'])
    assert.ok(!isNonProduct(p), p);
});

test('constraints: a prop value the component does not allow is unresolved, not shipped', () => {
  const sigs = system({ 'src/toggle.tsx': `import { cva } from 'class-variance-authority';\nconst v = cva('inline-flex', { variants: { size: { default: 'h-8', lg: 'h-9' } }, defaultVariants: { size: 'default' } });\nexport function Toggle({ size, pressed, ...props }: { size?: 'default' | 'lg'; pressed?: boolean }) { return <button data-slot="toggle" className={v({ size })} {...props} />; }\n` });
  const f = features(`export const B = () => <button aria-pressed={on} aria-label="Bold" onClick={() => setOn(!on)} className="size-6 hover:bg-accent"><Icon name="bold" /></button>;`);
  const e = classify(f, systemRoleMap(), 0.9, sigs);
  assert.equal(e.verdict, 'unclear', JSON.stringify(e.reasons.map(r => r.text)));
  assert.ok(e.unclear?.some(w => /size="sm" isn't a value Toggle allows \(default, lg\)/.test(w)), JSON.stringify(e.unclear));
});

// Review item 22: the app's own design-system rules file, read as constraints.
import { readRules } from '../../src/engine/constraints.js';

function rulesFile(body: unknown): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-rules-')), 'design-system.rules.json');
  fs.writeFileSync(f, JSON.stringify(body));
  return f;
}

test('rules: the shapes teams write are all read', () => {
  const r = readRules(rulesFile({ controlScale: { sm: 28, md: '2rem' }, preferPrimitives: { button: 'Button' }, avoid: ['LegacyButton'] }));
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.deepEqual(r.controlScale, [28, 32]);
  assert.deepEqual(r.prefer, { button: 'Button' });
  assert.deepEqual(r.avoid, ['LegacyButton']);
  assert.deepEqual(readRules('/nonexistent/rules.json'), { error: 'not found' });
});

test('rules: a size off the app\'s control scale is never picked', () => {
  const f = features(`export const A = () => <button aria-label="Close" onClick={close} className="size-5 hover:bg-accent"><Icon name="close" /></button>;`);
  const r = readRules(rulesFile({ controlScale: [28, 32] }));
  assert.ok(!('error' in r));
  const e = classify(f, systemRoleMap(), 0.9, acmeSigs(), r as any);
  assert.equal(e.props?.size, 'icon-sm', 'the nearest size on the scale (28px), not 24px');
});

test('rules: avoided components are ruled out; a preferred component for the element is the only one', () => {
  const code = `export const A = () => <button onClick={save} className="h-8 px-3 rounded bg-primary text-primary-foreground">Save</button>;`;
  const avoid = classify(features(code), systemRoleMap(), 0.9, acmeSigs(), readRules(rulesFile({ avoid: ['Button'] })) as any);
  assert.equal(avoid.verdict, 'unclear');
  assert.ok(avoid.reasons.some(r => /say to avoid Button/.test(r.text)), JSON.stringify(avoid.reasons));
  const prefer = classify(features(code), systemRoleMap(), 0.9, acmeSigs(), readRules(rulesFile({ preferPrimitives: { button: 'ActionButton' } })) as any);
  assert.equal(prefer.verdict, 'unclear', 'the preferred component is not a candidate, so nothing fits');
  assert.ok(prefer.reasons.some(r => /say a <button> becomes ActionButton/.test(r.text)));
});

test('config: recommend { labels, rules, typescript } parses and reaches the engine', async () => {
  const { parseConfig } = await import('../../src/config.js');
  const { engineConfig } = await import('../../src/engine/from-dsa.js');
  const { ACME_PROFILE } = await import('./setup.js');
  const c = parseConfig({ recommend: { labels: 'labels.jsonl', rules: 'design-system.rules.json', typescript: false } });
  assert.deepEqual(c.recommend, { labels: 'labels.jsonl', rules: 'design-system.rules.json', typescript: false });
  assert.deepEqual(engineConfig(c, ACME_PROFILE).recommend, { labels: 'labels.jsonl', rules: 'design-system.rules.json', typescript: false });
  assert.throws(() => parseConfig({ recommend: { typescript: 'yes' } }));
});
