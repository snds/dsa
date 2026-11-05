import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse, parseExpression as babelParseExpression } from '@babel/parser';
import type { ElementEval } from '@snds/dsa/engine';
export { MOUNT_MODULE } from '@snds/dsa/tag';

/**
 * Elements the crawler can't photograph (a condition it couldn't meet, a page it never reached) are drawn
 * from the code instead. Two ways, best first:
 *
 *  3. Mounted: the element's component, loaded through the app's own Vite dev server and rendered with
 *     React on one of the app's pages, so its real styles and its own imports apply. Props come from the
 *     gates the scan traced on it (`open && …` → open: true). Found on the page by its source tag.
 *  4. Markup: the element's own JSX written out as static HTML (literal attributes, its classes as the scan
 *     resolved them, its words), shown on one of the app's pages so the app's style sheets apply. No app
 *     code runs.
 *
 * Labelled "Drawn from the app's code" (3) and "Markup only" (4). A mount found by its exact source tag,
 * and not blank, counts as seeing the element (seenInApp): it's the real component with the real styles.
 * Markup never counts. Neither feeds placement, and both stay "not found live".
 */

/** Props that meet the element's own component's gates: `open` → true, `!open` → false, `mode === 'edit'` → 'edit'. */
export function gateProps(e: ElementEval): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const g of e.reach?.gates ?? []) {
    if ((g as any).component && e.within && (g as any).component !== e.within) continue;
    const t = g.test.trim();
    let m = t.match(/^(!*)\s*(?:props\.)?([A-Za-z_$][\w$]*)$/);
    if (m) { out[m[2]!] = (m[1]!.length % 2 === 1) === g.negated; continue; }
    m = t.match(/^(?:props\.)?([A-Za-z_$][\w$]*)\s*===?\s*['"]([^'"]{1,40})['"]$/);
    if (m && !g.negated) out[m[1]!] = m[2]!;
  }
  return out;
}

/** A value that passes a truthiness test: '' → 'a', 0 → 1, false → true, null → {}. */
const truthy = (v: Val): Val => v === '' ? 'a' : v === 0 ? 1 : v === false ? true : v === null ? {} : v;

/** A type written as text (`PaletteColour[]`, `string | null`), parsed. */
function typeNode(text: string): any {
  try { return (babelParse(`let __t: ${text};`, { sourceType: 'module', plugins: ['typescript'] }) as any).program.body[0].declarations[0].id.typeAnnotation.typeAnnotation; } catch { return null; }
}

/** Types declared in a file and in the local files it imports from (one step): what a state's type names. */
function typesWithImports(ast: any, file: string, read: (file: string) => string | null): Map<string, any> {
  const out = new Map<string, any>();
  for (const s of ast?.program?.body ?? []) {
    if (s.type !== 'ImportDeclaration' || !String(s.source.value).startsWith('.')) continue;
    const base = path.posix.join(path.posix.dirname(file), s.source.value);
    for (const f of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      const c = /\.(tsx?|jsx?)$/.test(f) ? read(f) : null;
      const a = c ? parse(c) : null;
      if (!a) continue;
      for (const [k, v] of localTypes(a)) out.set(k, v);
      break;
    }
  }
  if (ast) for (const [k, v] of localTypes(ast)) out.set(k, v);
  return out;
}

/**
 * The lists a file walks, by the name it gives each item: `uploads.map((up) => …)` → { up: 'uploads' },
 * `props.rows.filter(row => …)` → { row: 'rows' }. A condition on an item's field (`up.failed`) is met by a
 * list with one item that has it.
 */
export function itemAliases(code: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of code.matchAll(/(?<![\w$.])((?:props\.)?[A-Za-z_$][\w$]*)\s*\??\.\s*(?:map|filter|forEach|some|every|find|flatMap)\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/g)) {
    const list = m[1]!.replace(/^props\./, '');
    if (!(m[2]! in out)) out[m[2]!] = list;
  }
  return out;
}

/** `up.failed`, `row?.kind`: an item's field, when `up` names a list's item. */
const itemField = (m: any, aliases: Record<string, string>): { list: string; field: string } | null =>
  /MemberExpression$/.test(m?.type ?? '') && !m.computed && m.object?.type === 'Identifier' && aliases[m.object.name] && m.property?.name ? { list: aliases[m.object.name]!, field: m.property.name } : null;

/** `x.length`, `x?.length > 0`, `x.length === 0`, `props.x.length >= 1`: the list, and whether the test wants it non-empty. */
function lengthTest(e: any): { name: string; nonEmpty: boolean } | null {
  const list = (m: any): string | null => {
    if (!/MemberExpression$/.test(m?.type ?? '') || m.computed || m.property?.name !== 'length') return null;
    const o = m.object;
    if (o?.type === 'Identifier') return o.name;
    if (/MemberExpression$/.test(o?.type ?? '') && !o.computed && o.object?.type === 'Identifier' && o.object.name === 'props') return o.property?.name ?? null;
    return null;
  };
  const own = list(e);
  if (own) return { name: own, nonEmpty: true };
  if (e?.type !== 'BinaryExpression') return null;
  const left = list(e.left), right = list(e.right);
  const name = left ?? right;
  const n = left ? e.right : e.left;
  if (!name || n?.type !== 'NumericLiteral') return null;
  const op = left ? e.operator : ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=' } as Record<string, string>)[e.operator] ?? e.operator;
  const k = n.value as number;
  // Whether a list of one passes, and an empty one.
  const at = (x: number) => op === '>' ? x > k : op === '>=' ? x >= k : op === '<' ? x < k : op === '<=' ? x <= k : /^==/.test(op) ? x === k : /^!=/.test(op) ? x !== k : null;
  const one = at(1), none = at(0);
  if (one === null || one === none) return null;
  return { name, nonEmpty: one };
}

/**
 * The element's conditions on the props of the component mounted, made to hold over the props it's given
 * (recorded, or shaped from the source): a flag (`open`, `!!editor`, and `open={!!editor}` where a caller
 * passes it) true, a list read for its length (`palette.length > 0`) one item (`item` gives a recorded one,
 * else one shaped from the source, else a word),
 * a literal (`mode === 'edit'`) that literal. Gates on state are left to the state setter. Returns the props
 * and what it set, in words (`open = true`), so a drawing can say a condition was forced.
 */
