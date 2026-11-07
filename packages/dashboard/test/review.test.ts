import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from '../../../test/engine/fixture.js';
import { canDecideNow, candidatesOf, evidenceOf, pageName, photosLine, proposalFor, stepWords, withReview } from '../src/review.js';
import { proposalKey } from '../src/trust.js';
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
  assert.deepEqual(it.examples.map((x: any) => x.file), ['ledger/src/Bar.tsx'], "the same component and props, photos only: without one, a tile only repeats the system's drawing");
  assert.equal(it.usesCount, 2);
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
  const use = (line: number, props: object, o: object = {}) => ({ app: 'ledger', file: `ledger/src/U${line}.tsx`, line, component: 'Button', props, shot: { url: `shots/u${line}.png`, box: null, page: '/a', pageName: 'A' }, ...o });
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
  assert.equal(near.nearest.label, "dsa has no photo of this look. Here's a use with the same variant.");
  assert.deepEqual(near.nearest.examples.map((x: any) => x.line), [3], 'the closest only: the heading speaks for every tile');
  assert.deepEqual(near.nearest.examples.map((x: any) => x.differs), ['size sm']);
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

const reviewed = (E: object, e: object, pick: object) => evidenceOf({ threshold: 0.9, questions: [], evals: [], ...E } as any, e, pick);

test("a tile, a card, any container: a story's words with none of its own don't go up as its comparison", () => {
  const pick = { verdict: 'replace', use: 'ToggleGroupItem', props: {} };
  const proposals = { 'ToggleGroupItem#t': { use: 'ToggleGroupItem', props: {}, check: 'exact', url: 'rendered/t.png', own: false, content: "what it holds couldn't be copied, so the story's sample shows instead" } };
  const e = el('tile', { role: 'choice-tile', ownHash: 't', use: 'ToggleGroupItem', props: {}, shot: shot({ content: { text: null, inner: { marks: 1, blocks: 0, lost: 0 } } }) });
  const r = reviewed({ proposals }, e, pick);
  assert.equal(r.ready, false);
  assert.match(r.missing.map((m: any) => m.why).join(), /sample words/);
});

test("a whole structure is shown as an example, said plainly, and that can go up; words equal isn't enough to call it its own", () => {
  const pick = { verdict: 'replace', use: 'Table', props: {} };
  const proposals = { 'Table#w': { use: 'Table', props: {}, check: 'exact', url: 'rendered/t.png', own: false, example: true, content: "an example of the component, not this element's content" } };
  const e = el('table', { role: 'static-table', ownHash: 'w', use: 'Table', props: {}, shot: shot({ content: { text: 'A long table', inner: null } }) });
  assert.deepEqual(reviewed({ proposals }, e, pick).missing, []);
});

test("a field's words: drawn with them it's ready; a photo from before they were recorded needs taking again", () => {
  const pick = { verdict: 'replace', use: 'Input', props: {} };
  const proposals = { 'Input#f': { use: 'Input', props: {}, check: 'exact', url: 'rendered/i.png', own: true, text: 'Walnut' }, Input: { use: 'Input', props: {}, check: 'exact', url: 'rendered/plain.png', own: false } };
  const field = (content: object, o: object = {}) => el('field', { role: 'text-input', snippet: '<input defaultValue={value} />', use: 'Input', props: {}, ownHash: 'f', shot: shot({ content: { text: null, inner: null, ...content } }), ...o });
  assert.deepEqual(reviewed({ proposals }, field({ value: 'Walnut', placeholder: null }), pick).missing, []);
  // Words that aren't its own are caught like any other.
  assert.match(reviewed({ proposals }, field({ value: 'Linen', placeholder: null }), pick).missing[0].why, /aren't this element's own/);
  // An empty field has nothing to compare: the plain drawing is right.
  assert.deepEqual(reviewed({ proposals }, field({ value: null, placeholder: null }, { ownHash: null }), pick).missing, []);
  const old = reviewed({ proposals }, field({}, { ownHash: null }), pick);
  assert.deepEqual(old.missing.map((m: any) => m.kind), ['no-field-words']);
  assert.match(old.missing[0].fix, /screenshots again/);
});

