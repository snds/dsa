import { test } from 'vitest';
import './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { reactFeatures, visitWithAncestors, resetFeatureCaches, type ElementFeatures } from '../../src/engine/scanners/features.js';
import { calibrate, classify, type Evaluation } from '../../src/engine/classify.js';
import { withPlacement } from '../../src/engine/placement.js';

// Part components need their container (audit item 9, docs/element-review-audit/buttons-menus-toggles.md).
// The 2026-10-13 audit found DropdownMenuItem, ToggleGroupItem, TabsTrigger, CollapsibleTrigger and
// SidebarMenuButton recommended with no check that the container exists; 7 of 8 auto-approved calls
// in that slice were wrong or would crash. Snippets are trimmed from a host app.

function features(code: string, at = 0): ElementFeatures {
  resetFeatureCaches();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-parts-')), 'x.tsx');
  fs.writeFileSync(file, code);
  const hits: ElementFeatures[] = [];
  visitWithAncestors(parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }).program, (n: any, anc: any[]) => {
    if (n.type === 'JSXElement' && n.openingElement.name.name === 'button') hits.push(reactFeatures(n, [...anc], code, file, []));
  });
  assert.ok(hits[at], 'snippet has the native element');
  return hits[at];
}
const evalOf = (code: string, at = 0): Evaluation => classify(features(code, at));
const ROW = 'w-full text-left px-3 py-1.5 hover:bg-accent active:bg-accent flex items-center gap-2';

test('containers: right-click menu rows are ContextMenuItem inside ContextMenu, never sure without it', () => {
  const code = `export const M = () => <>{float?.t === 'ctx' && (() => (
    <Floating rect={{ left: float.x, top: float.y }} className="bg-card border rounded-lg shadow-xl py-1 text-sm">
      <button onClick={() => startEdit(float.cell)} className="${ROW}"><Icon name="edit" />Edit value</button>
      <button onClick={closeFloats} className="w-full text-left px-3 py-1.5 hover:bg-destructive/10 text-destructive flex items-center gap-2"><Icon name="delete" />Delete</button>
    </Floating>))()}</>;`;
  const edit = evalOf(code, 0), del = evalOf(code, 1);
  for (const e of [edit, del]) {
    assert.equal(e.use, 'ContextMenuItem');
    assert.equal(e.parent?.use, 'ContextMenu');
    assert.ok(e.confidence < 0.9, `capped below the threshold without its container (${e.confidence})`);
    assert.ok(e.reasons.some(r => /only works inside ContextMenu/.test(r.text)), JSON.stringify(e.reasons));
  }
  assert.equal(del.props?.variant, 'destructive', 'the red Delete row is destructive');
});

test('containers: a panel menu names the item kind and the DropdownMenu it needs', () => {
  const code = `export const P = () => <>{float?.t === 'panelMenu' && (<Floating rect={float.rect} className="bg-card border rounded-lg py-1">
    <button onClick={() => { markAllRead(); closeFloats(); }} className="${ROW}"><Icon name="done_all" />Mark all as read</button>
    <button onClick={() => { setShowResolved(s => !s); closeFloats(); }} className="${ROW}">{showResolved ? 'Hide resolved' : 'Show resolved'}</button>
    <button onClick={(e) => setFloat({ t: 'color', rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })} className="${ROW}">Comment indicator colour</button>
    {OPTIONS.map(([v, l]) => (<button key={v} onClick={() => { setNotif(v); closeFloats(); }} className="${ROW}">{notif === v ? <Icon name="check" /> : <span className="w-4 h-4" />}{l}</button>))}
  </Floating>)}</>;`;
  assert.deepEqual([0, 1, 2, 3].map(i => evalOf(code, i).use), ['DropdownMenuItem', 'DropdownMenuCheckboxItem', 'DropdownMenuSubTrigger', 'DropdownMenuRadioItem']);
  for (let i = 0; i < 4; i++) {
    const e = evalOf(code, i);
    assert.equal(e.parent?.use, 'DropdownMenu');
    assert.ok(e.confidence < 0.9);
  }
});

test('containers: a menu row inside a Acme DropdownMenu needs nothing more', () => {
  const e = evalOf(`export const M = () => <DropdownMenu><DropdownMenuContent><button onClick={archive} className="${ROW}"><Icon name="archive" />Archive</button></DropdownMenuContent></DropdownMenu>;`);
  assert.equal(e.use, 'DropdownMenuItem');
  assert.equal(e.parent, undefined);
  assert.ok(!e.reasons.some(r => /only works inside/.test(r.text)));
});

