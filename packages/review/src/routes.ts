import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import { walk, type Graph } from '@snds/dsa/engine';
import { routeConfig } from './apps.js';

/**
 * Which route renders which file, read from the source with no config: `<Route path element={<X/>}>`,
 * route objects (`{ path, element | Component | lazy }`, nested through `children`), React Router's
 * route config (`route('orders/:id', 'routes/order.tsx')`) and file-based routes (Next's pages/ and app/).
 * With the scan's import graph, every element gets the routes whose component renders its file, so the
 * crawler opens those first and can say "no route reaches this file" when none does.
 */
export interface RouteFile { path: string; file: string }

const SRC = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

export function routeFiles(dir: string, exclude: string[] = []): RouteFile[] {
  const files = walk(dir, SRC, exclude, true).slice(0, 6000);
  const out: RouteFile[] = [];
  const add = (p: string, file: string | null | undefined) => { if (file) out.push({ path: norm(p), file: path.resolve(file) }); };
  // React Router's route config: files are relative to the folder of routes.ts.
  const rc = routeConfig(dir, files);
  if (rc.file) for (const [p, f] of rc.files) add(p, resolveFile(path.dirname(rc.file), './' + f.replace(/^\.\//, '')));
  // Next.js: pages/x.tsx is /x, app/x/page.tsx is /x ([id] is :id).
  for (const base of ['pages', 'src/pages', 'app', 'src/app']) {
    const root = path.join(dir, base);
    if (!fs.existsSync(root) || (base.endsWith('app') && rc.file)) continue;
    for (const f of walk(root, SRC, exclude, true)) {
      const rel = path.relative(root, f).split(path.sep).join('/').replace(/\.[jt]sx?$|\.mjs$/, '');
      if (base.endsWith('pages')) { if (!/^(_app|_document|api\/)/.test(rel)) add('/' + rel.replace(/(^|\/)index$/, ''), f); }
      else if (/(^|\/)page$/.test(rel)) add('/' + rel.replace(/(^|\/)page$/, '').replace(/\([^)]*\)\/?/g, ''), f);
    }
  }
  for (const f of files) {
    let src: string;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!/\bpath\b/.test(src) || !/Route|Component|element|lazy/.test(src)) continue;
    let ast: any;
    try { ast = babelParse(src, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'typescript', 'decorators-legacy'] }); } catch { continue; }
    const imports = importsOf(ast, f);
    walkRoutes(ast.program, '', (p, comp, lazy) => add(p, lazy ? resolveFile(path.dirname(f), lazy) : comp ? imports.get(comp) ?? (definedIn(ast, comp) ? f : null) : null));
  }
  const seen = new Set<string>();
  return out.filter(r => { const k = r.path + '\0' + r.file; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Every file that leads to `file` through imports (it included), up to 12 steps. */
export function ancestorsOf(g: Graph, file: string): Set<string> {
  const out = new Set([path.resolve(file)]);
  let frontier = [...out];
  for (let d = 0; d < 12 && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier) for (const p of g.importers.get(f) ?? []) if (!out.has(p)) { out.add(p); next.push(p); }
    frontier = next;
  }
  return out;
}

/** The routes whose component renders this file. */
export function routesReaching(routes: RouteFile[], g: Graph, file: string): string[] {
  const up = ancestorsOf(g, file);
  return [...new Set(routes.filter(r => up.has(r.file)).map(r => r.path))];
}

/** A route that needs a value to open (`/orders/:id`, `/files/*`). */
export const needsValue = (p: string) => /(^|\/)(:|\*)|\[/.test(p);

/** A pattern as a test for a path: `/orders/:id` matches /orders/1042, not /orders or /orders/1042/edit. */
export function patternTest(p: string): RegExp {
  const parts = p.replace(/^#/, '').split('/').map(s => (s.startsWith(':') ? (s.endsWith('?') ? '(?:[^/]+)?' : '[^/]+') : s === '*' ? '.+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return new RegExp('^' + parts.join('/').replace(/\/\(\?:\[\^\/\]\+\)\?/g, '(?:/[^/]+)?') + '/?$');
}

const norm = (p: string) => ('/' + p.replace(/\[\.\.\.(\w+)\]/g, '*').replace(/\[(\w+)\]/g, ':$1')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
const join = (a: string, b: string) => (b.startsWith('/') ? b : `${a.replace(/\/$/, '')}/${b}`);

function walkRoutes(node: any, base: string, on: (p: string, comp: string | null, lazyFile: string | null) => void) {
  if (!node || typeof node.type !== 'string') return;
  let here = base;
  if (node.type === 'JSXElement' && /Route$/.test(nameOf(node.openingElement.name) ?? '')) {
    const attr = (k: string) => node.openingElement.attributes.find((a: any) => a.type === 'JSXAttribute' && a.name?.name === k)?.value;
    const p = strOf(attr('path'));
    if (p != null) {
      here = join(base, p);
      const el = attr('element');
      const comp = el?.type === 'JSXExpressionContainer' && el.expression.type === 'JSXElement' ? nameOf(el.expression.openingElement.name) : identOf(attr('Component') ?? attr('component'));
      on(here, comp, null);
    }
  } else if (node.type === 'ObjectExpression') {
    const prop = (k: string) => node.properties.find((x: any) => x.type === 'ObjectProperty' && (x.key.name === k || x.key.value === k))?.value;
    const p = strOf(prop('path'));
    if (p != null) {
      here = join(base, p);
      const el = prop('element'), comp = prop('Component') ?? prop('component'), lz = prop('lazy');
      const lazyFile = lz ? importIn(lz) : null;
      on(here, el?.type === 'JSXElement' ? nameOf(el.openingElement.name) : comp?.type === 'Identifier' ? comp.name : null, lazyFile);
    }
  }
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key.endsWith('Comments') || key === 'extra') continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) walkRoutes(c, here, on);
    else if (v && typeof v === 'object' && typeof v.type === 'string') walkRoutes(v, here, on);
  }
}

const nameOf = (n: any): string | null => (n?.type === 'JSXIdentifier' ? n.name : n?.type === 'JSXMemberExpression' ? n.property.name : null);
const strOf = (v: any): string | null => (!v ? null : v.type === 'StringLiteral' ? v.value : v.type === 'JSXExpressionContainer' ? strOf(v.expression) : v.type === 'TemplateLiteral' && !v.expressions.length ? v.quasis[0].value.cooked : null);
const identOf = (v: any): string | null => (v?.type === 'JSXExpressionContainer' && v.expression.type === 'Identifier' ? v.expression.name : null);

/** The module a lazy route loads: `lazy: () => import('./x')`. */
function importIn(n: any): string | null {
  let found: string | null = null;
  const look = (x: any) => {
    if (found || !x || typeof x.type !== 'string') return;
    // import('./x'): an ImportExpression in Babel 8, a call on Import before it.
    if (x.type === 'ImportExpression' && x.source?.type === 'StringLiteral') { found = x.source.value; return; }
    if (x.type === 'CallExpression' && x.callee.type === 'Import' && x.arguments[0]?.type === 'StringLiteral') { found = x.arguments[0].value; return; }
    for (const k in x) { if (k === 'loc') continue; const v = x[k]; if (Array.isArray(v)) v.forEach(look); else if (v && typeof v === 'object') look(v); }
  };
  look(n);
  return found;
}

/** Local names to the files they come from: imports, and `const X = lazy(() => import('./x'))`. */
function importsOf(ast: any, file: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = path.dirname(file);
  for (const s of ast.program.body) {
    if (s.type === 'ImportDeclaration' && s.source.value.startsWith('.')) {
      const f = resolveFile(dir, s.source.value);
      if (f) for (const sp of s.specifiers) out.set(sp.local.name, f);
    }
    const decls = s.type === 'VariableDeclaration' ? s.declarations : s.type === 'ExportNamedDeclaration' && s.declaration?.type === 'VariableDeclaration' ? s.declaration.declarations : [];
    for (const d of decls) {
      const lz = d.init && d.id?.type === 'Identifier' ? importIn(d.init) : null;
      if (lz) { const f = resolveFile(dir, lz); if (f) out.set(d.id.name, f); }
    }
  }
  return out;
}

const definedIn = (ast: any, name: string) => ast.program.body.some((s: any) => {
  const d = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s;
  return (d?.type === 'FunctionDeclaration' && d.id?.name === name) || (d?.type === 'VariableDeclaration' && d.declarations.some((x: any) => x.id?.name === name));
});

function resolveFile(dir: string, spec: string): string | null {
  const base = path.resolve(dir, spec);
  for (const c of [base, ...[...SRC].map(e => base + e), ...[...SRC].map(e => path.join(base, 'index' + e))]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}
