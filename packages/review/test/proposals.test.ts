import { test } from 'vitest';
import assert from 'node:assert/strict';
import { lookProps, proposalKey, type ElementEval } from '@snds/dsa/engine';
import { argsParam } from '../src/rendered.js';
import { pickExamples } from '../src/shots.js';

// What the element review needs to choose an answer: every case a decision covers, photographed,
// and the proposed component rendered with exactly the props the recommendation names.

const el = (id: string, file: string, o: Partial<ElementEval> = {}): ElementEval => ({
  id, file, line: 1, element: 'button', verdict: 'replace', role: 'action', use: 'Button', props: { variant: 'ghost', size: 'xs' },
  confidence: 0.8, needsHuman: true, alternatives: [], reasons: [], match: { text: id }, styleSig: 'same', ...o,
} as unknown as ElementEval);

test('a group that needs a decision is photographed case by case, a sure group by a few examples', () => {
  const ask = Array.from({ length: 12 }, (_, i) => el(`a${i}`, `f${i % 2}.tsx`));
  const sure = Array.from({ length: 12 }, (_, i) => el(`s${i}`, `g${i % 2}.tsx`, { needsHuman: false, use: 'Badge', props: {} }));
  const picked = pickExamples([...ask, ...sure], 3, new Set(), 40);
  assert.equal(picked.filter(e => e.id.startsWith('a')).length, 12, 'every case, including several in one file');
  assert.equal(picked.filter(e => e.id.startsWith('s')).length, 3);
  assert.equal(pickExamples(ask, 3, new Set(), 5).length, 5, 'capped by perQuestion');
});

test('a proposal is keyed by the component and its look props, in name order, without render or asChild', () => {
  assert.equal(proposalKey('Button', { variant: 'ghost', size: 'xs' }), 'Button|size=xs;variant=ghost');
  assert.equal(proposalKey('Button', { size: 'xs', variant: 'ghost', render: '<a />', asChild: true }), 'Button|size=xs;variant=ghost');
  assert.equal(proposalKey('Separator', {}), 'Separator');
  assert.deepEqual(lookProps({ render: '<button />', variant: 'outline' }), { variant: 'outline' });
});

test('props reach Storybook as URL args, leaving out values Storybook would refuse', () => {
  assert.equal(argsParam({ size: 'icon-xs', variant: 'ghost' }), 'size:icon-xs;variant:ghost');
  assert.equal(argsParam({ variant: 'ghost', href: '/x?y=1' }), 'variant:ghost');
});
