import { test } from 'vitest';
import assert from 'node:assert/strict';
import { forceGates, itemAliases, nullRead, propsPassedAt, typedProp, gateProps, markupOf, FN, MAP, SET, mountProps, stateValues, holdsInitially, stateSets } from '../src/drawn.js';

// What can't be photographed is drawn from the code: its own JSX as static markup (no app code runs), and
// props that meet the gates the scan traced, for mounting its component in the app's build.

const code = `export function Filters({ open, mode }: any) {
  if (!open) return null;
  return (
    <div>
      <button className={cn('btn', open && 'btn-on')} onClick={() => alert(1)} type="button" disabled aria-label="Apply" style={{ color: 'red' }}>{label}</button>
      <a href="javascript:alert(1)" title={'Help'}>Help <svg viewBox="0 0 16 16"><path d="M2 2h12" /></svg></a>
    </div>
  );
}
`;
const at = (line: number, col: number, o: object = {}) => ({ line, col, element: 'button', classTokens: [], match: { tag: 'button', classes: [], text: '' }, ...o }) as any;

test('markup: literal attributes and the scan\'s classes; never handlers, styles or script URLs', () => {
  const html = markupOf(code, at(5, 7, { classTokens: ['btn', 'btn-on'], match: { tag: 'button', classes: ['btn'], text: 'Apply filters' } }), 'E-1')!;
  assert.equal(html, '<button data-dsa-drawn="E-1" class="btn btn-on" type="button" disabled aria-label="Apply">Apply filters</button>');
  const link = markupOf(code, at(6, 7, { element: 'a' }))!;
  assert.doesNotMatch(link, /javascript|onClick|style/);
  assert.match(link, /^<a title="Help">Help <svg viewBox="0 0 16 16"><path d="M2 2h12"><\/path><\/svg><\/a>$/);
  // Not at that place: nothing drawn.
  assert.equal(markupOf(code, at(5, 9)), null);
});

test('gate props: what the element\'s own component needs to render it', () => {
  const e = (gates: any[]) => ({ within: 'Filters', reach: { gates: gates.map(g => ({ component: 'Filters', file: 'f.tsx', ids: [], kind: 'cond', ...g })) } }) as any;
  assert.deepEqual(gateProps(e([{ test: '!open', negated: true, kind: 'early-return' }])), { open: true });
  assert.deepEqual(gateProps(e([{ test: 'open', negated: false }, { test: "mode === 'edit'", negated: false }])), { open: true, mode: 'edit' });
  assert.deepEqual(gateProps(e([{ test: 'collapsed', negated: true }])), { collapsed: false });
  // A gate in another component isn't this one's props.
  assert.deepEqual(gateProps({ within: 'Filters', reach: { gates: [{ component: 'Page', test: 'open', negated: false, ids: [] }] } } as any), {});
});

test('props to mount a component alone: from its types, its body, a call site\'s literals, then its gates', () => {
  const code = `interface Item { id: string; qty: number }
type Mode = 'grid' | 'list';
interface Props { item: Item; tags: string[]; mode: Mode; onPick: () => void; label?: string; done: boolean }
export function Card({ item, tags, mode, onPick, done, size = 2 }: Props) { return <button>{item.id}</button>; }
export const Row = memo(function Row(props) { return <li onClick={props.onOpen}>{props.cells.map(c => c)}{props.title}</li>; });
export function Shell({ open, rows }) { if (!open) return null; return <div>{rows.length}</div>; }
`;
  const e = (within: string, gates: any[] = []) => ({ within, reach: { gates } }) as any;
  // Types: required fields only, nested object types filled in, the first of a union.
  assert.deepEqual(mountProps(e('Card'), code), { item: { id: '', qty: 0 }, tags: [], mode: 'grid', onPick: FN, done: false });
  // Untyped: handlers become functions, what's mapped becomes a list, the rest is left out.
  // A list gets one item, so it draws a row.
  assert.deepEqual(mountProps(e('Row'), code), { onOpen: FN, cells: [''] });
  // A call site's literals win over shapes; the gate wins over both.
  const caller = `import { Shell } from './Shell';\nexport const A = () => <Shell open={false} rows={[1, 2]} title="Orders" onClose={() => go()} key="k" />;\n`;
  assert.deepEqual(mountProps(e('Shell', [{ test: '!open', negated: true, component: 'Shell' }]), code, [caller]), { rows: [1, 2], open: true, title: 'Orders', onClose: FN });
});