test('one small part proposed as the whole it belongs to is compared with that part, or held out', () => {
  const pick = { verdict: 'replace', use: 'Sidebar', props: {} };
  const whole = { use: 'Sidebar', props: {}, check: 'exact', url: 'rendered/s.png', own: true, text: '', inner: true, w: 256, h: 900 };
  const part = { use: 'SidebarTrigger', props: {}, check: 'exact', url: 'rendered/p.png', own: true, text: '', inner: true, w: 28, h: 28 };
  const e = (o: object = {}) => el('toggle', { role: 'host-copy', ownHash: 'p', use: 'Sidebar', props: {}, alternatives: [{ verdict: 'replace', use: 'SidebarTrigger', props: {} }], shot: shot({ box: { x: 1, y: 1, w: 24, h: 24, cw: 240, ch: 120 }, content: { text: null, inner: { marks: 1, blocks: 0, lost: 0 } } }), ...o });
  const E = { proposals: { 'Sidebar#p': whole, 'SidebarTrigger#p': part } };
  const shown = proposalFor(E, e(), pick);
  assert.deepEqual([shown.url, shown.partUse, shown.partOf], ['rendered/p.png', 'SidebarTrigger', 'Sidebar']);
  assert.deepEqual(reviewed(E, e(), pick).missing, []);
  const none = reviewed({ proposals: { 'Sidebar#p': whole } }, e(), pick);
  assert.deepEqual(none.missing.map((m: any) => m.kind), ['whole-for-part']);
  assert.match(none.missing[0].why, /one small part/);
  // About its size: nothing changes.
  const same = proposalFor({ proposals: { 'Sidebar#p': { ...whole, w: 40, h: 40 } } }, e(), pick);
  assert.equal(same.url, 'rendered/s.png');
});

test("width a component only has from its container isn't counted against it; its drawing is the one nearest the element's width", () => {
  const pick = { verdict: 'replace', use: 'Field', props: {} };
  const e = (w: number, h: number, o: object = {}) => el('name', { ownHash: 'f', use: 'Field', props: {}, shot: shot({ box: { x: 1, y: 1, w, h, cw: 400, ch: 200 }, content: { text: 'Alder', inner: null } }), ...o });
  const fills = { use: 'Field', props: {}, check: 'exact', url: 'rendered/wide.png', own: true, text: 'Alder', w: 1232, h: 36, fills: true };
  // Drawn at the page's width, it's still the same kind of thing as the element.
  assert.deepEqual(reviewed({ proposals: { 'Field#f': fills } }, e(160, 26), pick).missing, []);
  const sizes = [{ for: 160, url: 'rendered/160.png', w: 160, h: 36 }, { for: 40, url: 'rendered/40.png', w: 40, h: 36 }];
  const E = { proposals: { 'Field#f': { ...fills, url: 'rendered/160.png', sizes } } };
  assert.deepEqual([proposalFor(E, e(158, 26), pick).url, proposalFor(E, e(24, 20), pick).url, proposalFor(E, e(24, 20), pick).w], ['rendered/160.png', 'rendered/40.png', 40]);
  // Filling its container doesn't excuse being many times taller; a fixed width still counts as width.
  assert.deepEqual(reviewed({ proposals: { 'Field#f': { ...fills, h: 400 } } }, e(160, 26), pick).missing.map((m: any) => m.kind), ['whole-for-part']);
  assert.deepEqual(reviewed({ proposals: { 'Field#f': { ...fills, fills: false } } }, e(160, 26), pick).missing.map((m: any) => m.kind), ['whole-for-part']);
});

test('a photo that shows nothing says so, and is never called a small part of anything', () => {
  const pick = { verdict: 'replace', use: 'Sheet', props: {} };
  const big = { use: 'Sheet', props: {}, check: 'exact', url: 'rendered/s.png', own: false, w: 1232, h: 900 };
  const e = (w: number, h: number) => el('dot', { use: 'Sheet', props: {}, shot: shot({ blank: true, box: { x: 1, y: 1, w, h, cw: 40, ch: 40 } }) });
  const tiny = reviewed({ proposals: { Sheet: big } }, e(4, 4), pick).missing;
  assert.deepEqual(tiny.map((m: any) => m.kind), ['tiny-photo']);
  assert.match(tiny[0].why, /only 4 × 4 px.*nothing usable/);
  assert.deepEqual(reviewed({ proposals: { Sheet: big } }, e(1392, 17), pick).missing.map((m: any) => m.kind), ['blank']);
});

