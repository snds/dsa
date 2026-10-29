import { test } from 'vitest';
import './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { reactFeatures, visitWithAncestors, resetFeatureCaches, type ElementFeatures } from '../../src/engine/scanners/features.js';
import { classify, systemRoles, type Evaluation } from '../../src/engine/classify.js';

// Buttons that wrap more than a label. The 2026-10-13 audit (docs/element-review-audit/gaps-and-regions.md)
// found 15 of 19 "clickable region" calls wrong: one gap sentence ("Acme has no clickable row, card, or
// region") covered list rows, cards, cell editors, tiles, swatches and a dropzone. Snippets are trimmed
// from a host app at the lines the audit names.

function features(code: string): ElementFeatures {
  resetFeatureCaches();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-region-')), 'x.tsx');
  fs.writeFileSync(file, code);
  let hit: ElementFeatures | null = null;
  visitWithAncestors(parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }).program, (n: any, anc: any[]) => {
    if (!hit && n.type === 'JSXElement' && /^(button|input)$/.test(n.openingElement.name.name)) hit = reactFeatures(n, [...anc], code, file, []);
  });
  assert.ok(hit, 'snippet has a native element');
  return hit!;
}
const evalOf = (code: string): Evaluation => classify(features(code));
const offers = (e: Evaluation, role: string) => e.alternatives.some(a => a.role === role);

test('regions: a list row with a title and a detail line is Item rendered as a button', () => {
  const e = evalOf(`export const R = () => <div>{RELATED.map(r => (
    <button type="button" key={r.name} onClick={() => setRelated(r)} className="w-full text-left group">
      <p className="text-sm font-medium text-foreground leading-tight group-hover:text-primary">{r.name}</p>
      <div className="flex items-center gap-2 mt-1 text-xs"><span className="px-1.5 py-0.5 rounded bg-muted">{r.type}</span><span>{r.quarter}</span></div>
    </button>))}</div>;`);
  assert.equal(e.role, 'clickable-region');
  assert.equal(e.verdict, 'replace');
  assert.equal(e.use, 'Item');
  assert.equal(e.props?.render, '<button type="button" />');
  assert.ok(e.reasons.some(r => /title line and a detail line/.test(r.text)), JSON.stringify(e.reasons));
  assert.ok(offers(e, 'button'), 'Button is always offered');
  assert.ok(e.confidence < 0.9, 'a design call: a person confirms');
});

test('regions: a title and detail nested in one span still reads as a list row, not a single action', () => {
  const e = evalOf(`export const L = () => <ul>{LAYERS.map(layer => (<li key={layer.id}>
    <button type="button" className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-accent">
      <StatusDot status={layer.status} />
      <span className="flex-1 min-w-0"><span className="block text-sm font-medium">{layer.label}</span><span className="block text-xs text-muted-foreground truncate">{layer.detail}</span></span>
      <Icon name="chevron_right" />
    </button></li>))}</ul>;`);
  assert.equal(e.role, 'clickable-region');
});

test('regions: a bordered card is Item variant outline', () => {
  const e = evalOf(`export const T = ({ item, onOpen }) => <button type="button" onClick={onOpen} className={clsx('w-full rounded-md border px-4 py-3 text-left bg-card', done ? 'border-border' : 'border-primary/40')}><div className="flex"><span>{item.title}</span></div><p className="text-xs">{item.due}</p></button>;`);
  assert.equal(e.use, 'Item');
  assert.equal(e.props?.variant, 'outline');
  assert.ok(e.reasons.some(r => /Drawn as a card/.test(r.text)));
});

test('regions: a click-to-edit cell value is a DataTable editable column, with how to do it', () => {
  const e = evalOf(`export const C = ({ value, format }) => <td><button type="button" data-cell-control="" onClick={(e) => { e.stopPropagation(); setEditing(true); }} className="min-w-0 text-left overflow-visible">{format(value)}</button></td>;`);
  assert.equal(e.role, 'editable-cell');
  assert.equal(e.use, 'DataTable');
  assert.match(e.how ?? '', /meta\.editable/);
  assert.ok(offers(e, 'button'));
});

test('regions: an image tile in a pick-one set is ToggleGroupItem', () => {
  const e = evalOf(`export const P = ({ images, selectedIndex }) => <div className="flex gap-2">{images.map((src, i) => { const selected = i === selectedIndex; return (
    <button key={i} type="button" onClick={() => onSelectImage(i)} className={clsx('w-14 h-14 rounded-lg bg-muted', selected ? 'border border-primary ring-2' : 'border border-border')}>
      <span className="block size-full overflow-hidden"><img src={src} alt="" className="w-full h-full object-cover" /></span>
    </button>); })}</div>;`);
  assert.equal(e.role, 'choice-tile');
  assert.equal(e.use, 'ToggleGroupItem');
  assert.ok(offers(e, 'clickable-region') || offers(e, 'button'));
});

