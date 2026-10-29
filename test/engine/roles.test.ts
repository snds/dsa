import { test } from 'vitest';
import './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { reactFeatures, visitWithAncestors, resetFeatureCaches, type ElementFeatures } from '../../src/engine/scanners/features.js';
import { classify, systemRoles, NEUTRAL_ROLES, type Evaluation } from '../../src/engine/classify.js';
import { lookalikeMap } from '../../src/engine/config.js';
import { loadRoleMap } from '../../src/engine/elements.js';

// Role semantics: disclosure, pressed toggle, segmented, nav item, record/breadcrumb links, and the role map.
// Cases A–G are the repros in the 2026-10-08 audit (D1–D4).

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-roles-'));

function features(code: string, extraFiles: Record<string, string> = {}): ElementFeatures {
  resetFeatureCaches();
  const dir = tmp();
  for (const [f, s] of Object.entries(extraFiles)) fs.writeFileSync(path.join(dir, f), s);
  const file = path.join(dir, 'x.tsx');
  fs.writeFileSync(file, code);
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  let hit: ElementFeatures | null = null;
  visitWithAncestors(ast.program, (n: any, anc: any[]) => {
    if (!hit && n.type === 'JSXElement' && /^(button|input|table|select|textarea|dialog)$/.test(n.openingElement.name.name)) hit = reactFeatures(n, [...anc], code, file, []);
  });
  assert.ok(hit, 'snippet has a native element');
  return hit!;
}
const evalOf = (code: string, extra?: Record<string, string>): Evaluation => classify(features(code, extra));
const DISCLOSURE = /^(disclosure|disclosure-icon|sidebar-toggle)$/;

test('roles: sr-only labelled icon button with aria-expanded is a disclosure with an icon size (repro A, SidebarTrigger)', () => {
  const e = evalOf(`export const A = () => <button aria-expanded={open} onClick={toggle} className={cn('size-7 hover:bg-accent', open && 'bg-accent')}><Icon name="dock_to_right" /><span className="sr-only">Toggle panel</span></button>;`);
  assert.equal(e.role, 'disclosure-icon');
  assert.equal(e.use, 'Button', 'IconButton is not on main: an icon-only Button');
  assert.equal(e.props?.size, 'icon-sm', 'size-7 → icon-sm, the icon size (not a labelled text size)');
  assert.ok(e.reasons.some(r => /labelled "Toggle panel"/.test(r.text)), JSON.stringify(e.reasons));
  // Acme's own SidebarTrigger markup, copied raw.
  const s = evalOf(`export function Trigger() { return <button data-sidebar="trigger" className="size-7" aria-expanded={open} onClick={toggleSidebar}><PanelLeftIcon /><span className="sr-only">Toggle Sidebar</span></button>; }`);
  assert.equal(s.role, 'sidebar-toggle');
  assert.equal(s.use, 'SidebarTrigger');
});

test('roles: aria-expanded with swapping icons and a side === switch is a disclosure, not a toggle (repro B)', () => {
  const e = evalOf(`export const A = () => <button aria-expanded={!collapsed} aria-label="Collapse" onClick={() => setCollapsed(c => !c)} className={side === 'left' ? 'border-r' : 'border-l'}>{collapsed ? <CaretRight /> : <CaretLeft />}</button>;`);
  assert.match(e.role, DISCLOSURE);
  assert.ok(!e.alternatives.some(a => a.role === 'toggle' && a.confidence >= e.confidence));
});

test('roles: a rotate-only switch with no ARIA is a disclosure that needs a human (repro C)', () => {
  const e = evalOf(`export const A = () => <button onClick={() => setIsOpen(!isOpen)} className={cn('p-1 transition-transform', isOpen && 'rotate-180')}><ChevronDownIcon /></button>;`);
  assert.match(e.role, DISCLOSURE);
  assert.ok(e.confidence < 0.9, String(e.confidence));
  assert.ok(e.reasons.some(r => /Add aria-expanded/.test(r.text)));
  const f = features(`export const A = () => <button className={isOpen ? 'rotate-180' : ''}><Icon /></button>;`);
  assert.equal(f.classes.switchKind, 'expanded');
  assert.equal(f.classes.switchTokensOnlyTransform, true);
  assert.equal(f.classes.selectedSwitch, true, 'old consumers still see the boolean');
});

