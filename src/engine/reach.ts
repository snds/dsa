import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import { readAliases, resolveSpecifier } from './modules.js';
import { walk } from './paths.js';
import { labelOf, visit, visitWithAncestors, gatesFrom, type Gate } from './scanners/features.js';
import { regionLabel, regionsOfAncestors, type Placement, type Region } from './placement.js';

/**
 * Reachability: can a person ever see this element, and what does it take?
 *
 *  - Import graph from the app's entry points (index.html scripts, Next app/pages). A file nothing
 *    reachable imports is unused code: delete it, don't migrate it.
 *  - Render gates from the AST ({open && …}, ternaries, `if (!open) return null`, Dialog/Sheet roots).
 *  - Triggers traced back from each gate: the state's setter → the handler that calls it → the
 *    element that handler is on, and its label ("Add Image"). When the gate is a prop, the trace
 *    continues at the parent that renders the component, up a few levels.
 *
 * The screenshot crawler replays the traced triggers; the review uses the same trace to say why
 * there's no picture when it still can't get there.
 */

/**
 * One thing to do to reveal an element: click (or double-click) a control, pick a value in it (`choose`: a
 * select or option list), or type into a field (`type`: a search box whose text the gate reads). `label` can
 * be empty (an icon button, a swatch): the crawler then finds it by its source line. `handed`: found
 * through a prop handed to another component (a toolbar's onAdd), so it may sit off the element's own files.
 */
export interface Step { label: string; event: 'click' | 'dblclick' | 'type' | 'choose'; file: string; line: number; /** Its column (from 1), so a control is told apart from its wrapper on the same line. */ col?: number | undefined; pos?: number | undefined; component: string; value?: string | undefined; handed?: boolean | undefined }
export interface Reach {
  status: 'unused' | 'gated' | 'page';
  /** Component chain from the app's root to the element's component (App › MaterialsDetailView › DetailChrome). */
  via?: string[] | undefined;
  /** Conditions between the page and the element, outermost first, with where they live. */
  gates: (Gate & { component: string; file: string })[];
  /** What to do to reveal it, outermost first. */
  steps: Step[];
  why: string;
  /** Regions the components above it render it inside (placement.ts), innermost first. */
  placement?: Placement | undefined;
  /** Saved-state keys the files on its chain read (localStorage, sessionStorage): clearing them shows what a first visit shows. */
  storage?: string[] | undefined;
  /** URL search parameters those files read (?q=): a value for one can reveal search results. */
  params?: string[] | undefined;
  /** What was looked for to reveal it, in plain words: each gate's state, its setter, and the control found (or not). */
  looked?: string[] | undefined;
}

const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const DESTRUCTIVE = /delete|remove|discard|archive|sign ?out|log ?out|reset|clear all|submit|save|send|publish|approve|reject|confirm|apply|done|replace/i;
/** Controls that hide or leave things: never a way to reveal one. */
const HIDES = /^(cancel|close|back|dismiss|×|x|clear|done)\b|^back to |\bclose\b|\bcancel\b/i;
const usable = (label: string) => !!label && label.length <= 40 && !DESTRUCTIVE.test(label) && !HIDES.test(label.trim());

export interface Graph {
  dir: string;
  ok: boolean;
  entries: string[];
  /** file → files that import it, and the reverse */
  importers: Map<string, Set<string>>;
  imports: Map<string, string[]>;
  /** reachable file → the file it was first reached from (null for entries) */
  reached: Map<string, string | null>;
  /** basenames of local specifiers that didn't resolve: a file by that name is never called unused */
  unresolved: Set<string>;
  info: Map<string, FileInfo | null>;
}