test('containers: role="option" in a listbox is a picker option, ComboboxItem in a multiple Combobox', () => {
  const e = evalOf(`export const O = ({ label, sel }) => <div><button type="button" role="option" aria-selected={sel} tabIndex={-1} onClick={() => onToggle(label)} className="flex w-full items-center gap-2 px-2 py-1.5"><Checkbox checked={sel} /><span>{label}</span></button></div>;`);
  assert.equal(e.role, 'combobox-item');
  assert.equal(e.use, 'ComboboxItem');
  assert.equal(e.parent?.use, 'Combobox');
  assert.equal(e.parent?.props?.multiple, 'true', 'a checkbox per option: several can be picked');
});

test('containers: expanders inside table rows are GroupRow (DataTable grouping), never CollapsibleTrigger around a <tr>', () => {
  const text = evalOf(`export const R = () => <tr><td className="px-3 py-2"><button type="button" onClick={onExpand} className="flex items-center gap-1 text-primary text-xs">{open ? <Icon name="expand_more" size="xs" /> : <Icon name="chevron_right" size="xs" />}Landed Cost</button></td></tr>;`);
  const icon = evalOf(`export const R = () => <tr><td><div className="flex"><button type="button" aria-expanded={row.getIsExpanded()} aria-label={'Expand ' + name} onClick={() => row.toggleExpanded()}><Icon name="chevron_right" size="sm" className={clsx('transition-transform', row.getIsExpanded() && 'rotate-90')} /></button></div></td></tr>;`);
  for (const e of [text, icon]) {
    assert.equal(e.role, 'row-expander');
    assert.equal(e.use, 'GroupRow');
    assert.equal(e.from, '@acme/data-table/grouping');
    assert.equal(e.parent?.use, 'DataTable', 'GroupRow comes with DataTable grouping');
    assert.ok(e.confidence < 0.9);
    assert.ok(e.alternatives.some(a => a.use === 'Button' && a.props?.variant === 'ghost' && a.props?.size === 'xs'), 'Button ghost xs with aria-expanded until then');
  }
  // Outside a table, a disclosure is still a CollapsibleTrigger, inside Collapsible.
  const plain = evalOf(`export const A = () => <button aria-expanded={open} onClick={() => setOpen(!open)} className="text-sm text-primary">{open ? 'Hide' : 'Show more'}</button>;`);
  assert.equal(plain.use, 'CollapsibleTrigger');
  assert.equal(plain.parent?.use, 'Collapsible');
});

test('containers: a current nav row outside SidebarProvider names the shell and is never auto-approved; inside SidebarMenu it is', () => {
  const row = `<button type="button" aria-current={active ? 'page' : undefined} onClick={() => go(item.id)} className={cn('flex w-full items-center gap-2 px-2 h-8 text-sm', active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent')}><Icon name={item.icon} />{item.label}</button>`;
  const bare = evalOf(`export const N = () => <nav><ul>{ITEMS.map(item => <li key={item.id}>${row}</li>)}</ul></nav>;`);
  assert.equal(bare.use, 'SidebarMenuButton');
  assert.equal(bare.parent?.use, 'SidebarProvider');
  assert.ok(bare.confidence < 0.9, `SidebarMenuButton throws outside SidebarProvider (${bare.confidence})`);
  assert.ok(bare.parent!.how.includes('throws'));
  const inShell = evalOf(`export const N = () => <SidebarMenu>{ITEMS.map(item => <SidebarMenuItem key={item.id}>${row}</SidebarMenuItem>)}</SidebarMenu>;`);
  assert.equal(inShell.use, 'SidebarMenuButton');
  assert.equal(inShell.parent, undefined);
  // A host component that happens to be called Sidebar is not the Acme shell.
  const hostSidebar = evalOf(`export const N = () => <Sidebar><nav>{ITEMS.map(item => <div key={item.id}>${row}</div>)}</nav></Sidebar>;`);
  assert.equal(hostSidebar.parent?.use, 'SidebarProvider');
});