test('roles: icons imported from an icon package count as icons whatever their name (repro D)', () => {
  const code = `import { SidebarSimple } from '@phosphor-icons/react';\nimport { Gear as Cog } from 'lucide-react';\nexport const A = () => <button aria-expanded={open} aria-label="Collapse"><SidebarSimple /></button>;\nexport const B = () => <button aria-label="Settings"><Cog /></button>;`;
  const f = features(code);
  assert.equal(f.children.icons, 1);
  assert.equal(f.children.elements.length, 0);
  const e = classify(f);
  assert.notEqual(e.ruleId, 'button.fallback');
  assert.match(e.role, DISCLOSURE);
  // Bare Phosphor names (X, List) are icons by name too.
  assert.equal(features(`export const A = () => <button aria-label="Close" onClick={close}><X /></button>;`).children.icons, 1);
});

test('roles: labelled "Show more" with aria-expanded maps to CollapsibleTrigger (repro E)', () => {
  const e = evalOf(`export const A = () => <button aria-expanded={open} onClick={() => setOpen(!open)} className="text-sm text-primary"><ChevronDown className={cn(open && 'rotate-180')} />{open ? 'Hide' : 'Show more'}</button>;`);
  assert.equal(e.role, 'disclosure');
  assert.equal(e.use, 'CollapsibleTrigger');
  assert.ok(e.confidence >= 0.85, String(e.confidence));
});

test('roles: a single aria-pressed icon button is a Toggle, not an icon button (repro F)', () => {
  const e = evalOf(`export const A = () => <button aria-pressed={bold} aria-label="Bold" onClick={() => setBold(!bold)} className="size-7 hover:bg-accent"><Icon name="format_bold" /></button>;`);
  assert.equal(e.role, 'toggle');
  assert.equal(e.use, 'Toggle');
  assert.ok(!e.alternatives.some(a => a.role === 'icon-button' && a.confidence >= e.confidence));
});

test('roles: aria-pressed icon buttons mapped inside role="group" are segmented (repro G)', () => {
  const e = evalOf(`export const A = () => <div role="group" aria-label="View">{MODES.map(m => <button key={m} aria-pressed={mode === m} aria-label={m} onClick={() => setMode(m)} className="size-7 hover:bg-accent"><Icon name={m} /></button>)}</div>;`);
  assert.equal(e.role, 'segmented');
  assert.equal(e.use, 'ToggleGroupItem');
  // Sibling buttons with an equality switch are a set too.
  const s = evalOf(`export const A = () => <div className="flex"><button onClick={() => setA('internal')} className={clsx('h-8 text-xs', a === 'internal' ? 'bg-selected' : 'hover:bg-accent')}>Internal</button><button onClick={() => setA('external')} className={clsx('h-8 text-xs', a === 'external' ? 'bg-selected' : 'hover:bg-accent')}>External</button></div>;`);
  assert.equal(s.role, 'segmented');
});

test('roles: an aria-current sidebar item with an active ternary is a nav item', () => {
  const e = evalOf(`export function NavItem({ active, onSelect, label }) { return <button type="button" onClick={onSelect} aria-current={active ? 'page' : undefined} className={clsx('flex w-full items-center gap-3 px-3 text-left text-sm', active ? 'bg-sidebar-selected text-sidebar-selected-foreground' : 'hover:bg-sidebar-accent')}><Icon name="home" />{label}</button>; }`);
  assert.equal(e.role, 'nav-item');
  assert.equal(e.use, 'SidebarMenuButton');
  // Without aria-current: a full-width icon + label row lit by `active` (no help from the component name).
  const n = evalOf(`function Row({ active, label, onClick }) { return <button onClick={onClick} className={clsx('flex w-full items-center gap-2 h-8 px-2.5 text-sm', active ? 'bg-selected text-primary' : 'hover:bg-accent')}><Icon name="x" /><span className="flex-1 text-left truncate">{label}</span></button>; }`);
  assert.equal(n.role, 'nav-item');
  assert.ok(n.confidence < 0.9, 'heuristic nav calls go to a human');
});

