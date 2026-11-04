import { test } from 'vitest';
import assert from 'node:assert/strict';
import { trustRubric, type Criterion } from '../src/trust.js';
import type { CardFacts } from '../src/card-dom.js';

// The presentation score: can a person judge a recommendation from its card alone? Each check passes,
// fails, or doesn't apply, and a check that depends on another doesn't apply when that one fails, so one
// missing photo counts once. The card's own checks are read from the rendered card, never assumed.

const shot = (match = 1) => ({ url: 'shots/a.png', match, box: { x: 10, y: 10, w: 80, h: 36, cw: 240, ch: 120 } });
const ev = (id: string, o: object) => ({ id, target: 'ledger', file: `ledger/src/${id}.tsx`, line: 3, element: 'button', verdict: 'replace', use: 'Button', props: { variant: 'ghost' }, confidence: 0.8, reasons: [], how: null, ...o });
const proposals = {
  'Button|variant=ghost': { use: 'Button', props: { variant: 'ghost' }, check: 'exact', url: 'rendered/p.png', content: null },
  Toggle: { use: 'Toggle', props: {}, check: 'none', url: null, note: 'No Toggle story.' },
  Sheet: { use: 'Sheet', props: {}, check: 'none', url: null, note: "Sheet isn't a component dsa found in the design system's source, so it can't be drawn." },
};
const payload = (evals: object[]) => ({ elements: { threshold: 0.9, evals, questions: [], proposals } });
// What a correct card shows for an element: every label, the code opener, both panes at scale.
const card = (id: string, o: Partial<CardFacts> = {}): CardFacts => ({ id, target: 'ledger', place: `src/${id}.tsx:3`, thumb: false, photoLabel: true, opensCode: true, proposalLabel: true, sameScale: true, ...o });
const row = (s: ReturnType<typeof trustRubric>, id: string) => s.rows.find((r) => r.id === id)!;
const failed = (s: ReturnType<typeof trustRubric>, id: string) => row(s, id).failed;

test('a missing photo is one failure, not four: the checks that need it do not apply', () => {
  const s = trustRubric(payload([ev('weak', { shot: shot(0.5), confidence: 0.95 }), ev('none', {}), ev('blank', { shot: { ...shot(), blank: true } })]), { cards: [] });
  assert.deepEqual(failed(s, 'weak'), ['shown', 'confidence'], 'ready on nothing to see: shown, and the confidence that claims it');
  assert.deepEqual(failed(s, 'none'), ['shown']);
  assert.deepEqual(failed(s, 'blank'), ['shown']);
  for (const k of ['photoLabel', 'opensCode', 'sameScale'] as Criterion[]) assert.equal(row(s, 'none').outcomes[k], 'na', k);
  assert.equal(s.criteria.shown.fail, 3);
  assert.equal(s.criteria.photoLabel.fail, 0);
});

test('the card checks come from the rendered card; without one they are untested, not passed', () => {
  const evals = [ev('ok', { shot: shot(), confidence: 0.95 })];
  const untested = trustRubric(payload(evals));
  assert.deepEqual(untested.untested, ['photoLabel', 'opensCode', 'proposalLabel', 'sameScale']);
  assert.deepEqual(row(untested, 'ok').untested, ['photoLabel', 'opensCode', 'proposalLabel', 'sameScale']);
  assert.equal(untested.criteria.photoLabel.pass, 0);
  // A card that shows it all.
  assert.deepEqual(failed(trustRubric(payload(evals), { cards: [card('ok')] }), 'ok'), []);
  // A card that leaves the place unclickable and draws the proposal at another scale.
  assert.deepEqual(failed(trustRubric(payload(evals), { cards: [card('ok', { opensCode: false, sameScale: false })] }), 'ok'), ['opensCode', 'sameScale']);
  // An older page with no element ids: matched by its app and place.
  assert.deepEqual(failed(trustRubric(payload(evals), { cards: [card('ok', { id: null })] }), 'ok'), []);
  // Shown only as a thumbnail of another element's look: not its own labelled photo.
  assert.deepEqual(failed(trustRubric(payload(evals), { cards: [card('ok', { thumb: true, photoLabel: false, opensCode: false, sameScale: false })] }), 'ok'), ['photoLabel', 'opensCode', 'sameScale']);
  // Not on the card at all.
  assert.deepEqual(failed(trustRubric(payload(evals), { cards: [] }), 'ok'), ['photoLabel', 'opensCode', 'proposalLabel', 'sameScale']);
});

test('the proposal: nothing to draw from is its own class; drawn exactly; own content where it can be carried', () => {
  const s = trustRubric(payload([
    ev('nosrc', { shot: shot(), use: 'Sheet', props: {} }),
    ev('closest', { shot: shot(), use: 'Toggle', props: {}, rendered: { systemShot: 'rendered/t.png' } }),
    ev('mine', { shot: shot(), ownHash: 'abc' }),
    ev('table', { shot: shot(), role: 'static-table', ownHash: 'abc' }),
  ]), { cards: [card('nosrc'), card('closest'), card('mine'), card('table')] });
  assert.deepEqual(failed(s, 'nosrc'), ['drawable'], 'no drawable source: not also "not drawn exactly"');
  assert.equal(row(s, 'nosrc').outcomes.exact, 'na');
  assert.deepEqual(failed(s, 'closest'), ['exact'], 'the closest variant stands in, with the reason: the fallback holds');
  assert.equal(row(s, 'closest').outcomes.fallback, 'pass');
  assert.deepEqual(failed(s, 'mine'), ['own'], "the story's sample, not its own words");
  assert.equal(row(s, 'table').outcomes.own, 'na', "a container's content is other elements");
  const withOwn = payload([ev('mine', { shot: shot(), ownHash: 'abc', confidence: 0.95 })]) as any;
  withOwn.elements.proposals['Button|variant=ghost#abc'] = { use: 'Button', props: { variant: 'ghost' }, check: 'exact', url: 'rendered/own.png', own: true };
  assert.deepEqual(failed(trustRubric(withOwn, { cards: [card('mine')] }), 'mine'), []);
});

