import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
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

/** A prop value the page turns into a function that does nothing. */
export const FN = { __dsa: 'fn' } as const;
type Val = string | number | boolean | null | typeof FN | Val[] | { [k: string]: Val };

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
  for (const k of names) {
    if (k in out || k === 'children') continue;
    if (/^(on|handle|set)[A-Z]/.test(k)) out[k] = FN;
    else if (usedAsList(fn.body, param.type === 'Identifier' ? param.name : null, k)) out[k] = [];
  }
  return out;
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
      return parts.length ? shapeOf(parts[0], types, depth) : null;
    }
    case 'TSTypeReference': {
      const n = t.typeName?.type === 'Identifier' ? t.typeName.name : t.typeName?.right?.name;
      if (/^(Array|ReadonlyArray|Set)$/.test(n)) return [];
      if (/^(Record|Map|Partial)$/.test(n)) return {};
      if (n === 'Date') return undefined;
      if (/Handler$|Callback$|^Dispatch$|^SetStateAction$/.test(n)) return FN;
      if (/^(ReactNode|ReactElement|JSX)$/.test(n)) return undefined;
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