export function buildGraph(dir: string, exclude: string[] = [], extraAliases: Record<string, string> = {}): Graph {
  const aliases = readAliases(dir, extraAliases);
  const files = walk(dir, SRC_EXT, exclude);
  const importers = new Map<string, Set<string>>();
  const imports = new Map<string, string[]>();
  const unresolved = new Set<string>();
  const add = (from: string, to: string) => { (imports.get(from) ?? imports.set(from, []).get(from)!).push(to); (importers.get(to) ?? importers.set(to, new Set()).get(to)!).add(from); };
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const specs = new Set<string>();
    for (const re of [/(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]/g, /import\s*['"]([^'"]+)['"]/g, /import\(\s*['"`]([^'"`$]+)['"`]\s*\)/g, /require\(\s*['"]([^'"]+)['"]\s*\)/g, /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g]) {
      for (const m of src.matchAll(re)) specs.add(m[1]!);
    }
    for (const s of specs) {
      const local = s.startsWith('.') || aliases.some(([p]) => p && s.startsWith(p));
      if (!local) continue;
      const to = resolveSpecifier(f, s, aliases);
      if (to) add(f, to); else unresolved.add(path.basename(s).replace(/\.\w+$/, ''));
    }
    // import.meta.glob('./pages/*.tsx') — every match is reachable from here.
    for (const m of src.matchAll(/import\.meta\.glob\(\s*(\[[^\]]*\]|['"][^'"]+['"])/g)) {
      for (const g of m[1]!.match(/['"][^'"]+['"]/g) ?? []) {
        const pat = g.slice(1, -1);
        if (pat.startsWith('!')) continue;
        const abs = path.resolve(path.dirname(f), pat).split(path.sep).join('/');
        const re = new RegExp('^' + abs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*') + '$');
        for (const c of files) if (re.test(c.split(path.sep).join('/'))) add(f, c);
      }
    }
  }
  const entries = findEntries(dir, aliases, exclude);
  const reached = new Map<string, string | null>();
  const queue = entries.filter(e => fs.existsSync(e));
  for (const e of queue) reached.set(e, null);
  while (queue.length) {
    const f = queue.shift()!;
    for (const to of imports.get(f) ?? []) if (!reached.has(to)) { reached.set(to, f); queue.push(to); }
  }
  // No entry found (a library, an unknown setup): don't call anything unused.
  return { dir, ok: reached.size > 0, entries, importers, imports, reached, unresolved, info: new Map() };
}

function findEntries(dir: string, aliases: [string, string][], exclude: string[] = []): string[] {
  const out: string[] = [];
  // Every HTML page in the app (multi-page apps keep labs and demos in their own pages).
  // Not the scan excludes: a folder left out of the scan (labs/) can still hold real pages.
  const html = htmlPages(dir);
  for (const h of html) {
    const text = fs.readFileSync(h, 'utf8');
    for (const m of text.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)) {
      if (/^https?:/.test(m[1]!)) continue;
      const p = m[1]!.startsWith('/') ? path.join(dir, m[1]!) : path.resolve(path.dirname(h), m[1]!);
      const r = resolveSpecifier(h, p, aliases) ?? (fs.existsSync(p) ? p : null);
      if (r) out.push(r);
    }
  }
  // Next.js: every page, layout, and route under app/ or pages/ is an entry.
  for (const d of ['app', 'pages', 'src/app', 'src/pages']) {
    const base = path.join(dir, d);
    if (!fs.existsSync(path.join(dir, 'next.config.js')) && !fs.existsSync(path.join(dir, 'next.config.mjs')) && !fs.existsSync(path.join(dir, 'next.config.ts'))) break;
    if (fs.existsSync(base)) out.push(...walk(base, SRC_EXT).filter(f => d.endsWith('pages') || /\/(page|layout|template|route|loading|error|not-found)\.[jt]sx?$/.test(f)));
  }
  return [...new Set(out)];
}

/** HTML pages that load the app's own scripts (vendor copies, builds, and node_modules skipped). */
export function htmlPages(dir: string, exclude: string[] = []): string[] {
  return walk(dir, new Set(['.html']), exclude).filter(f => !/[\\/](vendor|public|static|storybook-static|coverage)[\\/]/.test(path.relative(dir, f)) && /<script[^>]*type=["']module["'][^>]*src=["'](?!https?:)/.test(fs.readFileSync(f, 'utf8')));
}

/** Files that can never render: nothing reachable from an entry imports them. */
export function isUnused(g: Graph, file: string): boolean {
  if (!g.ok || g.reached.has(file)) return false;
  if (g.unresolved.has(path.basename(file).replace(/\.\w+$/, ''))) return false;
  return true;
}

// ---------------------------------------------------------------- per-file facts

interface Handler { label: string; event: Step['event']; line: number; col: number; pos: number; calls: Set<string>; component: string; tag: string; /** Children with a literal value (a tab, a toggle item, an option): onValueChange={setMode} picks one. */ options?: { value: string; line: number; col: number; pos: number; label: string }[] }
interface Usage { name: string; line: number; props: Map<string, { text: string; ids: string[] }>; gates: Gate[]; component: string; regions: Region[] }
interface Comp { name: string; start: number; end: number; props: Set<string> }
interface FileInfo { setters: Map<string, string>; fnCalls: Map<string, Set<string>>; handlers: Handler[]; usages: Usage[]; comps: Comp[]; fns: { name: string; start: number; end: number }[]; defaultExport?: string | undefined; storage: Set<string>; params: Set<string>;
  /** What a hook call is bound to (`const { modal } = useDetailImages()` → modal), by hook, with where. */
  hookBinds: { hook: string; names: string[]; pos: number }[];
  /** A value rendered as JSX (`{modal}`, `{images.modal}`): its names and the conditions around it. */
  renders: { names: string[]; pos: number; gates: Gate[] }[] }

function fileInfo(g: Graph, file: string): FileInfo | null {
  if (g.info.has(file)) return g.info.get(file)!;
  let src: string, ast: any;
  try { src = fs.readFileSync(file, 'utf8'); ast = babelParse(src, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'typescript'] }); } catch { g.info.set(file, null); return null; }
  const fi: FileInfo = { setters: new Map(), fnCalls: new Map(), handlers: [], usages: [], comps: [], fns: [], storage: new Set(), params: new Set(), hookBinds: [], renders: [] };
  // setOpen(false) / setEditor(null) hide things: recorded as off:setOpen, not as a way to open.
  const off = (x: any) => { const a = x.arguments?.[0]; return a && ((a.type === 'BooleanLiteral' && !a.value) || a.type === 'NullLiteral' || (a.type === 'Identifier' && a.name === 'undefined')); };
  // setTab('media') is also recorded as setTab:media, so a gate `tab === 'media'` traces to the control that picks it.
  const lit = (x: any) => { const a = x.arguments?.[0]; return a?.type === 'StringLiteral' || a?.type === 'NumericLiteral' ? String(a.value) : null; };
  const callees = (n: any) => { const s = new Set<string>(); visit(n, (x: any) => { if (x.type === 'CallExpression') { if (x.callee.type === 'Identifier') { s.add(off(x) ? 'off:' + x.callee.name : x.callee.name); if (lit(x) != null) s.add(`${x.callee.name}:${lit(x)}`); } else if (x.callee.type === 'MemberExpression' && x.callee.property?.type === 'Identifier') s.add(x.callee.property.name); } if (x.type === 'Identifier') s.add('ref:' + x.name); }); return s; };
  // The innermost named function: a component, or a helper/hook (followed to its caller later).
  const compAt = (pos: number) => fi.fns.filter(c => c.start <= pos && pos <= c.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]?.name ?? '';
  visitWithAncestors(ast.program, (n: any, anc: any[]) => {
    // const [open, setOpen] = useState(…)
    if (n.type === 'VariableDeclarator' && n.id?.type === 'ArrayPattern' && n.init?.type === 'CallExpression' && /use(State|Reducer)$/.test(n.init.callee?.name ?? n.init.callee?.property?.name ?? '')) {
      const [v, set] = n.id.elements;
      if (v?.type === 'Identifier' && set?.type === 'Identifier') fi.setters.set(v.name, set.name);
    }
    // const { modal } = useDetailImages() / const images = useDetailImages(): what a hook's result is bound to.
    if (n.type === 'VariableDeclarator' && n.init?.type === 'CallExpression' && /^use[A-Z]/.test(n.init.callee?.name ?? '')) {
      const names = n.id?.type === 'Identifier' ? [n.id.name] : n.id?.type === 'ObjectPattern' ? n.id.properties.map((p: any) => p.value?.name ?? p.key?.name).filter(Boolean) : n.id?.type === 'ArrayPattern' ? n.id.elements.map((e: any) => e?.name).filter(Boolean) : [];
      if (names.length) fi.hookBinds.push({ hook: n.init.callee.name, names, pos: n.start });
    }
    // {modal} / {images.modal} in JSX, and the conditions around it.
    if (n.type === 'JSXExpressionContainer' && (n.expression?.type === 'Identifier' || n.expression?.type === 'MemberExpression')) {
      let e = n.expression; const names: string[] = [];
      while (e?.type === 'MemberExpression') { if (e.property?.name) names.push(e.property.name); e = e.object; }
      if (e?.type === 'Identifier') { names.push(e.name); fi.renders.push({ names, pos: n.start, gates: gatesFrom(anc, n, src) }); }
    }
    // Components: Capitalized functions; their destructured props.
    const fn = n.type === 'FunctionDeclaration' ? n : n.type === 'VariableDeclarator' && /Function|Arrow/.test(n.init?.type ?? '') ? n.init : n.type === 'VariableDeclarator' && n.init?.type === 'CallExpression' && /Function|Arrow/.test(n.init.arguments?.[0]?.type ?? '') ? n.init.arguments[0] : null;
    const name = n.type === 'FunctionDeclaration' ? n.id?.name : n.id?.name;
    if (fn && name) {
      if (/^[A-Z]/.test(name)) {
        const props = new Set<string>();
        const p = fn.params?.[0];
        if (p?.type === 'ObjectPattern') for (const pr of p.properties) { if (pr.key?.name) props.add(pr.key.name); }
        else if (p?.type === 'Identifier') props.add('props');
        fi.comps.push({ name, start: n.start, end: n.end, props });
      }
      fi.fnCalls.set(name, callees(fn.body));
      fi.fns.push({ name, start: n.start, end: n.end });
    }
    if (n.type === 'ExportDefaultDeclaration') fi.defaultExport = n.declaration?.id?.name ?? n.declaration?.name;
    // Saved state (localStorage.getItem('setupDone'), useLocalStorage('k', …)) and URL search state (searchParams.get('q')).
    if (n.type === 'CallExpression') {
      const a0 = n.arguments?.[0]?.type === 'StringLiteral' ? n.arguments[0].value : null;
      const c = n.callee;
      if (a0 && c.type === 'MemberExpression' && /^(get|set|remove)Item$/.test(c.property?.name ?? '') && /(local|session)Storage$/.test(c.object?.name ?? c.object?.property?.name ?? '')) fi.storage.add(a0);
      else if (a0 && c.type === 'Identifier' && /^use(Local|Session)Storage|^usePersist/.test(c.name)) fi.storage.add(a0);
      else if (a0 && c.type === 'MemberExpression' && c.property?.name === 'get' && (/search|param|query/i.test(c.object?.name ?? c.object?.property?.name ?? '') || (c.object?.type === 'NewExpression' && c.object.callee?.name === 'URLSearchParams'))) fi.params.add(a0);
      else if (a0 && c.type === 'Identifier' && /^use(QueryState|SearchParam)/.test(c.name)) fi.params.add(a0);
    }
    if (n.type === 'JSXElement') {
      const open = n.openingElement;
      const tag = open.name.type === 'JSXIdentifier' ? open.name.name : open.name.type === 'JSXMemberExpression' ? open.name.property.name : '';
      for (const a of open.attributes) {
        const k = a.name?.name;
        // Clicks, and the change events that set state: a tab list, a toggle group, a dialog's open, a checkbox, a field.
        if (typeof k !== 'string' || !/^on(Click|DoubleClick|Select|PointerDown|MouseDown|CheckedChange|ValueChange|OpenChange|PressedChange|Change|Input|Toggle)$/.test(k) || !a.value?.expression) continue;
        const field = /^on(Change|Input)$/.test(k) && (/^(input|textarea)$/.test(tag) || /Input|Search|Field/.test(tag)) && !/checkbox|radio/.test(attrText(open, 'type'));
        const choice = tag === 'select' || k === 'onValueChange';
        // Children with a literal value: the tab, toggle item or option that onValueChange={setMode} picks.
        const options: Handler['options'] = [];
        if (choice) visit(n, (x: any) => { if (x !== n && x.type === 'JSXElement') { const v = attrText(x.openingElement, 'value'); if (v) options.push({ value: v, line: x.loc?.start.line ?? 0, col: (x.loc?.start.column ?? 0) + 1, pos: x.start, label: labelOf(x) }); } });
        fi.handlers.push({ label: labelOf(n), event: k === 'onDoubleClick' ? 'dblclick' : field ? 'type' : tag === 'select' ? 'choose' : 'click', line: n.loc?.start.line ?? 0, col: (n.loc?.start.column ?? 0) + 1, pos: n.start, calls: callees(a.value.expression), component: '', tag, ...(options.length ? { options } : {}) });
      }
      if (/^[A-Z]/.test(tag)) {
        const props = new Map<string, { text: string; ids: string[] }>();
        for (const a of open.attributes) {
          if (typeof a.name?.name !== 'string') continue;
          const e = a.value?.expression ?? a.value;
          const ids: string[] = [];
          if (e) visit(e, (x: any) => { if (x.type === 'Identifier') ids.push(x.name); if (x.type === 'MemberExpression' && x.property?.type === 'Identifier') ids.push(x.property.name); });
          props.set(a.name.name, { text: e ? src.slice(e.start, e.end).replace(/\s+/g, ' ').slice(0, 60) : 'true', ids });
        }
        fi.usages.push({ name: tag, line: n.loc?.start.line ?? 0, props, gates: gatesFrom(anc, n, src), component: '', regions: regionsOfAncestors(anc) });
      }
    }
  });
  const posOf = (line: number) => { let p = 0; for (let i = 1; i < line; i++) p = src.indexOf('\n', p) + 1; return p; };
  for (const h of fi.handlers) h.component = compAt(posOf(h.line));
  for (const u of fi.usages) u.component = compAt(posOf(u.line));
  g.info.set(file, fi);
  return fi;
}

/** Everything a handler ends up calling, through local functions (two levels). */
function expand(fi: FileInfo, calls: Set<string>): Set<string> {
  const out = new Set(calls);
  for (let d = 0; d < 2; d++) for (const c of [...out]) { const k = c.replace(/^ref:/, ''); for (const x of fi.fnCalls.get(k) ?? []) out.add(x); }
  return out;
}

// ---------------------------------------------------------------- tracing

export function reachFor(g: Graph, file: string, line: number, ownGates: Gate[]): Reach {
  if (isUnused(g, file)) {
    return { status: 'unused', gates: [], steps: [], why: `Never rendered: nothing reachable from the app's entry (${g.entries.map(e => path.relative(g.dir, e)).join(', ')}) imports ${path.basename(file)}.` };
  }
  // 1. Walk up: the element's component, where it's rendered, and the conditions at each level.
  const levels: { file: string; comp: string; gates: Gate[] }[] = [];
  let f = file, local = ownGates, comp = '';
  const fi0 = fileInfo(g, file);
  // The innermost named function: a component, or a render helper / hook (cellFor, useDetailImages)
  // whose JSX shows up wherever the component that calls it renders.
  if (fi0) { let p = 0; const src = fs.readFileSync(file, 'utf8'); for (let i = 1; i < line; i++) p = src.indexOf('\n', p) + 1; comp = fi0.fns.filter(c => c.start <= p && p <= c.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]?.name ?? ''; }
  const seen = new Set<string>();
  const placed: Placement = { regions: [], from: [] };
  for (let depth = 0; depth < 6 && f && !seen.has(f + comp); depth++) {
    seen.add(f + comp);
    const fi = fileInfo(g, f);
    if (!fi) break;
    levels.push({ file: f, comp, gates: local });
    const c = fi.comps.find(x => x.name === comp);
    const parents = [...(g.importers.get(f) ?? []), f];
    let next: { file: string; usage: Usage } | null = null;
    for (const pf of parents) {
      const pi = fileInfo(g, pf);
      const us = pi?.usages.filter(u => u.name === comp && u.component !== comp) ?? [];
      // Prefer a usage with no gates (the element is plainly on a page there).
      const pick = us.find(u => !u.gates.length && !propGated(c, u)) ?? us[0];
      if (pick && (!next || (next.usage.gates.length && !pick.gates.length))) next = { file: pf, usage: pick };
    }
    // A helper or hook isn't rendered as <Tag>: follow it to the component that calls it (same file
    // first, then files that import this one). Its JSX renders wherever that component renders it.
    if (!next && comp && (!c || !/^[A-Z]/.test(comp))) {
      for (const pf of [f, ...(g.importers.get(f) ?? [])]) {
        const pi = fileInfo(g, pf);
        const caller = pi?.comps.find(x => x.name !== comp && (pi.fnCalls.get(x.name)?.has(comp) || pi.fnCalls.get(x.name)?.has('ref:' + comp)));
        if (caller) {
          // A hook's JSX shows where the caller renders what the hook returned: the conditions around that.
          const inCaller = (p: number) => caller.start <= p && p <= caller.end;
          const bound = new Set(pi!.hookBinds.filter(b => b.hook === comp && inCaller(b.pos)).flatMap(b => b.names));
          const at = bound.size ? pi!.renders.find(r => inCaller(r.pos) && r.names.some(x => bound.has(x))) : undefined;
          local = at?.gates ?? []; f = pf; comp = caller.name; break;
        }
      }
      if (levels[levels.length - 1]!.comp !== comp) continue;
    }
    if (!next) break;
    // A prop that the component's own gates read becomes a condition at the parent.
    const propGates: Gate[] = [];
    if (c) for (const gt of local) for (const id of gt.ids) {
      const v = c.props.has(id) ? next.usage.props.get(id) : undefined;
      if (v && !/^(true|false)$/.test(v.text)) propGates.push({ kind: 'cond', test: `${id}={${v.text}}`, negated: false, ids: v.ids });
    }
    local = [...next.usage.gates, ...propGates];
    // Placement: the JSX around <comp/> in its parent (an <aside>, a nav, a Dialog…).
    const fresh = next.usage.regions.filter(r => !placed.regions.includes(r));
    if (fresh.length) {
      placed.regions.push(...fresh);
      placed.from.push(`${next.usage.component || path.basename(next.file).replace(/\.\w+$/, '')} (${path.basename(next.file)}) renders ${comp || 'it'} inside ${fresh.map(regionLabel).join(' within ')}`);
    }
    f = next.file; comp = next.usage.component;
  }
  // 2. Triggers, per level, outermost first. Only for UI flags near the element (editing, open,
  //    !!editor), not data conditions (items.length > 1), within five levels, and only
  //    controls that live along the element's own chain of files (not a notification bell elsewhere
  //    that happens to navigate there too).
  const chainFiles = new Set(levels.map(l => l.file));
  const below = (i: number) => new Set(levels.slice(0, i).map(l => l.comp));
  const steps: Step[] = [];
  const gates: Reach['gates'] = [];
  const looked: string[] = [];
  levels.forEach((lv, i) => {
    const fi = fileInfo(g, lv.file)!;
    for (const gt of lv.gates) gates.push({ ...gt, component: lv.comp, file: lv.file });
    const mine: Step[] = [];
    for (const gt of [...lv.gates].reverse()) {
      if (i >= 5) continue;
      if (gt.kind === 'overlay' && gt.trigger && usable(gt.trigger)) { mine.push({ label: gt.trigger, event: 'click', file: lv.file, line, component: lv.comp }); continue; }
      // Pure UI flags trace whole; in a mixed test (`viewMode === 'table' && draftOpen`) only the
      // state used as a bare flag (`draftOpen`) is traced, never the comparisons.
      const test = gt.test.replace(/^\w+=\{(.*)\}$/, '$1');
      const ids = gt.kind === 'overlay' || FLAG.test(test) ? gt.ids : gt.ids.filter(id => new RegExp(`(^|&&|\\|\\||!|\\()\\s*${id}\\s*($|&&|\\|\\||\\))`).test(test));
      const setters = new Set(ids.map(id => fi.setters.get(id)).filter(s => s && fanIn(fi, s) <= 4) as string[]);
      // Content swaps: `tab === 'media'` is shown by whatever calls setTab('media') (a tab, a segment, a menu item).
      if (!gt.negated) for (const [, a, b, c, d] of test.matchAll(/\b([A-Za-z_$][\w$]*)\s*===?\s*['"]([^'"]{1,40})['"]|['"]([^'"]{1,40})['"]\s*===?\s*([A-Za-z_$][\w$]*)\b/g)) {
        const s = fi.setters.get((a ?? d)!);
        if (s) setters.add(`${s}:${b ?? c}`);
      }
      if (!setters.size) { if (gt.kind !== 'overlay') looked.push(`“${test.slice(0, 40)}”: no state setter for ${ids.length ? ids.join(', ') : 'it'} in ${lv.comp || path.basename(lv.file)} (it may come from data or the URL)`); continue; }
      // Not a control inside what it's supposed to open (that one closes or re-targets it).
      const inside = below(i);
      // Not a control inside what the gate guards either (a Save button in the draft row it closes).
      const guarded = (s: Step) => s.file === lv.file && s.pos != null && lv.gates.some(x => x.at && s.pos! >= x.at[0] && s.pos! <= x.at[1]);
      const got = triggersFor(g, lv.file, setters, s => (chainFiles.has(s.file) || Boolean(s.handed)) && !inside.has(s.component) && !guarded(s)).slice(0, 1);
      looked.push(`${[...setters].join(', ')} for “${test.slice(0, 40)}”: ${got.length ? got.map(s => `${s.event === 'type' ? 'typing in' : s.event === 'choose' ? `choosing “${s.value}” in` : 'clicking'} ${s.label ? `“${s.label}”` : 'an unlabelled control'} at ${path.basename(s.file)}:${s.line}`).join(', ') : 'no control found that calls it'}`);
      mine.push(...got);
    }
    steps.unshift(...mine);
  });
  const near = dedupe(steps).slice(-3);
  // gates were collected innermost first; the Reach lists them outermost first.
  const real = gates.filter(x => x.kind !== 'overlay' || x.trigger || x.test).reverse();
  const chain = levels.map(l => l.comp || path.basename(l.file).replace(/\.\w+$/, '')).reverse();
  // Saved state and URL search state the files on its chain read.
  const storage = [...new Set(levels.flatMap(l => [...(fileInfo(g, l.file)?.storage ?? [])]))].slice(0, 12);
  const params = [...new Set(levels.flatMap(l => [...(fileInfo(g, l.file)?.params ?? [])]))].slice(0, 6);
  return { status: real.length ? 'gated' : 'page', via: chain, gates: real, steps: near, why: describeReach(real, near, chain), placement: placed.regions.length ? placed : undefined, ...(storage.length ? { storage } : {}), ...(params.length ? { params } : {}), ...(looked.length ? { looked } : {}) };
}

/** A UI flag: identifiers, member access, negation, && between them. No comparisons, counts, or calls. */
const FLAG = /^[!\s\w.?&|]+$/;

/**
 * The labeled controls that end up calling any of `names` (a state setter, or functions wrapping it):
 * handlers in this file; then, when the call is handed on (a hook returns openAdd, a parent passes
 * onAddImage={media.openAdd}), the components it's handed to and the files that use the hook.
 */
function triggersFor(g: Graph, file: string, names: Set<string>, allow: (s: Step) => boolean = () => true, depth = 0, seen = new Set<string>(), handed = false): Step[] {
  const key = file + '|' + [...names].sort().join(',');
  if (depth > 3 || seen.has(key)) return [];
  seen.add(key);
  const fi = fileInfo(g, file);
  if (!fi) return [];
  // Local functions that call any of the names count as the names too.
  const all = new Set(names);
  for (let d = 0; d < 3; d++) for (const [fn, calls] of fi.fnCalls) if (!all.has(fn) && [...calls].some(c => all.has(c.replace(/^ref:/, '')))) all.add(fn);
  // A control with no words (an icon button, a swatch) still counts: the crawler finds it by its source line.
  const ok = (l: string) => !l || usable(l);
  const hits = fi.handlers.filter(h => ok(h.label) && [...expand(fi, h.calls)].some(c => all.has(c.replace(/^ref:/, ''))));
  const found: Step[] = hits.map(h => ({ label: h.label, event: h.event, file, line: h.line, col: h.col, pos: h.pos, component: h.component, ...(handed ? { handed } : {}) }));
  // setMode:edit wanted, and a tab list with onValueChange={setMode}: the child whose value is 'edit'.
  for (const want of all) {
    const m = want.match(/^([^:]+):(.+)$/);
    if (!m || m[1]!.startsWith('off')) continue;
    for (const h of fi.handlers) {
      if (!h.options || ![...expand(fi, h.calls)].some(c => c.replace(/^ref:/, '') === m[1])) continue;
      const o = h.options.find(x => x.value === m[2]);
      if (o && ok(o.label)) found.push({ label: o.label, event: h.tag === 'select' ? 'choose' : 'click', file, line: o.line, col: o.col, pos: o.pos, component: h.component, ...(h.tag === 'select' ? { value: o.value } : {}), ...(handed ? { handed } : {}) });
    }
  }
  // Only controls the caller can use (on the element's own chain of files, or handed a prop from it) count toward the caps below.
  const out: Step[] = found.filter(allow).slice(0, 3);
  // Handed to a child as a prop: follow the prop name into the component that receives it.
  for (const u of fi.usages) {
    for (const [prop, v] of u.props) {
      if (!/^on[A-Z]/.test(prop) || !v.ids.some(i => all.has(i))) continue;
      const childFile = [file, ...(g.imports.get(file) ?? [])].find(cf => fileInfo(g, cf)?.comps.some(c => c.name === u.name));
      if (childFile) out.push(...triggersFor(g, childFile, new Set([prop]), allow, depth + 1, seen, true));
      if (out.length >= 6) return dedupe(out);
    }
  }
  // Returned from a hook or exported: callers in the files that import this one use the same names.
  for (const imp of g.importers.get(file) ?? []) {
    if (out.length >= 6) break;
    out.push(...triggersFor(g, imp, all, allow, depth + 1, seen, handed));
  }
  return dedupe(out);
}

/** How many handlers and functions in the file turn this setter on. */
function fanIn(fi: FileInfo, setter: string) {
  let n = 0;
  for (const h of fi.handlers) if (h.calls.has(setter)) n++;
  for (const calls of fi.fnCalls.values()) if (calls.has(setter)) n++;
  return n;
}

function propGated(c: Comp | undefined, u: Usage) { return !!c && [...u.props.keys()].some(k => /^(open|isOpen|show|visible|expanded)$/.test(k) && u.props.get(k)!.text !== 'true'); }
const tidy = (l: string) => l.replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
// The same control once: by its words and its place (two "Edit" buttons are two controls).
const dedupe = (s: Step[]) => s.map(x => ({ ...x, label: tidy(x.label) })).filter(x => x.label || x.line).filter((x, i, a) => a.findIndex(y => y.label === x.label && y.event === x.event && y.file === x.file && y.line === x.line) === i);
const attrText = (open: any, k: string): string => { const a = open.attributes?.find((x: any) => x.name?.name === k); return a?.value?.type === 'StringLiteral' ? a.value.value : a?.value?.expression?.type === 'StringLiteral' ? a.value.expression.value : ''; };

function describeReach(gates: Reach['gates'], steps: Step[], chain: string[]): string {
  const path = chain.length > 1 ? ` (${chain.join(' › ')})` : '';
  if (!gates.length) return `Rendered directly on a page${path}.`;
  const g = gates[gates.length - 1]!;
  const inner = g.kind === 'overlay' ? `inside a ${g.overlay}${g.component ? ` in ${g.component}` : ''}` : `only when ${g.negated ? 'not ' : ''}\`${g.test}\`${g.component ? ` in ${g.component}` : ''}`;
  // A label read from the code loses the values it fills in ("Message on {date}: Open request {id} -"):
  // shown as "…" so it reads as words with gaps, not as garbled text.
  const words = (l: string) => l.replace(/\s+([:;,])/g, ' …$1').replace(/\s*[-–—:;,]+$/, ' …').replace(/^[-–—:;,]+\s*/, '… ').replace(/(…\s*){2,}/g, '… ').trim();
  const name = (s: Step) => { const l = words(s.label); return l ? `“${l.length > 32 ? l.slice(0, 30) + '…' : l}”` : 'an unlabelled control'; };
  const how = steps.length ? `, opened by ${steps.map(s => `${s.event === 'type' ? 'typing in ' : s.event === 'choose' ? `choosing “${s.value}” in ` : ''}${name(s)}${s.event === 'dblclick' ? ' (double-click)' : ''}${s.component ? ` in ${s.component}` : ''}`).join(' then ')}` : '';
  const outer = gates.length > 1 ? `; ${gates.length - 1} more condition${gates.length > 2 ? 's' : ''} above it` : '';
  return `Renders ${inner}${how}${outer}${path}.`;
}
