import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';

/**
 * Source tags: each host JSX element (`button`, `input`, `a`…) gets `data-dsa-src="<file>:<line>:<col>"`, the
 * place the scanner records for it, so the crawler matches the element on the page exactly instead of
 * guessing from its tag, classes and words. The file is relative to the scan root, the way the scanner
 * stores it: never an absolute path, and nothing outside the repo is tagged.
 *
 * Off unless `when` is true or DSA_TAG=1, so a production build is never tagged by accident. Tags show
 * file paths in the build's DOM: use them on internal dev or preview builds only.
 *
 *   import { dsaTag } from '@snds/dsa/tag';
 *   export default defineConfig({ plugins: [dsaTag({ when: process.env.DSA_TAG === '1' }), react()] });
 *
 * Babel (and Next.js through Babel): `plugins: ['@snds/dsa/tag/babel']`.
 *
 * While on, the Vite plugin also serves /@dsa/mount (MOUNT_MODULE), which the crawler uses to draw an
 * element it can't reach live from the app's own component and styles.
 */
export interface TagOptions {
  /** Tag this build. Default: DSA_TAG=1 in the environment. */
  when?: boolean | undefined;
  /** The scan root (the folder with dsa.config.json). Default: DSA_TAG_ROOT, else the nearest folder up with dsa.config.json, else the git root. */
  root?: string | undefined;
  /** The app's own folder, when it sits outside the scan root (the scanner shows those files as "<folder>/<path>"). Default: DSA_TAG_DIR. */
  dir?: string | undefined;
  /**
   * Also tag component elements. Only for components that pass unknown props through to the DOM: a
   * component that doesn't gets a prop it ignores (or warns about). True for all, or a list of names.
   */
  components?: boolean | string[] | undefined;
}

export const TAG_ATTR = 'data-dsa-src';

/** Is tagging on for these options? */
export function tagEnabled(o: TagOptions = {}): boolean {
  return o.when ?? process.env.DSA_TAG === '1';
}

const roots = new Map<string, string | null>();
/** The nearest folder up from `dir` holding dsa.config.json, else the nearest git root. */
function findRoot(dir: string): string | null {
  if (roots.has(dir)) return roots.get(dir)!;
  let git: string | null = null;
  let found: string | null = null;
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'dsa.config.json'))) { found = d; break; }
    if (!git && fs.existsSync(path.join(d, '.git'))) git = d;
    if (path.dirname(d) === d) break;
  }
  const r = found ?? git;
  roots.set(dir, r);
  return r;
}

/**
 * A file's tag path, as the scanner shows it: relative to the root, with forward slashes. A file in an app
 * folder outside the root reads "<folder>/<path>". Null for anything else outside, and for node_modules.
 */