test('containers: joined segments need ToggleGroup fit="flush"; rows that switch a dialog panel need vertical Tabs', () => {
  const code = `export const S = () => <div className="flex h-8 w-full overflow-hidden rounded-sm border border-border bg-muted">
    <button type="button" onClick={() => setAudience('internal')} className={clsx('inline-flex h-full flex-1 items-center justify-center gap-1.5 text-xs', aud === 'internal' ? 'bg-selected text-primary' : 'text-muted-foreground hover:bg-accent')}><Icon name="lock" size="sm" />Internal</button>
    <button type="button" onClick={() => setAudience('vendor')} className={clsx('inline-flex h-full flex-1 items-center justify-center gap-1.5 border-l border-border text-xs', aud === 'vendor' ? 'bg-selected text-primary' : 'text-muted-foreground hover:bg-accent')}><Icon name="group" size="sm" />Vendor</button>
  </div>;`;
  for (const i of [0, 1]) {
    const e = evalOf(code, i);
    assert.equal(e.use, 'ToggleGroupItem');
    assert.equal(e.parent?.use, 'ToggleGroup');
    assert.deepEqual(e.parent?.props, { fit: 'flush', variant: 'outline' }, `segment ${i}: a one-side border is the divider, not a box`);
  }
  const tabs = evalOf(`export const T = () => <Dialog><DialogContent><aside>{VIEWS.map(v => <button key={v.id} onClick={() => setView(v.id)} className={cn('w-full text-left px-3 py-2 text-sm', view === v.id ? 'bg-accent' : 'hover:bg-accent')}>{v.label}</button>)}</aside></DialogContent></Dialog>;`);
  assert.equal(tabs.use, 'TabsTrigger');
  assert.equal(tabs.parent?.use, 'Tabs');
  assert.equal(tabs.parent?.props?.orientation, 'vertical');
});

test('containers: "one of a set" skips a lone select box, pins on a canvas and stat tiles', () => {
  // The page put the card's select box inside role="group"; it is still one item's checkbox.
  const f = features(`export function CardSelectControl({ selected, onToggle }) { return <IconTooltip label="x"><button type="button" onClick={onToggle} aria-pressed={selected} aria-label={selected ? 'Deselect' : 'Select'} className={clsx('absolute top-2 left-2 w-[18px] h-[18px] border', selected ? 'bg-primary' : 'bg-card/90')}>{selected && <Icon name="check" size="xs" />}</button></IconTooltip>; }`);
  const box = classify(withPlacement(f, undefined, { regions: [], attrs: {}, parentRole: 'group', siblings: 0, geometry: [] }).f);
  assert.equal(box.use, 'Checkbox');
  assert.notEqual(box.use, 'ToggleGroupItem');
  const pin = evalOf(`export const C = () => <div>{marks.map((m, i) => <button key={m.id} onClick={(e) => { e.stopPropagation(); setSelectedId(m.id); }} title={m.n} style={{ left: m.x + '%', top: m.y + '%' }} className={clsx('absolute w-7 h-7 rounded-full bg-[#202020] text-white', selectedId === m.id && 'ring-2 ring-primary')}>{letter(i)}</button>)}</div>;`);
  assert.ok(!/segmented|chip-toggle/.test(pin.role), `a pin placed by coordinates is not an option (${pin.role})`);
  const tile = evalOf(`export const S = () => <div role="group" aria-label="Filter by stage"><button type="button" onClick={() => setStageFilter('All')} className={clsx('relative flex flex-col items-start gap-0.5 px-3.5 py-2.5 border-r border-border', stageFilter === 'All' ? 'bg-card' : 'hover:bg-card/80')}><span className="text-[10px] uppercase text-muted-foreground">All</span><span className="text-lg font-semibold tabular-nums">{stageCounts.All}</span></button></div>;`);
  assert.ok(!/segmented|chip-toggle/.test(tile.role), `a label over a count is a stat tile (${tile.role})`);
});

test('containers: "Expand Image" opens a viewer, not a disclosure', () => {
  const e = evalOf(`export const T = () => <IconTooltip label="Expand Image"><button type="button" aria-label="Expand Image" onClick={(e) => { e.stopPropagation(); onExpand(); }} className={clsx('group/img relative rounded overflow-hidden bg-muted border border-border cursor-zoom-in', sizeClass)}><img src={src} alt="" /></button></IconTooltip>;`);
  assert.notEqual(e.use, 'CollapsibleTrigger');
  assert.ok(!/disclosure/.test(e.role), e.role);
});

test('containers: calibration from other elements cannot lift a part above the threshold without its container', () => {
  const e = evalOf(`export const M = () => <Floating className="py-1"><button onClick={closeFloats} className="${ROW}"><Icon name="content_copy" />Copy</button></Floating>;`);
  assert.equal(e.use, 'DropdownMenuItem');
  const c = calibrate(e, { n: 20, agree: 20, componentAgree: 20, propFixes: 0, fixes: {} });
  assert.ok(c.confidence <= e.confidence, `${c.confidence} > ${e.confidence}`);
  assert.ok(c.confidence < 0.9);
});
