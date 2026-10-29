import { test } from 'vitest';
import './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { reactFeatures, visitWithAncestors, resetFeatureCaches, type ElementFeatures } from '../../src/engine/scanners/features.js';
import { classify } from '../../src/engine/classify.js';
import { buildGraph, reachFor } from '../../src/engine/reach.js';
import { readPagePlacement, withPlacement, type PagePlacement } from '../../src/engine/placement.js';

// Placement: where an element sits (the components above it, and the live page) decides what it is as
// much as its classes. Repros from the 2026-10-12 review: a sidebar's collapse handle became a toggle,
// sidebar nav rows became a ToggleGroup, a dialog's source list became app navigation.

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-place-')));

function featuresIn(file: string, nth = 0): { f: ElementFeatures; line: number } {
  const code = fs.readFileSync(file, 'utf8');
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  const hits: { f: ElementFeatures; line: number }[] = [];
  visitWithAncestors(ast.program, (n: any, anc: any[]) => {
    if (n.type === 'JSXElement' && n.openingElement.name.name === 'button') hits.push({ f: reactFeatures(n, [...anc], code, file, []), line: n.loc.start.line });
  });
  assert.ok(hits[nth], 'snippet has a button');
  return hits[nth];
}
function features(code: string): ElementFeatures {
  resetFeatureCaches();
  const file = path.join(tmp(), 'x.tsx');
  fs.writeFileSync(file, code);
  return featuresIn(file).f;
}

test('placement: a collapse handle on the sidebar edge, labelled "Collapse navigation", is SidebarTrigger (not a toggle)', () => {
  const e = classify(features(`export const Rail = ({ collapsed, onToggle }) => <button type="button" aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} onClick={onToggle} className="absolute -right-3 top-6 bg-card border rounded-full size-6"><Icon name="chevron_left" /></button>;`));
  assert.equal(e.role, 'sidebar-toggle', JSON.stringify(e.reasons));
  assert.equal(e.use, 'SidebarTrigger');
  assert.ok(e.reasons.some(r => /label says so/.test(r.text)));
  assert.ok(!e.alternatives.some(a => /^(toggle|segmented)$/.test(a.role) && a.confidence >= e.confidence));
});

test('placement: a section expander inside a sidebar opens its group, so it is not SidebarTrigger', () => {
  const e = classify(features(`export const G = () => <aside><button aria-expanded={open} aria-label="Toggle Products" onClick={() => setOpen(!open)} className="size-6"><Icon name="expand_more" /></button></aside>;`));
  assert.equal(e.role, 'disclosure-icon', JSON.stringify(e.reasons));
});

test('placement (code): nav rows rendered inside the Acme Sidebar by a parent file are nav items, not a segmented control', () => {
  resetFeatureCaches();
  const app = tmp();
  fs.mkdirSync(path.join(app, 'src'));
  fs.writeFileSync(path.join(app, 'index.html'), '<script type="module" src="/src/main.tsx"></script>');
  fs.writeFileSync(path.join(app, 'src/main.tsx'), `import { Shell } from './Shell';\n`);
  fs.writeFileSync(path.join(app, 'src/Shell.tsx'), `import { SideNav } from './SideNav';\nexport function Shell() {\n  return <div><Sidebar><SidebarContent><SideNav /></SidebarContent></Sidebar><main /></div>;\n}\n`);
  const nav = path.join(app, 'src/SideNav.tsx');
  fs.writeFileSync(nav, `export function SideNav({ items, active, setActive }) {\n  return <div>{items.map(i => (\n    <button key={i.id} onClick={() => setActive(i.id)} className={clsx('group flex items-center gap-2 h-8 px-2 rounded-sm text-sm', active === i.id && 'bg-accent font-medium')}><Icon name={i.icon} />{i.label}</button>\n  ))}</div>;\n}\n`);
  const { f, line } = featuresIn(nav);
  const alone = classify(f);
  assert.match(alone.role, /^(segmented|chip-toggle|toggle)$/, 'without placement this reads as a toggle or one of a set (the reported bug)');
  const r = reachFor(buildGraph(app), nav, line, f.context.gates ?? []);
  assert.deepEqual(r.placement?.regions, ['sidebar']);
  const placed = withPlacement(f, r.placement);
  const e = classify(placed.f);
  assert.equal(e.role, 'nav-item', JSON.stringify(e.reasons));
  assert.equal(e.use, 'SidebarMenuButton');
  assert.match(placed.reasons[0]!.text, /Shell \(Shell\.tsx\) renders SideNav inside a sidebar/);
});

test('placement (code): a list of sources inside a Dialog that switches its panel is vertical tabs, not app navigation', () => {
  const e = classify(features(`const navItemCls = (on) => on ? 'w-full text-left px-3 py-2 bg-accent' : 'w-full text-left px-3 py-2';\nexport const M = () => <Dialog open={open}><DialogContent><div>{sources.map(s => <button key={s.id} onClick={() => setSource(s.id)} className={navItemCls(source === s.id)}>{s.label}</button>)}</div></DialogContent></Dialog>;`));
  assert.equal(e.role, 'tab', JSON.stringify(e.reasons));
  assert.equal(e.use, 'TabsTrigger');
});