test('where the app uses it: only photos are tiles; with none, the page has a line to say so; a wordless drawing is no example', () => {
  const system = [{ component: 'Button', axes: { size: ['default', 'sm'] }, defaults: { size: 'default' } }];
  const use = (line: number, props: object, o: object = {}) => ({ app: 'ledger', file: `ledger/src/U${line}.tsx`, line, component: 'Button', props, shot: null, ...o });
  const pick = { use: 'Button', props: {} };
  const item = (uses: any[], plain: object = {}) => {
    const p: any = payload([el('a', { ...pick, needsHuman: true })]);
    p.elements.proposals.Button = { use: 'Button', props: {}, check: 'exact', url: 'r/b.png', ...plain };
    p.elements.proposals['Button#own1'] = { use: 'Button', props: {}, check: 'exact', url: 'r/o.png', own: true, text: 'Save' };
    return withReview(p, { audit: 0, system, precedents: uses }).elements.review.items[0];
  };
  const noPhotos = item([use(1, {}), use(2, {})]);
  assert.deepEqual([noPhotos.examples, noPhotos.usesCount], [[], 2]);
  const photo = { url: 's/u.png', box: null, page: '/a', pageName: 'A' };
  assert.deepEqual(item([use(1, {}), use(2, {}, { shot: photo })]).examples.map((x: any) => x.line), [2]);
  const near = item([use(3, { size: 'sm' })]);
  assert.deepEqual(near.nearest.examples, []);
  assert.equal(near.nearest.label, 'The app uses Button with size sm, but dsa has no photo of it yet.');
  assert.equal(item([]).systemExample.url, 'r/b.png');
  assert.equal(item([], { bare: true }).systemExample, null);
});

test('a drawing whose words are cut off is held out, and no candidate; at a width where they show, it stands', () => {
  const pick = { verdict: 'replace', use: 'Field', props: {} };
  const e = (w: number, o: object = {}) => el('name', { ownHash: 'f', use: 'Field', props: {}, shot: shot({ box: { x: 1, y: 1, w, h: 24, cw: 400, ch: 200 }, content: { text: 'Alder', inner: null } }), ...o });
  const base = { use: 'Field', props: {}, check: 'exact', url: 'rendered/f.png', own: true, text: 'Alder', w: 60, h: 24, fills: true };
  const cut = reviewed({ proposals: { 'Field#f': { ...base, cut: true } } }, e(60), pick).missing;
  assert.deepEqual(cut.map((m: any) => m.kind), ['cut-off']);
  assert.match(cut[0].why, /cut off/);
  // One width can be cut when another isn't: the one this element gets decides.
  const sizes = [{ for: 60, url: 'rendered/60.png', w: 90, h: 24, wider: true }, { for: 300, url: 'rendered/300.png', w: 300, h: 24, cut: true }];
  const E = { proposals: { 'Field#f': { ...base, sizes } } };
  assert.deepEqual(reviewed(E, e(60), pick).missing, []);
  assert.equal(proposalFor(E, e(60), pick).wider, true);
  assert.deepEqual(reviewed(E, e(300), pick).missing.map((m: any) => m.kind), ['cut-off']);
  const vague = e(60, { verdict: 'unclear', use: null, alternatives: [{ verdict: 'replace', use: 'Field', props: {} }] });
  assert.equal(candidatesOf({ proposals: { 'Field#f': { ...base, cut: true } } }, vague).length, 0);
  assert.equal(candidatesOf({ proposals: { 'Field#f': base } }, vague).length, 1);
});

