import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import { visit } from './scanners/features.js';
import type { ElementFeatures } from './scanners/features.js';

/**
 * Component signatures, generated from the design system's own source (never hand-written):
 *
 *   structure  — the element and ARIA role it renders, its data-slot anatomy, icon positions
 *   properties — variant/size axes and values, from cva() (stock shadcn layer + the system's layer merged)
 *   tokens     — what each variant × size resolves to: height, padding, radius, background,
 *                text color, border, type, hover fills — with CSS custom-property aliases followed
 *                through the token package, so h-(--acme-control-h) ≡ h-(--button-height).
 *
 * A raw element is scored against every signature of a candidate component; the best match and
 * its margin over the runner-up become evidence for the recommendation and its confidence.
 */

export type Props = Map<string, string>;

export interface Signature {
  component: string;
  from: string;
  variant: string;
  size: string;
  tag: string;
  role?: string | undefined;
  /** Child slots the component styles: icon, label… */
  childSlots: string[];
  iconOnly: boolean;
  props: Props;
}

export interface ComponentSig {
  component: string;
  from: string;
  file: string;
  tag: string;
  role?: string | undefined;
  childSlots: string[];
  /** The root's data-slot, for finding rendered instances (button, input…). */
  slot?: string | undefined;
  axes: Record<string, string[]>;
  defaults: Record<string, string>;
  sigs: Signature[];
}

export interface SignatureSet {
  components: Map<string, ComponentSig>;
  aliases: Map<string, string>;
  /** Root custom properties' literal values (for "2rem" vs "--acme-control-h"). */
  values: Map<string, string>;
}

// Headless primitives → what they render.
const PRIMITIVES: [RegExp, string, string?][] = [
  [/(^|\/)button$/, 'button'], [/(^|\/)input$/, 'input'], [/(^|\/)checkbox$/, 'button', 'checkbox'], [/(^|\/)switch$/, 'button', 'switch'],
  [/(^|\/)toggle$/, 'button'], [/(^|\/)tabs$/, 'button', 'tab'], [/(^|\/)radio(-group)?$/, 'button', 'radio'], [/(^|\/)select$/, 'button', 'combobox'],
  [/(^|\/)menu$/, 'div', 'menuitem'], [/(^|\/)dialog$/, 'div', 'dialog'], [/(^|\/)slider$/, 'div', 'slider'], [/(^|\/)textarea$/, 'textarea'],
];

// ---------- token normalization (shared by signatures and raw elements) ----------