test('placement (page): a left-rail column and live aria-expanded from the crawl fill what the source leaves out', () => {
  const row = features(`export const Item = ({ item, current, onClick }) => <button onClick={onClick} className={clsx('flex items-center gap-2 h-8 px-2', current === item.id && 'bg-accent')}><Icon name={item.icon} />{item.label}</button>;`);
  const page: PagePlacement = { regions: ['sidebar'], attrs: {}, siblings: 6, geometry: ['in the left rail (240×900, at the window edge)'] };
  const placed = withPlacement(row, undefined, page);
  const e = classify(placed.f);
  assert.equal(e.role, 'nav-item', JSON.stringify(e.reasons));
  assert.ok(e.reasons.some(r => /Placement \(page\): in the left rail/.test(r.text)) || placed.reasons.some(r => /left rail/.test(r.text)));
  // A plain icon button that the page shows with aria-expanded: a disclosure, whatever the source said.
  const btn = features(`export const More = (props) => <button {...props} className="size-7 hover:bg-accent"><Icon name="more_horiz" /></button>;`);
  const live = withPlacement(btn, undefined, { regions: [], attrs: { 'aria-expanded': 'false' }, siblings: 0, geometry: [] });
  assert.match(classify(live.f).role, /^(disclosure|disclosure-icon)$/);
  assert.ok(live.reasons.some(r => /aria-expanded="false"/.test(r.text)));
});

test('reach: a content swap (`tab === \'media\'`) traces to the control that calls setTab(\'media\')', () => {
  resetFeatureCaches();
  const app = tmp();
  fs.mkdirSync(path.join(app, 'src'));
  fs.writeFileSync(path.join(app, 'index.html'), '<script type="module" src="/src/main.tsx"></script>');
  fs.writeFileSync(path.join(app, 'src/main.tsx'), `import { App } from './App';\n`);
  const file = path.join(app, 'src/App.tsx');
  fs.writeFileSync(file, `import { useState } from 'react';\nexport function App() {\n  const [tab, setTab] = useState('details');\n  return <div>\n    <div role="tablist"><button onClick={() => setTab('details')}>Details</button><button onClick={() => setTab('media')}>Media</button></div>\n    {tab === 'media' && <section><button className="pick">Pick image</button></section>}\n  </div>;\n}\n`);
  const { f, line } = featuresIn(file, 2);
  const r = reachFor(buildGraph(app), file, line, f.context.gates ?? []);
  assert.equal(r.status, 'gated');
  assert.deepEqual(r.steps.map(s => s.label), ['Media'], r.why);
});

test('placement: an <aside> is a side panel, not a sidebar — equal-width segments in it stay segmented', () => {
  const e = classify(features(`export const Audience = () => <aside><div className="flex h-8 border rounded-md"><button type="button" onClick={() => setAudience('internal')} className={clsx('inline-flex h-full flex-1 items-center gap-1.5 text-xs', audience === 'internal' && 'bg-accent')}><Icon name="lock" />Internal</button><button type="button" onClick={() => setAudience('vendor')} className={clsx('inline-flex h-full flex-1 items-center gap-1.5 text-xs', audience === 'vendor' && 'bg-accent')}><Icon name="group" />Vendor</button></div></aside>;`));
  assert.match(e.role, /^(segmented|chip-toggle)$/, JSON.stringify(e.reasons));
});

test('placement: a raw button inside a menu trigger (or with aria-haspopup on the page) keeps its button look, not a disclosure', () => {
  const inTrigger = classify(features(`export const M = () => <DropdownMenu><DropdownMenuTrigger asChild><button className="h-8 px-3 rounded-md border hover:bg-accent text-sm">Sort</button></DropdownMenuTrigger></DropdownMenu>;`));
  assert.equal(inTrigger.use, 'Button', JSON.stringify(inTrigger.reasons));
  assert.ok(inTrigger.reasons.some(r => /keep it as the trigger/.test(r.text)));
  const btn = features(`export const More = (props) => <button {...props} className="size-7 hover:bg-accent"><Icon name="more_horiz" /></button>;`);
  const live = withPlacement(btn, undefined, { regions: [], attrs: { 'aria-expanded': 'false', 'aria-haspopup': 'menu' }, siblings: 0, geometry: [] });
  const e = classify(live.f);
  assert.equal(e.role, 'icon-button', JSON.stringify(e.reasons));
});

test('placement (page): only screenshot matches of 0.8 or more say where an element sits', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'shots'));
  const placement = { regions: ['nav'], attrs: { 'aria-expanded': 'false' }, parentRole: 'group', siblings: 2, geometry: ['in a table cell'] };
  fs.writeFileSync(path.join(dir, 'shots', 'index.json'), JSON.stringify({ shots: {
    'E-weak': { matchScore: 0.65, ties: 1, placement },
    'E-tied': { matchScore: 0.85, ties: 3, placement },
    'E-sure': { matchScore: 0.92, ties: 1, placement },
  } }));
  const m = readPagePlacement(dir);
  assert.equal(m.get('E-weak'), undefined, 'a 0.65 match may be another element: no placement, no reasons');
  assert.deepEqual(m.get('E-tied')?.regions, ['nav'], 'a tie between look-alikes still shows where they sit');
  assert.deepEqual(m.get('E-tied')?.attrs, {}, 'but not one look-alike\'s live state');
  assert.deepEqual(m.get('E-sure')?.attrs, { 'aria-expanded': 'false' });
});