test("a card's photos are of its own app: the same look first, then the nearest, each saying how it differs; with none, the line says why", () => {
  const system: any[] = [{ component: 'Button', axes: { variant: ['default', 'outline'], size: ['default', 'sm'] }, defaults: { variant: 'default', size: 'default' } }, { component: 'Toggle', axes: {}, defaults: {} }];
  const photo = (n: number) => ({ url: `s/${n}.png`, box: null, page: '/a', pageName: 'A' });
  const use = (line: number, props: object, o: object = {}) => ({ app: 'ledger', file: `ledger/src/U${line}.tsx`, line, component: 'Button', props, shot: null, ...o });
  const pick = { use: 'Button', props: { variant: 'outline' } };
  const item = (uses: any[], e: object = { ...pick }) => {
    const p: any = payload([el('a', { needsHuman: true, ...e })]);
    p.elements.proposals['Button|variant=outline#own1'] = { use: 'Button', props: pick.props, check: 'exact', url: 'r/o.png', own: true, text: 'Save' };
    p.elements.proposals['Button#own1'] = { use: 'Button', props: {}, check: 'exact', url: 'r/b.png', own: true, text: 'Save' };
    const out = withReview(p, { audit: 0, system, precedents: uses });
    return { it: out.elements.review.items[0], photos: out.elements.review.photos };
  };
  const mixed = item([use(1, { variant: 'outline' }, { shot: photo(1) }), use(2, { variant: 'outline', size: 'sm' }, { shot: photo(2) }), use(3, {}, { shot: photo(3) }), use(4, {}, { shot: photo(4) })]);
  assert.deepEqual(mixed.it.examples.map((x: any) => x.line), [1]);
  assert.equal(mixed.it.nearest, null, 'one photo of the look itself beats any number of near ones');
  assert.deepEqual(mixed.photos, { cards: 1, sameLook: 1, otherLook: 0, elsewhere: 0, labOnly: 0, none: 0, withPhoto: 1, distinctPhotos: 1, mostShown: 1, without: {} });
  // Another app's uses don't stand in, with or without a photo.
  const elsewhere = item([use(1, { variant: 'outline' }, { app: 'other', shot: photo(1) })]);
  assert.deepEqual([elsewhere.it.examples, elsewhere.it.usesCount, elsewhere.it.nearest, elsewhere.it.noPhoto], [[], 0, null, null]);
  // A look set in the code is a real photo, and says that's all it can say.
  const set = item([use(5, {}, { dynamic: ['variant'], shot: photo(5) })]);
  assert.equal(set.it.nearest.examples[0].differs, 'its look is set in the code');
  // No photo at all: why, from what the crawler saw of each.
  const why = (missed: string[]) => item(missed.map((m, i) => use(i + 1, { variant: 'outline' }, m === '-' ? {} : { missed: m }))).it.noPhoto;
  assert.equal(why(['not-seen', 'hidden']).why, 'hidden');
  assert.equal(why(['hidden']).line, 'The app uses Button in one place, but dsa has no photo of it: it was on the page, but hidden behind something closed, such as a menu or a tab.');
  assert.match(why(['not-seen', 'not-seen']).line, /2 places.*didn't show on any page dsa opened/);
  assert.match(why(['-']).line, /hasn't photographed it yet\.$/, 'no advice to take the screenshots again: a fresh run says this too');
  assert.match(why(['not-seen', 'out-of-time']).line, /ran out of time before reaching it/, "a page the limit never reached isn't a page it isn't on");
  const none = item([use(1, { variant: 'outline' }, { missed: 'not-seen' })]);
  assert.deepEqual(none.photos, { cards: 1, sameLook: 0, otherLook: 0, elsewhere: 0, labOnly: 0, none: 1, withPhoto: 0, distinctPhotos: 0, mostShown: 0, without: { 'not-seen': 1 } });
  // No clear pick: the closest candidate is what its photos are of.
  const unclear = item([use(1, {}, { shot: photo(1) })], { verdict: 'unclear', use: null, props: null, alternatives: [{ verdict: 'replace', use: 'Button', props: {} }] });
  assert.equal(unclear.it.about.use, 'Button');
  assert.deepEqual(unclear.it.examples.map((x: any) => x.line), [1]);
});

describe('photos of other looks say what they are', () => {
  const system: any[] = [{ component: 'Button', axes: { variant: ['default', 'dark', 'ghost', 'link'], size: ['default', 'xs', 'lg', 'icon'] }, defaults: { variant: 'default', size: 'default' } }];
  const use = (line: number, props: Record<string, unknown>, photo = true, page = `/p${line}`) => ({ app: 'ledger', file: `ledger/src/U${line}.tsx`, line, component: 'Button', props, shot: photo ? { url: `s/${line}.png`, box: null, page, pageName: page } : null });
  const cards = (picks: Record<string, unknown>[], uses: any[]) => {
    const p: any = payload(picks.map((props, i) => el(`e${i}`, { use: 'Button', props, needsHuman: true })));
    for (const props of picks) p.elements.proposals[`${proposalKey('Button', props)}#own1`] = { use: 'Button', props, check: 'exact', url: 'r/o.png', own: true, text: 'Save' };
    return withReview(p, { audit: 0, system, precedents: uses }).elements.review;
  };

  test("the heading can't contradict its tiles: the closest with no photo doesn't speak for the ones that have one", () => {
    const [it] = cards([{ variant: 'ghost', size: 'xs' }], [use(1, { variant: 'dark', size: 'xs' }, false), use(2, { variant: 'dark', size: 'icon' }), use(3, { variant: 'dark', size: 'lg' })]).items;
    assert.equal(it.nearest.kind, 'elsewhere');
    assert.equal(it.nearest.label, "dsa has no photo of this look. Here's how this app uses Button elsewhere.");
    assert.equal(it.nearest.examples.length, 1, 'one tile, not three weak ones');
    assert.doesNotMatch(JSON.stringify(it.nearest), /\bin dark\b/, 'a variant name, not dark mode');
    assert.match(it.nearest.examples[0].differs, /^the dark variant, size /);
  });

  test("two looks both at the default size share nothing to see; a shared size set on purpose is one tile; the same variant up to three", () => {
    const link = cards([{ variant: 'link' }], [use(1, { variant: 'dark' }), use(2, { variant: 'dark' })]).items[0];
    assert.deepEqual([link.nearest.kind, link.nearest.examples.length], ['elsewhere', 1]);
    const size = cards([{ variant: 'ghost', size: 'xs' }], [use(1, { variant: 'dark', size: 'xs' }), use(2, { variant: 'link', size: 'xs' })]).items[0];
    assert.deepEqual([size.nearest.kind, size.nearest.examples.length, size.nearest.label], ['close', 1, "dsa has no photo of this look. Here's a use with the same size."]);
    const variant = cards([{ variant: 'ghost', size: 'xs' }], [use(1, { variant: 'ghost', size: 'lg' }), use(2, { variant: 'ghost' }), use(3, { variant: 'ghost', size: 'icon' }), use(4, { variant: 'dark', size: 'xs' })]).items[0];
    assert.deepEqual(variant.nearest.examples.map((x: any) => x.line), [1, 2, 3]);
    assert.equal(variant.nearest.label, 'dsa has no photo of this look. Here are uses with the same variant.');
  });

  test('one photo does not take over: cards show the least-shown photo, from different pages, and the count says so', () => {
    const uses = [use(1, { variant: 'dark' }), use(2, { variant: 'dark', size: 'lg' }), use(3, { variant: 'dark', size: 'icon' })];
    const review = cards([{ variant: 'link' }, { variant: 'ghost' }, { variant: 'link', size: 'xs' }], uses);
    assert.deepEqual(review.items.map((i: any) => i.nearest.examples[0].line).sort(), [1, 2, 3], 'each card a different photo');
    assert.deepEqual(review.photos, { cards: 3, sameLook: 0, otherLook: 3, elsewhere: 3, labOnly: 0, none: 0, withPhoto: 3, distinctPhotos: 3, mostShown: 1, without: {} });
    assert.equal(cards([{ variant: 'link' }, { variant: 'ghost' }], [use(1, { variant: 'dark' })]).photos.mostShown, 2);
    const samePage = cards([{ variant: 'ghost' }], [use(1, { variant: 'ghost' }, true, '/a'), use(2, { variant: 'ghost' }, true, '/a'), use(3, { variant: 'ghost' }, true, '/b')]).items[0];
    assert.deepEqual(samePage.examples.map((x: any) => x.line), [1, 3, 2], 'other pages before a repeat of this one');
  });

  test('the log line counts the look itself, apart from every other look', () => {
    assert.equal(photosLine({ cards: 118, sameLook: 60, otherLook: 40, elsewhere: 25, labOnly: 5, none: 13, distinctPhotos: 70, mostShown: 6 }), 'Review cards: 118. Photo in the look proposed, in the product: 60. Only another look in the product: 40 (25 of them just how the app uses it elsewhere). Only from a lab page: 5. No photo: 13. 70 different photos, none on more than 6 cards.');
  });
});

describe('a lab page is not the product', () => {
  const system: any[] = [{ component: 'Button', axes: { variant: ['default', 'link', 'ghost'], size: ['default', 'xs'] }, defaults: { variant: 'default', size: 'default' } }];
  const use = (line: number, props: Record<string, string>, lab = false) => ({ app: 'ledger', file: `ledger/src/U${line}.tsx`, line, component: 'Button', props, ...(lab ? { lab } : {}), shot: { url: `s/${line}.png`, box: null, page: `/p${line}`, pageName: `/p${line}` } });
  const card = (uses: any[]) => {
    const props = { variant: 'link' };
    const p: any = payload([el('e0', { use: 'Button', props, needsHuman: true })]);
    p.elements.proposals[`${proposalKey('Button', props)}#own1`] = { use: 'Button', props, check: 'exact', url: 'r/o.png', own: true, text: 'Save' };
    return withReview(p, { audit: 0, system, precedents: uses }).elements.review;
  };
  const link = { variant: 'link' }, ghost = { variant: 'ghost' };

  test('a product photo of the look: the lab photo stays out of it', () => {
    const r = card([use(1, link, true), use(2, link)]);
    assert.deepEqual(r.items[0].examples.map((x: any) => x.line), [2]);
    assert.deepEqual(r.items[0].labExamples, []);
    assert.equal(r.photos.sameLook, 1);
    assert.equal(r.photos.labOnly, 0);
  });

  test('the look only on a lab page, nothing else: shown, and counted apart', () => {
    const r = card([use(1, link, true), use(2, link, true)]);
    assert.deepEqual(r.items[0].examples, []);
    assert.equal(r.items[0].labExamples.length, 1, 'one is enough');
    assert.equal(r.items[0].noPhoto, null);
    assert.deepEqual([r.photos.sameLook, r.photos.otherLook, r.photos.labOnly, r.photos.none, r.photos.withPhoto], [0, 0, 1, 0, 1]);
  });

  test('the look on a lab page and another look in the product: the product leads, and it counts as another look', () => {
    const r = card([use(1, link, true), use(2, ghost)]);
    assert.deepEqual(r.items[0].nearest.examples.map((x: any) => x.line), [2]);
    assert.match(r.items[0].nearest.label, /no photo of this look in the product/);
    assert.deepEqual(r.items[0].labExamples.map((x: any) => x.line), [1]);
    assert.deepEqual([r.photos.sameLook, r.photos.otherLook, r.photos.labOnly], [0, 1, 0]);
  });

  test('another look: the product before a closer one from a lab; only a lab, one tile, counted apart', () => {
    const closer = { variant: 'link', size: 'xs' };
    const props = { variant: 'link', size: 'lg' };
    const p: any = payload([el('e0', { use: 'Button', props, needsHuman: true })]);
    p.elements.proposals[`${proposalKey('Button', props)}#own1`] = { use: 'Button', props, check: 'exact', url: 'r/o.png', own: true, text: 'Save' };
    const sys: any[] = [{ component: 'Button', axes: { variant: ['default', 'link', 'ghost'], size: ['default', 'xs', 'lg'] }, defaults: { variant: 'default', size: 'default' } }];
    const both = withReview(JSON.parse(JSON.stringify(p)), { audit: 0, system: sys, precedents: [use(1, closer, true), use(2, ghost)] }).elements.review;
    assert.deepEqual(both.items[0].nearest.examples.map((x: any) => x.line), [2]);
    const labs = withReview(JSON.parse(JSON.stringify(p)), { audit: 0, system: sys, precedents: [use(1, closer, true), use(3, closer, true)] }).elements.review;
    assert.equal(labs.items[0].nearest.examples.length, 1);
    assert.deepEqual([labs.photos.otherLook, labs.photos.labOnly], [0, 1]);
  });

  test('the log line keeps them apart, and a named page in another file says where it is', () => {
    assert.match(photosLine({ cards: 3, sameLook: 1, otherLook: 0, elsewhere: 0, labOnly: 2, none: 0, distinctPhotos: 2, mostShown: 1 }), /in the product: 1\..*Only from a lab page: 2\./);
    assert.equal(pageName('http://x.test/labs/token-lab.html#gallery'), 'Labs › Token lab.html › Gallery');
    assert.equal(pageName('http://x.test/#/colours/gallery'), 'Colours › Gallery');
    assert.equal(pageName('http://x.test/index.html#gallery'), 'Gallery');
  });
});