const SCALE = (n: string) => `${parseFloat(n) * 0.25}rem`;
const TEXT_SIZES = /^(xs|sm|base|lg|xl|\d?xl|\[[\d.]+(px|rem)\]|body(-\w+)?|caption|label(-\w+)?|code|heading(-\w+)?)$/;
const IGNORE_PREFIX = /^(dark|focus|focus-visible|focus-within|disabled|aria-invalid|in-data|has-data|data|group|peer|placeholder|file|motion-|print|sm|md|lg|xl|2xl|\*|not-|first|last|odd|even|\[)/;
const STATES = new Set(['hover', 'active', 'aria-expanded', 'aria-selected', 'aria-pressed', 'aria-checked']);

/** Follow --a: var(--b) chains to the root custom property. */
export const rootVar = (name: string, aliases: Map<string, string>) => {
  let n = name.replace(/^--/, ''), guard = 0;
  while (aliases.has(n) && guard++ < 12) n = aliases.get(n)!;
  return n;
};

function value(raw: string, aliases: Map<string, string>): string {
  const v = raw.replace(/!$/, '').replace(/^!/, '');
  const m = v.match(/^\((--[\w-]+)\)$/) || v.match(/^\[var\((--[\w-]+)\)\]$/);
  if (m) return `var:${rootVar(m[1]!, aliases)}`;
  if (/^\d+(\.\d+)?$/.test(v)) return SCALE(v);
  return v;
}

const color = (c: string, aliases: Map<string, string>) => {
  const base = c.replace(/\/\d+$/, '').replace(/!$/, '');
  if (/^\(--/.test(base)) return `var:${rootVar(base.slice(1, -1), aliases)}`;
  return `color:${rootVar(`color-${base}`, aliases)}`;
};

/** Tailwind classes → visual properties, keyed by state ("bg", "hover:bg"). Later classes win. */
export function normalize(tokens: string[], aliases: Map<string, string>): Props {
  const p: Props = new Map();
  for (const raw of tokens) {
    const parts = raw.split(':');
    const util = parts.pop()!.replace(/!$/, '');
    const prefixes = parts;
    if (prefixes.some(x => IGNORE_PREFIX.test(x) && !STATES.has(x))) continue;
    if (util.startsWith('[') || util.startsWith('-')) continue;
    const state = prefixes.filter(x => STATES.has(x)).join(':');
    const key = (k: string) => (state ? `${state}:${k}` : k);
    let m: RegExpMatchArray | null;
    if ((m = util.match(/^size-(.+)$/))) { p.set(key('height'), value(m[1]!, aliases)); p.set(key('width'), value(m[1]!, aliases)); }
    else if ((m = util.match(/^h-(.+)$/)) && m[1] !== 'full' && m[1] !== 'auto') p.set(key('height'), value(m[1]!, aliases));
    else if ((m = util.match(/^w-(.+)$/)) && /^\(--|^\d/.test(m[1]!)) p.set(key('width'), value(m[1]!, aliases));
    else if ((m = util.match(/^p-(.+)$/))) { p.set(key('px'), value(m[1]!, aliases)); p.set(key('py'), value(m[1]!, aliases)); }
    else if ((m = util.match(/^px-(.+)$/))) p.set(key('px'), value(m[1]!, aliases));
    else if ((m = util.match(/^py-(.+)$/))) p.set(key('py'), value(m[1]!, aliases));
    else if ((m = util.match(/^rounded(?:-(.+))?$/))) p.set(key('radius'), radius(m[1], aliases));
    else if ((m = util.match(/^bg-(.+)$/)) && !/^(clip|origin|gradient|none|linear|radial|cover|contain|center|no-repeat)/.test(m[1]!)) p.set(key('bg'), m[1] === 'transparent' ? 'transparent' : color(m[1]!, aliases));
    else if ((m = util.match(/^text-(.+)$/))) {
      if (TEXT_SIZES.test(m[1]!)) p.set(key('font-size'), m[1]!);
      else if (!/^(left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/.test(m[1]!)) p.set(key('fg'), color(m[1]!, aliases));
    }
    else if (util === 'border') p.set(key('border-width'), '1px');
    else if ((m = util.match(/^border-(\d+|\[.+\])$/))) p.set(key('border-width'), m[1]!);
    else if ((m = util.match(/^border-(?!([trblxy]|collapse|separate|solid|dashed|dotted|none)(-|$))(.+)$/))) p.set(key('border-color'), m[3] === 'transparent' ? 'transparent' : color(m[3]!, aliases));
    else if ((m = util.match(/^border-(dashed|dotted)$/))) p.set(key('border-style'), m[1]!);
    else if ((m = util.match(/^font-(thin|light|normal|medium|semibold|bold|extrabold|black)$/))) p.set(key('font-weight'), m[1]!);
    else if (util === 'underline' || util === 'no-underline') p.set(key('decoration'), util);
    else if ((m = util.match(/^shadow(?:-(.+))?$/))) p.set(key('shadow'), m[1] ?? 'sm');
  }
  return p;
}

function radius(v: string | undefined, aliases: Map<string, string>) {
  if (!v) return 'var:radius-sm';
  if (v === 'none' || v === 'full') return v;
  if (/^\(--/.test(v)) return value(v, aliases);
  if (/^(xs|sm|md|lg|xl|2xl|3xl)$/.test(v)) return `var:${rootVar(`radius-${v}`, aliases)}`;
  return v;
}

// ---------- reading the design system ----------

function parseFile(file: string): any {
  try { return babelParse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', errorRecovery: true, plugins: ['jsx', 'typescript'] }); } catch { return null; }
}

const strs = (n: any): string[] => {
  const out: string[] = [];
  if (!n) return out;
  visit(n, (x: any) => {
    if (x.type === 'StringLiteral') out.push(...x.value.split(/\s+/).filter(Boolean));
    else if (x.type === 'TemplateLiteral') for (const q of x.quasis) out.push(...(q.value.cooked ?? '').split(/\s+/).filter(Boolean));
  });
  return out;
};

interface Cva { base: string[]; variants: Record<string, Record<string, string[]>>; defaults: Record<string, string> }

function cvasIn(ast: any): Map<string, Cva> {
  const m = new Map<string, Cva>();
  visit(ast.program, (n: any) => {
    if (n.type !== 'VariableDeclarator' || n.init?.type !== 'CallExpression' || n.init.callee?.name !== 'cva') return;
    const [b, cfg] = n.init.arguments;
    const c: Cva = { base: strs(b), variants: {}, defaults: {} };
    for (const p of cfg?.properties ?? []) {
      const k = p.key?.name ?? p.key?.value;
      if (k === 'variants') for (const axis of p.value.properties ?? []) {
        const an = axis.key?.name ?? axis.key?.value;
        c.variants[an] = {};
        for (const v of axis.value.properties ?? []) c.variants[an][v.key?.name ?? v.key?.value] = strs(v.value);
      }
      if (k === 'defaultVariants') for (const d of p.value.properties ?? []) c.defaults[d.key?.name ?? d.key?.value] = d.value?.value;
    }
    m.set(n.id.name, c);
  });
  return m;
}

interface RawComp { name: string; file: string; rootName: string; rootSource?: string | undefined; classTokens: string[]; cvaRefs: string[]; slots: string[]; childSlots: string[]; stockRef?: { file: string; name: string } | undefined }

function componentsIn(file: string): RawComp[] {
  const ast = parseFile(file);
  if (!ast) return [];
  const imports = new Map<string, { source: string; name: string }>();
  for (const s of ast.program.body) if (s.type === 'ImportDeclaration') for (const sp of s.specifiers ?? []) imports.set(sp.local.name, { source: s.source.value, name: sp.imported?.name ?? sp.local.name });
  const out: RawComp[] = [];
  const fns: [string, any][] = [];
  for (const s of ast.program.body) {
    const d = s.type === 'ExportNamedDeclaration' ? s.declaration : s;
    if (d?.type === 'FunctionDeclaration' && d.id && /^[A-Z]/.test(d.id.name)) fns.push([d.id.name, d]);
    if (d?.type === 'VariableDeclaration') for (const v of d.declarations) if (/^[A-Z]/.test(v.id?.name ?? '') && /Function|Arrow|Call/.test(v.init?.type ?? '')) fns.push([v.id.name, v.init]);
  }
  for (const [name, fn] of fns) {
    let root: any = null;
    visit(fn, (n: any) => { if (!root && n.type === 'JSXElement') root = n; });
    if (!root) continue;
    const nm = root.openingElement.name;
    const rootName = nm.type === 'JSXIdentifier' ? nm.name : nm.type === 'JSXMemberExpression' ? `${nm.object.name}.${nm.property.name}` : '?';
    const cls = root.openingElement.attributes.find((a: any) => a.name?.name === 'className');
    const cvaRefs: string[] = [];
    if (cls) visit(cls.value, (n: any) => { if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name !== 'cn') cvaRefs.push(n.callee.name); });
    const slots: string[] = [], childSlots: string[] = [];
    visit(fn, (n: any) => {
      if (n.type === 'JSXAttribute' && n.name?.name === 'data-slot' && n.value?.type === 'StringLiteral') slots.push(n.value.value);
    });
    const allText = strs(fn).join(' ');
    for (const m of allText.matchAll(/data-slot=([\w-]+)/g)) childSlots.push(m[1]!);
    for (const m of allText.matchAll(/data-\[icon=([\w-]+)\]/g)) childSlots.push(`icon:${m[1]}`);
    const objName = rootName.split('.')[0];
    const imp = imports.get(objName);
    const stockRef = imp && /vendor\/shadcn/.test(imp.source) ? { file: resolveTs(file, imp.source), name: imp.name } : undefined;
    out.push({ name, file, rootName, rootSource: imp?.source, classTokens: cls ? strs(cls.value).filter(t => !cvaRefs.includes(t)) : [], cvaRefs, slots: [...new Set(slots)], childSlots: [...new Set(childSlots)], stockRef });
  }
  return out;
}

/**
 * A cva by name: defined in the file, imported from a relative module, or wrapped by a local helper
 * (L2a toggleVariants calls the stock one). Stock ToggleGroupItem calls toggleVariants from ../../toggle.
 */
function cvaFor(file: string, name: string, local?: Map<string, Cva>, depth = 0): Cva | undefined {
  const ast = parseFile(file);
  if (!ast || depth > 3) return undefined;
  const own = (local ?? cvasIn(ast)).get(name);
  if (own) return own;
  for (const s of ast.program.body) {
    if (s.type !== 'ImportDeclaration' || !s.source.value.startsWith('.')) continue;
    const sp = (s.specifiers ?? []).find((x: any) => x.local?.name === name);
    if (!sp) continue;
    const target = resolveTs(file, s.source.value);
    return fs.existsSync(target) ? cvaFor(target, sp.imported?.name ?? name, undefined, depth + 1) : undefined;
  }
  let inner: string | undefined;
  // A wrapper around the cva (const buttonVariants = (p) => cn(variants(p)), or the same as a function declaration).
  visit(ast.program, (n: any) => {
    if (inner) return;
    const body = n.type === 'VariableDeclarator' && n.id?.name === name && /Function|Arrow/.test(n.init?.type ?? '') ? n.init.body
      : n.type === 'FunctionDeclaration' && n.id?.name === name ? n.body : undefined;
    if (!body) return;
    visit(body, (x: any) => { if (!inner && x.type === 'CallExpression' && x.callee?.type === 'Identifier' && !/^(cn|clsx|cx)$/.test(x.callee.name)) inner = x.callee.name; });
  });
  return inner && inner !== name ? cvaFor(file, inner, undefined, depth + 1) : undefined;
}

function resolveTs(from: string, spec: string) {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, `${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return base;
}

function tagOf(c: RawComp, stock?: RawComp): { tag: string; role?: string | undefined } {
  const r = stock ?? c;
  if (/^[a-z]/.test(r.rootName)) return { tag: r.rootName };
  const src = r.rootSource ?? '';
  for (const [re, tag, role] of PRIMITIVES) if (re.test(src.replace(/\/index$/, ''))) {
    // Tabs.Tab → tab; Tabs.List → tablist, not a button.
    if (role === 'tab' && !/\.Tab$/.test(r.rootName)) return { tag: 'div', role: 'tablist' };
    return { tag, role };
  }
  // Headless triggers and item buttons (Collapsible.Trigger, SidebarMenuButton) render a <button>.
  if (/(\.Trigger|Trigger|Button)$/.test(r.rootName) || /(Trigger|Button)$/.test(c.name)) return { tag: 'button' };
  return { tag: 'div' };
}

/** CSS custom property aliases (--a: var(--b)) and literal values, from every .css in the given dirs. */
export function readTokenAliases(dirs: string[]) {
  const aliases = new Map<string, string>();
  const values = new Map<string, string>();
  const walk = (d: string, depth = 0) => {
    if (depth > 4 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.css')) {
        const css = fs.readFileSync(p, 'utf8');
        for (const m of css.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
          const v = m[2]!.trim();
          const alias = v.match(/^var\(--([\w-]+)\)$/);
          if (alias) { if (!aliases.has(m[1]!)) aliases.set(m[1]!, alias[1]!); }
          else if (!values.has(m[1]!)) values.set(m[1]!, v.replace(/\s*\/\*.*\*\//, ''));
        }
      }
    }
  };
  for (const d of dirs) walk(d);
  return { aliases, values };
}

/**
 * Component source files under a package's src/, at any depth (src/button.tsx, src/components/ui/button.tsx),
 * in a fixed order: a folder's files before its subfolders, each sorted. Stories and tests are skipped, and so is
 * vendor/: the stock layer under a component (vendor/shadcn) is read through the component that wraps it.
 * Files directly in src/ are always read. Deeper files are read only when the package's src/index re-exports
 * them (its public surface), so a feature's internals or a helper in state/ never become a recommendation.
 */
export function componentFiles(src: string): string[] {
  const all = allTsx(src);
  const pub = publicFiles(src);
  return all.filter(f => path.dirname(f) === src || pub.has(f));
}

/** Files src/index.ts(x) re-exports (export … from), following re-exporting barrels a few hops. */
function publicFiles(src: string): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const follow = (file: string, depth: number) => {
    if (depth > 4 || seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const ast = parseFile(file);
    if (!ast) return;
    for (const st of ast.program.body) {
      if ((st.type !== 'ExportAllDeclaration' && st.type !== 'ExportNamedDeclaration') || !st.source?.value?.startsWith('.')) continue;
      const target = resolveTs(file, st.source.value);
      out.add(target);
      if (/\.ts$/.test(target)) follow(target, depth + 1);
    }
  };
  for (const f of ['index.ts', 'index.tsx']) follow(path.join(src, f), 0);
  return out;
}

function allTsx(src: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) if (e.isFile() && /\.tsx$/.test(e.name) && !/\.(stories|test|spec)\.tsx$/.test(e.name)) out.push(path.join(d, e.name));
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || /^(node_modules|vendor|test|tests|__tests__|stories)$/.test(e.name)) continue;
      walk(path.join(d, e.name));
    }
  };
  if (fs.existsSync(src)) walk(src);
  return out;
}

/**
 * Build signatures from the core packages. `packages` maps package dirs to their npm names,
 * so a component file maps to its public import (@acme/ui/button).
 */
export function buildSignatures(packages: { dir: string; name: string }[]): SignatureSet {
  const { aliases, values } = readTokenAliases(packages.map(p => p.dir));
  const components = new Map<string, ComponentSig>();
  for (const pkg of packages) {
    const src = path.join(pkg.dir, 'src');
    if (!fs.existsSync(src)) continue;
    const exportsMap = readExports(pkg.dir, pkg.name);
    for (const file of componentFiles(src)) {
      const ast = parseFile(file);
      if (!ast) continue;
      const cvas = cvasIn(ast);
      for (const c of componentsIn(file)) {
        // The stock layer: the vendored shadcn component this one renders, with its own cva.
        const stockComps = c.stockRef && fs.existsSync(c.stockRef.file) ? componentsIn(c.stockRef.file) : [];
        const stock = stockComps.find(s => s.name === c.stockRef!.name);
        const stockCvas = c.stockRef && fs.existsSync(c.stockRef.file) ? cvasIn(parseFile(c.stockRef.file)) : new Map<string, Cva>();
        const layers: { base: string[]; cva?: Cva | undefined }[] = [];
        // A cva can live in a sibling module (stock ToggleGroupItem calls toggleVariants from ./toggle).
        if (stock) layers.push({ base: stock.classTokens, cva: stock.cvaRefs.map(r => cvaFor(c.stockRef!.file, r, stockCvas)).find(Boolean) });
        layers.push({ base: c.classTokens, cva: c.cvaRefs.map(r => cvaFor(file, r, cvas)).find(Boolean) });
        const axes: Record<string, string[]> = {};
        const defaults: Record<string, string> = {};
        for (const l of layers) if (l.cva) for (const [a, vs] of Object.entries(l.cva.variants)) { axes[a] = [...new Set([...(axes[a] ?? []), ...Object.keys(vs)])]; Object.assign(defaults, l.cva.defaults); }
        const { tag, role } = tagOf(c, stock);
        const slotText = layers.flatMap(l => [...l.base, ...(l.cva ? [...l.cva.base, ...Object.values(l.cva.variants).flatMap(v => Object.values(v).flat())] : [])]).join(' ');
        const cvaSlots = [...slotText.matchAll(/data-slot=([\w-]+)/g)].map(m => m[1]).concat([...slotText.matchAll(/data-\[icon=([\w-]+)\]/g)].map(m => `icon:${m[1]}`));
        const childSlots = [...new Set([...c.childSlots, ...(stock?.childSlots ?? []), ...cvaSlots])].filter(s => s !== c.slots[0]) as string[];
        const from = exportsMap.get(path.resolve(file)) ?? pkg.name;
        const variantAxis = axes.variant ?? ['default'];
        const sizeAxis = axes.size ?? ['default'];
        const sigs: Signature[] = [];
        for (const v of variantAxis) for (const s of sizeAxis) {
          const tokens: string[] = [];
          for (const l of layers) {
            tokens.push(...l.base);
            if (!l.cva) continue;
            tokens.push(...l.cva.base);
            const pick = (axis: string, want: string) => l.cva!.variants[axis]?.[want] ?? l.cva!.variants[axis]?.[l.cva!.defaults[axis] ?? 'default'] ?? [];
            if (l.cva.variants.variant) tokens.push(...pick('variant', v));
            if (l.cva.variants.size) tokens.push(...pick('size', s === 'toolbar-icon' && !l.cva.variants.size[s] ? 'icon' : s));
            for (const [axis, vals] of Object.entries(l.cva.variants)) if (axis !== 'variant' && axis !== 'size') tokens.push(...(vals[l.cva.defaults[axis]! ?? Object.keys(vals)[0]] ?? []));
          }
          sigs.push({ component: c.name, from, variant: v, size: s, tag, role, childSlots, iconOnly: /icon/.test(s), props: normalize(tokens, aliases) });
        }
        const deeper = path.dirname(file) !== src;
        if (!components.has(c.name) || (c.cvaRefs.length && !deeper)) components.set(c.name, { component: c.name, from, file, tag, role, childSlots, slot: c.slots[0] ?? stock?.slots[0], axes, defaults, sigs });
      }
    }
  }
  for (const pkg of packages) deriveSizeMapped(pkg.dir, components);
  return { components, aliases, values };
}

/**
 * Laterals that render another component and translate their own size ladder into its sizes
 * (IconButton: `ICON_BUTTON_SIZE = { xs: 'icon-xs', … }` onto Button) have no cva of their own, so
 * their signatures are the base component's, re-keyed: IconButton sm ≡ Button icon-sm, every variant.
 */
function deriveSizeMapped(dir: string, components: Map<string, ComponentSig>) {
  const src = path.join(dir, 'src');
  if (!fs.existsSync(src)) return;
  for (const file of componentFiles(src)) {
    const ast = parseFile(file);
    if (!ast) continue;
    // Components this file imports from a sibling module, with a size axis.
    const bases: ComponentSig[] = [];
    for (const st of ast.program.body) if (st.type === 'ImportDeclaration' && st.source.value.startsWith('.')) {
      for (const sp of st.specifiers ?? []) { const c = components.get(sp.imported?.name ?? ''); if (c?.axes.size && c.file !== file) bases.push(c); }
    }
    if (!bases.length) continue;
    // A top-level object literal of strings whose values are all one base's sizes and whose keys aren't.
    for (const st of ast.program.body) {
      const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st;
      if (decl?.type !== 'VariableDeclaration') continue;
      for (const d of decl.declarations) {
        let init = d.init;
        while (init && /^TS(As|Satisfies)Expression$/.test(init.type)) init = init.expression;
        if (init?.type !== 'ObjectExpression' || !init.properties.length) continue;
        const pairs: [string, string | null][] = init.properties.map((p: any) => [p.key?.name ?? p.key?.value, p.value?.type === 'StringLiteral' ? p.value.value : null]);
        if (pairs.some(([k, v]) => !k || v === null)) continue;
        const base = bases.find(b => pairs.every(([, v]) => b.axes.size!.includes(v!)) && pairs.some(([k, v]) => k !== v));
        if (!base) continue;
        // The lateral: the exported component in this file that isn't the base.
        const lateral = [...components.values()].find(c => c.file === file && c.component !== base.component && !Object.keys(c.axes).length);
        if (!lateral) continue;
        const sizes = new Map(pairs as [string, string][]);
        // A variant with its own square size (Button toolbar → toolbar-icon) that the file names: its default uses it.
        const text = fs.readFileSync(file, 'utf8');
        const own = (v: string) => base.axes.size!.includes(`${v}-icon`) && text.includes(`"${v}-icon"`) ? `${v}-icon` : undefined;
        const sigs: Signature[] = [];
        for (const [size, mapped] of sizes) for (const v of base.axes.variant ?? ['default']) {
          const baseSize = size === (base.defaults.size ?? 'default') ? own(v) ?? mapped : mapped;
          for (const b of base.sigs.filter(x => x.size === baseSize && x.variant === v)) sigs.push({ ...b, component: lateral.component, from: lateral.from, size, iconOnly: b.iconOnly });
        }
        if (!sigs.length) continue;
        const defaults = { ...base.defaults, ...paramDefaults(ast, lateral.component) };
        components.set(lateral.component, { ...lateral, tag: base.tag, role: base.role, childSlots: base.childSlots, axes: { variant: base.axes.variant ?? ['default'], size: [...sizes.keys()] }, defaults, sigs });
      }
    }
  }
}

/** `function X({ size = "default", variant = "ghost" })` → { size: 'default', variant: 'ghost' }. */
function paramDefaults(ast: any, name: string): Record<string, string> {
  const out: Record<string, string> = {};
  visit(ast.program, (n: any) => {
    if (n.type !== 'FunctionDeclaration' || n.id?.name !== name) return;
    for (const p of n.params[0]?.properties ?? []) if (p.value?.type === 'AssignmentPattern' && p.value.right?.type === 'StringLiteral') out[p.key?.name] = p.value.right.value;
  });
  return out;
}

function readExports(dir: string, name: string): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const [k, v] of Object.entries<any>(pj.exports ?? {})) {
      const target = typeof v === 'string' ? v : v?.import ?? v?.default;
      if (typeof target === 'string' && /\.tsx?$/.test(target)) m.set(path.resolve(dir, target), k === '.' ? name : `${name}/${k.replace(/^\.\//, '')}`);
    }
  } catch { /* no exports */ }
  return m;
}

// ---------- matching ----------

const WEIGHTS: Record<string, number> = {
  bg: 2, fg: 1.5, 'border-color': 1.25, 'border-width': 1, decoration: 1.5, height: 1.5, width: 1, radius: 1,
  px: 0.75, py: 0.5, 'font-size': 0.5, 'font-weight': 0.25, shadow: 0.25, 'border-style': 0.75,
};
const weightOf = (k: string) => { const base = k.split(':').pop()!; return (WEIGHTS[base] ?? 0.25) * (k.includes(':') ? 0.4 : 1); };

export interface Dim { key: string; element?: string | undefined; sig?: string | undefined; ok: boolean; weight: number }
export interface SigMatch { sig: Signature; score: number; dims: Dim[]; structure: { ok: boolean; notes: string[] } }

/** Values that equal "not set" for comparison (a transparent border is no border). */
const neutral = (k: string, v?: string) => v === undefined || v === 'transparent' || (k === 'border-width' && v === '0') || (k === 'shadow' && v === 'none');

export function compare(el: Props, sig: Signature, values: Map<string, string>): { score: number; dims: Dim[] } {
  const keys = new Set([...el.keys(), ...sig.props.keys()]);
  let got = 0, total = 0;
  const dims: Dim[] = [];
  for (const k of keys) {
    const w = weightOf(k);
    const a = el.get(k), b = sig.props.get(k);
    if (neutral(k, a) && neutral(k, b)) continue;
    // A 1px border in a transparent color is no visible border.
    if (k.endsWith('border-width') && neutral('border-color', sig.props.get(k.replace('border-width', 'border-color'))) && neutral(k, a)) continue;
    let ok = a === b || equivalent(a, b, values);
    // The element not specifying something the component sets to a quiet default isn't a mismatch.
    if (!ok && a === undefined && /^(font-weight|font-size|shadow|py|px)$/.test(k)) ok = true;
    total += w;
    if (ok) got += w;
    dims.push({ key: k, element: a, sig: b, ok, weight: w });
  }
  return { score: total ? got / total : 0, dims };
}

/** var:acme-control-h vs 2.25rem: equal if the root token's literal value matches. */
function equivalent(a: string | undefined, b: string | undefined, values: Map<string, string>) {
  if (!a || !b) return false;
  const lit = (x: string) => (x.startsWith('var:') ? values.get(x.slice(4)) ?? x : x).replace(/\s*\/\*.*$/, '');
  return lit(a) === lit(b);
}

export function structureFit(f: ElementFeatures, sig: Signature): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  let ok = true;
  if (sig.tag !== f.element && !(sig.tag === 'button' && f.element === 'button')) { ok = false; notes.push(`renders <${sig.tag}>, element is <${f.element}>`); }
  const role = f.attrs.role;
  if ((sig.role ?? '') !== (role && role !== '\u0000dynamic' ? role : '') && (sig.role || role)) { ok = false; notes.push(`role ${sig.role ?? 'none'} vs ${role ?? 'none'}`); }
  const c = f.children;
  const iconOnly = c.icons > 0 && !c.text && !c.dynamicText && !c.elements.length;
  if (iconOnly !== sig.iconOnly && /icon/.test(sig.size + (sig.iconOnly ? 'icon' : ''))) { notes.push(iconOnly ? 'icon-only element, text-size signature' : 'labelled element, icon-size signature'); ok = false; }
  if (c.elements.length >= 2 || c.interactive) { ok = false; notes.push(`${c.elements.length} structural children: the component's anatomy has no slot for them`); }
  if (c.icons && !sig.childSlots.some(s => s.startsWith('icon')) && sig.tag === 'button') notes.push('icon child: component has no icon slot styling');
  return { ok, notes };
}

export function bestMatches(f: ElementFeatures, comp: ComponentSig, set: SignatureSet, restrict?: (s: Signature) => boolean): SigMatch[] {
  const el = normalize([...f.classes.tokens], set.aliases);
  return comp.sigs.filter(s => !restrict || restrict(s)).map(sig => {
    const { score, dims } = compare(el, sig, set.values);
    const structure = structureFit(f, sig);
    return { sig, score, dims, structure };
  }).sort((a, b) => (Number(b.structure.ok) - Number(a.structure.ok)) || b.score - a.score);
}

export function describeDim(d: Dim): string {
  const show = (v?: string) => (v ?? 'unset').replace(/^var:/, '--').replace(/^color:color-/, '').replace(/^color:/, '');
  return d.ok ? `${d.key} ✓ ${show(d.element ?? d.sig)}` : `${d.key} ✗ ${show(d.element)} vs ${show(d.sig)}`;
}

/** Serializable view for the report and `dsa signatures`. */
export function signatureSummary(set: SignatureSet) {
  return [...set.components.values()].map(c => ({
    component: c.component, from: c.from, file: c.file, slot: c.slot, tag: c.tag, role: c.role, childSlots: c.childSlots, axes: c.axes, defaults: c.defaults,
    sigs: c.sigs.map(s => ({ variant: s.variant, size: s.size, props: Object.fromEntries(s.props) })),
  }));
}