test('regions: a drag-and-drop area is the file dropzone gap, with its own sentence', () => {
  const e = evalOf(`export const U = ({ onFiles, className }) => <button type="button" aria-label="Click to upload or drag and drop" onClick={() => ref.current?.click()} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDrop={(e) => { e.preventDefault(); onFiles(e.dataTransfer.files); }} className={clsx('w-full rounded-lg border border-dashed flex flex-col items-center py-6', className)}><Icon name="upload" /><span>Click to upload</span><span className="text-xs">PNG, JPG</span></button>;`);
  assert.equal(e.role, 'drop-target');
  assert.equal(e.verdict, 'gap');
  assert.match(e.gap ?? '', /no file dropzone/);
  assert.ok(!e.reasons.some(r => /styling comes from outside/.test(r.text) && r.delta < 0), 'outside styling does not lower a gap');
  assert.ok(offers(e, 'button'));
});

test('regions: swatch parts and a hidden native colour picker are the colour field gap', () => {
  const trigger = evalOf(`export const H = () => <PopoverTrigger asChild><button type="button" title="Pick a Colour" aria-label="Pick a Colour" className="inline-flex shrink-0 rounded p-0 hover:ring-2"><ObjectThumb alt="" size="field"><HexFace value={value} /></ObjectThumb></button></PopoverTrigger>;`);
  assert.equal(trigger.role, 'color-input');
  assert.equal(trigger.verdict, 'gap');
  const preset = evalOf(`export const P = () => <div className="flex gap-1.5">{HEX_PRESETS.map((h) => (<button key={h} type="button" onClick={() => setHex(h)} aria-label={h} className={clsx('inline-flex rounded-full p-0', value === h ? 'ring-2 ring-primary' : 'ring-1 ring-border')}><ObjectThumb alt="" size="chip"><ObjectThumbFill hex={h} /></ObjectThumb></button>))}</div>;`);
  assert.equal(preset.role, 'color-input');
  assert.ok(offers(preset, 'choice-tile'), 'meanwhile: a pick-one set');
  const overlay = evalOf(`export const O = () => <input type="color" value={hex} onChange={e => setHex(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />;`);
  assert.equal(overlay.role, 'color-input');
  // An icon button that removes a colour is an icon button, not a colour part.
  const remove = evalOf(`export const X = () => <button type="button" onClick={() => onRemoveSwatchLink?.(id)} title="Remove Colour" aria-label="Remove Colour" className="rounded-sm bg-card/90 p-1 shadow-sm"><Icon name="close" size="sm" /></button>;`);
  assert.notEqual(remove.role, 'color-input');
});

test('regions: one label with icons is a single action Button; an avatar menu trigger stays a trigger', () => {
  const cta = evalOf(`export const A = () => <button type="button" onClick={() => setFullSearch(true)} className="flex items-center gap-2 w-full rounded-md border border-dashed border-primary px-3 py-2 text-left text-sm text-primary hover:bg-selected"><Icon name="search" /><span>Can't find it? <span className="font-medium">Search all colours</span></span><Icon name="arrow_forward" /></button>;`);
  assert.equal(cta.role, 'button');
  assert.equal(cta.use, 'Button');
  assert.ok(offers(cta, 'clickable-region'));
  const avatar = evalOf(`export const M = () => <DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label="Account Menu" className="shrink-0 rounded-full hover:ring-2"><Avatar className="size-8"><AvatarFallback>SS</AvatarFallback></Avatar></button></DropdownMenuTrigger></DropdownMenu>;`);
  assert.equal(avatar.ruleId, 'button.region-trigger');
  assert.equal(avatar.use, 'Button');
});

test('regions: role names are re-pointed, never removed, and the false gap sentence is gone', () => {
  for (const r of ['clickable-region', 'selector-card', 'color-input', 'editable-cell', 'choice-tile', 'drop-target']) assert.ok(r in systemRoles(), r);
  assert.equal(systemRoles()['clickable-region']!.use, 'Item');
  assert.ok(!Object.values(systemRoles()).some(r => /no (design system component for a )?clickable (row|region)/i.test(r.gap ?? '')));
});
