import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from '../../../test/engine/fixture.js';
import { canDecideNow, evidenceOf, pageName, stepWords, withReview } from '../src/review.js';
import { reviewQueue } from '../src/labels.js';
import { appendHumanLabels, humanLabelsFile } from '../src/server.js';

// Review for people: an element is offered for review only when a person can see both halves (its own
// photo, and the proposal drawn with its own words). Everything else says what's missing and how to fix it.

const box = { x: 10, y: 10, w: 64, h: 32, cw: 240, ch: 120 };
const shot = (o: object = {}) => ({ url: 'shots/a.png', match: 1, tagged: true, box, page: 'http://127.0.0.1:5173/#/requests/table/sheet/add-request', ...o });
const el = (id: string, o: object = {}) => ({ id, target: 'ledger', file: `ledger/src/${id}.tsx`, line: 3, element: 'button', role: 'button', verdict: 'replace', use: 'Button', props: { variant: 'outline' }, confidence: 0.95, needsHuman: false, label: 'Save', ownHash: 'own1', reasons: [], shot: shot(), alternatives: [{ use: 'Toggle', props: {} }], ...o });
const proposals = {
  'Button|variant=outline': { use: 'Button', props: { variant: 'outline' }, check: 'exact', url: 'rendered/plain.png', own: false },
  'Button|variant=outline#own1': { use: 'Button', props: { variant: 'outline' }, check: 'exact', url: 'rendered/own.png', own: true, text: 'Save' },
  // Drawn with words that aren't this element's (another element's own render), and with a stand-in icon.
  'Button|variant=outline#own2': { use: 'Button', props: { variant: 'outline' }, check: 'exact', url: 'rendered/own2.png', own: true, text: 'Schemas' },
  'Button|variant=ghost#own3': { use: 'Button', props: { variant: 'ghost' }, check: 'exact', url: 'rendered/icon.png', content: "stand-in icon: the app's own icon wasn't captured" },
  Sheet: { use: 'Sheet', props: {}, check: 'none', url: null, noSource: true },
};
const payload = (evals: object[]) => ({ elements: { threshold: 0.9, questions: [], proposals, evals } });

