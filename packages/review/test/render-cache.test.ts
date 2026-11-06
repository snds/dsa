import { expect, test } from 'vitest';
import { __test, drawingReport, drawnSummary, reusable, unstyledLook } from '../src/rendered.js';
import { crawlEntries, staleDeps } from '../src/harness.js';
const assert_ = (a: unknown, b: unknown) => expect(a).toBe(b);

// A drawing made before drawings recorded their words can't show the review its words are the element's
// own, so the cache draws it again instead of keeping it.

const own = { text: 'Library' };
const drawn = (o: object = {}) => ({ use: 'Button', props: {}, check: 'exact' as const, shot: 'a.png', checked: true, own: true, hash: 'h', ...o });

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
  expect(reusable({ use: 'Button', props: {}, check: 'exact', shot: 'a.png', checked: true, hash: 'h' } as any, { use: 'Button', props: {} } as any, 'h')).toBe(true);
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
  assert_(reusable({ use: 'Button', props: {}, check: 'exact', shot: 'a.png', checked: true, hash: 'h', styles: { fontFamily: 'Inter' } } as any, p, 'h'), true);
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

test('a drawing that failed is tried again; one that can never be drawn is not', () => {
  const p = { use: 'Button', props: {} } as any;
  assert_(reusable({ use: 'Button', props: {}, check: 'none', via: 'source', note: 'failed', hash: 'h' } as any, p, 'h'), false);
  assert_(reusable({ use: 'Button', props: {}, check: 'none', via: 'story', fallback: 'f.png', hash: 'h' } as any, p, 'h'), false);
  assert_(reusable({ use: 'Nope', props: {}, check: 'none', noSource: true, hash: 'none:t' } as any, p, 'none:t'), true);
});

test('a failed source drawing never beats a story drawing, even one that lost its inner content or the styles', () => {
  const failed = { use: 'Button', props: {}, check: 'none', via: 'source', note: 'failed', hash: 'h' } as any;
  const lost = { use: 'Button', props: {}, check: 'exact', via: 'story', shot: 'a.png', innerLost: true, hash: 'h' } as any;
  const bare = { use: 'Button', props: {}, check: 'exact', via: 'story', shot: 'b.png', unstyled: true, hash: 'h' } as any;
  const asWritten = { use: 'Button', props: {}, check: 'none', via: 'story', fallback: 'f.png', hash: 'h' } as any;
  assert_(__test.pickBetter(failed, lost), lost);
  assert_(__test.pickBetter(lost, failed), lost);
  assert_(__test.pickBetter(failed, bare), bare);
  assert_(__test.pickBetter(failed, asWritten), asWritten);
  // Between two pictures, the one with its inner content.
  const whole = { ...lost, shot: 'c.png', innerLost: undefined, inner: true };
  assert_(__test.pickBetter(lost, whole), whole);
});

test('the summary counts real drawings, and the report says why the rest have no picture', () => {
  const items = {
    A: { use: 'Button', props: {}, check: 'exact', via: 'source', shot: 'a.png' },
    B: { use: 'Button', props: {}, check: 'unverified', via: 'story', shot: 'b.png' },
    C: { use: 'Button', props: {}, check: 'none', via: 'source', note: "Button couldn't be drawn: it failed." },
    D: { use: 'Tabs', props: {}, check: 'none', via: 'source', note: "Tabs couldn't be drawn: it failed." },
    E: { use: 'Nope', props: {}, check: 'none', noSource: true, note: "Nope isn't a component." },
  } as any;
  const line = drawnSummary(items);
  expect(line).toContain('2 of 5 drawn with their props · 3 with no picture · 1 exact');
  expect(line).toContain('1 drawn from the system\'s source');
  const report = drawingReport(items, new Map());
  expect(report).toContain("  No picture (2): It couldn't be drawn: it failed.");
  expect(report).toContain("  No picture (1): It isn't a component.");
  expect(drawingReport({ A: items.A }, new Map()).join('\n')).not.toContain('No picture');
  expect(drawingReport(items, new Map(), { failed: 1, reloads: 2 }).join('\n')).toContain('reloaded 2 times');
});

test('what a page says when its dependencies changed under it', () => {
  for (const why of ["it failed to draw: Cannot read properties of null (reading 'useRef')", "it failed to draw: Cannot read properties of null (reading 'useState')", 'its file did not load: Failed to fetch dynamically imported module: http://x/a.tsx', 'Invalid hook call. Hooks can only be called inside of the body of a function component.']) assert_(staleDeps(why), true);
  for (const why of [undefined, "Button isn't exported from its file", "it failed to draw: Cannot read properties of null (reading 'map')", 'it drew, but nothing showed with its data-slot']) assert_(staleDeps(why), false);
});

test("the files Vite reads first are given relative to its root, with a path's special characters kept literal", () => {
  expect(crawlEntries('/a/kit', ['/a/kit/src/A.tsx', '/a/kit/src/A.tsx', null, '/a/other/(group)/[b].tsx'])).toEqual(['src/A.tsx', '../other/\\(group\\)/\\[b\\].tsx']);
});

test('a picture nobody looked at is drawn again, whatever it claims', () => {
  const own = { use: 'Button', props: {}, own: { text: 'Open drawer' } } as any;
  const drawn = { use: 'Button', props: {}, check: 'exact', shot: 'a.png', own: true, text: 'Open drawer', hash: 'h' } as any;
  assert_(reusable(drawn, own, 'h'), false);
  assert_(reusable({ ...drawn, checked: true }, own, 'h'), true);
});