export function tagPath(file: string, root: string, dir?: string): string | null {
  const abs = path.resolve(file);
  if (abs.split(path.sep).includes('node_modules')) return null;
  const rel = path.relative(root, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  if (!dir) return null;
  const inDir = path.relative(dir, abs);
  if (!inDir || inDir.startsWith('..') || path.isAbsolute(inDir)) return null;
  return path.join(path.basename(dir), inDir).split(path.sep).join('/');
}

/** A file's tag path under these options (root and app folder from the options, the environment, or found). */
export function tagFileOf(file: string, o: TagOptions = {}): string | null {
  const root = o.root ?? process.env.DSA_TAG_ROOT ?? findRoot(path.dirname(path.resolve(file)));
  return root ? tagPath(file, root, o.dir ?? process.env.DSA_TAG_DIR) : null;
}

const SOURCE = /\.(jsx|tsx|js|mjs|cjs|mts|cts)$/;
const FRAGMENT = /(^|\.)Fragment$/;

/** One element the tagger stamped. */
export interface Tag { element: string; value: string; line: number; col: number }

/**
 * Tag one file's source. Null when there's nothing to do (tagging off, not a JSX file, outside the root,
 * no JSX, or it doesn't parse). Lines are kept: every tag is inserted on its element's own line.
 */
export function tagSource(code: string, file: string, o: TagOptions = {}): { code: string; tags: Tag[] } | null {
  if (!tagEnabled(o)) return null;
  const clean = file.replace(/[?#].*$/, '');
  if (!SOURCE.test(clean) || !code.includes('<')) return null;
  const rel = tagFileOf(clean, o);
  if (!rel) return null;
  let ast: any;
  // The scanner's own parser options, so lines and columns are the ones it records.
  try { ast = babelParse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'typescript', 'decorators-legacy'] }); } catch { return null; }
  const comps = o.components;
  const edits: { at: number; text: string }[] = [];
  const tags: Tag[] = [];
  walk(ast.program, (n) => {
    if (n.type !== 'JSXOpeningElement' || !n.loc) return;
    const name = jsxName(n.name);
    if (!name) return;
    const host = n.name.type === 'JSXIdentifier' && /^[a-z]/.test(name) && !name.includes('-');
    if (!host && !(comps === true ? !FRAGMENT.test(name) : Array.isArray(comps) && comps.includes(name))) return;
    if (n.attributes.some((a: any) => a.type === 'JSXAttribute' && a.name?.name === TAG_ATTR)) return;
    const line = n.loc.start.line, col = n.loc.start.column + 1;
    const value = `${rel}:${line}:${col}`;
    // Straight after the name: before any spread, so a tag passed in from a caller still wins.
    edits.push({ at: n.name.end, text: ` ${TAG_ATTR}=${JSON.stringify(value)}` });
    tags.push({ element: name, value, line, col });
  });
  // The file's own components, exported or not, kept by its tag path so /@dsa/mount can draw one that
  // isn't exported (a row, a panel defined beside its parent). A global, not an export: Fast Refresh stays.
  const local = localComponents(ast);
  if (!edits.length && !local.length) return null;
  let out = code;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  // On the file's last line when it ends in a newline, so no line moves and the count stays.
  if (local.length) out += `${out.endsWith('\n') ? '' : '\n'};(globalThis.__dsaLocal ??= {})[${JSON.stringify(rel)}] = { ${local.join(', ')} };`;
  return { code: out, tags };
}

/** Top-level components declared in the file (a capitalised function, class or const), exported or not. */
function localComponents(ast: any): string[] {
  const out = new Set<string>();
  for (const s0 of ast.program.body) {
    const s = s0.type === 'ExportNamedDeclaration' || s0.type === 'ExportDefaultDeclaration' ? s0.declaration : s0;
    if (!s || s.declare) continue;
    if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id && /^[A-Z]/.test(s.id.name)) out.add(s.id.name);
    if (s.type === 'VariableDeclaration') for (const d of s.declarations) if (d.id?.type === 'Identifier' && /^[A-Z]/.test(d.id.name) && d.init && /Function|Call|Class/.test(d.init.type)) out.add(d.id.name);
  }
  return [...out];
}

const jsxName = (n: any): string | null => n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? (jsxName(n.object) ? `${jsxName(n.object)}.${n.property.name}` : null) : null;

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

/**
 * /@dsa/mount, served by the tagger whenever it's on: draws one component on the app's own page with React,
 * so the crawler can show an element it can't reach live from the app's own code and styles. Fixed text;
 * what it mounts comes in as arguments from the crawler.
 *
 * - The component: exported from its file, or one the file declares without exporting (kept by the tagger).
 * - Its providers: every context the live app provides at the deepest point near the element (the same
 *   file's elements if the page shows any, else the deepest tagged element), with the live values. That
 *   covers the providers the app's entry file wraps it in (a query client, a theme, a router, a store) and
 *   ones deeper in the tree. The live app is hidden, not removed, so the next mount can read it again.
 * - Its props: plain values from the crawler; {"__dsa":"fn"} becomes a function that does nothing.
 *
 * Returns { ok, why, providers }: why says, in plain words, what stopped it.
 */