test('roles: a record name that opens a record is ObjectName; a "← Data / X" back button is BreadcrumbBack', () => {
  const r = evalOf(`export const C = () => <td><button type="button" className="text-link hover:underline text-left truncate" onClick={() => openRow(row.id)}>{value}</button></td>;`);
  assert.equal(r.role, 'record-link');
  assert.equal(r.use, 'ObjectName');
  const b = evalOf(`export const B = () => <button type="button" className="text-sm text-primary hover:underline" onClick={() => setOpenId(null)}>← Data / {label}</button>;`);
  assert.equal(b.role, 'breadcrumb-back');
  assert.equal(b.use, 'BreadcrumbBack');
  // A plain in-page link action stays a link Button.
  assert.equal(evalOf(`export const L = () => <button className="text-primary hover:underline" onClick={() => addColour()}>Add colour</button>;`).role, 'link-button');
});

test('roles: back controls are BreadcrumbBack by handler or back arrow, never by a CRUMB class name; "/" trails stay BreadcrumbLink', () => {
  // A leading back-arrow icon, any handler (CellComments "← All comments").
  const icon = evalOf(`export const A = () => <button className="text-sm text-primary hover:underline" onClick={() => setThread(undefined)}><Icon name="arrow_back" />All comments</button>;`);
  assert.equal(icon.role, 'breadcrumb-back');
  assert.equal(icon.use, 'BreadcrumbBack');
  assert.ok(icon.reasons.some(r => /starts with a back arrow/.test(r.text)), JSON.stringify(icon.reasons));
  // A CRUMB_LINK style on an "Advanced Search ›" action is a link action, with no breadcrumb reason.
  const crumbStyled = evalOf(`const CRUMB_LINK = 'text-xs text-primary hover:underline';\nexport const A = () => <button className={CRUMB_LINK} onClick={() => openAdvanced()}>Advanced Search ›</button>;`);
  assert.equal(crumbStyled.role, 'link-button');
  assert.ok(!crumbStyled.alternatives.some(a => /^breadcrumb/.test(a.role)), JSON.stringify(crumbStyled.alternatives));
  assert.ok(!crumbStyled.reasons.some(r => /breadcrumb|back/i.test(r.text)), JSON.stringify(crumbStyled.reasons));
  // A crumb in a real "/" trail that doesn't go back.
  const trail = evalOf(`export const A = () => <button className="text-sm text-primary hover:underline" onClick={() => go(area)}>Products / Shirts</button>;`);
  assert.equal(trail.role, 'breadcrumb-link');
  assert.equal(trail.use, 'BreadcrumbLink');
});

test('roles: role="option" is a picker option (ComboboxItem); role="menuitem" stays a menu row', () => {
  const option = evalOf(`export const A = () => <ul role="listbox">{items.map(i => <li key={i.id}><button role="option" aria-selected={i.id === value} onClick={() => pick(i.id)}>{i.label}</button></li>)}</ul>;`);
  assert.equal(option.role, 'combobox-item');
  assert.equal(option.use, 'ComboboxItem');
  const item = evalOf(`export const A = () => <div role="menu"><button role="menuitem" onClick={rename}>Rename</button></div>;`);
  assert.equal(item.role, 'menu-item');
  // A computed role that is "option" or "listbox"-ish but never "radio" is a picker option too.
  const dyn = evalOf(`export const A = () => <button role={multi ? 'option' : 'menuitemcheckbox'} aria-selected={on} onClick={toggle}>{label}</button>;`);
  assert.equal(dyn.role, 'combobox-item');
});