test('props shaped from how the body reads them: sets and maps, a node never an object, a row handed to a child', () => {
  const code = `import type { Print } from './types';
type Deco = { mode: string; dot: boolean };
interface Props { lead: Deco; print: Print; linked: Set<string>; byId: Lookup; tree: TreeData }
export function Panel({ lead, print, linked, byId, tree }: Props) {
  return <div>{open ? lead : null}{print.colours.map(c => <i key={c.key}>{c.name.toUpperCase()}</i>)}{linked.has(print.key) && 'linked'}{byId.get('a')}<Node node={tree.root} /></div>;
}
function Node({ node }) { return <ul>{node.children.length}{node.children.map(n => <Node key={n.id} node={n} />)}</ul>; }
`;
  const e = (within: string) => ({ within, reach: { gates: [] } }) as any;
  const p = mountProps(e('Panel'), code) as any;
  // Rendered: text, not the type's object (an object there throws).
  assert.equal(p.lead, '');
  // Typed elsewhere: from what's read, nested, a list with one row shaped by what the row reads.
  assert.deepEqual(p.print, { colours: [{ key: '', name: '' }], key: '' });
  // .has( → a Set, .get( → a Map.
  assert.deepEqual([p.linked, p.byId], [SET, MAP]);
  // Handed to Node in the same file: shaped by how Node reads its node, a row each level, the deepest empty.
  const row = p.tree.root.children[0];
  assert.equal(row.id, '');
  assert.ok(Array.isArray(row.children), JSON.stringify(p.tree));
  let d = p.tree.root, levels = 0;
  while (d.children?.length) { d = d.children[0]; levels++; }
  assert.ok(levels >= 1 && levels <= 4 && Array.isArray(d.children), JSON.stringify(p.tree));
});

test("the values a root's nav state can take: compared, set, cased and typed", () => {
  const app = `type Nav = 'Home' | 'Colours' | 'Prints';
export function App() {
  const [activeNav, setActiveNav] = useState<Nav>('Home');
  const [tab, setTab] = useState('a');
  const go = () => setActiveNav('Materials');
  switch (activeNav) { case 'Lab': return null; default: break; }
  return <div>{activeNav === 'Partners' && <P/>}{'Requests' === activeNav ? 1 : 2}{tab === 'x' && <i>{'Other'}</i>}</div>;
}`;
  assert.deepEqual(stateValues(app, 'activeNav').sort(), ['Colours', 'Home', 'Lab', 'Materials', 'Partners', 'Prints', 'Requests']);
  assert.deepEqual(stateValues(app, 'tab'), ['x']);
});

test("a condition that holds with its initial state isn't the one to blame, and state isn't set to what it starts as", () => {
  const app = `export function App() {
  const [setupTakeover, setSetupTakeover] = useState(false);
  const [nav, setNav] = useState('Home');
  const [colour, setColour] = useState<Colour | null>(null);
  const [filters, setFilters] = useState({});
  return null;
}`;
  assert.equal(holdsInitially({ test: 'setupTakeover', negated: true }, app), true);
  assert.equal(holdsInitially({ test: 'setupTakeover', negated: false }, app), false);
  assert.equal(holdsInitially({ test: "nav === 'Home'", negated: false }, app), true);
  assert.equal(holdsInitially({ test: "nav === 'Prints'", negated: false }, app), false);
  assert.equal(holdsInitially({ test: "nav !== 'Prints'", negated: false }, app), true);
  assert.equal(holdsInitially({ test: 'unknown', negated: false }, app), false);
  const gates = [{ test: 'colour && filters', negated: false, component: 'App', file: 'App.tsx' }];
  const [set] = stateSets(gates, () => app);
  // A typed value with nothing read off it: an object, not true. State that starts as an object: left alone.
  assert.deepEqual(set!.slots.map(x => [x.name, x.value]), [['colour', {}]]);
});

test("nav values from the files the root imports: its type alias, and a registry passed to its setter", () => {
  const app = `import { NAV, type NavKey } from './nav';
export function App() {
  const [view, setView] = useState<NavKey>('home');
  return <nav>{NAV.map(n => <button key={n.id} onClick={() => setView(n.id)}>{n.label}</button>)}</nav>;
}`;
  const nav = `export type NavKey = 'home' | 'colours' | 'prints';\nexport const NAV = [{ id: 'home', label: 'Home' }, { id: 'colours', label: 'Colours' }, { id: 'labs', label: 'Labs' }];`;
  assert.deepEqual(stateValues(app, 'view').sort(), []);
  assert.deepEqual(stateValues(app, 'view', [nav]).sort(), ['colours', 'home', 'labs', 'prints']);
});

