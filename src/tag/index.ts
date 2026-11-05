import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import { LEDGER_RUNTIME } from './ledger.js';

export { LEDGER_RUNTIME } from './ledger.js';

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
  /**
   * Mark where each component is used: `data-dsa-use="file:line:col"` on every component element, which
   * reaches the page when the component passes unknown props to its element (shadcn-style components do),
   * so the crawler can photograph the app's own uses of a design-system component. Default: DSA_TAG_USES=1.
   */
  uses?: boolean | undefined;
}

export const USE_ATTR = 'data-dsa-use';

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

/**
 * The file a tag path names (tagPath backwards): under the root, else, for "<folder>/<path>", in the app
 * folder outside it. Null when neither exists. Real paths, so they compare with Vite's own.
 */
export function fileOfTag(rel: string, root: string, dir?: string): string | null {
  const real = (f: string) => { try { return fs.realpathSync(f); } catch { return null; } };
  const clean = rel.replace(/\\/g, '/');
  if (!clean || clean.split('/').includes('..') || path.isAbsolute(clean)) return null;
  const inRoot = real(path.join(root, clean));
  if (inRoot) return inRoot;
  if (dir && clean.startsWith(path.basename(dir) + '/')) return real(path.join(dir, clean.slice(path.basename(dir).length + 1)));
  return null;
}

/**
 * The URL a Vite dev server serves a file at: under its root, the path from the root ("/src/x.tsx"), else
 * "/@fs/<absolute path>", each after the server's base ("/" unless the config sets one).
 */
export function viteUrlOf(file: string, viteRoot: string, base = '/'): string {
  let r = viteRoot;
  try { r = fs.realpathSync(viteRoot); } catch { /* as given */ }
  const b = base.endsWith('/') ? base : base + '/';
  const inRoot = path.relative(r, file);
  if (inRoot && !inRoot.startsWith('..') && !path.isAbsolute(inRoot)) return b + inRoot.split(path.sep).join('/');
  const abs = file.split(path.sep).join('/');
  return b + '@fs' + (abs.startsWith('/') ? '' : '/') + abs;
}

/**
 * A file in a copy of the app, named as the original: DSA_TAG_COPY is ["<copy folder>", "<app folder>"]. dsa's
 * render tier runs the app's tests from a copy, so nothing they write lands in the app, with tags that still
 * match the scan's.
 */