test("a question's card proposes its auto-pick, which may be a size no one rendered", () => {
  const p = payload([ev('ok', { shot: shot(), confidence: 0.95 })]) as any;
  p.elements.questions = [{ ids: ['ok'], auto: { verdict: 'replace', use: 'Button', props: { variant: 'ghost', size: 'sm' } } }];
  assert.deepEqual(failed(trustRubric(p, { cards: [card('ok')] }), 'ok'), ['exact', 'confidence', 'fallback'], 'not drawn yet: a drawing to do, not a missing source');
});

test('reasons in plain words: utility classes and CSS variables are code too', () => {
  const s = trustRubric(payload([
    ev('plain', { shot: shot(), reasons: [{ text: 'aria-pressed: a latch.', plain: 'It works as a latch.' }] }),
    ev('util', { shot: shot(), reasons: [{ text: 'Height from size-5 and px-2.', plain: 'Height from size-5 and px-2.' }] }),
    ev('cssvar', { shot: shot(), how: 'Its height is --density-control-h.' }),
  ]), { cards: [card('plain'), card('util'), card('cssvar')] });
  assert.deepEqual(failed(s, 'plain'), []);
  assert.deepEqual(failed(s, 'util'), ['plain']);
  assert.deepEqual(failed(s, 'cssvar'), ['plain']);
});

test("another element's photo isn't this one's: a ready card that only has its look-alike's photo is flagged", () => {
  const s = trustRubric(payload([ev('a', { shot: shot(), styleSig: 's1' }), ev('b', { styleSig: 's1', confidence: 0.95 })]), { cards: [card('a')] });
  assert.deepEqual(failed(s, 'b'), ['shown', 'confidence']);
  assert.equal(row(s, 'b').siblingPhoto, true, 'the engine used to count the look-alike; the rubric never did');
  assert.equal(row(s, 'a').siblingPhoto, false);
});

test('pictures by source: live, isolated render (credited, labelled), drawn with guessed props, markup', () => {
  const at = (o: object) => trustRubric(payload([ev('x', { shot: { ...shot(), ...o }, confidence: 0.95 })]), { cards: [card('x')] });
  // Mounted in the app's build with the props it was recorded with: a labelled pass of its own.
  const iso = at({ source: 'isolated', drawn: 'mount', match: undefined });
  assert.deepEqual(iso.rows[0]!.failed, []);
  assert.deepEqual([iso.rows[0]!.source, iso.sources.isolated], ['isolated', 1]);
  // Drawn with guessed props, found by its exact tag: counts, reported apart.
  const guessed = at({ drawn: 'mount', exact: true });
  assert.deepEqual(guessed.rows[0]!.failed, []);
  assert.deepEqual([guessed.rows[0]!.source, guessed.sources.guessed, guessed.sources.live], ['guessed', 1, 0]);
  assert.ok(at({ drawn: 'mount' }).rows[0]!.failed.includes('shown'), 'not by its exact tag');
  assert.equal(at({ drawn: 'markup' }).sources.markup, 1);
  assert.ok(at({ drawn: 'markup' }).rows[0]!.failed.includes('shown'));
  assert.ok(at({ source: 'isolated', blank: true }).rows[0]!.failed.includes('shown'));
  // A source tag proves the place, whatever the crawler's score.
  assert.deepEqual(at({ match: 0.5, tagged: true }).rows[0]!.failed, []);
});

test('unused code, lab pages, exceptions and ignored elements are left out and counted', () => {
  const s = trustRubric(payload([
    ev('ok', { shot: shot() }), ev('u', { reach: { status: 'unused' } }), ev('u2', { exception: 'unused' }),
    ev('lab', { exception: 'lab' }), ev('allow', { exception: 'allowed' }), ev('ign', { verdict: 'ignore' }),
  ]), { cards: [card('ok')] });
  assert.equal(s.recommendations, 1);
  assert.deepEqual(s.excluded, { unused: 2, lab: 1, exception: 1, ignored: 1 });
});

test('the score is passing over all; each check over the cards it applies to', () => {
  const s = trustRubric(payload([ev('ok', { shot: shot(), confidence: 0.95 }), ev('none', {}), ev('nosrc', { shot: shot(), use: 'Sheet', props: {} })]), { cards: [card('ok'), card('nosrc')] });
  assert.equal(s.passing, 1);
  assert.equal(s.rate, 33.3);
  assert.deepEqual(s.criteria.shown, { pass: 2, fail: 1, na: 0, untested: 0, rate: 66.7 });
  assert.deepEqual(s.criteria.exact, { pass: 2, fail: 0, na: 1, untested: 0, rate: 100 }, 'a proposal is drawn or not whether or not the element is shown');
  assert.deepEqual(s.blocking.map((b) => [b.criterion, b.failing]), [['shown', 1], ['drawable', 1]]);
});
