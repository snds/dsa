import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import type { ElementEval } from '@snds/dsa/engine';

/**
 * Elements the crawler can't photograph (a condition it couldn't meet, a page it never reached) are drawn
 * from the code instead, and the card says "Drawn direct from code". Two ways, best first:
 *
 *  3. Mounted: the element's component, loaded through the app's own Vite dev server and rendered with
 *     React on one of the app's pages, so its real styles and its own imports apply. Props come from the
 *     gates the scan traced on it (`open && …` → open: true). Found on the page by its source tag.
 *  4. Markup: the element's own JSX written out as static HTML (literal attributes, its classes as the scan
 *     resolved them, its words), shown on one of the app's pages so the app's style sheets apply. No app
 *     code runs.
 *
 * Neither is a photo of the app: a drawing never counts as evidence that a person can see the element.
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

/**
 * Served by the app's own Vite dev server (the tagging runner adds it): mounts one component on the page
 * with React, inside an error boundary, replacing the page's body. Fixed text; what it mounts comes in as
 * arguments from the crawler.
 */
export const MOUNT_MODULE = `import { createElement, Component } from 'react';
import { createRoot } from 'react-dom/client';
class Guard extends Component {
  constructor(p) { super(p); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { window.__dsaMountError = String((err && err.message) || err).slice(0, 200); }
  render() { return this.state.failed ? null : this.props.children; }
}
window.__dsaMount = async (file, name, props) => {
  window.__dsaMountError = null;
  let mod;
  try { mod = await import(/* @vite-ignore */ file); } catch (e) { return 'its file did not load: ' + String((e && e.message) || e).slice(0, 160); }
  const C = mod[name] || (mod.default && (name === 'default' || mod.default.name === name) ? mod.default : undefined);
  if (!C) return 'its component is not exported';
  const host = document.createElement('div');
  host.id = 'dsa-mount';
  host.style.padding = '24px';
  document.body.replaceChildren(host);
  createRoot(host).render(createElement(Guard, null, createElement(C, props)));
  await new Promise((r) => setTimeout(r, 400));
  return window.__dsaMountError ? 'its component failed to render: ' + window.__dsaMountError : 'ok';
};
`;

/** Runs in the page: show static markup alone, on the app's page (its style sheets stay in the head). */
export const SHOW_MARKUP = `(html) => {
  const host = document.createElement('div');
  host.id = 'dsa-markup';
  host.style.padding = '24px';
  host.innerHTML = html;
  host.querySelectorAll('script, iframe, object, embed').forEach((x) => x.remove());
  document.body.replaceChildren(host);
  return Boolean(host.querySelector('[data-dsa-drawn]'));
}`;
