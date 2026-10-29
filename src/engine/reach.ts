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

export interface Step { label: string; event: 'click' | 'dblclick'; file: string; line: number; pos?: number | undefined; component: string }
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

interface Handler { label: string; event: 'click' | 'dblclick'; line: number; pos: number; calls: Set<string>; component: string; tag: string }
interface Usage { name: string; line: number; props: Map<string, { text: string; ids: string[] }>; gates: Gate[]; component: string; regions: Region[] }
interface Comp { name: string; start: number; end: number; props: Set<string> }
interface FileInfo { setters: Map<string, string>; fnCalls: Map<string, Set<string>>; handlers: Handler[]; usages: Usage[]; comps: Comp[]; fns: { name: string; start: number; end: number }[]; defaultExport?: string | undefined }

function fileInfo(g: Graph, file: string): FileInfo | null {
  if (g.info.has(file)) return g.info.get(file)!;
  let src: string, ast: any;
  try { src = fs.readFileSync(file, 'utf8'); ast = babelParse(src, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'typescript'] }); } catch { g.info.set(file, null); return null; }
  const fi: FileInfo = { setters: new Map(), fnCalls: new Map(), handlers: [], usages: [], comps: [], fns: [] };
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
    if (n.type === 'JSXElement') {
      const open = n.openingElement;
      const tag = open.name.type === 'JSXIdentifier' ? open.name.name : open.name.type === 'JSXMemberExpression' ? open.name.property.name : '';
      for (const a of open.attributes) {
        const k = a.name?.name;
        if (typeof k !== 'string' || !/^on(Click|DoubleClick|Select|PointerDown|MouseDown|CheckedChange)$/.test(k) || !a.value?.expression) continue;
        fi.handlers.push({ label: labelOf(n), event: k === 'onDoubleClick' ? 'dblclick' : 'click', line: n.loc?.start.line ?? 0, pos: n.start, calls: callees(a.value.expression), component: '', tag });
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
        if (caller) { local = []; f = pf; comp = caller.name; break; }
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
      if (!setters.size) continue;
      // Not a control inside what it's supposed to open (that one closes or re-targets it).
      const inside = below(i);
      // Not a control inside what the gate guards either (a Save button in the draft row it closes).
      const guarded = (s: Step) => s.file === lv.file && s.pos != null && lv.gates.some(x => x.at && s.pos! >= x.at[0] && s.pos! <= x.at[1]);
      mine.push(...triggersFor(g, lv.file, setters, s => chainFiles.has(s.file) && !inside.has(s.component) && !guarded(s)).slice(0, 1));
    }
    steps.unshift(...mine);
  });
  const near = dedupe(steps).slice(-3);
  // gates were collected innermost first; the Reach lists them outermost first.
  const real = gates.filter(x => x.kind !== 'overlay' || x.trigger || x.test).reverse();
  const chain = levels.map(l => l.comp || path.basename(l.file).replace(/\.\w+$/, '')).reverse();
  return { status: real.length ? 'gated' : 'page', via: chain, gates: real, steps: near, why: describeReach(real, near, chain), placement: placed.regions.length ? placed : undefined };
}

/** A UI flag: identifiers, member access, negation, && between them. No comparisons, counts, or calls. */
const FLAG = /^[!\s\w.?&|]+$/;

/**
 * The labeled controls that end up calling any of `names` (a state setter, or functions wrapping it):
 * handlers in this file; then, when the call is handed on (a hook returns openAdd, a parent passes
 * onAddImage={media.openAdd}), the components it's handed to and the files that use the hook.
 */
function triggersFor(g: Graph, file: string, names: Set<string>, allow: (s: Step) => boolean = () => true, depth = 0, seen = new Set<string>()): Step[] {
  const key = file + '|' + [...names].sort().join(',');
  if (depth > 3 || seen.has(key)) return [];
  seen.add(key);
  const fi = fileInfo(g, file);
  if (!fi) return [];
  // Local functions that call any of the names count as the names too.
  const all = new Set(names);
  for (let d = 0; d < 3; d++) for (const [fn, calls] of fi.fnCalls) if (!all.has(fn) && [...calls].some(c => all.has(c.replace(/^ref:/, '')))) all.add(fn);
  const hits = fi.handlers.filter(h => usable(h.label) && [...expand(fi, h.calls)].some(c => all.has(c.replace(/^ref:/, ''))));
  // Only controls the caller can use (on the element's own chain of files) count toward the caps below.
  const out: Step[] = hits.map(h => ({ label: h.label, event: h.event, file, line: h.line, pos: h.pos, component: h.component })).filter(allow).slice(0, 3);
  // Handed to a child as a prop: follow the prop name into the component that receives it.
  for (const u of fi.usages) {
    for (const [prop, v] of u.props) {
      if (!/^on[A-Z]/.test(prop) || !v.ids.some(i => all.has(i))) continue;
      const childFile = [file, ...(g.imports.get(file) ?? [])].find(cf => fileInfo(g, cf)?.comps.some(c => c.name === u.name));
      if (childFile) out.push(...triggersFor(g, childFile, new Set([prop]), allow, depth + 1, seen));
      if (out.length >= 6) return dedupe(out);
    }
  }
  // Returned from a hook or exported: callers in the files that import this one use the same names.
  for (const imp of g.importers.get(file) ?? []) {
    if (out.length >= 6) break;
    out.push(...triggersFor(g, imp, all, allow, depth + 1, seen));
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
const dedupe = (s: Step[]) => s.map(x => ({ ...x, label: tidy(x.label) })).filter(x => x.label).filter((x, i, a) => a.findIndex(y => y.label === x.label && y.event === x.event) === i);

function describeReach(gates: Reach['gates'], steps: Step[], chain: string[]): string {
  const path = chain.length > 1 ? ` (${chain.join(' › ')})` : '';
  if (!gates.length) return `Rendered directly on a page${path}.`;
  const g = gates[gates.length - 1]!;
  const inner = g.kind === 'overlay' ? `inside a ${g.overlay}${g.component ? ` in ${g.component}` : ''}` : `only when ${g.negated ? 'not ' : ''}\`${g.test}\`${g.component ? ` in ${g.component}` : ''}`;
  const how = steps.length ? `, opened by ${steps.map(s => `“${s.label.length > 32 ? s.label.slice(0, 30) + '…' : s.label}”${s.event === 'dblclick' ? ' (double-click)' : ''}${s.component ? ` in ${s.component}` : ''}`).join(' then ')}` : '';
  const outer = gates.length > 1 ? `; ${gates.length - 1} more condition${gates.length > 2 ? 's' : ''} above it` : '';
  return `Renders ${inner}${how}${outer}${path}.`;
}
