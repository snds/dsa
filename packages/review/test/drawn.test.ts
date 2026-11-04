import { test } from 'vitest';
import assert from 'node:assert/strict';
import { gateProps, markupOf, FN, mountProps } from '../src/drawn.js';

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
