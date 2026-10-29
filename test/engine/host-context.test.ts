import { test } from 'vitest';
import { useAcme } from './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { reactFeatures, visitWithAncestors, resetFeatureCaches } from '../../src/engine/scanners/features.js';
import { systemRoleMap } from '../../src/engine/classify.js';
import { evaluateRows, type ElementEval } from '../../src/engine/elements.js';
import { isLabFile } from '../../src/engine/host-context.js';
import { questions } from '../../src/engine/questions.js';
import type { Lookalike, Target } from '../../src/engine/types.js';

// Context the element rules can't see (audit item 11, docs/element-review-audit/README.md §6): lab
// pages scanned as product UI, host copies of Acme components judged element by element, and Acme
// parts inside a button counted as raw images.

/** A host app under a temp root, with a minimal component list, evaluated like the pipeline does. */
function evaluate(files: Record<string, string>): ElementEval[] {
  resetFeatureCaches();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-host-'));
  // The system's component list, as a profile gives it: name, import path, and whether it is the
  // system's own component (found inside longer host names) or a thin wrap.
  useAcme({ components: () => [
    { name: 'RichOptionList', from: '@acme/ui/RichOptionList', kind: 'own' }, { name: 'FilterChip', from: '@acme/ui/FilterChip', kind: 'own' },
    { name: 'AmountInput', from: '@acme/ui/AmountInput', kind: 'own' }, { name: 'Avatar', from: '@acme/ui/avatar', kind: 'own' },
    { name: 'Table', from: '@acme/ui/table', kind: 'wrap' }, { name: 'Button', from: '@acme/ui/button', kind: 'own' },
    { name: 'GroupRow', from: '@acme/data-table/grouping', kind: 'own' }, { name: 'TableRow', from: '@acme/ui/table', kind: 'wrap' },
  ] });
  const dir = path.join(root, 'app');
  const rows: Lookalike[] = [];
  for (const [rel, code] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, code);
  }
  for (const rel of Object.keys(files).filter(f => /\.tsx$/.test(f))) {
    const file = path.join(dir, rel), code = fs.readFileSync(file, 'utf8');
    visitWithAncestors(parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }).program, (n: any, anc: any[]) => {
      if (n.type === 'JSXElement' && n.openingElement.name.name === 'button') rows.push({ target: 'app', element: 'button', component: 'Button', file: `app/${rel}`, line: n.loc.start.line, features: reactFeatures(n, [...anc], code, file, []) });
    });
  }
  const target: Target = { name: 'app', dir, role: 'child', deps: {} };
  return evaluateRows({ root, target, rows, exceptionOf: new Map(), map: systemRoleMap(), decisions: { file: path.join(dir, 'd.json'), decisions: [], policies: [] }, stats: new Map(), threshold: 0.9 });
}

const ACTION = (label: string) => `<button type="button" onClick={go} className="h-8 px-3 rounded-md bg-primary text-primary-foreground">${label}</button>`;

test('context: lab pages (features/*Lab) are tagged lab and stay out of Ready and the questions; "Lab results" product UI does not', () => {
  assert.ok(isLabFile('src/app/features/tokenLab/sections/TokensSection.tsx'));
  assert.ok(isLabFile('src/app/features/uxPatternsLab/canvasShim.tsx'));
  assert.ok(!isLabFile('src/app/features/vendorPortal/LabResultsView.tsx'), 'lab results are a product feature');
  assert.ok(!isLabFile('src/app/components/Label.tsx'));
  const evals = evaluate({
    'src/app/features/interactionLab/InteractionLab.tsx': `export function InteractionLab() { return <div>${ACTION('Save')}</div>; }`,
    'src/app/features/vendorPortal/LabResultsView.tsx': `export function LabResultsView() { return <div>${ACTION('Send')}</div>; }`,
  });
  const lab = evals.find(e => /interactionLab/.test(e.file))!, product = evals.find(e => /LabResults/.test(e.file))!;
  assert.equal(lab.exception, 'lab');
  assert.equal(product.exception, undefined);
  const ready = evals.filter(e => !e.exception && !e.needsHuman && !e.decided);
  assert.ok(!ready.includes(lab), 'lab specimens are never Ready');
  assert.ok(!questions(evals).some(q => q.items.includes(lab)));
});