function asOriginal(file: string): string {
  const c = process.env.DSA_TAG_COPY;
  if (!c) return file;
  try {
    const [from, to] = JSON.parse(c) as [string, string];
    const abs = path.resolve(file);
    for (const f of new Set([from, fs.realpathSync(from)])) {
      const rel = path.relative(f, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return path.join(to, rel);
    }
  } catch { /* not a copy */ }
  return file;
}

/** A file's tag path under these options (root and app folder from the options, the environment, or found). */
export function tagFileOf(given: string, o: TagOptions = {}): string | null {
  const file = asOriginal(given);
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
  // Fail safe: the output is parsed again before it's handed on. If it doesn't parse, the file gets its
  // source tags alone (no use marks, no state names); if that doesn't either, it's served as written. Either
  // way one line names the file: one file must never take the app down.
  const clean = file.replace(/[?#].*$/, '');
  const plugins: any[] = /\.ts$/.test(clean) ? ['typescript', 'decorators-legacy'] : ['jsx', 'typescript', 'decorators-legacy'];
  const parses = (c: string) => { try { babelParse(c, { sourceType: 'unambiguous', plugins }); return true; } catch { return false; } };
  const full = tagFile(code, file, o, false);
  if (!full || parses(full.code)) return full;
  const lean = tagFile(code, file, o, true);
  if (lean && parses(lean.code)) { warnOnce(clean, 'its use marks and state names made code that does not parse, so it has source tags only'); return lean; }
  warnOnce(clean, 'tagging it made code that does not parse, so it is served as written');
  return null;
}

const warned = new Set<string>();
function warnOnce(file: string, why: string) {
  if (warned.has(file)) return;
  warned.add(file);
  console.warn(`dsa tag: ${file}: ${why}. Please report this file's shape.`);
}

function tagFile(code: string, file: string, o: TagOptions, lean: boolean): { code: string; tags: Tag[] } | null {
  if (!tagEnabled(o)) return null;
  const clean = file.replace(/[?#].*$/, '');
  // A plain .ts file (a custom hook) has no JSX: only its state hooks are named, parsed as TypeScript alone.
  const tsOnly = /\.ts$/.test(clean) && !/\.d\.ts$/.test(clean);
  // No JSX: nothing to tag, unless it makes a context the mount may need to provide, or keeps state (kept below).
  if (!(SOURCE.test(clean) || tsOnly) || (!code.includes('<') && !/\bcreateContext\b|\buse(State|Reducer)\b/.test(code))) return null;
  if (tsOnly && !/\buse(State|Reducer)\b/.test(code)) return null;
  const rel = tagFileOf(clean, o);
  if (!rel) return null;
  let ast: any;
  // The scanner's own parser options, so lines and columns are the ones it records.
  try { ast = babelParse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins: tsOnly ? ['typescript', 'decorators-legacy'] : ['jsx', 'typescript', 'decorators-legacy'] }); } catch { return null; }
  const comps = o.components;
  const uses = !lean && (o.uses ?? process.env.DSA_TAG_USES === '1');
  const edits: { at: number; text: string }[] = [];
  const tags: Tag[] = [];
  walk(ast.program, (n) => {
    if (n.type !== 'JSXOpeningElement' || !n.loc) return;
    const name = jsxName(n.name);
    if (!name) return;
    const host = n.name.type === 'JSXIdentifier' && /^[a-z]/.test(name) && !name.includes('-');
    if (!host && uses && !FRAGMENT.test(name) && /^[A-Z]/.test(name.split('.').pop() ?? '') && !n.attributes.some((a: any) => a.type === 'JSXAttribute' && a.name?.name === USE_ATTR)) {
      edits.push({ at: afterName(n), text: ` ${USE_ATTR}=${JSON.stringify(`${rel}:${n.loc.start.line}:${n.loc.start.column + 1}`)}` });
    }
    if (!host && !(comps === true ? !FRAGMENT.test(name) : Array.isArray(comps) && comps.includes(name))) return;
    if (n.attributes.some((a: any) => a.type === 'JSXAttribute' && a.name?.name === TAG_ATTR)) return;
    const line = n.loc.start.line, col = n.loc.start.column + 1;
    const value = `${rel}:${line}:${col}`;
    // Straight after the name: before any spread, so a tag passed in from a caller still wins.
    edits.push({ at: afterName(n), text: ` ${TAG_ATTR}=${JSON.stringify(value)}` });
    tags.push({ element: name, value, line, col });
  });
  // Each state hook's name, kept by its setter (`const [open, setOpen] = useState(…)` → setOpen is "open"), so
  // the crawler sets state by name instead of guessing the hook's place. A statement after the declaration,
  // on its own line's end: no hook is added or moved, so Fast Refresh and the hooks' order stay as they were.
  if (!lean) walk(ast.program, (n) => {
    if (n.type !== 'BlockStatement') return;
    for (const st of n.body) {
      if (st.type !== 'VariableDeclaration') continue;
      for (const d of st.declarations) {
        const call = d.init?.type === 'CallExpression' ? d.init : null;
        const callee = call?.callee;
        const hook = callee?.type === 'Identifier' ? callee.name : callee?.type === 'MemberExpression' && callee.property?.type === 'Identifier' ? callee.property.name : '';
        if (!/^use(State|Reducer)$/.test(hook) || d.id?.type !== 'ArrayPattern') continue;
        const [v, set] = d.id.elements;
        if (v?.type !== 'Identifier' || set?.type !== 'Identifier' || !d.loc) continue;
        edits.push({ at: st.end, text: `;globalThis.__dsaStateName?.(${set.name}, ${JSON.stringify(v.name)}, ${JSON.stringify(`${rel}:${d.loc.start.line}`)});` });
      }
    }
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

// Straight after the element's name and any type arguments (`<Table<Row> …>`): an attribute between the two
// isn't JSX.
const afterName = (n: any): number => (n.typeArguments ?? n.typeParameters)?.end ?? n.name.end;

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
 * - Its providers: with scope "app", only the app's own (those above the element's file on the page, else
 *   above its shallowest tagged element); otherwise every context the live app provides at the deepest point near the element (the same
 *   file's elements if the page shows any, else the deepest tagged element), with the live values. That
 *   covers the providers the app's entry file wraps it in (a query client, a theme, a router, a store) and
 *   ones deeper in the tree; then any other the page provides elsewhere, so a component drawn on another
 *   page still gets its store. The live app is hidden, not removed, so the next mount can read it again.
 * - Its props: plain values from the crawler; {"__dsa":"fn"} becomes a function that does nothing, and
 *   {"__dsa":"set"} / {"__dsa":"map"} an empty Set / Map.
 *
 * Returns { ok, why, providers, threw }: why says, in plain words, what stopped it; threw is the error's
 * first line and the component that threw, when it failed to render.
 */
export const MOUNT_MODULE = `import { createElement, Component } from 'react';
import { createRoot } from 'react-dom/client';
class Guard extends Component {
  constructor(p) { super(p); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  // The error's first line, and the component that threw: the first one its component stack names.
  componentDidCatch(err, info) {
    const at = String((info && info.componentStack) || '').match(/(?:\\bat|\\bin) ([A-Z][\\w$]*)(?: \\((\\S+?)(?::\\d+){1,2}\\))?/);
    window.__dsaMountError = { message: String((err && err.message) || err).split('\\n')[0].slice(0, 200), component: at ? at[1] : '', src: at && at[2] ? at[2] : '' };
  }
  render() { return this.state.failed ? null : this.props.children; }
}
const noop = () => {};
const revive = (v) => Array.isArray(v) ? v.map(revive) : v && typeof v === 'object' ? (v.__dsa === 'fn' ? noop : v.__dsa === 'set' ? new Set() : v.__dsa === 'map' ? new Map() : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]))) : v;
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
// Every context the live app provides anywhere: the nearest element's first (innermost first), then any
// other the page's tagged elements sit under, so a component drawn away from its own page still gets them.
function contextsAll(file) {
  const out = contextsAt(nearest(file)), seen = new Set(out.map((c) => c.ctx));
  const all = Array.from(document.querySelectorAll('[data-dsa-src]')).filter((el) => !el.closest('#dsa-mount, #dsa-markup'));
  const step = Math.max(1, Math.ceil(all.length / 300));
  for (let i = 0; i < all.length; i += step) for (const c of contextsAt(all[i])) if (!seen.has(c.ctx)) { seen.add(c.ctx); out.push(c); }
  return out;
}
// The app's own providers only: those above the element's own file on the page, else those above the
// shallowest tagged element (what the entry file wraps the app in), not the ones a deep page adds (an open
// dialog's, a panel's), which can put a drawn component in a state that hides the element.
function contextsApp(file) {
  const all = Array.from(document.querySelectorAll('[data-dsa-src]')).filter((el) => !el.closest('#dsa-mount, #dsa-markup'));
  const same = file ? all.filter((el) => el.getAttribute('data-dsa-src').startsWith(file + ':')) : [];
  if (same.length) return contextsAt(nearest(file));
  const depth = (el) => { let d = 0; for (let x = el; x; x = x.parentElement) d++; return d; };
  return contextsAt(all.reduce((a, b) => (!a || depth(b) < depth(a) ? b : a), null));
}
function nearest(file) {
  const all = Array.from(document.querySelectorAll('[data-dsa-src]')).filter((el) => !el.closest('#dsa-mount, #dsa-markup'));
  const same = file ? all.filter((el) => el.getAttribute('data-dsa-src').startsWith(file + ':')) : [];
  const depth = (el) => { let d = 0; for (let x = el; x; x = x.parentElement) d++; return d; };
  return (same.length ? same : all).reduce((a, b) => (!a || depth(b) > depth(a) ? b : a), null);
}
// Why a module didn't load, in words: what the server answered for it, else the first import of it that failed.
async function whyNotLoaded(url, err) {
  // Vite answers an error as a page with the error in it: its message, else the text without tags.
  const message = (t) => { const m = t.match(/"message":\\s*"((?:[^"\\\\]|\\\\.)*)"/); if (m) { try { return JSON.parse('"' + m[1] + '"'); } catch {} } return t.replace(/<script[\\s\\S]*?<\\/script>|<style[\\s\\S]*?<\\/style>|<[^>]+>/g, ' '); };
  const answer = async (u) => { try { const r = await fetch(u, { headers: { accept: '*/*' } }); const t = await r.text(); return { status: r.status, text: r.ok ? t : message(t).trim().split('\\n')[0].slice(0, 140) }; } catch (e) { return { status: 0, text: String((e && e.message) || e).slice(0, 80) }; } };
  const said = (u, a) => u + ' answered ' + (a.status || 'nothing') + (a.text ? ' (' + a.text.replace(/\\s+/g, ' ').slice(0, 140) + ')' : '');
  const top = await answer(url);
  if (top.status !== 200) return said(url, top);
  const deps = [...new Set([...top.text.matchAll(/(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*)["'](\\/[^"']+)["']/g)].map((m) => m[1]))].slice(0, 60);
  for (const d of deps) { const a = await answer(d); if (a.status !== 200) return 'it loaded, but its import ' + said(d, a); }
  return err;
}
let root = null;
// Imported by the URL as given: Vite rewrites a dynamic import() here to add "?import", which loads a second
// copy of the module, with its own contexts, apart from the copy the app and its other files import.
const importAsApp = new Function('u', 'return import(u)');
// One component of a file, imported where this server serves it (the tagger knows its root and base), then
// from the crawler's guesses: { C } or { why }.
async function load(files, name, file) {
  let served = null;
  try { const r = await fetch('/@dsa/where?file=' + encodeURIComponent(file || '')); if (r.ok) served = await r.json(); } catch {}
  if (served && served.missing) return { why: 'its file is not on this server (' + served.missing + ')' };
  const tries = [...new Set([...(served && served.url ? [served.url] : []), ...[].concat(files)])];
  let mod, err = '', first = null;
  for (const f of tries) { try { mod = await importAsApp(f); break; } catch (e) { if (!first) { first = f; err = String((e && e.message) || e).slice(0, 160); } } }
  if (!mod) return { why: 'its file did not load: ' + (/fetch|loading|Importing a module/i.test(err) ? await whyNotLoaded(first, err) : err) };
  const local = (globalThis.__dsaLocal || {})[file] || {};
  const C = mod[name] || (mod.default && (name === 'default' || mod.default.name === name) ? mod.default : undefined) || local[name];
  return C ? { C } : { why: 'its component ' + name + ' is not in its file as built' };
}
window.__dsaMount = async (files, name, props, file, wraps, scope) => {
  window.__dsaMountError = null;
  const got = await load(files, name, file);
  if (!got.C) return { ok: false, why: got.why };
  const C = got.C;
  // Providers found in the source that the page doesn't have (useX needs XProvider): each wraps it, inside the borrowed ones.
  const extra = [];
  for (const w of [].concat(wraps || [])) {
    const p = await load(w.files, w.name, w.file);
    if (!p.C) return { ok: false, why: 'its provider ' + w.name + ' did not load: ' + p.why };
    // A bare context (no provider component in its file): its Provider, with the value the crawler shaped.
    extra.push(w.context ? { P: p.C.Provider || p.C, props: w.props || {} } : { P: p.C, props: w.props || {} });
  }
  const ctxs = scope === 'app' ? contextsApp(file) : contextsAll(file);
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
  for (const { P, props: pp } of extra) el = createElement(P, revive(pp), el);
  for (const { ctx, value } of ctxs) el = createElement(ctx.Provider || ctx, { value }, el);
  root = createRoot(host);
  root.render(createElement(Guard, null, el));
  await new Promise((r) => setTimeout(r, 400));
  const t = window.__dsaMountError;
  const n = ctxs.length + extra.length;
  return t ? { ok: false, why: 'its component failed to render: ' + t.message + (t.component && t.component !== name ? ' (in ' + t.component + ')' : ''), threw: t, providers: n } : { ok: true, providers: n };
};
`;

/**
 * The Vite plugin (Vite, React Router v7, Remix on Vite). Runs before other plugins, on the source as
 * written, so its lines and columns are the scanner's. Does nothing unless tagging is on.
 */
export function dsaTag(o: TagOptions = {}): { name: string; enforce: 'pre'; configResolved: (c: { root: string; base: string }) => void; configureServer: (server: any) => void; transformIndexHtml: () => { tag: string; children: string; injectTo: 'head-prepend' }[]; resolveId: (id: string) => string | null; load: (id: string) => string | null; transform: (code: string, id: string) => { code: string; map: null } | null } {
  const on = tagEnabled(o);
  let viteRoot = process.cwd(), base = '/';
  return {
    name: 'dsa:tag',
    enforce: 'pre',
    configResolved(c) { viteRoot = c.root; base = c.base || '/'; },
    // /@dsa/where?file=<tag path>: the URL this server serves that file at (its root and base applied), so
    // the crawler's mount imports it the way the app does. Before Vite's own handlers, so any base works.
    configureServer(server) {
      if (!on) return;
      server.middlewares.use('/@dsa/where', (req: any, res: any) => {
        const rel = new URL(req.url ?? '', 'http://x').searchParams.get('file') ?? '';
        const root = o.root ?? process.env.DSA_TAG_ROOT ?? findRoot(viteRoot);
        const file = root ? fileOfTag(rel, root, o.dir ?? process.env.DSA_TAG_DIR) : null;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(file ? { url: viteUrlOf(file, viteRoot, base) } : { missing: root ? `no ${rel} under the scan root` : 'the tagger found no scan root' }));
      });
      // POST /@dsa/ledger: the ledger runtime's records, one JSON line each, appended to DSA_LEDGER. Only
      // when that names a file: a dev server someone runs by hand records what they click through.
      server.middlewares.use('/@dsa/ledger', (req: any, res: any) => {
        const file = process.env.DSA_LEDGER;
        if (req.method !== 'POST' || !file) { res.statusCode = 204; res.end(); return; }
        let body = '';
        req.on('data', (c: Buffer) => { if (body.length < 4_000_000) body += c; });
        req.on('end', () => {
          try {
            const recs = JSON.parse(body);
            if (Array.isArray(recs) && recs.length) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n'); }
          } catch { /* not a batch of records */ }
          res.statusCode = 204; res.end();
        });
      });
    },
    // The ledger runtime, first in the page's head, so it sees React from its first commit.
    transformIndexHtml: () => (on ? [{ tag: 'script', children: (process.env.DSA_LEDGER ? 'window.__dsaLedgerPost = true;\n' : '') + LEDGER_RUNTIME, injectTo: 'head-prepend' as const }] : []),
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