test('a list read for its length is set to one item: state, by how the component reads it', () => {
  const app = `import { useState } from 'react';\nexport function Editor() {\n  const [palette, setPalette] = useState([]);\n  const [rows, setRows] = useState([]);\n  return <div>{palette.length > 0 ? <ul>{palette.map(p => <li key={p.id}>{p.hex}</li>)}</ul> : null}{rows.length === 0 && <p>None</p>}</div>;\n}\n`;
  const gate = (test: string, negated = false) => [{ test, negated, component: 'Editor', file: 'e.tsx' }];
  const [set] = stateSets(gate('palette.length > 0'), () => app);
  assert.deepEqual(set!.slots, [{ index: 0, name: 'palette', value: [{ id: '', hex: '' }] }]);
  assert.deepEqual(stateSets(gate('palette.length'), () => app)[0]!.slots[0]!.value, [{ id: '', hex: '' }]);
  // Wanted empty: [] (rows.length === 0 holds as it starts, but it's set the same way).
  assert.deepEqual(stateSets(gate('rows.length === 0'), () => app)[0]!.slots[0]!.value, []);
  assert.deepEqual(stateSets(gate('palette.length > 0', true), () => app)[0]!.slots[0]!.value, []);
});

test('the conditions on the props of the component mounted are forced over its recorded props, and said', () => {
  const g = (test: string, component = 'Panel', negated = false) => ({ test, negated, component, file: 'p.tsx', ids: [], kind: 'cond' });
  const e = (gates: any[]) => ({ within: 'Panel', reach: { gates } }) as any;
  // Recorded with an empty list and closed: one recorded item, and open.
  const recorded = { items: [], open: false, mode: 'view', title: 'Shelf' };
  const f = forceGates(e([g('items.length > 0'), g('open'), g("mode === 'edit'")]), 'Panel', recorded, {}, (p) => p === 'items' ? { name: 'Fern' } : undefined);
  assert.deepEqual(f.props, { items: [{ name: 'Fern' }], open: true, mode: 'edit', title: 'Shelf' });
  assert.deepEqual(f.forced, ['items = [{"name":"Fern"}]', 'open = true', 'mode = "edit"']);
  // Already holding: nothing forced. No recorded item: the shaped one, else a word.
  assert.deepEqual(forceGates(e([g('open')]), 'Panel', { open: true }).forced, []);
  assert.deepEqual(forceGates(e([g('items?.length')]), 'Panel', { items: [] }).props, { items: ['a'] });
  // A gate on another component's own condition is left alone; one a caller passes as this prop holds.
  assert.deepEqual(forceGates(e([g('ready', 'Page')]), 'Panel', { ready: false }).forced, []);
  assert.deepEqual(forceGates(e([g('open={!!editor}', 'Page')]), 'Panel', {}, { open: false }).props, { open: true });
  // Wanted false, or set: `!busy`, `image != null` (a shaped object kept over true).
  assert.deepEqual(forceGates(e([g('!busy'), g('image != null')]), 'Panel', { busy: true, image: null }, { image: { src: '' } }).props, { busy: false, image: { src: '' } });
  // A name the component doesn't take isn't added.
  assert.deepEqual(forceGates(e([g('loaded')]), 'Panel', { open: true }).props, { open: true });
});

test('a state set for a condition takes its declared type, from the file or one it imports', () => {
  const types = `export type Swatch = { hex: string; name: string; n: number };\nexport type Draft = { id: string };\n`;
  const app = `import { useState } from 'react';\nimport type { Swatch } from '../lib/types';\nexport function Editor() {\n  const [palette, setPalette] = useState<Swatch[]>([]);\n  const [picked, setPicked] = useState<string | null>(null);\n  const [draft, setDraft] = useState<Draft | null>(null);\n  return <div>{palette.length > 0 && <ul />}{picked && <b />}{draft && <i />}</div>;\n}\ntype Draft = { id: string; at: number };\n`;
  const read = (f: string) => f === 'src/app/Editor.tsx' ? app : f === 'src/lib/types.ts' ? types : null;
  const value = (test: string) => stateSets([{ test, negated: false, component: 'Editor', file: 'src/app/Editor.tsx' }], read)[0]!.slots[0]!.value;
  assert.deepEqual(value('palette.length > 0'), [{ hex: '', name: '', n: 0 }]);
  assert.equal(value('picked'), 'a');
  assert.deepEqual(value('draft'), { id: '', at: 0 });
});