export function forceGates(e: ElementEval, name: string, given: Record<string, unknown>, shaped: Record<string, unknown> = {}, item?: (prop: string) => unknown, aliases: Record<string, string> = {}): { props: Record<string, unknown>; forced: string[] } {
  const props: Record<string, unknown> = { ...given };
  const forced: string[] = [];
  const takes = (x: string) => x in props || x in shaped;
  const set = (x: string, v: unknown) => { props[x] = v; forced.push(`${x} = ${(JSON.stringify(v) ?? String(v)).slice(0, 30)}`); };
  const truthy = (x: string, truth: boolean) => {
    if (Boolean(props[x]) === truth) return;
    if (!truth) return set(x, props[x] && typeof props[x] === 'object' ? null : false);
    const s = shaped[x];
    set(x, s && typeof s === 'object' ? s : true);
  };
  const root = (m: any): string | null => m?.type === 'Identifier' ? m.name : /MemberExpression$/.test(m?.type ?? '') && !m.computed && m.object?.type === 'Identifier' && m.object.name === 'props' ? m.property?.name ?? null : null;
  // A list prop with one item whose field holds `value` (true: any truthy value), the rest of the item as recorded or shaped.
  const withItem = (f: { list: string; field: string }, value: unknown) => {
    if (!takes(f.list)) return;
    const cur = Array.isArray(props[f.list]) ? props[f.list] as unknown[] : [];
    const ok = (x: any) => x && typeof x === 'object' && (value === true ? Boolean(x[f.field]) : value === false ? !x[f.field] : x[f.field] === value);
    if (cur.some(ok)) return;
    const s = shaped[f.list];
    const base = [cur[0], item?.(f.list), Array.isArray(s) ? s[0] : undefined].find(x => x && typeof x === 'object') ?? {};
    set(f.list, [{ ...(base as object), [f.field]: value }, ...cur.slice(0, 2)]);
  };
  const visit = (x: any, truth: boolean): void => {
    if (!x) return;
    const it = itemField(x, aliases);
    if (it) return withItem(it, truth);
    const r = root(x);
    if (r) { if (takes(r)) truthy(r, truth); return; }
    if (x.type === 'UnaryExpression' && x.operator === '!') return visit(x.argument, !truth);
    if (x.type === 'CallExpression' && x.callee?.name === 'Boolean' && x.arguments.length === 1) return visit(x.arguments[0], truth);
    if (x.type === 'LogicalExpression') {
      if ((x.operator === '&&' && truth) || (x.operator === '||' && !truth)) { visit(x.left, truth); visit(x.right, truth); }
      else visit(x.left, truth);
      return;
    }
    const len = lengthTest(x);
    if (len) {
      if (!takes(len.name)) return;
      const v = props[len.name];
      const has = Array.isArray(v) && v.length > 0;
      if (len.nonEmpty !== truth) { if (has) set(len.name, []); return; }
      if (has) return;
      const s = shaped[len.name];
      // Nothing says what an item is: a word, which renders as text and reads as nothing (`{}` can't render).
      const one = item?.(len.name) ?? (Array.isArray(s) && s.length ? s[0] : 'a');
      set(len.name, [one]);
      return;
    }
    if (x.type === 'BinaryExpression' && /^[!=]==?$/.test(x.operator)) {
      const ft = itemField(x.left, aliases) ?? itemField(x.right, aliases);
      const fl = itemField(x.left, aliases) ? x.right : x.left;
      if (ft && /^(String|Numeric|Boolean)Literal$/.test(fl?.type ?? '') && x.operator.startsWith('=') === truth) return withItem(ft, fl.value);
      const id = root(x.left) ? x.left : root(x.right) ? x.right : null;
      const lit = id === x.left ? x.right : x.left;
      const n = id && root(id);
      if (!n || !takes(n)) return;
      // `x != null`, `x !== undefined`: x set.
      if (lit?.type === 'NullLiteral' || (lit?.type === 'Identifier' && lit.name === 'undefined')) return truthy(n, x.operator.startsWith('!') === truth);
      if (!/^(String|Numeric|Boolean)Literal$/.test(lit?.type ?? '')) return;
      const eq = x.operator.startsWith('=') === truth;
      if (eq && props[n] !== lit.value) set(n, lit.value);
      else if (!eq && props[n] === lit.value) set(n, typeof lit.value === 'boolean' ? !lit.value : typeof lit.value === 'number' ? lit.value + 1 : `${lit.value}-other`);
    }
  };
  for (const g of e.reach?.gates ?? []) {
    const gc = (g as any).component as string | undefined;
    // A condition a caller passes as this component's prop (`<Editor open={!!editor}>`): that prop holds.
    const asProp = g.test.match(/^([\w$]+)=\{[\s\S]*\}$/);
    if (asProp) { if (gc !== name && takes(asProp[1]!)) truthy(asProp[1]!, !g.negated); continue; }
    if (gc ? gc !== name : e.within !== name) continue;
    let expr: any = null;
    try { expr = babelParseExpression(g.test, { plugins: ['jsx', 'typescript'] }); } catch { continue; }
    visit(expr, !g.negated);
  }
  return { props, forced: [...new Set(forced)] };
}

/** A prop value the page turns into a function that does nothing. */
export const FN = { __dsa: 'fn' } as const;
/** A prop value the page turns into an empty Set, or an empty Map: what `.has(`, `.get(` are called on. */
export const SET = { __dsa: 'set' } as const;
export const MAP = { __dsa: 'map' } as const;
type Val = string | number | boolean | null | typeof FN | typeof SET | typeof MAP | Val[] | { [k: string]: Val };
const special = (v: unknown) => Boolean(v && typeof v === 'object' && '__dsa' in (v as object));

/**
 * Props to mount a component with, so it renders without its parent: best last, so each wins over the one
 * before it.
 *  1. Type-shaped defaults for what it needs: from its props type (string '', number 0, boolean false, a
 *     list [], a function, an object with its own required fields), else from how its body uses each
 *     prop (`.map(` → [], `onX` → a function).
 *  2. The values a call site passes as literals (`<Panel title="Orders" rows={[]} onClose={() => …}>`).
 *  3. The gates the scan traced on the element (gateProps).
 */
export function mountProps(e: ElementEval, code: string, callers: string[] = []): Record<string, Val> {
  const out: Record<string, Val> = {};
  const ast = parse(code);
  if (ast && e.within) Object.assign(out, shapedProps(ast, e.within));
  for (const c of [code, ...callers]) {
    const site = c === code ? ast : parse(c);
    const lit = site && e.within ? callSite(site, e.within) : null;
    if (lit) { Object.assign(out, lit); break; }
  }
  return Object.assign(out, gateProps(e));
}

const parse = (code: string): any => { try { return babelParse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'typescript', 'decorators-legacy'] }); } catch { return null; } };

/** The component's function: a declaration, an arrow, or one wrapped in memo()/forwardRef(). */
function componentFn(ast: any, name: string): any {
  for (const s0 of ast.program.body) {
    const s = s0.type === 'ExportNamedDeclaration' || s0.type === 'ExportDefaultDeclaration' ? s0.declaration : s0;
    if (!s) continue;
    if (s.type === 'FunctionDeclaration' && s.id?.name === name) return s;
    if (s.type === 'VariableDeclaration') for (const d of s.declarations) {
      if (d.id?.name !== name || !d.init) continue;
      let f = d.init;
      while (f.type === 'CallExpression') f = f.arguments.find((a: any) => /Function|Call/.test(a.type)) ?? f.arguments[0];
      if (f && /Function/.test(f.type)) return f;
    }
  }
  return null;
}

/** Types declared in the file, by name: interfaces and type aliases. */
function localTypes(ast: any): Map<string, any> {
  const m = new Map<string, any>();
  walk(ast.program, (n) => {
    if (n.type === 'TSInterfaceDeclaration') m.set(n.id.name, { type: 'TSTypeLiteral', members: n.body.body });
    if (n.type === 'TSTypeAliasDeclaration') m.set(n.id.name, n.typeAnnotation);
  });
  return m;
}

