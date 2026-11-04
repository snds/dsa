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