test('roles: alternatives show their real scores; a close-call cap below one is flagged, never silent', () => {
  const cases = [
    `export const A = () => <div role="group">{M.map(m => <button key={m} aria-pressed={mode === m} aria-label={m} className="size-7"><Icon /></button>)}</div>;`,
    `export const A = () => <button className={clsx('h-8 px-3 border', on === k ? 'bg-primary' : '')}>{k}</button>;`,
    `export const A = () => <button className="text-sm text-primary hover:underline" onClick={() => setOpenId(null)}>← Back</button>;`,
    `export const A = () => <button className="text-primary hover:underline" onClick={() => openRow(id)}>{name}</button>;`,
    `export const A = () => <td><button className="w-full text-left" aria-expanded={open}><p>{a}</p><div>{b}</div></button></td>;`,
    `export const A = () => <li><button className="w-full text-left h-8 rounded px-3 bg-muted hover:bg-accent">Item</button></li>;`,
    `const A = () => <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{r.a}</td><td>{r.b}</td></tr>)}</tbody></table>;`,
  ];
  const check = (e: Evaluation, code: string) => {
    assert.ok(e.score !== undefined && e.score >= e.confidence);
    for (const a of e.alternatives) {
      assert.ok(a.confidence <= e.score!, `ranking: ${e.role} scored ${e.score} under ${a.role} ${a.confidence}: ${code}`);
      if (a.confidence > e.confidence) {
        assert.ok(e.capped, `${a.role} ${a.confidence} shown above ${e.role} ${e.confidence} with no cap flag: ${code}`);
        assert.ok(e.reasons.some(r => r.text.startsWith('Close call with ')));
      }
    }
  };
  for (const code of cases) check(evalOf(code), code);
  // A stricter-than-default cap (review threshold 80%) puts the runner-up visibly above the capped winner.
  const code = cases[2]!;
  const e = classify(features(code), undefined, 0.8);
  check(e, code);
  assert.equal(e.role, 'breadcrumb-back');
  assert.deepEqual(e.capped, { score: e.score, closeTo: 'link-button' });
  assert.ok(e.alternatives[0]!.confidence > e.confidence, 'the real runner-up score is reported, not clamped');
});

test('roles: a missing rawElements file is one clear error from both loaders', () => {
  const root = tmp();
  const config = { rawElements: 'packages/lint/raw-elements.json' } as any;
  const messages: string[] = [];
  for (const load of [() => lookalikeMap(root, config), () => loadRoleMap(root, config)]) {
    assert.throws(load, (err: Error) => { messages.push(err.message); return /rawElements: packages\/lint\/raw-elements\.json not found/.test(err.message); });
  }
  assert.equal(messages[0], messages[1], 'same error, same words');
});

/**
 * Role names are API: a profile re-points a role, never removes it. Checking each target against the
 * system's real exports belongs in the system's own repo, next to its profile.
 */
test('roles: the neutral map and a profile name the same roles, and the phantom names stay gone', () => {
  const neutral = NEUTRAL_ROLES;
  const acme = systemRoles();
  assert.deepEqual(Object.keys(neutral).filter(k => !(k in acme)), [], 'every neutral role is in the profile');
  for (const roles of [neutral, acme]) {
    for (const phantom of ['MultiSelect', 'IconButton']) assert.ok(!Object.values(roles).some(r => r.use === phantom), phantom);
    assert.equal(roles['combobox-item']?.use, 'ComboboxItem');
    for (const [role, r] of Object.entries(roles)) if (!r.use) assert.ok(r.verdict === 'gap' || r.verdict === 'keep', `${role} has no component, so it is a gap or keep`);
  }
  assert.equal(acme['breadcrumb-back']?.use, 'BreadcrumbBack');
  assert.ok(!Object.values(neutral).some(r => r.from), 'neutral offers name no import paths');
});