function shapedProps(ast: any, name: string): Record<string, Val> {
  const fn = componentFn(ast, name);
  const param = fn?.params?.[0];
  if (!param) return {};
  const types = localTypes(ast);
  const out: Record<string, Val> = {};
  let ann = param.typeAnnotation?.typeAnnotation;
  // React.FC<Props> on the const: the type is on the declarator, not the param.
  if (!ann) walk(ast.program, (n) => { if (!ann && n.type === 'VariableDeclarator' && n.id?.name === name) ann = n.id.typeAnnotation?.typeAnnotation?.typeParameters?.params?.[0]; });
  const lit = literalOf(ann, types);
  const defaults = new Set<string>();
  if (param.type === 'ObjectPattern') for (const p of param.properties) if (p.type === 'ObjectProperty' && p.value?.type === 'AssignmentPattern') defaults.add(p.key.name);
  if (lit) for (const m of lit.members ?? []) {
    if (m.type !== 'TSPropertySignature' || m.optional || !m.key?.name || defaults.has(m.key.name) || m.key.name === 'children') continue;
    const v = shapeOf(m.typeAnnotation?.typeAnnotation, types, 0);
    if (v !== undefined) out[m.key.name] = v;
  }
  // Untyped: from the names it takes (destructured, or read as props.x) and how its body uses them.
  const names = new Set<string>();
  if (param.type === 'ObjectPattern') for (const p of param.properties) { if (p.type === 'ObjectProperty' && p.value?.type !== 'AssignmentPattern' && p.key?.name) names.add(p.key.name); }
  else if (param.type === 'Identifier') walk(fn.body, (n) => { if (n.type === 'MemberExpression' && !n.computed && n.object?.type === 'Identifier' && n.object.name === param.name && n.property?.name) names.add(n.property.name); });
  // Destructured with another local name (`{ print: p }`): its uses go by that name.
  const local = new Map<string, string>();
  if (param.type === 'ObjectPattern') for (const p of param.properties) if (p.type === 'ObjectProperty' && p.key?.name) local.set(p.key.name, p.value?.type === 'Identifier' ? p.value.name : p.value?.left?.name ?? p.key.name);
  const propsName = param.type === 'Identifier' ? param.name : null;
  const isRoot = (n: any, k: string) => propsName ? /MemberExpression$/.test(n?.type) && !n.computed && n.object?.name === propsName && n.property?.name === k : n?.type === 'Identifier' && n.name === (local.get(k) ?? k);
  // Required ones only: the type's required props, or, untyped, every prop without a default. An optional
  // prop given a value could switch on a branch the element isn't in (`error && <Error …/>`).
  const required = lit ? new Set<string>((lit.members ?? []).filter((m: any) => m.type === 'TSPropertySignature' && !m.optional && m.key?.name && !defaults.has(m.key.name)).map((m: any) => m.key.name)) : names;
  for (const k of required) {
    if (k === 'children') continue;
    if (!(k in out)) {
      if (/^(on|handle|set)[A-Z]/.test(k)) { out[k] = FN; continue; }
      if (usedAsList(fn.body, propsName, k)) out[k] = [];
    }
    // What its body reads off it (`print.key`, `rows.map(r => r.name)`), nested: the type's own fields stay.
    const used = usageOf(fn.body, (n) => isRoot(n, k), 0, ast);
    if (used !== undefined) out[k] = mergeShape(out[k], used);
  }
  // Rendered (`{label}`, `{open ? lead : null}`) or handed on as a node (`<Chip icon={lead}>`): an object
  // there throws ("Objects are not valid as a React child"), so it's text instead.
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (!v || typeof v !== 'object' || Array.isArray(v) || special(v)) continue;
    if (renderedIn(fn.body, (n) => isRoot(n, k))) out[k] = '';
  }
  return out;
}

const NODE_ATTR = /^(children|label|icon|title|lead|leading|trail|trailing|prefix|suffix|start|end|adornment|description|content|header|footer|text|placeholder|tooltip|badge|avatar|empty|caption|subtitle|heading)$/i;

/** Is a value the root picks out rendered somewhere in this body: as a JSX child, or in a node-like attribute? */
function renderedIn(body: any, isRoot: (n: any) => boolean): boolean {
  let hit = false;
  const visit = (n: any, inNode: boolean, parent: any) => {
    if (hit || !n || typeof n.type !== 'string') return;
    if (inNode && isRoot(n) && !(/MemberExpression$/.test(parent?.type) && parent.object === n) && !(/CallExpression$/.test(parent?.type) && parent.callee === n)) { hit = true; return; }
    for (const key in n) {
      if (key === 'loc' || key === 'start' || key === 'end' || key.endsWith('Comments') || key === 'extra') continue;
      const v = n[key];
      // Inside a JSX child container, or a node-like attribute's value: what's there gets rendered.
      const next = inNode || (n.type === 'JSXExpressionContainer' && parent?.type === 'JSXElement') || (n.type === 'JSXAttribute' && key === 'value' && NODE_ATTR.test(n.name?.name ?? ''));
      // Not into a callback's arguments or a member's property: those aren't the value rendered.
      if (Array.isArray(v)) for (const c of v) visit(c, next && !(/CallExpression$/.test(n.type) && key === 'arguments'), n);
      else if (v && typeof v === 'object') visit(v, next && !(/MemberExpression$/.test(n.type) && key === 'property'), n);
    }
  };
  visit(body, false, null);
  return hit;
}

const LIST = /^(map|filter|forEach|some|every|find|findIndex|reduce|slice|includes|join|flatMap|at|sort|length)$/;
const NUM = /^(toFixed|toPrecision|toLocaleString)$/;
const SETS = /^(has|add|delete|size|clear)$/;
const MAPS = /^(get|set|entries|keys|values)$/;
const STR = /^(toUpperCase|toLowerCase|trim|split|replace|startsWith|endsWith|padStart|padEnd|charAt|localeCompare|match)$/;

/**
 * A value shaped by how code reads it, from the nodes `isRoot` picks out: `x.key` → { key: '' },
 * `x.total.toFixed(` → { total: 0 }, `x.rows.map(r => r.name)` → { rows: [{ name: '' }] } (one item, so a
 * list draws a row), `x.onOpen(` → a function. Undefined when nothing reads it.
 */
function usageOf(body: any, isRoot: (n: any) => boolean, depth: number, ast?: any): Val | undefined {
  if (depth > 6) return undefined;
  let shape: Val | undefined;
  let handed: Val | undefined;
  const fields = new Map<string, any[]>();
  walk(body, (n) => {
    // Handed to a component in the same file (`<Node node={n} />`): shaped by how that component reads it.
    if (ast && handed === undefined && n.type === 'JSXOpeningElement' && n.name?.type === 'JSXIdentifier' && /^[A-Z]/.test(n.name.name)) {
      for (const a of n.attributes ?? []) {
        if (a.type !== 'JSXAttribute' || a.value?.type !== 'JSXExpressionContainer' || !isRoot(a.value.expression)) continue;
        const v = propUsage(ast, n.name.name, a.name?.name, depth + 1);
        if (v !== undefined) handed = v;
      }
    }
    if (!/MemberExpression$/.test(n.type) || !isRoot(n.object)) return;
    const name = n.computed ? null : n.property?.name;
    if (!name) { if (shape === undefined) shape = {}; return; }
    if (LIST.test(name)) {
      // A list: one item, shaped by what the callback reads off its first parameter. Deep down (a tree
      // drawing itself), an empty one, so the drawing ends.
      if (Array.isArray(shape) && shape.length && shape[0] !== '') return;
      if (depth >= 4) { shape = []; return; }
      const call = parentCall(body, n);
      const cb = call?.arguments?.[0];
      const item = cb && /Function/.test(cb.type) && cb.params?.[0]?.type === 'Identifier' ? usageOf(cb.body, (m) => m?.type === 'Identifier' && m.name === cb.params[0].name, depth + 1, ast) : undefined;
      if (name === 'length') { if (!Array.isArray(shape)) shape = ['']; return; }
      shape = [item ?? ''];
      return;
    }
    if (NUM.test(name)) { shape = 0; return; }
    if (SETS.test(name) && (!shape || special(shape))) { shape = SET; return; }
    if (MAPS.test(name) && parentCall(body, n) && (!shape || special(shape))) { shape = MAP; return; }
    if (STR.test(name)) { shape = ''; return; }
    if (shape === undefined || typeof shape !== 'object' || Array.isArray(shape)) shape = {};
    fields.set(name, [...(fields.get(name) ?? []), n]);
  });
  if (shape && typeof shape === 'object' && !Array.isArray(shape) && fields.size) {
    const o: Record<string, Val> = {};
    for (const [f, nodes] of fields) {
      const set = new Set(nodes);
      const called = nodes.some(x => parentCall(body, x)?.callee === x);
      o[f] = called ? FN : usageOf(body, (m) => set.has(m), depth + 1, ast) ?? '';
    }
    return handed !== undefined ? mergeShape(handed, o) : o;
  }
  return shape === undefined ? handed : handed !== undefined ? mergeShape(handed, shape) : shape;
}

