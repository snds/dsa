import { test } from 'vitest';
import './setup.js';
import assert from 'node:assert/strict';
import { questions } from '../../src/engine/review.js';
import type { ElementEval } from '../../src/engine/elements.js';

// Review cards group by design identity (src/identity.ts), the way a design-system designer reads them:
// the control first, then the role, what it does, and tone. Repros from the 2026-10-13 audit
// (docs/element-review-audit): HOVER_WASH paired a page-index row with a filter chip; a draft row's ✓
// was auto-approved while its ✕ was asked; AmountInput's two chevrons sat in two cards.

let n = 0;
const ev = (over: Partial<ElementEval>): ElementEval => ({
  id: `E-${++n}`, target: 'app', file: 'src/X.tsx', line: n * 10, col: 1, element: 'button', fingerprint: `fp${n}`,
  verdict: 'replace', role: 'button', use: 'Button', props: { variant: 'ghost' }, ruleId: 'button.ghost',
  confidence: 0.8, needsHuman: true, reasons: [], alternatives: [], visualDiffs: [], a11y: [],
  snippet: '<button>', source: '<button></button>', match: { tag: 'button', classes: [], text: '' }, classTokens: [],
  ...over,
} as ElementEval);
const cardOf = (qs: ReturnType<typeof questions>, id: string) => qs.find(q => q.items.some(i => i.id === id));

test('groups: a utility class never pairs unlike things (HOVER_WASH)', () => {
  const row = ev({ role: 'menu-item', use: 'DropdownMenuItem', props: {}, ruleId: 'button.menu-item', styleKey: 'HOVER_WASH' });
  const chip = ev({ role: 'chip-toggle', use: 'ToggleGroupItem', props: {}, ruleId: 'button.chip', styleKey: 'HOVER_WASH' });
  const qs = questions([row, chip]);
  assert.notEqual(cardOf(qs, row.id), cardOf(qs, chip.id));
  assert.ok(!qs.some(q => q.kind === 'pattern' && q.key === 'HOVER_WASH'));
});

test('groups: a control keeps its parts in one card, sure parts included, one decision per kind of part', () => {
  const box = { name: 'div', line: 200 };
  const ok = ev({ file: 'src/Draft.tsx', container: box, props: { variant: 'ghost', size: 'icon-sm' }, confidence: 0.92, needsHuman: false, match: { tag: 'button', classes: [], text: '', ariaLabel: 'Save' } });
  const cancel = ev({ file: 'src/Draft.tsx', container: box, props: { variant: 'ghost', size: 'icon-sm' }, classTokens: ['text-destructive'], match: { tag: 'button', classes: [], text: '', ariaLabel: 'Cancel' } });
  const qs = questions([ok, cancel]);
  const card = cardOf(qs, cancel.id)!;
  assert.ok(card.items.some(i => i.id === ok.id), 'the sure ✓ sits with the asked ✕');
  assert.match(card.title, /side by side in Draft: “Save”, “Cancel”/);
  // Different answers inside one control: a part each.
  const menu = { name: 'DropdownMenuContent', line: 300 };
  const item = ev({ file: 'src/M.tsx', container: menu, role: 'menu-item', use: 'DropdownMenuItem', props: {} });
  const check = ev({ file: 'src/M.tsx', container: menu, role: 'menu-item', use: 'DropdownMenuCheckboxItem', props: {} });
  const m = cardOf(questions([item, check]), item.id)!;
  assert.equal(m.parts?.length, 2);
  assert.match(m.title, /^One menu in M/);
  assert.match(m.ask, /Its parts need 2 different answers/);
});

test('groups: the insides of a hand-built Acme component say so first (AmountInput chevrons)', () => {
  const up = ev({ file: 'src/AmountInput.tsx', within: 'AmountInput', recipe: 'AmountInput', role: 'icon-button', use: 'IconButton' });
  const down = ev({ file: 'src/AmountInput.tsx', within: 'AmountInput', recipe: 'AmountInput', role: 'icon-button', use: 'IconButton' });
  const qs = questions([up, down]);
  assert.equal(qs.length, 1);
  assert.match(qs[0]!.title, /insides of a hand-built AmountInput/);
  assert.match(qs[0]!.note ?? '', /Importing AmountInput from Acme/);
});

test('groups: one family, several sizes is one card with a version each; sure members come as context', () => {
  const pencil = (size: string, sure = false) => ev({ role: 'icon-button', use: 'IconButton', props: { variant: 'ghost', size }, source: '<button><Icon name="edit" /></button>', confidence: sure ? 0.95 : 0.8, needsHuman: !sure });
  const a = pencil('xs'), b = pencil('sm'), c = pencil('sm'), sure = pencil('xs', true);
  const qs = questions([a, b, c, sure]);
  assert.equal(qs.length, 1);
  assert.equal(qs[0]!.title, 'Edit buttons (pencil)');
  assert.equal(qs[0]!.parts?.length, 2);
  assert.match(qs[0]!.ask, /2 versions of the same thing/);
  assert.deepEqual(qs[0]!.context?.map(e => e.id), [sure.id]);
});

test('groups: card words carry no rule ids, class hashes or asChild', () => {
  const evs = [
    ev({ role: 'link-button', props: { variant: 'link' }, ruleId: 'button.quiet-text', classTokens: ['text-muted-foreground'], styleSig: 'eb250804' }),
    ev({ role: 'link-button', props: { variant: 'link' }, ruleId: 'button.quiet-text', classTokens: ['text-muted-foreground'], styleSig: 'eb250804' }),
    ev({ role: 'clickable-region', use: 'Item', props: { render: '<button type="button" />' }, ruleId: 'button.region-row' }),
    ev({ role: 'drop-target', verdict: 'gap', use: undefined, props: {}, gap: 'Acme has no file dropzone.', ruleId: 'button.region-drop' }),
  ];
  for (const q of questions(evs)) {
    const words = `${q.title} ${q.ask}`;
    assert.doesNotMatch(words, /button\.|eb250804|asChild|clickable-region|visual parity/, words);
  }
  const qs = questions(evs);
  assert.equal(cardOf(qs, evs[0]!.id)!.title, 'Grey text actions');
  assert.equal(cardOf(qs, evs[2]!.id)!.ask, 'Replace with Item rendered as a button?');
  assert.equal(cardOf(qs, evs[3]!.id)!.home, 'No Acme home yet');
});

test('groups: a shared style carries the answer as a policy only when no unlike element shares it', () => {
  const a = ev({ styleKey: 'PLUS_NOUN_LINK', role: 'link-button', props: { variant: 'link' } });
  const b = ev({ styleKey: 'PLUS_NOUN_LINK', role: 'link-button', props: { variant: 'link' } });
  assert.equal(questions([a, b])[0]!.kind, 'pattern');
  // CRUMB_LINK on a trail crumb too: the policy would reach it, so the card decides its own members only.
  const c = ev({ styleKey: 'CRUMB_LINK', role: 'link-button', props: { variant: 'link' } });
  const d = ev({ styleKey: 'CRUMB_LINK', role: 'link-button', props: { variant: 'link' } });
  const crumb = ev({ styleKey: 'CRUMB_LINK', role: 'breadcrumb-link', use: 'BreadcrumbLink', props: {} });
  const qs = questions([c, d, crumb]);
  assert.equal(cardOf(qs, c.id)!.kind, 'group');
  assert.notEqual(cardOf(qs, c.id), cardOf(qs, crumb.id));
});