test('a condition on a list item\'s field is met by a list with one such item: props and state', () => {
  const code = `export function Uploads({ uploads, rows }) {\n  const [docs, setDocs] = useState([]);\n  return <ul>{uploads.map((up) => up.failed && <li>{up.name}</li>)}{props.rows.filter(row => row.kind === 'document')}{docs.map(d => d.open && <b />)}</ul>;\n}\n`;
  assert.deepEqual(itemAliases(code), { up: 'uploads', row: 'rows', d: 'docs' });
  const e = (gates: any[]) => ({ within: 'Uploads', reach: { gates: gates.map(g => ({ component: 'Uploads', file: 'u.jsx', ids: [], kind: 'cond', negated: false, ...g })) } }) as any;
  const f = forceGates(e([{ test: 'up.failed' }, { test: "row.kind === 'document'" }]), 'Uploads', { uploads: [{ name: 'a.png', failed: false }], rows: [] }, {}, undefined, itemAliases(code));
  assert.deepEqual(f.props, { uploads: [{ name: 'a.png', failed: true }, { name: 'a.png', failed: false }], rows: [{ kind: 'document' }] });
  assert.deepEqual(f.forced, ['uploads = [{"name":"a.png","failed":true', 'rows = [{"kind":"document"}]']);
  const state = `import { useState } from 'react';\nexport function Uploads() {\n  const [docs, setDocs] = useState([]);\n  return <ul>{docs.map(d => d.open && <b />)}</ul>;\n}\n`;
  assert.deepEqual(stateSets([{ test: 'd.open', negated: false, component: 'Uploads', file: 'u.jsx' }], () => state)[0]!.slots[0]!.value, [{ open: true }]);
});

test('a read off nothing in its props: the path from the prop, and a value of the kind the read needs', () => {
  const code = `export function Chips({ alias, rows, props2 }) {\n  return <div>{alias.owner.name}{rows.find(r => r.on)}{alias.label.trim()}</div>;\n}\n`;
  assert.deepEqual(nullRead(code, 'Chips', "Cannot read properties of null (reading 'name')"), { path: ['alias', 'owner'], value: { name: '' } });
  assert.deepEqual(nullRead(code, 'Chips', "Cannot read properties of undefined (reading 'find')"), { path: ['rows'], value: [] });
  assert.deepEqual(nullRead(code, 'Chips', "Cannot read properties of undefined (reading 'trim')"), { path: ['alias', 'label'], value: '' });
  assert.equal(nullRead(code, 'Chips', 'Something else'), null);
});

test('the props a component hands a helper on a line, and a value of their declared type (a list with one typed item)', () => {
  const types = `export type Quote = { id: string; price: { n: number } };\n`;
  const code = `import type { Quote } from './quotes';\nexport function Compare({ quotes, label }: { quotes: Quote[]; label: string }) {\n  const best = cheapest(quotes, label);\n  return <b>{best.id}</b>;\n}\n`;
  assert.deepEqual(propsPassedAt(code, 'Compare', 3), { helper: 'cheapest', props: ['quotes', 'label'] });
  assert.equal(propsPassedAt(code, 'Compare', 4), null);
  const read = (f: string) => f === '/app/src/quotes.ts' ? types : null;
  assert.deepEqual(typedProp(code, 'Compare', 'quotes', '/app/src/Compare.tsx', read), [{ id: '', price: { n: 0 } }]);
  assert.equal(typedProp(code, 'Compare', 'label', '/app/src/Compare.tsx', read), 'a');
});

test('a tag on a state holding one of several shapes sets it to that shape: the union member with the tag', () => {
  const code = `import { useState } from 'react';\ntype Float = { t: 'ctx'; x: number; y: number } | { t: 'panelMenu'; panel: string };\nexport function Grid() {\n  const [float, setFloat] = useState<Float | null>(null);\n  return <div>{float?.t === 'panelMenu' && <b />}{float?.t === 'ctx' && <i />}</div>;\n}\n`;
  const value = (test: string) => stateSets([{ test, negated: false, component: 'Grid', file: 'g.tsx' }], () => code)[0]!.slots[0]!.value;
  assert.deepEqual(value("float?.t === 'panelMenu'"), { t: 'panelMenu', panel: '' });
  assert.deepEqual(value("float?.t === 'ctx'"), { t: 'ctx', x: 0, y: 0 });
});
