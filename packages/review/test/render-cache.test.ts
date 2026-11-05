import { expect, test } from 'vitest';
import { reusable } from '../src/rendered.js';

// A drawing made before drawings recorded their words can't show the review its words are the element's
// own, so the cache draws it again instead of keeping it.

const own = { text: 'Library' };
const drawn = (o: object = {}) => ({ use: 'Button', props: {}, check: 'exact' as const, shot: 'a.png', own: true, hash: 'h', ...o });

test('a cached own-content drawing with no recorded words is drawn again', () => {
  expect(reusable(drawn() as any, { use: 'Button', props: {}, own } as any, 'h')).toBe(false);
});

test('one that drew other words than the element has now is drawn again', () => {
  expect(reusable(drawn({ text: 'Schemas' }) as any, { use: 'Button', props: {}, own } as any, 'h')).toBe(false);
});

test('one that drew the element’s own words, with the same inputs, stands', () => {
  expect(reusable(drawn({ text: 'Library' }) as any, { use: 'Button', props: {}, own } as any, 'h')).toBe(true);
  expect(reusable(drawn({ text: 'Library' }) as any, { use: 'Button', props: {}, own } as any, 'changed')).toBe(false);
});

test('a plain drawing (no own content wanted) stands on its hash alone', () => {
  expect(reusable({ use: 'Button', props: {}, check: 'exact', shot: 'a.png', hash: 'h' } as any, { use: 'Button', props: {} } as any, 'h')).toBe(true);
});
