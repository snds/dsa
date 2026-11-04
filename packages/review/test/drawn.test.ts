import { test } from 'vitest';
import assert from 'node:assert/strict';
import { gateProps, markupOf, FN, MAP, SET, mountProps, stateValues } from '../src/drawn.js';

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
