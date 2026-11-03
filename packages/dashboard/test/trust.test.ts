import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CARD, trustRubric } from '../src/trust.js';

// The review QA rubric: a recommendation is trustworthy only when all ten checks hold on its card.
// The data decides what was captured and rendered; the card decides what is labelled and how it's drawn.

const shot = (match = 1) => ({ url: 'shots/a.png', match, box: { x: 10, y: 10, w: 80, h: 36, cw: 240, ch: 120 } });
const ev = (id: string, o: object) => ({ id, target: 'ledger', file: `ledger/src/${id}.tsx`, line: 3, element: 'button', verdict: 'replace', use: 'Button', props: { variant: 'ghost' }, confidence: 0.8, reasons: [], how: null, ...o });
const payload = {
  elements: {
    threshold: 0.9,
    evals: [
      // Everything in place.
      ev('ok', { shot: shot(), confidence: 0.95, reasons: [{ text: 'Looks like Button ghost.', plain: 'Looks like Button ghost.' }] }),
      // A guess among look-alikes: hidden, so nothing to see, yet "ready".
      ev('weak', { shot: shot(0.5), confidence: 0.95 }),
      // Code terms in its reason, with a plain line beside them.
      ev('code', { shot: shot(), reasons: [{ text: 'aria-pressed: a latch.', plain: 'It works as a latch.' }] }),
      // No exact render: the closest variant stands in, with the reason.
      ev('closest', { shot: shot(), use: 'Toggle', props: {}, rendered: { systemShot: 'rendered/t.png' } }),
      // Captured but blank: the card doesn't show it, it says so.
      ev('blank', { shot: { ...shot(), blank: true } }),
      // Not reviewed: an exception and unused code.
      ev('skip', { exception: 'allowed' }),
      ev('unused', { reach: { status: 'unused' } }),
    ],
    questions: [],
    proposals: {
      'Button|variant=ghost': { use: 'Button', props: { variant: 'ghost' }, check: 'exact', url: 'rendered/p.png', content: null },
      Toggle: { use: 'Toggle', props: {}, check: 'none', url: null, note: 'No Toggle story.' },
    },
  },
};

test('ten checks per recommendation; one failing check fails it', () => {
  const s = trustRubric(payload);
  assert.equal(s.recommendations, 5, 'exceptions and unused code are not recommendations');
  const row = (id: string) => s.rows.find((r) => r.id === id)!;
  assert.deepEqual(row('ok').failed, []);
  assert.deepEqual(row('weak').failed, ['C1', 'C2', 'C3', 'C6', 'C9']);
  assert.deepEqual(row('code').failed, []);
  assert.deepEqual(row('closest').failed, ['C4', 'C5', 'C6'], 'a reason and a fallback image keep C10');
  assert.deepEqual(row('blank').failed, ['C1', 'C2', 'C3', 'C6']);
  assert.equal(s.passing, 2);
  assert.equal(s.rate, 40);
  assert.equal(s.criteria.C1.pass, 3);
  assert.deepEqual(s.blocking.slice(0, 2).map((b) => [b.criterion, b.failing]), [['C6', 3], ['C1', 2]], 'most failed first');
});

test('an older card, on the same data: unlabelled photos, two scales, code in the reasons, no fallback', () => {
  const s = trustRubric(payload, { card: { ...CARD, photoLabels: false, sameScale: false, plainReasons: false, fallback: false } });
  assert.equal(s.passing, 0);
  assert.equal(s.criteria.C3.pass, 0, 'no photo is labelled');
  assert.equal(s.criteria.C6.pass, 0);
  assert.ok(s.rows.find((r) => r.id === 'code')!.failed.includes('C7'));
  assert.ok(s.rows.find((r) => r.id === 'closest')!.failed.includes('C10'));
});

test("a question's card proposes its auto-pick, which may be a size no one rendered", () => {
  const p = structuredClone(payload) as any;
  p.elements.questions = [{ ids: ['ok'], auto: { verdict: 'replace', use: 'Button', props: { variant: 'ghost', size: 'sm' } } }];
  const r = trustRubric(p).rows.find((x) => x.id === 'ok')!;
  assert.deepEqual(r.failed, ['C4', 'C5', 'C6', 'C9', 'C10']);
});

test("an element with its own words passes only on a render that carries them, not the story's sample", () => {
  const p = structuredClone(payload) as any;
  const ok = p.elements.evals.find((e: any) => e.id === 'ok');
  ok.ownHash = 'abc123';
  assert.deepEqual(trustRubric(p).rows.find((x) => x.id === 'ok')!.failed, ['C4', 'C9', 'C10'], 'the generic render shows the story label');
  p.elements.proposals['Button|variant=ghost#abc123'] = { use: 'Button', props: { variant: 'ghost' }, check: 'exact', url: 'rendered/own.png', own: true };
  assert.deepEqual(trustRubric(p).rows.find((x) => x.id === 'ok')!.failed, []);
  // Drawn exactly, but with a stand-in icon: not the element.
  p.elements.proposals['Button|variant=ghost#abc123'] = { use: 'Button', props: { variant: 'ghost' }, check: 'exact', url: 'rendered/own.png', own: false, content: "stand-in icon: the app's own icon wasn't captured" };
  const r = trustRubric(p).rows.find((x) => x.id === 'ok')!;
  assert.ok(r.failed.includes('C4') && !r.failed.includes('C10'), 'it says why, and shows a render');
});

test('a photo matched by its source tag is proof of place: shown, and "ready" once the exact render is there', () => {
  // A crawler score under the 80% bar, but found by the line that made it: the place is exact.
  const tagged = { elements: { ...payload.elements, evals: [ev('tag', { shot: { ...shot(0.5), tagged: true }, confidence: 0.95 }), ev('guess', { shot: shot(0.5), confidence: 0.95 })] } };
  const s = trustRubric(tagged);
  assert.deepEqual(s.rows.find((r) => r.id === 'tag')!.failed, [], 'C1, C2 and C9 hold on a tagged photo and an exact render');
  assert.ok(s.rows.find((r) => r.id === 'guess')!.failed.includes('C1'));
  // Still a photo of nothing when it's blank: a tag proves the place, not what was painted.
  const blank = trustRubric({ elements: { ...payload.elements, evals: [ev('tag', { shot: { ...shot(), tagged: true, blank: true }, confidence: 0.95 })] } });
  assert.ok(blank.rows[0]!.failed.includes('C2'));
});

test('a drawing from the code is shown, but it is not a photo: C1 fails, so it is never "ready" on it', () => {
  const drawn = trustRubric({ elements: { ...payload.elements, evals: [ev('drawn', { shot: { ...shot(), drawn: 'mount' }, confidence: 0.8 })] } });
  assert.ok(drawn.rows[0]!.failed.includes('C1'));
  assert.ok(!drawn.rows[0]!.failed.includes('C9'), 'held under the bar, its confidence matches what can be seen');
  // A live photo with a covering layer hidden is still a photo of the app.
  const uncovered = trustRubric({ elements: { ...payload.elements, evals: [ev('ok', { shot: { ...shot(), uncovered: 1 }, confidence: 0.95 })] } });
  assert.deepEqual(uncovered.rows[0]!.failed, []);
});