test('a person is only asked when both halves are real; otherwise it says why and what would fix it', () => {
  const E = payload([]).elements;
  const why = (o: object) => evidenceOf(E, el('x', o), { verdict: 'replace', use: (o as any).use ?? 'Button', props: (o as any).props ?? { variant: 'outline' } });
  assert.deepEqual(why({}), { ready: true, current: 'live', missing: [] });
  assert.equal(why({ shot: shot({ source: 'isolated', drawn: 'mount', match: undefined }) }).current, 'isolated', 'recorded props count, labelled as such');
  const cases: [object, RegExp][] = [
    [{ shot: null }, /no photo of it/],
    [{ shot: null, staleShot: { why: 'older-run' } }, /older run/],
    [{ shot: null, reach: { why: 'it shows only after a step the crawler could not take' } }, /hasn't reached it yet/],
    [{ shot: shot({ drawn: 'mount', exact: true }) }, /guessed props/],
    [{ shot: shot({ drawn: 'markup' }) }, /Only its markup/],
    [{ shot: shot({ blank: true }) }, /shows nothing/],
    [{ shot: shot({ tagged: false, match: 0.6 }) }, /different element/],
    [{ ownHash: 'other' }, /sample words/],
    [{ props: { variant: 'ghost' } }, /isn't drawn yet/],
    [{ use: 'Sheet', props: {} }, /nothing to draw Sheet from/],
    // "With its own words" only when the drawing's words are the element's: "Schemas" isn't "Save".
    [{ ownHash: 'own2' }, /words aren't this element's own/],
    // An icon button proposed with a "+" stand-in reads as another control: evidence, not a decision.
    [{ ownHash: 'own3', label: null, props: { variant: 'ghost' } }, /stand-in icon/],
  ];
  for (const [o, re] of cases) {
    const r = why(o);
    assert.equal(r.ready, false, JSON.stringify(o));
    assert.match(r.missing.map((m) => m.why).join(' '), re);
    assert.ok(r.missing.every((m) => m.fix.length > 0), 'each reason says what would fix it');
  }
});

test('page names in plain words', () => {
  assert.equal(pageName('http://127.0.0.1:5173/#/colour/CB-401/from/list/colours'), 'Colour CB-401, opened from the Colours list');
  assert.equal(pageName('http://127.0.0.1:5173/#/requests/table/sheet/add-request'), 'Requests › Table › Sheet › Add request');
  assert.equal(pageName('https://example.com/orders/ORD-1042?tab=2'), 'Orders › ORD-1042');
  assert.equal(pageName('https://example.com/'), 'the home page');
  assert.equal(pageName(null), 'an unknown page');
  assert.equal(pageName('http://localhost:3000/#/_r_4k_'), 'an unnamed page', "a framework's generated id isn't a name");
  assert.equal(pageName('http://localhost:3000/schema/_r_4k_/reactions'), 'Schema › Reactions');
});

test('the queue holds only reviewable elements, with label fields and precedents; the rest are counted as set aside', () => {
  const evals = Array.from({ length: 60 }, (_, i) => el(`e${i}`, i % 3 === 0 ? { shot: shot({ drawn: 'markup' }) } : {}));
  const p = withReview(payload(evals), {
    seed: 's', audit: 0.5,
    system: [{ component: 'Button', axes: { variant: ['default', 'outline'] }, defaults: { variant: 'default' } }],
    precedents: [
      { app: 'ledger', file: 'ledger/src/Bar.tsx', line: 9, component: 'Button', props: { variant: 'outline' }, shot: { url: 'shots/u.png', box, pageName: 'Orders' } },
      { app: 'ledger', file: 'ledger/src/Baz.tsx', line: 4, component: 'Button', props: { variant: 'outline' }, shot: null },
      { app: 'ledger', file: 'ledger/src/Qux.tsx', line: 2, component: 'Button', props: { variant: 'default' }, shot: null },
    ],
    sourceRef: () => 'abc123',
  });
  const R = p.elements.review;
  assert.equal(R.setAside, 20);
  assert.equal(R.ready, 40);
  assert.ok(R.items.length > 5 && R.items.length < 35, `about half of the ready ones (${R.items.length})`);
  const byId = new Map(p.elements.evals.map((e: any) => [e.id, e]));
  for (const it of R.items) assert.equal((byId.get(it.id) as any).review.ready, true, 'never a near-empty candidate');
  const it = R.items[0];
  assert.deepEqual(it.examples.map((x: any) => x.file), ['ledger/src/Bar.tsx', 'ledger/src/Baz.tsx'], 'the same component and props, photos first');
  assert.deepEqual([it.label.app, it.label.sourceRef], ['ledger', 'abc123']);
  // A queue from dsa labels queue: kept only where it can be reviewed.
  const q = withReview(payload(evals), { queue: [{ id: 'e0', why: 'disagree' }, { id: 'e1', why: 'disagree' }] });
  assert.deepEqual(q.elements.review.items.map((x: any) => x.id), ['e1']);
});

test('dsa labels queue leaves out what needs evidence', () => {
  const evals = [el('a'), el('b', { shot: shot({ drawn: 'mount', exact: true }) })];
  const label = (id: string) => ({ id, app: 'ledger', file: `src/${id}.tsx`, line: 3, sourceRef: 'x', elementHash: 'h', truth: { verdict: 'replace' as const, use: 'Toggle' }, acceptableAlts: [], labeler: 'tool', method: 'migrated' as const, at: '2026-10-06T12:00:00Z' });
  const q = reviewQueue({ labels: [label('a'), label('b')], payload: payload(evals) });
  assert.deepEqual(q.items.map((x) => x.id), ['a']);
  assert.equal(q.needsEvidence, 1);
});

test('answers are saved as human labels, schema-checked; a second answer from the same person replaces the first', () => {
  const data = tmp();
  const row = (verdict: string, use?: string) => ({ id: 'e1', app: 'ledger', file: 'ledger/src/e1.tsx', line: 3, sourceRef: 'abc', elementHash: 'h', truth: { verdict, ...(use ? { use } : {}) }, acceptableAlts: [], labeler: 'pat', method: 'human', at: '2026-10-06T12:00:00Z' });
  assert.equal(appendHumanLabels(data, [row('replace', 'Button')]).saved, 1);
  assert.equal(appendHumanLabels(data, [row('keep')]).saved, 1);
  const lines = fs.readFileSync(humanLabelsFile(data), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.truth.verdict), ['keep']);
  assert.ok(appendHumanLabels(data, [{ ...row('replace', 'Button'), method: 'migrated' }]).errors[0]!.includes('human'));
  assert.ok(appendHumanLabels(data, [{ ...row('replace') }]).errors.length, 'a replace names its component');
  assert.equal(path.basename(path.dirname(humanLabelsFile(data))), 'labels');
});

test('every element a person can decide now is offered, before the audit, by the rule Element Review counts with', () => {
  const p = withReview(payload([
    el('open1', { needsHuman: true, confidence: 0.6 }),
    el('open2', { needsHuman: true, confidence: 0.5 }),
    el('decided', { needsHuman: true, decided: { decision: { verdict: 'keep' } } }),
    el('nophoto', { needsHuman: true, shot: null }),
    el('sure', {}),
  ]), { audit: 1 });
  const E = p.elements;
  const now = E.evals.filter(canDecideNow).map((e: any) => e.id);
  assert.deepEqual(now, ['open1', 'open2']);
  assert.deepEqual(E.evals.filter((e: any) => e.review.decideNow).map((e: any) => e.id), now, 'stamped for the page');
  assert.equal(E.review.decideNow, 2);
  assert.deepEqual(E.review.items.map((i: any) => [i.id, i.why]), [['open1', 'decide'], ['open2', 'decide'], ['sure', 'audit']]);
});

test('what the crawler could not reach is said plainly; the code conditions are kept apart for engineers', () => {
  const E = payload([]).elements;
  const gated = (o: object) => evidenceOf(E, el('x', { shot: null, reach: { status: 'gated', why: 'Renders only when `!fullSearch && mode === "button"` in AddSheet, opened by “Message on : Open request -” in Bell; 10 more conditions above it (main › App).', ...o } }), null).missing[0]!;
  const flow = gated({ gates: [{ kind: 'condition', test: '!fullSearch' }], steps: ['Message on : Open request -'] });
  assert.equal(flow.kind, 'flow');
  assert.equal(flow.why, "The crawler hasn't reached it yet: it only shows after steps in a flow, such as opening “Message on …: Open request …”.");
  assert.match(flow.group, /^aren't reached yet: they only show after steps in a flow/);
  assert.doesNotMatch(flow.why + flow.group, /`|&&|conditions above|›/, 'no code on the face');
  assert.match(flow.detail!, /fullSearch/, 'the code conditions stay, for engineers');
  assert.equal(gated({ gates: [{ kind: 'overlay', overlay: 'dialog' }], steps: [] }).kind, 'overlay');
  assert.equal(gated({ gates: [{ kind: 'condition', test: 'x' }], steps: [] }).kind, 'state');
  assert.equal(gated({ status: 'page', gates: [], steps: [] }).kind, 'unphotographed');
});

test("a control's words from the code show the values it fills in as gaps", () => {
  assert.equal(stepWords('Message on : Open request -'), 'Message on …: Open request …');
  assert.equal(stepWords({ label: 'Save' }), 'Save');
  assert.equal(stepWords(''), '');
});

test('a use matches on the system axes, not type="button"; no exact use shows the nearest, labelled; a claim of none needs the whole app read', () => {
  const system = [{ component: 'Button', axes: { variant: ['default', 'outline'], size: ['default', 'sm', 'xs'] }, defaults: { variant: 'default', size: 'default' } }];
  const use = (line: number, props: object, o: object = {}) => ({ app: 'ledger', file: `ledger/src/U${line}.tsx`, line, component: 'Button', props, ...o });
  const pick = { use: 'Button', props: { variant: 'outline', size: 'xs' } };
  const withDrawing = (uses: any[], searched?: any) => {
    const p: any = payload([el('a', { ...pick, needsHuman: true })]);
    p.elements.proposals['Button|size=xs;variant=outline#own1'] = { use: 'Button', props: pick.props, check: 'exact', url: 'r/o.png', own: true, text: 'Save' };
    return withReview(p, { audit: 0, system, precedents: uses, searched }).elements.review.items[0];
  };
  const exact = withDrawing([use(1, { variant: 'outline', size: 'xs', type: 'button' })]);
  assert.equal(exact.usesCount, 1, 'type="button" does not make it another look');
  assert.equal(exact.nearest, null);
  // An axis set from the code might be anything: not exact, not nearest.
  assert.equal(withDrawing([use(2, { variant: 'outline' }, { dynamic: ['size'] })]).usesCount, 0);
  const near = withDrawing([use(3, { variant: 'outline', size: 'sm', type: 'button' }), use(4, { variant: 'default', size: 'default' })]);
  assert.equal(near.usesCount, 0);
  assert.equal(near.nearest.label, "Not at this size, but here's the same variant at sm.");
  assert.deepEqual(near.nearest.examples.map((x: any) => x.line), [3]);
  assert.equal(withDrawing([], { ledger: { files: 40, unread: 0 } }).searched.whole, true);
  assert.equal(withDrawing([], { ledger: { files: 40, unread: 2 } }).searched.whole, false);
  assert.equal(withDrawing([]).searched, null, 'no search of its own: no claim');
});

test("a proposal drawn without the system's styles needs evidence, not a decision", () => {
  const E: any = payload([]).elements;
  const p = { ...E.proposals, 'Button|variant=outline#own1': { ...E.proposals['Button|variant=outline#own1'], unstyled: true } };
  const r = evidenceOf({ ...E, proposals: p }, el('x'), { verdict: 'replace', use: 'Button', props: { variant: 'outline' } });
  assert.equal(r.ready, false);
  assert.equal(r.missing[0]!.kind, 'unstyled');
  assert.match(r.missing[0]!.why, /couldn't be drawn with the system's styles/);
});

test("a proposal that lacks what the element holds besides its words needs evidence", () => {
  const E: any = payload([]).elements;
  const key = 'Button|variant=outline#own1';
  const pick = { verdict: 'replace', use: 'Button', props: { variant: 'outline' } };
  const judge = (content: object, drawn: object = {}) => evidenceOf({ ...E, proposals: { ...E.proposals, [key]: { ...E.proposals[key], ...drawn } } }, el('x', { shot: shot({ content }) }), pick);
  const holds = { text: 'Save', inner: { marks: 1, blocks: 1, lost: 0 } };
  assert.equal(judge(holds).missing[0]!.why, "The proposal doesn't show this element's inner content.");
  assert.equal(judge(holds, { innerLost: true }).missing[0]!.kind, 'no-inner');
  assert.equal(judge(holds, { inner: true }).ready, true);
  assert.equal(judge({ text: 'Save', inner: null }).ready, true, 'it holds only its words');
  assert.equal(judge({ text: 'Save' }).missing[0]!.kind, 'no-inner', 'a photo from before this was recorded');
  // Words come from the photo, so another element's drawing is caught even with no label.
  assert.equal(evidenceOf(E, el('y', { label: null, shot: shot({ content: { text: 'Other', inner: null } }) }), pick).missing[0]!.kind, 'not-own-words');
});

test("an icon-only button has no words to draw: its aria-label is not its words", () => {
  const E: any = { ...payload([]).elements, proposals: { 'Button|variant=outline#own1': { use: 'Button', props: { variant: 'outline' }, check: 'exact', url: 'rendered/own.png', own: true, text: '', inner: true } } };
  const pick = { verdict: 'replace', use: 'Button', props: { variant: 'outline' } };
  const photo = { content: { text: null, inner: { marks: 1, blocks: 0, lost: 0 } } };
  assert.equal(evidenceOf(E, el('x', { label: 'Open drawer', shot: shot(photo) }), pick).ready, true);
  // Words the source holds and the photo missed are still its words: a drawing without them is wrong.
  assert.equal(evidenceOf(E, el('x', { label: 'Open drawer', words: 'Open drawer', shot: shot(photo) }), pick).missing[0]!.kind, 'not-own-words');
  // With no record from a photo, the label is all there is to go on.
  assert.equal(evidenceOf(E, el('x', { label: 'Open drawer', shot: shot() }), pick).missing[0]!.kind, 'not-own-words');
});

test('no clear answer: reviewable only with a candidate drawn with its own content', () => {
  const candidate = { verdict: 'replace', use: 'Button', props: { variant: 'ghost' } };
  const drawn = (o: object) => ({ ...payload([]).elements, proposals: { 'Button|variant=ghost#own1': { use: 'Button', props: { variant: 'ghost' }, check: 'exact', url: 'rendered/c.png', own: true, text: 'Save', ...o } } });
  const unclear = { verdict: 'unclear', use: null, props: null };
  const element = (alternatives: object[]) => el('x', { ...unclear, alternatives, shot: shot({ content: { text: 'Save', inner: null } }) });
  assert.equal(evidenceOf(drawn({}), element([candidate]), unclear).ready, true);
  assert.equal(evidenceOf(drawn({}), element([]), unclear).missing[0]!.kind, 'no-candidates');
  assert.equal(evidenceOf(drawn({ text: 'Other' }), element([candidate]), unclear).missing[0]!.kind, 'no-candidates', 'other words');
  assert.equal(evidenceOf(drawn({ url: null }), element([candidate]), unclear).missing[0]!.kind, 'no-candidates', 'not drawn');
});