/** How a component in this file reads one of its props, as a value (usageOf). */
function propUsage(ast: any, comp: string, prop: string | undefined, depth: number): Val | undefined {
  if (!prop || depth > 6) return undefined;
  const fn = componentFn(ast, comp);
  const param = fn?.params?.[0];
  if (!param) return undefined;
  let isRoot: (n: any) => boolean;
  if (param.type === 'ObjectPattern') {
    const p = param.properties.find((x: any) => x.type === 'ObjectProperty' && x.key?.name === prop);
    if (!p) return undefined;
    const local = p.value?.type === 'Identifier' ? p.value.name : p.value?.left?.name ?? prop;
    isRoot = (n) => n?.type === 'Identifier' && n.name === local;
  } else if (param.type === 'Identifier') isRoot = (n) => /MemberExpression$/.test(n?.type) && !n.computed && n.object?.name === param.name && n.property?.name === prop;
  else return undefined;
  return usageOf(fn.body, isRoot, depth, ast);
}

/** The call whose callee is this node, if any. */
function parentCall(body: any, node: any): any {
  let found: any = null;
  walk(body, (n) => { if (!found && (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') && n.callee === node) found = n; });
  return found;
}

/** The type's shape, with what the body reads filled in where the type left it out. */
function mergeShape(a: Val | undefined, b: Val): Val {
  if (a === undefined || a === null) return b;
  // Called .has( or .get( on: a Set or Map, whatever else the type guessed.
  if (special(b) && !special(a)) return b;
  if (Array.isArray(a)) return a.length || !Array.isArray(b) ? a : b;
  if (typeof a === 'object' && typeof b === 'object' && b && !Array.isArray(b) && !special(a) && !special(b)) {
    const o: Record<string, Val> = { ...(a as Record<string, Val>) };
    for (const [k, v] of Object.entries(b)) o[k] = mergeShape(o[k], v);
    return o;
  }
  return a;
}

/** Is this prop used as a list (`.map(`, `.length`, `.filter(`…) in the body? */
function usedAsList(body: any, obj: string | null, k: string): boolean {
  let hit = false;
  walk(body, (n) => {
    if (hit || !/MemberExpression$/.test(n.type) || n.computed || !/^(map|filter|forEach|length|some|every|find|findIndex|reduce|slice|includes|join|flatMap|at)$/.test(n.property?.name ?? '')) return;
    const o = n.object;
    if (obj ? /MemberExpression$/.test(o?.type) && o.object?.name === obj && o.property?.name === k : o?.type === 'Identifier' && o.name === k) hit = true;
  });
  return hit;
}

function literalOf(t: any, types: Map<string, any>): any {
  if (!t) return null;
  if (t.type === 'TSTypeLiteral') return t;
  if (t.type === 'TSTypeReference' && t.typeName?.type === 'Identifier') return literalOf(types.get(t.typeName.name), types);
  if (t.type === 'TSIntersectionType') return { type: 'TSTypeLiteral', members: t.types.flatMap((x: any) => literalOf(x, types)?.members ?? []) };
  return null;
}

function shapeOf(t: any, types: Map<string, any>, depth: number): Val | undefined {
  if (!t) return undefined;
  switch (t.type) {
    case 'TSStringKeyword': return '';
    case 'TSNumberKeyword': return 0;
    case 'TSBooleanKeyword': return false;
    case 'TSArrayType': case 'TSTupleType': return [];
    case 'TSFunctionType': return FN;
    case 'TSLiteralType': return t.literal.type === 'TemplateLiteral' ? '' : t.literal.value;
    case 'TSNullKeyword': return null;
    case 'TSUnionType': {
      const parts = t.types.filter((x: any) => x.type !== 'TSUndefinedKeyword' && x.type !== 'TSNullKeyword');
      // A plain value or a node renders anywhere; an object only where it's read. So those go first.
      const plain = parts.find((x: any) => /^TS(String|Number|Boolean)Keyword$|^TSLiteralType$/.test(x.type) || /^(ReactNode|ReactElement|Element)$/.test(x.typeName?.name ?? x.typeName?.right?.name ?? ''));
      return plain ? shapeOf(plain, types, depth) : parts.length ? shapeOf(parts[0], types, depth) : null;
    }
    case 'TSTypeReference': {
      const n = t.typeName?.type === 'Identifier' ? t.typeName.name : t.typeName?.right?.name;
      if (/^(Array|ReadonlyArray)$/.test(n)) return [];
      if (/^(Set|ReadonlySet|WeakSet)$/.test(n)) return SET;
      if (/^(Map|ReadonlyMap|WeakMap)$/.test(n)) return MAP;
      if (/^(Record|Partial)$/.test(n)) return {};
      if (n === 'Date') return undefined;
      if (/Handler$|Callback$|^Dispatch$|^SetStateAction$/.test(n)) return FN;
      // A node: nothing, which renders as nothing (JSX.Element, ReactNode, ReactElement).
      if (/^(ReactNode|ReactElement|Element|ReactChild|ReactFragment)$/.test(n)) return null;
      const l = depth < 2 ? literalOf(types.get(n), types) : null;
      if (l) return objectOf(l, types, depth);
      const alias = types.get(n);
      return alias && alias.type !== 'TSTypeLiteral' && depth < 2 ? shapeOf(alias, types, depth + 1) : undefined;
    }
    case 'TSTypeLiteral': return depth < 2 ? objectOf(t, types, depth) : {};
    default: return undefined;
  }
}

function objectOf(l: any, types: Map<string, any>, depth: number): Val {
  const o: Record<string, Val> = {};
  for (const m of l.members ?? []) {
    if (m.type !== 'TSPropertySignature' || m.optional || !m.key?.name) continue;
    const v = shapeOf(m.typeAnnotation?.typeAnnotation, types, depth + 1);
    if (v !== undefined) o[m.key.name] = v;
  }
  return o;
}

/** The literal props of the first `<Name …>` in this file: plain values, lists and objects of them, and functions. */
function callSite(ast: any, name: string): Record<string, Val> | null {
  let found: any = null;
  walk(ast.program, (n) => { if (!found && n.type === 'JSXOpeningElement' && n.name.type === 'JSXIdentifier' && n.name.name === name) found = n; });
  if (!found) return null;
  const out: Record<string, Val> = {};
  for (const a of found.attributes) {
    if (a.type !== 'JSXAttribute' || a.name.type !== 'JSXIdentifier' || a.name.name === 'key' || a.name.name === 'ref') continue;
    const v = a.value === null ? true : a.value.type === 'StringLiteral' ? a.value.value : a.value.type === 'JSXExpressionContainer' ? valueOf(a.value.expression) : undefined;
    if (v !== undefined) out[a.name.name] = v;
  }
  return out;
}

function valueOf(x: any): Val | undefined {
  switch (x?.type) {
    case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': return x.value;
    case 'NullLiteral': return null;
    case 'TemplateLiteral': return x.expressions.length ? undefined : x.quasis.map((q: any) => q.value.cooked ?? '').join('');
    case 'ArrowFunctionExpression': case 'FunctionExpression': return FN;
    case 'ArrayExpression': { const v = x.elements.map(valueOf); return v.every((y: any) => y !== undefined) ? v : []; }
    case 'ObjectExpression': {
      const o: Record<string, Val> = {};
      for (const p of x.properties) { if (p.type !== 'ObjectProperty' || p.computed) return undefined; const v = valueOf(p.value); if (v === undefined) return undefined; o[p.key.name ?? p.key.value] = v; }
      return o;
    }
    case 'TSAsExpression': case 'TSSatisfiesExpression': return valueOf(x.expression);
    default: return undefined;
  }
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RENAME: Record<string, string> = { className: 'class', htmlFor: 'for', tabIndex: 'tabindex', readOnly: 'readonly', autoFocus: 'autofocus', viewBox: 'viewBox', strokeWidth: 'stroke-width', strokeLinecap: 'stroke-linecap', strokeLinejoin: 'stroke-linejoin', fillRule: 'fill-rule', clipRule: 'clip-rule' };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The element at file:line:col as static HTML: its tag, its literal attributes (never handlers, styles or
 * script URLs), the classes the scan resolved for it, its words, and the host elements inside it (an
 * icon's svg). Expressions are left out, except plain strings. Null when the element isn't there.
 */
export function markupOf(code: string, e: Pick<ElementEval, 'line' | 'col' | 'element' | 'classTokens' | 'match'>, tag?: string): string | null {
  let ast: any;
  try { ast = babelParse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'typescript', 'decorators-legacy'] }); } catch { return null; }
  let found: any = null;
  walk(ast.program, (n) => { if (!found && n.type === 'JSXElement' && n.openingElement.loc?.start.line === e.line && n.openingElement.loc.start.column + 1 === e.col) found = n; });
  if (!found || found.openingElement.name.type !== 'JSXIdentifier') return null;
  const html = draw(found, true, e, tag);
  return html || null;
}

function draw(n: any, top: boolean, e: Pick<ElementEval, 'element' | 'classTokens' | 'match'>, tag?: string): string {
  if (n.type === 'JSXText') return esc(n.value.replace(/\s+/g, ' '));
  if (n.type === 'JSXExpressionContainer') {
    const x = n.expression;
    if (x.type === 'StringLiteral') return esc(x.value);
    if (x.type === 'TemplateLiteral' && !x.expressions.length) return esc(x.quasis.map((q: any) => q.value.cooked ?? '').join(''));
    return '';
  }
  if (n.type === 'JSXFragment') return n.children.map((c: any) => draw(c, false, e)).join('');
  if (n.type !== 'JSXElement') return '';
  const name = n.openingElement.name;
  // A component inside it can't be drawn without running it: what's inside stays, its own markup doesn't.
  if (name.type !== 'JSXIdentifier' || !/^[a-z]/.test(name.name)) return n.children.map((c: any) => draw(c, false, e)).join('');
  const el = name.name;
  const attrs: string[] = [];
  for (const a of n.openingElement.attributes) {
    if (a.type !== 'JSXAttribute' || a.name.type !== 'JSXIdentifier') continue;
    const k = a.name.name;
    if (/^on[A-Z]/.test(k) || k === 'style' || k === 'dangerouslySetInnerHTML' || k === 'ref' || k === 'key' || (top && (k === 'className' || k === 'class'))) continue;
    let v: string | true | null = null;
    if (a.value === null) v = true;
    else if (a.value.type === 'StringLiteral') v = a.value.value;
    else if (a.value.type === 'JSXExpressionContainer') {
      const x = a.value.expression;
      if (x.type === 'StringLiteral') v = x.value;
      else if (x.type === 'BooleanLiteral') v = x.value ? true : null;
      else if (x.type === 'NumericLiteral') v = String(x.value);
      else if (x.type === 'TemplateLiteral' && !x.expressions.length) v = x.quasis.map((q: any) => q.value.cooked ?? '').join('');
    }
    if (v === null || (typeof v === 'string' && /^\s*javascript:/i.test(v))) continue;
    const out = RENAME[k] ?? k;
    attrs.push(v === true ? out : `${out}="${esc(v)}"`);
  }
  // The element's own classes, as the scan resolved them (constants, cn() and clsx() included).
  if (top && e.classTokens?.length) attrs.unshift(`class="${esc(e.classTokens.join(' '))}"`);
  if (top && tag) attrs.unshift(`data-dsa-drawn="${esc(tag)}"`);
  const open = `<${el}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  if (VOID.has(el)) return open;
  let inner = n.children.map((c: any) => draw(c, false, e)).join('').trim();
  // Words the scan read that the markup can't show (they come from an expression): the scan's own.
  if (top && !inner && e.match?.text) inner = esc(e.match.text);
  return `${open}${inner}</${el}>`;
}

function walk(node: any, fn: (n: any) => void) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key.endsWith('Comments') || key === 'extra') continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) walk(c, fn);
    else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, fn);
  }
}

/** The element's source file, read from the scan root or its app's folder. */
export function readSource(root: string, file: string, dir?: string): string | null {
  const tries = [path.resolve(root, file), ...(dir ? [path.join(path.dirname(dir), file)] : [])];
  for (const f of tries) { try { return fs.readFileSync(f, 'utf8'); } catch { /* next */ } }
  return null;
}


/** Runs in the page: show static markup alone, on the app's page (its style sheets stay in the head; the live app is hidden, not removed). */
/**
 * Runs in the page, for a drawing that came out 0×0: why, in words a person can act on, and a fallback
 * that still shows it. The element (and any wrapper hiding it) is made visible, given a small minimum
 * size and a dashed outline, and, when the markup left it empty, labelled with its tag. Null when the
 * element isn't on the page at all.
 */
export const NO_SIZE = `(id) => {
  const el = document.querySelector('[data-dsa-shot="' + CSS.escape(id) + '"]');
  if (!el) return null;
  const cls = (x) => typeof x.className === 'string' && x.className.trim() ? ', class "' + x.className.trim().split(/\\s+/).slice(0, 3).join(' ') + '"' : '';
  let why = '', hidden = [];
  for (let x = el; x && x !== document.body; x = x.parentElement) if (getComputedStyle(x).display === 'none') hidden.push(x);
  const st = getComputedStyle(el);
  const empty = !el.textContent.trim() && !el.querySelector('img, svg, input, select, textarea, video, canvas, picture');
  if (hidden.length) why = (hidden[0] === el ? 'its styles hide it' : 'a wrapper around it is hidden') + ' (display: none' + cls(hidden[0]) + ')';
  else if (st.visibility === 'hidden') why = 'its styles hide it (visibility: hidden' + cls(el) + ')';
  else if (empty) why = 'it is empty in its markup: its text and icons come from values or components only the running app fills in';
  else if (parseFloat(st.width) === 0 || parseFloat(st.height) === 0) why = 'its styles give it no width or height' + (cls(el) ? ' (' + cls(el).slice(2) + ')' : '');
  else why = 'it drew at 0×0 (its size comes from a layout around it that the drawing does not have)';
  for (const x of hidden) x.style.setProperty('display', x === el ? 'inline-block' : 'block', 'important');
  el.style.setProperty('visibility', 'visible', 'important');
  if (getComputedStyle(el).display === 'inline') el.style.setProperty('display', 'inline-block', 'important');
  el.style.setProperty('min-width', '48px', 'important');
  el.style.setProperty('min-height', '24px', 'important');
  el.style.setProperty('outline', '2px dashed #c2410c', 'important');
  el.style.setProperty('outline-offset', '2px', 'important');
  if (empty && !el.children.length && !/^(input|img|select|textarea|br|hr|svg)$/i.test(el.tagName)) el.textContent = '<' + el.tagName.toLowerCase() + '>';
  return why;
}`;

export const SHOW_MARKUP = `(html) => {
  document.getElementById('dsa-mount')?.remove();
  document.getElementById('dsa-markup')?.remove();
  for (const c of Array.from(document.body.children)) c.setAttribute('data-dsa-hide', '');
  if (!document.getElementById('dsa-hide')) { const st = document.createElement('style'); st.id = 'dsa-hide'; st.textContent = '[data-dsa-hide]{display:none !important}'; document.head.append(st); }
  const host = document.createElement('div');
  host.id = 'dsa-markup';
  host.style.padding = '24px';
  host.innerHTML = html;
  host.querySelectorAll('script, iframe, object, embed').forEach((x) => x.remove());
  document.body.append(host);
  return Boolean(host.querySelector('[data-dsa-drawn]'));
}`;

/** Top-level components in a file (a capitalised function, or a const holding one), with their source range. */
function components(ast: any): { name: string; node: any; start: number; end: number }[] {
  const out: { name: string; node: any; start: number; end: number }[] = [];
  for (const s0 of ast.program.body) {
    const s = s0.type === 'ExportNamedDeclaration' || s0.type === 'ExportDefaultDeclaration' ? s0.declaration : s0;
    if (!s) continue;
    if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && /^[A-Z]/.test(s.id?.name ?? '')) out.push({ name: s.id.name, node: s, start: s.loc.start.line, end: s.loc.end.line });
    if (s.type === 'VariableDeclaration') for (const d of s.declarations) if (/^[A-Z]/.test(d.id?.name ?? '') && d.init && /Function|Call|Class/.test(d.init.type)) out.push({ name: d.id.name, node: d, start: d.loc.start.line, end: d.loc.end.line });
  }
  return out;
}

/**
 * The component to mount for an element whose own function isn't one the build keeps (a render helper like
 * `cellFor`, `renderBody` or `toolbar`, or a function inside a component): the component whose body holds
 * the element's line, else the first one that calls the helper. Null when the file has neither.
 */
export function parentComponent(code: string, name: string, line: number): string | null {
  const ast = parse(code);
  if (!ast) return null;
  const all = components(ast).filter(c => c.name !== name);
  const around = all.find(c => c.start <= line && line <= c.end);
  if (around) return around.name;
  for (const c of all) {
    let calls = false;
    walk(c.node, (n) => { if (!calls && n.type === 'Identifier' && n.name === name) calls = true; });
    if (calls) return c.name;
  }
  return null;
}

/**
 * A read off nothing in a component's own props ("reading 'find'" on `rows.find(…)`, "reading 'name'" on
 * `alias.owner.name`): the path from the prop to what was missing, and a value of the kind that read needs
 * there: a list for a list's methods and length, a string for a string's, else an object with the field.
 */
export function nullRead(code: string, component: string, message: string): { path: string[]; value: Val } | null {
  const k = message.match(/reading '([\w$]+)'/)?.[1];
  if (!k) return null;
  const ast = parse(code);
  const fn = ast ? componentFn(ast, component) : null;
  if (!fn) return null;
  const param = fn.params?.[0];
  const params = new Set<string>();
  if (param?.type === 'ObjectPattern') for (const p of param.properties) if (p.type === 'ObjectProperty' && p.key?.name) params.add(p.value?.type === 'Identifier' ? p.value.name : p.key.name);
  const propsName = param?.type === 'Identifier' ? param.name : '';
  let found: string[] | null = null;
  walk(fn.body, (n) => {
    if (found || !/MemberExpression$/.test(n.type) || n.computed || n.property?.name !== k) return;
    const at: string[] = [];
    let o = n.object;
    while (/MemberExpression$/.test(o?.type ?? '') && !o.computed && o.property?.name) { at.unshift(o.property.name); o = o.object; }
    if (o?.type !== 'Identifier') return;
    if (o.name === propsName && at.length) found = at;
    else if (params.has(o.name)) found = [o.name, ...at];
  });
  if (!found) return null;
  const value: Val = /^(length|map|filter|find|findIndex|forEach|some|every|reduce|flatMap|slice|includes|indexOf|join|at|sort)$/.test(k) ? []
    : /^(trim|toLowerCase|toUpperCase|split|startsWith|endsWith|replace|padStart|charAt)$/.test(k) ? '' : { [k]: '' };
  return { path: found, value };
}

/**
 * What a component that threw while drawing was missing, read off its error and its source: "the prop
 * invoice", "a provider for StoreCtx", "what useStore reads (a provider above it)". Empty when it can't tell.
 */
export function whatItNeeded(code: string, component: string, message: string): string {
  const ast = parse(code);
  const fn = ast ? componentFn(ast, component) : null;
  if (!fn) return '';
  // The property it read off nothing ("reading 'map'", "x.map is not a function", "destructure property 'id'").
  const m = message.match(/reading '([\w$]+)'/) ?? message.match(/\.([\w$]+) is not a function/) ?? message.match(/destructure property '([\w$]+)'/);
  if (!m) return '';
  const prop = m[1]!;
  const params = new Set<string>();
  let propsName = '';
  const param = fn.params?.[0];
  if (param?.type === 'ObjectPattern') for (const p of param.properties) { if (p.type === 'ObjectProperty' && p.key?.name) params.add(p.value?.type === 'Identifier' ? p.value.name : p.key.name); }
  else if (param?.type === 'Identifier') propsName = param.name;
  // Each local name, and what set it: a hook (`const s = useStore()`), a context (`useContext(StoreCtx)`).
  const from = new Map<string, string>();
  walk(fn.body, (n) => {
    if (n.type !== 'VariableDeclarator' || n.init?.type !== 'CallExpression') return;
    const callee = n.init.callee?.type === 'Identifier' ? n.init.callee.name : n.init.callee?.property?.name ?? '';
    if (!/^use[A-Z]/.test(callee)) return;
    const arg = n.init.arguments?.[0];
    const what = callee === 'useContext' && arg ? `a provider for ${arg.type === 'Identifier' ? arg.name : arg.property?.name ?? 'its context'}` : `what ${callee} reads (a provider above it)`;
    const names: string[] = n.id.type === 'Identifier' ? [n.id.name] : n.id.type === 'ObjectPattern' ? n.id.properties.map((p: any) => p.value?.name ?? p.key?.name).filter(Boolean) : n.id.type === 'ArrayPattern' ? n.id.elements.map((e: any) => e?.name).filter(Boolean) : [];
    for (const x of names) from.set(x, what);
  });
  // The object it was read from: `invoice.id`, `props.invoice.id`, `s.shop`.
  let found = '';
  const rootOf = (o: any): string[] => { const path: string[] = []; while (o?.type === 'MemberExpression' || o?.type === 'OptionalMemberExpression') { if (!o.computed && o.property?.name) path.unshift(o.property.name); o = o.object; } return o?.type === 'Identifier' ? [o.name, ...path] : []; };
  walk(fn.body, (n) => {
    if (found || !(n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') || n.computed || n.property?.name !== prop) return;
    const [head, ...rest] = rootOf(n.object);
    if (!head) return;
    if (head === propsName && rest[0]) found = `the prop ${rest[0]}`;
    else if (params.has(head)) found = `the prop ${head}`;
    else if (from.has(head)) found = from.get(head)!;
  });
  if (!found && params.has(prop)) found = `the prop ${prop}`;
  return found;
}

/**
 * What a component reads off a hook's result, as a value: `const c = useCanvasChrome(); c.zoom` →
 * { zoom: '' }; `const { zoom, setZoom } = useCanvasChrome()` → { zoom: '', setZoom: a function }.
 */
export function hookValue(code: string, component: string, hook: string): Val | undefined {
  const ast = parse(code);
  const fn = ast ? componentFn(ast, component) : null;
  if (!fn || !hook) return undefined;
  let out: Val | undefined;
  walk(fn.body, (n) => {
    if (out !== undefined || n.type !== 'VariableDeclarator' || n.init?.type !== 'CallExpression' || n.init.callee?.name !== hook) return;
    if (n.id.type === 'Identifier') out = usageOf(fn.body, (m) => m?.type === 'Identifier' && m.name === n.id.name, 0, ast) ?? {};
    else if (n.id.type === 'ObjectPattern') {
      const o: Record<string, Val> = {};
      for (const p of n.id.properties) {
        const k = p.key?.name, local = p.value?.type === 'Identifier' ? p.value.name : p.value?.left?.name ?? k;
        if (!k) continue;
        o[k] = /^(on|set|handle|toggle)[A-Z]/.test(k) ? FN : usageOf(fn.body, (m) => m?.type === 'Identifier' && m.name === local, 0, ast) ?? '';
      }
      out = o;
    }
  });
  return out;
}

/** One component's state to set so an element shows: which of its state hooks (in order), and to what. */
export interface StateSet { file: string; component: string; slots: { index: number; name: string; value: Val }[] }

const NO_QUEUE = /^use(Memo|Callback|Ref|Effect|LayoutEffect|InsertionEffect|ImperativeHandle|Context|Id|DebugValue|SyncExternalStore|DeferredValue)$/;
const QUEUE_OTHER = /^use(Transition|ActionState|Optimistic|FormState)$/;

/**
 * The component's state hooks, in the order React keeps them: each useState/useReducer's name
 * (`const [open, setOpen] = useState(…)` → open), null for another hook that keeps state. Stops at the
 * first custom hook, whose own hooks can't be counted from here.
 */
export function stateOrder(code: string, component: string, hookCode?: (name: string) => string | null): (string | null)[] {
  return orderOf(code, component, hookCode, 0).out;
}

/** Where a custom hook's own state hooks begin among a component's (it keeps them in its caller's fiber), or -1. */
export function hookStart(code: string, component: string, hook: string, hookCode?: (name: string) => string | null): number {
  return orderOf(code, component, hookCode, 0).starts.get(hook) ?? -1;
}

function orderOf(code: string, component: string, hookCode: ((name: string) => string | null) | undefined, depth: number): { out: (string | null)[]; complete: boolean; starts: Map<string, number> } {
  const ast = parse(code);
  const fn = ast ? componentFn(ast, component) : null;
  const out: (string | null)[] = [];
  const starts = new Map<string, number>();
  if (!fn?.body?.body) return { out, complete: false, starts };
  // A custom hook the app declares: its own hooks keep state too (counted, unnamed). Null when it can't be read.
  const inner = (name: string): (string | null)[] | null => {
    if (depth > 3 || !hookCode) return null;
    const src = hookCode(name);
    if (!src) return null;
    const got = orderOf(src, name, hookCode, depth + 1);
    // Only when every hook inside it was counted: one it couldn't read leaves the order unknown.
    return got.complete ? got.out.map(() => null) : null;
  };
  const nameOf = (c: any) => c?.type === 'Identifier' ? c.name : c?.property?.name ?? '';
  for (const st of fn.body.body) {
    const calls: { name: string; id: any }[] = [];
    if (st.type === 'VariableDeclaration') for (const d of st.declarations) { if (d.init?.type === 'CallExpression') calls.push({ name: nameOf(d.init.callee), id: d.id }); }
    else if (st.type === 'ExpressionStatement' && st.expression?.type === 'CallExpression') calls.push({ name: nameOf(st.expression.callee), id: null });
    else if (st.type === 'ReturnStatement' && st.argument?.type === 'CallExpression') calls.push({ name: nameOf(st.argument.callee), id: null });
    for (const c of calls) {
      if (!/^use[A-Z]/.test(c.name)) continue;
      if (c.name === 'useState' || c.name === 'useReducer') out.push(c.id?.type === 'ArrayPattern' && c.id.elements[0]?.type === 'Identifier' ? c.id.elements[0].name : null);
      else if (QUEUE_OTHER.test(c.name)) out.push(null);
      else if (!NO_QUEUE.test(c.name)) { const k = inner(c.name); if (!k) return { out, complete: false, starts }; if (!starts.has(c.name)) starts.set(c.name, out.length); out.push(...k); }
    }
  }
  return { out, complete: true, starts };
}

/**
 * The state to set so an element's conditions hold: for each gate on a component's own state (`openColour`,
 * `!singleView`, `mode === 'current'`, `a || b` false), that hook and a value: a literal from the test, a
 * value shaped by how the component reads it, or true / false. Gates on props or members are left alone.
 */
/**
 * A state hook's initial value as written (`useState(null)`, `useState<Colour | null>(null)`, `useState({})`):
 * a value that already holds isn't set again, and a boolean never goes into state that starts as an object.
 */
export function initialOf(code: string, name: string): { type?: string | undefined; init: string } | null {
  const m = code.match(new RegExp(`\\[\\s*${name.replace(/[$]/g, '\\$')}\\s*,\\s*[\\w$]+\\s*\\]\\s*=\\s*(?:React\\.)?useState\\s*(?:<([^>]*)>)?\\s*\\(\\s*([^)]*?)\\s*\\)`));
  return m ? { type: m[1]?.trim(), init: m[2]!.trim() } : null;
}

/**
 * Whether a condition already holds with its state at the initial values its source gives (`!setupTakeover`
 * when it starts false, `nav === 'Home'` when it starts 'Home'). False when that can't be told.
 */
export function holdsInitially(g: { test: string; negated: boolean }, code: string): boolean {
  const id = g.test.match(/^!?\s*([\w$]+)$/);
  const eq = g.test.match(/^([\w$]+)\s*(===?|!==?)\s*(['"])(.*)\3$/);
  const name = id?.[1] ?? eq?.[1];
  const at = name ? initialOf(code, name) : null;
  if (!at) return false;
  const v = at.init;
  if (id) {
    const truthy = /^(true|[1-9]\d*|(['"`]).+\2|\{|\[|new\s)/.test(v);
    const falsy = /^(false|null|undefined|0|''|""|``|)$/.test(v);
    if (!truthy && !falsy) return false;
    return (truthy !== g.test.startsWith('!')) !== g.negated;
  }
  const lit = v.match(/^(['"`])(.*)\1$/)?.[2];
  if (lit === undefined) return false;
  return ((lit === eq![4]) === eq![2]!.startsWith('=')) !== g.negated;
}

export function stateSets(gates: { test: string; negated: boolean; component?: string; file?: string }[], read: (file: string) => string | null, hookCode?: (name: string, from: string) => string | null): StateSet[] {
  const out = new Map<string, StateSet>();
  for (const [gi, g] of gates.entries()) {
    if (!g.component || !g.file) continue;
    const code = read(g.file);
    if (!code) continue;
    const order = stateOrder(code, g.component, hookCode ? (n) => hookCode(n, g.file!) : undefined);
    // Its own state hooks by name, counted or not: past a hook whose own hooks can't be counted, a state has no
    // known place, but the tagger names each by its setter, so it can still be set by name (index -1).
    const declared = new Set([...code.matchAll(/\[\s*([\w$]+)\s*,\s*[\w$]+\s*\]\s*=\s*(?:React\.)?use(?:State|Reducer)\b/g)].map(m => m[1]!));
    const known = (x: string) => order.includes(x) || declared.has(x);
    if (!order.some(Boolean) && !declared.size) continue;
    const ast = parse(code);
    const fn = ast ? componentFn(ast, g.component) : null;
    // A condition passed as a prop (`open={!!editor}`): the prop must hold, so its value's condition does.
    const asProp = g.test.match(/^[\w$]+=\{([\s\S]*)\}$/);
    let expr: any = null;
    try { expr = babelParseExpression(asProp ? asProp[1]! : g.test, { plugins: ['jsx', 'typescript'] }); } catch { continue; }
    // A custom hook keeps its state in the component that calls it, after that component's earlier hooks:
    // the nearest condition above it whose component calls the hook, its state at that offset.
    let target = { file: g.file, component: g.component }, offset = 0;
    if (/^use[A-Z]/.test(g.component)) {
      const callers = gates.slice(0, gi).reverse().concat(gates.slice(gi + 1)).filter(c => c.component && c.file && !/^use[A-Z]/.test(c.component) && (read(c.file) ?? '').includes(`${g.component}(`));
      const c = callers[0];
      if (!c) continue;
      const at = hookStart(read(c.file!)!, c.component!, g.component, hookCode ? (n) => hookCode(n, c.file!) : undefined);
      if (at < 0) continue;
      target = { file: c.file!, component: c.component! };
      offset = at;
    }
    const want = new Map<string, Val>();
    const aliases = itemAliases(code);
    const initial = (x: string) => initialOf(code, x);
    // A value of the state's declared type (`useState<PaletteColour[]>`, the type here or in a file it imports).
    let types: Map<string, any> | null = null;
    const typed = (x: string): any => {
      const t = initial(x)?.type;
      if (!t) return null;
      types ??= typesWithImports(ast, g.file!, read);
      return typeNode(t);
    };
    const itemOf = (x: string): Val | undefined => {
      const t = typed(x);
      const el = t?.type === 'TSArrayType' ? t.elementType : t?.type === 'TSTypeReference' && /^(Array|ReadonlyArray)$/.test(t.typeName?.name ?? '') ? t.typeParameters?.params?.[0] : null;
      const v = el ? shapeOf(el, types!, 0) : undefined;
      return v === undefined ? undefined : truthy(v);
    };
    const shapeFor = (x: string, truth: boolean): Val | undefined => {
      const at = initial(x);
      const objecty = at ? /^(\{|\[|new\s)/.test(at.init) : false;
      if (!truth) return objecty ? undefined : false;
      if (objecty) return undefined;
      const v = fn ? usageOf(fn.body, (m) => m?.type === 'Identifier' && m.name === x, 0, ast) : undefined;
      // Nothing read off it: a value of its type, or true unless its type says it's a value, not a flag.
      if (v === undefined || v === '') {
        const t = typed(x);
        const tv = t ? shapeOf(t, types!, 0) : undefined;
        if (tv !== undefined) return truthy(tv);
        return at?.type && !/\bboolean\b/.test(at.type) ? {} : true;
      }
      return v === 0 ? 1 : Array.isArray(v) && !v.length ? [''] : v;
    };
    const visit = (e: any, truth: boolean) => {
      if (!e) return;
      if (e.type === 'Identifier') { if (known(e.name)) { const v = shapeFor(e.name, truth); if (v !== undefined) want.set(e.name, v); } return; }
      if (e.type === 'UnaryExpression' && e.operator === '!') return visit(e.argument, !truth);
      if (e.type === 'LogicalExpression') {
        if ((e.operator === '&&' && truth) || (e.operator === '||' && !truth)) { visit(e.left, truth); visit(e.right, truth); }
        else visit(e.left, truth);
        return;
      }
      // A condition on a list item's field (`up.failed`, `row.kind === 'document'`): the list with one such item.
      const f = itemField(e, aliases) ?? (e.type === 'BinaryExpression' && /^[!=]==?$/.test(e.operator) && e.operator.startsWith('=') === truth ? itemField(e.left, aliases) ?? itemField(e.right, aliases) : null);
      if (f && known(f.list)) {
        const lit = e.type === 'BinaryExpression' ? (itemField(e.left, aliases) ? e.right : e.left) : null;
        const v: Val = lit && /^(String|Numeric|Boolean)Literal$/.test(lit.type) ? lit.value : truth;
        const it = itemOf(f.list);
        want.set(f.list, [{ ...(it && typeof it === 'object' && !Array.isArray(it) ? it : {}), [f.field]: v }]);
        return;
      }
      // A list read for its length (`palette.length > 0`, `items.length`, `rows.length === 0`): one item, or none.
      const len = lengthTest(e);
      if (len) {
        if (!known(len.name)) return;
        if (len.nonEmpty !== truth) { want.set(len.name, []); return; }
        // One item of its declared type, else as the component reads it.
        const it = itemOf(len.name);
        const v = fn ? usageOf(fn.body, (m) => m?.type === 'Identifier' && m.name === len.name, 0, ast) : undefined;
        want.set(len.name, it !== undefined ? [it] : Array.isArray(v) && v.length && v[0] !== '' ? v.slice(0, 1) : ['a']);
        return;
      }
      if (e.type === 'BinaryExpression' && /^[!=]==?$/.test(e.operator)) {
        const [id, lit] = e.left.type === 'Identifier' ? [e.left, e.right] : [e.right, e.left];
        if (id?.type !== 'Identifier' || !known(id.name) || !/^(String|Numeric|Boolean)Literal$/.test(lit?.type)) return;
        const eq = e.operator.startsWith('=') === truth;
        if (eq) want.set(id.name, lit.value);
        else if (typeof lit.value === 'boolean') want.set(id.name, !lit.value);
      }
    };
    visit(expr, !g.negated);
    if (!want.size) continue;
    const key = `${target.file}|${target.component}`;
    const s = out.get(key) ?? { file: target.file, component: target.component, slots: [] };
    for (const [name, value] of want) {
      const index = order.indexOf(name);
      if (index >= 0 && !s.slots.some(x => x.index === offset + index)) s.slots.push({ index: offset + index, name, value });
      else if (index < 0 && !s.slots.some(x => x.name === name)) s.slots.push({ index: -1, name, value });
    }
    if (s.slots.length) out.set(key, s);
  }
  return [...out.values()];
}

/**
 * The string values a component's state can take, from its source: literals compared with it (`nav === 'Colours'`,
 * a `switch (nav)`'s cases), passed to its setter (`setNav('Prints')`), and in its type (`useState<'a' | 'b'>`, or
 * a type alias of literals it names). Used to set a root's nav state to each value by itself, to see what it shows.
 */
export function stateValues(code: string, name: string, more: string[] = []): string[] {
  const out = new Set<string>();
  const esc = name.replace(/[$]/g, '\\$');
  const lit = `(['"\`])([^'"\`\\n]{1,60})\\1`;
  const add = (re: RegExp, from = code) => { for (const m of from.matchAll(re)) out.add(m[2]!); };
  add(new RegExp(`\\b${esc}\\s*[!=]==?\\s*${lit}`, 'g'));
  add(new RegExp(`${lit}\\s*[!=]==?\\s*${esc}\\b`, 'g'));
  const decl = code.match(new RegExp(`\\[\\s*${esc}\\s*,\\s*([\\w$]+)\\s*\\]\\s*=\\s*(?:React\\.)?useState\\s*(?:<([^>]+)>)?`));
  const all = [code, ...more];
  if (decl) {
    const setter = decl[1]!.replace(/[$]/g, '\\$');
    add(new RegExp(`\\b${setter}\\s*\\(\\s*${lit}`, 'g'));
    let type = decl[2] ?? '';
    // A type alias of literals, here or in a file it imports (`type NavKey = 'home' | 'colours'`), or an enum of strings.
    const alias = /^\s*([\w$]+)\s*$/.exec(type)?.[1];
    if (alias) {
      type = '';
      for (const c of all) {
        const t = c.match(new RegExp(`\\btype\\s+${alias}\\s*=\\s*([^;]+)`))?.[1];
        if (t) { type = t; break; }
        const en = c.match(new RegExp(`\\benum\\s+${alias}\\s*\\{([^}]*)\\}`))?.[1];
        if (en) { type = en; break; }
      }
    }
    for (const m of type.matchAll(new RegExp(lit, 'g'))) out.add(m[2]!);
    // Set from a registry (`items.map(n => <button onClick={() => setNav(n.id)}>`): that field's string values,
    // in this file and the files it imports.
    for (const m of code.matchAll(new RegExp(`\\b${setter}\\s*\\(\\s*[\\w$]+\\.([\\w$]+)\\s*\\)`, 'g'))) {
      for (const c of all) add(new RegExp(`\\b${m[1]}\\s*:\\s*${lit}`, 'g'), c);
    }
  }
  const sw = code.match(new RegExp(`switch\\s*\\(\\s*${esc}\\s*\\)\\s*\\{`));
  if (sw) {
    let depth = 0, i = sw.index! + sw[0].length - 1, end = i;
    for (; i < code.length; i++) { if (code[i] === '{') depth++; else if (code[i] === '}' && --depth === 0) { end = i; break; } }
    for (const m of code.slice(sw.index!, end).matchAll(new RegExp(`case\\s+${lit}`, 'g'))) out.add(m[2]!);
  }
  return [...out].slice(0, 60);
}