test('context: a host copy of a Acme component is answered by importing Acme, with the element\'s own reading kept as an alternative', () => {
  const evals = evaluate({
    'src/components/RichOptionList.tsx': `export function RichOptionList({ options }) { return <div>{options.map(o => <OptionRow key={o.id} o={o} />)}</div>; }
function OptionRow({ o }) { return ${ACTION('{o.label}')}; }`,
  });
  const e = evals[0]!;
  assert.equal(e.role, 'host-copy');
  assert.equal(e.use, 'RichOptionList');
  assert.equal(e.from, '@acme/ui/RichOptionList');
  assert.equal(e.recipe, 'RichOptionList');
  assert.ok(e.needsHuman, 'importing Acme instead of the copy is confirmed by a person, once for the whole copy');
  assert.match(e.reasons[0]!.text, /^Host copy of Acme RichOptionList: RichOptionList\.tsx rebuilds it/);
  assert.equal(e.alternatives[0]!.use, 'Button', 'the element\'s own call stays, for when importing isn\'t possible yet');
});

test('context: Acme\'s own longer names count inside host names (renderRichGroupRow → GroupRow); a composing file or a one-word feature file is not a copy', () => {
  const evals = evaluate({
    'src/components/RichGroupRow.tsx': `export const renderRichGroupRow = (row) => <tr><td><button type="button" aria-expanded={row.open} onClick={row.toggle}><Icon name="chevron_right" /></button></td></tr>;`,
    'src/components/MyAmount.tsx': `import { AmountInput } from '@acme/ui';\nexport function AmountInput2() { return <AmountInput />; }\nexport function AmountInputRow() { return ${ACTION('Apply')}; }`,
    'src/components/Table.tsx': `export function Table() { return <div>${ACTION('Add row')}</div>; }`,
  });
  const group = evals.find(e => /RichGroupRow/.test(e.file))!;
  assert.equal(group.role, 'host-copy');
  assert.equal(group.use, 'GroupRow');
  assert.equal(evals.find(e => /MyAmount/.test(e.file))!.role !== 'host-copy', true, 'the file imports Acme AmountInput: it composes, not copies');
  const table = evals.find(e => /Table\.tsx/.test(e.file))!;
  assert.equal(table.recipe, 'Table', 'a function named exactly like a Acme component is still read as a copy (unchanged from #113)');
  const feature = evaluate({ 'src/components/Table.tsx': `export function LandingTable() { return <div>${ACTION('Add row')}</div>; }` })[0]!;
  assert.notEqual(feature.role, 'host-copy', 'Table.tsx holding a feature table is not a copy of the Acme Table primitive');
  // Another noun after the Acme name makes it something else: a section about group rows, not a GroupRow.
  const section = evaluate({ 'src/components/GroupRowSection.tsx': `export function Specimens() { return <div>${ACTION('Add')}</div>; }` })[0]!;
  assert.notEqual(section.role, 'host-copy');
  const renderer = evaluate({ 'src/components/rows.tsx': `export const makeStandardGroupRowRenderer = () => () => <tr><td>${ACTION('Edit')}</td></tr>;` })[0]!;
  assert.equal(renderer.use, 'GroupRow', 'a "Renderer" suffix still names the same thing');
});

test('context: a Acme Avatar inside a button is Acme already, not a raw image', () => {
  const evals = evaluate({
    'src/components/ui/avatar.tsx': `export * from "@acme/ui/avatar";`,
    'src/components/Header.tsx': `import { Avatar, AvatarFallback } from './ui/avatar';
export function Header() { return <DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label="Account Menu" className="shrink-0 rounded-full hover:ring-2"><Avatar><AvatarFallback>SS</AvatarFallback></Avatar></button></DropdownMenuTrigger></DropdownMenu>; }`,
  });
  const e = evals[0]!;
  assert.equal(e.use, 'Button');
  assert.ok(e.reasons.some(r => /Wraps a Acme Avatar/.test(r.text)), JSON.stringify(e.reasons));
  assert.ok(!e.reasons.some(r => /shows an image or avatar/.test(r.text)));
  // The same markup with a raw <img> stays an image.
  const raw = evaluate({ 'src/components/Header.tsx': `export function Header() { return <DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label="Account" className="rounded-full"><img src={me.photo} alt="" /></button></DropdownMenuTrigger></DropdownMenu>; }` })[0]!;
  assert.ok(raw.reasons.some(r => /shows an image or avatar/.test(r.text)));
});