export const MOUNT_MODULE = `import { createElement, Component } from 'react';
import { createRoot } from 'react-dom/client';
class Guard extends Component {
  constructor(p) { super(p); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { window.__dsaMountError = String((err && err.message) || err).slice(0, 200); }
  render() { return this.state.failed ? null : this.props.children; }
}
const noop = () => {};
const revive = (v) => Array.isArray(v) ? v.map(revive) : v && typeof v === 'object' ? (v.__dsa === 'fn' ? noop : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]))) : v;
const fiberOf = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); return k ? el[k] : null; };
// The contexts provided above a node of the live app, innermost first, one value per context.
function contextsAt(el) {
  const out = [], seen = new Set();
  for (let f = el && fiberOf(el); f; f = f.return) {
    if (f.tag !== 10 || !f.type) continue;
    const ctx = f.type._context || f.type;
    if (seen.has(ctx) || !f.memoizedProps || !('value' in f.memoizedProps)) continue;
    seen.add(ctx); out.push({ ctx, value: f.memoizedProps.value });
  }
  return out;
}
function nearest(file) {
  const all = Array.from(document.querySelectorAll('[data-dsa-src]')).filter((el) => !el.closest('#dsa-mount, #dsa-markup'));
  const same = file ? all.filter((el) => el.getAttribute('data-dsa-src').startsWith(file + ':')) : [];
  const depth = (el) => { let d = 0; for (let x = el; x; x = x.parentElement) d++; return d; };
  return (same.length ? same : all).reduce((a, b) => (!a || depth(b) > depth(a) ? b : a), null);
}
let root = null;
window.__dsaMount = async (files, name, props, file) => {
  window.__dsaMountError = null;
  let mod, err = '';
  for (const f of [].concat(files)) { try { mod = await import(/* @vite-ignore */ f); break; } catch (e) { err = String((e && e.message) || e).slice(0, 160); } }
  if (!mod) return { ok: false, why: 'its file did not load: ' + err };
  const local = (globalThis.__dsaLocal || {})[file] || {};
  const C = mod[name] || (mod.default && (name === 'default' || mod.default.name === name) ? mod.default : undefined) || local[name];
  if (!C) return { ok: false, why: 'its component ' + name + ' is not in its file as built' };
  const ctxs = contextsAt(nearest(file));
  if (root) { try { root.unmount(); } catch {} root = null; }
  document.getElementById('dsa-mount')?.remove();
  document.getElementById('dsa-markup')?.remove();
  for (const c of Array.from(document.body.children)) c.setAttribute('data-dsa-hide', '');
  if (!document.getElementById('dsa-hide')) { const st = document.createElement('style'); st.id = 'dsa-hide'; st.textContent = '[data-dsa-hide]{display:none !important}'; document.head.append(st); }
  const host = document.createElement('div');
  host.id = 'dsa-mount';
  host.style.padding = '24px';
  document.body.append(host);
  let el = createElement(C, revive(props));
  for (const { ctx, value } of ctxs) el = createElement(ctx.Provider || ctx, { value }, el);
  root = createRoot(host);
  root.render(createElement(Guard, null, el));
  await new Promise((r) => setTimeout(r, 400));
  return window.__dsaMountError ? { ok: false, why: 'its component failed to render: ' + window.__dsaMountError, providers: ctxs.length } : { ok: true, providers: ctxs.length };
};
`;

/**
 * The Vite plugin (Vite, React Router v7, Remix on Vite). Runs before other plugins, on the source as
 * written, so its lines and columns are the scanner's. Does nothing unless tagging is on.
 */
export function dsaTag(o: TagOptions = {}): { name: string; enforce: 'pre'; resolveId: (id: string) => string | null; load: (id: string) => string | null; transform: (code: string, id: string) => { code: string; map: null } | null } {
  const on = tagEnabled(o);
  return {
    name: 'dsa:tag',
    enforce: 'pre',
    // /@dsa/mount (MOUNT_MODULE): only while tagging is on, so a production build never has it.
    resolveId: (id) => (on && id === '/@dsa/mount' ? '\0dsa-mount.js' : null),
    load: (id) => (on && id === '\0dsa-mount.js' ? MOUNT_MODULE : null),
    transform(code, id) {
      if (!on || id.startsWith('\0')) return null;
      const r = tagSource(code, id, { ...o, when: true });
      return r ? { code: r.code, map: null } : null;
    },
  };
}

export default dsaTag;
