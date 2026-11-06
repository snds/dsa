import { expect, test } from 'vitest';
import { drawingReport, reusable, unstyledLook } from '../src/rendered.js';
const assert_ = (a: unknown, b: unknown) => expect(a).toBe(b);

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

test("a browser's defaults mean the system's stylesheet didn't reach the drawing", () => {
  assert_(unstyledLook({ fontFamily: '"Times New Roman"', fontSize: '16px' }), true);
  assert_(unstyledLook({ fontFamily: 'Arial', fontSize: '13.3333px', borderStyle: 'outset' }), true);
  assert_(unstyledLook({ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: '14px', borderStyle: 'solid' }), false);
});

test('a drawing made before drawings recorded their font, or without the system styles, is drawn again', () => {
  const p = { use: 'Button', props: {} } as any;
  assert_(reusable({ use: 'Button', props: {}, check: 'exact', hash: 'h', styles: { fontSize: '14px' } } as any, p, 'h'), false);
  assert_(reusable({ use: 'Button', props: {}, check: 'exact', hash: 'h', unstyled: true, styles: { fontFamily: 'Times' } } as any, p, 'h'), false);
  assert_(reusable({ use: 'Button', props: {}, check: 'exact', hash: 'h', styles: { fontFamily: 'Inter' } } as any, p, 'h'), true);
});

test('a render always says how many drawings the styles missed and which elements they are, zero included', () => {
  const want = new Map([['B', { use: 'Button', props: {}, where: ['src/A.tsx:4'] }], ['T', { use: 'Tabs', props: { size: 'sm' }, where: ['src/B.tsx:9'] }]]) as any;
  const clean = { B: { use: 'Button', props: {}, styles: { fontFamily: 'Inter' } }, T: { use: 'Tabs', props: { size: 'sm' }, styles: { fontFamily: 'Inter' } } } as any;
  const zero = drawingReport(clean, want);
  expect(zero[0]).toContain("Without the system's styles (unstyled): 0 of 2 drawings.");
  expect(zero[1]).toContain('0 drawn with what their element holds besides its words, 0 without it.');
  const caught = drawingReport({ B: { ...clean.B, unstyled: true }, T: { ...clean.T, innerLost: true } } as any, want, { failed: 3, first: 'its file did not load' });
  expect(caught[0]).toContain('1 of 2 drawings: Button (src/A.tsx:4).');
  expect(caught[1]).toContain('0 drawn with what their element holds besides its words, 1 without it: Tabs size=sm (src/B.tsx:9).');
  expect(caught[2]).toContain("3 couldn't be drawn, so stories were tried. First reason: its file did not load");
});
