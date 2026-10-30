import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { Parser as HtmlParser } from 'htmlparser2';
import { displayPath, walk } from '../paths.js';
import { readAliases, resolveSpecifier, type ShimExports } from '../modules.js';
import { loadClassReader, type ClassReader } from '../tailwind.js';
import { allDsPackages, libraryOfPackage, lookalikeMap, type Config } from '../config.js';
import type { Framework, Instance, Lookalike, LibraryDef, Target } from '../types.js';
import { fileConsts, reactFeatures, templateFeatures, visitWithAncestors, type ElementFeatures } from './features.js';

/**
 * Static scan of one target's source. Counts DS component instances, override props on them,
 * and raw native elements that imitate DS components (look-alikes).
 * Deterministic: same files in, same rows out.
 */

const OVERRIDE_PROPS: Record<string, string> = { className: 'className', class: 'className', style: 'style', sx: 'style' };

interface ImportBinding { pkg: string; imported: string; namespace: boolean; via?: 'shim' | undefined }

export interface CodeScanResult {
  instances: Instance[];
  lookalikes: Lookalike[];
  filesScanned: number;
  parseErrors: { file: string; message: string }[];
  /** Local modules found re-exporting or wrapping DS components. */
  shimModules?: number | undefined;
}

export function scanCode(root: string, config: Config, target: Target, exclude: string[]): CodeScanResult {
  const res: CodeScanResult = { instances: [], lookalikes: [], filesScanned: 0, parseErrors: [] };
  const isAngular = Boolean(target.deps['@angular/core']);
  const exts = new Set(['.jsx', '.tsx', '.js', '.ts', '.vue', '.mjs']);
  if (isAngular) exts.add('.html');
  const files = walk(target.dir, exts, exclude);
  const classReader = loadClassReader(root, config);
  const ctx: Ctx = {
    root,
    target,
    ds: new Set(allDsPackages(config)),
    config,
    ...lookalikeMap(root, config),
    prefixes: prefixMap(config),
    res,
    // Providers implement components with raw elements; that isn't a look-alike.
    countLookalikes: target.role === 'consumer' || target.role === 'child',
    classReader,
    leakyClassOnly: Boolean(classReader) && config.tailwind?.classNameOverrides !== 'any',
    aliases: readAliases(target.dir, target.aliases),
    asts: new Map(),
    shims: new Map(),
  };
  // Pass 1: parse scripts once and learn which local modules re-export or wrap DS components.
  for (const file of files) {
    if (!/\.(m?[jt]sx?)$/.test(file)) continue;
    try {
      const src = fs.readFileSync(file, 'utf8');
      if (src.length > 1_500_000) continue;
      ctx.asts.set(file, parseScript(src, path.extname(file)));
    } catch { /* reported in pass 2 */ }
  }
  buildShims(ctx);
  res.shimModules = ctx.shims.size;
  for (const file of files) {
    let src: string;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (src.length > 1_500_000) continue; // generated bundles
    res.filesScanned++;
    try {
      const ext = path.extname(file);
      if (ext === '.vue') scanVue(ctx, file, src);
      else if (ext === '.html') scanAngularTemplate(ctx, file, src, 0);
      else scanScript(ctx, file, src, ext);
    } catch (e: any) {
      res.parseErrors.push({ file: rel(ctx, file), message: String(e?.message ?? e).split('\n')[0]! });
    }
  }
  return res;
}

interface Ctx {
  root: string;
  target: Target;
  ds: Set<string>;
  config: Config;
  lookalikes: Record<string, string>;
  inputTypes: Record<string, string>;
  allowTypes: string[];
  prefixes: { prefix: string; lib: LibraryDef }[];
  res: CodeScanResult;
  countLookalikes: boolean;
  classReader: ClassReader | null;
  /** With a Tailwind class reader, className counts as an override only when it carries drift. */
  leakyClassOnly: boolean;
  aliases: [string, string][];
  asts: Map<string, any>;
  shims: Map<string, ShimExports>;
}

const rel = (ctx: Ctx, file: string) => displayPath(ctx.root, file, ctx.target.dir);

function prefixMap(config: Config) {
  const libs = [config.designSystem.core, ...(config.designSystem.children ?? [])];
  // Longest prefix first so "ck-ds-" beats "ds-" style overlaps.
  return libs.flatMap(lib => (lib.tagPrefixes ?? []).map(prefix => ({ prefix, lib }))).sort((a, b) => b.prefix.length - a.prefix.length);
}

const pascal = (kebab: string) => kebab.split('-').filter(Boolean).map(s => s[0]!.toUpperCase() + s.slice(1)).join('');
const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** The DS package a specifier belongs to, accepting subpaths like "@acme/ds-react/button". */
function dsPackageOf(ctx: Ctx, source: string): string | null {
  for (const p of ctx.ds) if (source === p || source.startsWith(p + '/')) return p;
  return null;
}

function pushInstance(ctx: Ctx, file: string, line: number, pkg: string, component: string, framework: Framework, overrides: string[]) {
  const lib = libraryOfPackage(ctx.config, pkg);
  // A child library rendering its own components isn't consumption.
  if (ctx.target.role !== 'consumer' && lib?.name === ctx.target.name) return;
  ctx.res.instances.push({ target: ctx.target.name, library: lib?.name ?? 'unknown', pkg, component, file: rel(ctx, file), line, framework, overrides: [...new Set(overrides)].sort() });
}

const DYNAMIC = '\u0000dynamic';

function pushLookalike(ctx: Ctx, file: string, line: number, element: string, attrs: Record<string, string>, features?: ElementFeatures) {
  if (!ctx.countLookalikes) return;
  let component = ctx.lookalikes[element];
  if (!component) return;
  if (element === 'input') {
    if (attrs.type === DYNAMIC) return; // type decided at runtime: can't say what it should be (matches the system's lint rule)
    const type = (attrs.type ?? 'text').toLowerCase();
    if (ctx.allowTypes.includes(type)) return;
    component = ctx.inputTypes[type] ?? component;
  }
  ctx.res.lookalikes.push({ target: ctx.target.name, element, component, file: rel(ctx, file), line, col: features?.col, features });
}

// ---------- React / React Native / Preact (and Angular inline templates in .ts) ----------

function parseScript(src: string, ext: string) {
  const jsx = ext !== '.ts' && ext !== '.mts';
  return babelParse(src, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    plugins: [...(jsx ? (['jsx'] as const) : []), 'typescript', 'decorators-legacy'],
  });
}

/** DS imports in a file, plus imports of local shims resolved to the DS component behind them. */
function importBindings(ctx: Ctx, file: string, ast: any): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const node of ast.program.body as any[]) {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') continue;
    const source: string = node.source.value;
    const pkg = dsPackageOf(ctx, source);
    if (pkg) {
      for (const s of node.specifiers) {
        if (s.importKind === 'type') continue;
        if (s.type === 'ImportSpecifier') bindings.set(s.local.name, { pkg, imported: s.imported.name ?? s.imported.value, namespace: false });
        else if (s.type === 'ImportDefaultSpecifier') bindings.set(s.local.name, { pkg, imported: s.local.name, namespace: false });
        else if (s.type === 'ImportNamespaceSpecifier') bindings.set(s.local.name, { pkg, imported: '*', namespace: true });
      }
      continue;
    }
    const target = resolveSpecifier(file, source, ctx.aliases);
    const shim = target ? ctx.shims.get(target) : undefined;
    if (!shim) continue;
    for (const s of node.specifiers) {
      if (s.importKind === 'type') continue;
      if (s.type === 'ImportSpecifier') {
        const name = s.imported.name ?? s.imported.value;
        const hit = shim.named.get(name);
        if (hit) bindings.set(s.local.name, { pkg: hit.pkg, imported: hit.imported, namespace: false, via: 'shim' });
        else if (shim.wildcard.length && /^[A-Z]/.test(name)) bindings.set(s.local.name, { pkg: shim.wildcard[0]!, imported: name, namespace: false, via: 'shim' });
      } else if (s.type === 'ImportNamespaceSpecifier' && shim.wildcard.length) {
        bindings.set(s.local.name, { pkg: shim.wildcard[0]!, imported: '*', namespace: true, via: 'shim' });
      }
    }
  }
  return bindings;
}

/** First JSX element inside a node that is bound to a DS component. */
function firstDsJsx(node: any, bindings: Map<string, ImportBinding>): ImportBinding | null {
  let hit: ImportBinding | null = null;
  visit(node, (n: any) => {
    if (hit || n.type !== 'JSXOpeningElement') return;
    if (n.name.type === 'JSXIdentifier') { const b = bindings.get(n.name.name); if (b && !b.namespace) hit = b; }
    else if (n.name.type === 'JSXMemberExpression' && n.name.object.type === 'JSXIdentifier') {
      const b = bindings.get(n.name.object.name); if (b?.namespace) hit = { ...b, imported: n.name.property.name, namespace: false };
    }
  });
  return hit;
}

/**
 * Build the shim map: modules that `export *` from a DS package, re-export named DS components,
 * or export a local component whose first rendered element is a DS component (a wrapper).
 * Iterates so shims of shims resolve (three hops is plenty in practice).
 */
function buildShims(ctx: Ctx) {
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const [file, ast] of ctx.asts) {
      const bindings = importBindings(ctx, file, ast);
      const exp: ShimExports = { wildcard: [], named: new Map() };
      for (const node of ast.program.body as any[]) {
        if (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type') {
          const src: string = node.source.value;
          const pkg = dsPackageOf(ctx, src);
          if (pkg) exp.wildcard.push(pkg);
          else {
            const t = resolveSpecifier(file, src, ctx.aliases);
            const inner = t ? ctx.shims.get(t) : undefined;
            if (inner) { exp.wildcard.push(...inner.wildcard); for (const [k, v] of inner.named) exp.named.set(k, v); }
          }
        } else if (node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type') {
          if (node.source) {
            const src: string = node.source.value;
            const pkg = dsPackageOf(ctx, src);
            const t = pkg ? null : resolveSpecifier(file, src, ctx.aliases);
            const inner = t ? ctx.shims.get(t) : undefined;
            for (const sp of node.specifiers ?? []) {
              const local = sp.local?.name, exported = sp.exported?.name ?? sp.exported?.value;
              if (!local || !exported) continue;
              if (pkg) exp.named.set(exported, { pkg, imported: local, wrapper: false });
              else if (inner) {
                const hit = inner.named.get(local) ?? (inner.wildcard.length && /^[A-Z]/.test(local) ? { pkg: inner.wildcard[0]!, imported: local, wrapper: false } : undefined);
                if (hit) exp.named.set(exported, hit);
              }
            }
          } else {
            for (const sp of node.specifiers ?? []) {
              const b = bindings.get(sp.local?.name);
              const exported = sp.exported?.name ?? sp.exported?.value;
              if (b && !b.namespace && exported) exp.named.set(exported, { pkg: b.pkg, imported: b.imported, wrapper: false });
            }
            const d = node.declaration;
            const decls: [string, any][] = [];
            if (d?.type === 'FunctionDeclaration' && d.id) decls.push([d.id.name, d]);
            if (d?.type === 'VariableDeclaration') for (const v of d.declarations) if (v.id?.name && v.init) decls.push([v.id.name, v.init]);
            for (const [name, body] of decls) {
              if (!/^[A-Z]/.test(name)) continue;
              const hit = firstDsJsx(body, bindings);
              if (hit) exp.named.set(name, { pkg: hit.pkg, imported: hit.imported, wrapper: true });
            }
          }
        }
      }
      if (exp.wildcard.length || exp.named.size) {
        const prev = ctx.shims.get(file);
        if (!prev || prev.named.size !== exp.named.size || prev.wildcard.length !== exp.wildcard.length) changed = true;
        ctx.shims.set(file, exp);
      }
    }
    if (!changed) break;
  }
}

function scanScript(ctx: Ctx, file: string, src: string, ext: string) {
  const ast = ctx.asts.get(file) ?? parseScript(src, ext);
  const bindings = importBindings(ctx, file, ast);
  fileConsts(file, ast); // seed the constant table from the AST we already have
  visitWithAncestors(ast.program, (node: any, ancestors: any[]) => {
    if (node.type === 'JSXOpeningElement') onJsx(ctx, file, node, bindings);
    // Native elements: read the whole element (children, ancestors) so the evaluator has facts to work with.
    if (node.type === 'JSXElement' && node.openingElement.name.type === 'JSXIdentifier' && /^[a-z]/.test(node.openingElement.name.name) && !bindings.has(node.openingElement.name.name)) {
      const name = node.openingElement.name.name;
      if (!ctx.lookalikes[name] || !ctx.countLookalikes) return;
      // render={<button />} hands the component the element it draws as (Base UI): the component's own element,
      // not a bypass. Content slots (action={<button>…</button>}) are still raw elements.
      if (inRenderProp(ancestors)) return;
      const feats = reactFeatures(node, ancestors, src, file, ctx.aliases);
      pushLookalike(ctx, file, node.loc?.start.line ?? 0, name, feats.attrs, feats);
    }
    // Angular: @Component({ template: `...` })
    if (node.type === 'ObjectProperty' && node.key?.name === 'template' && ctx.target.deps['@angular/core']) {
      const v = node.value;
      const text = v.type === 'StringLiteral' ? v.value : v.type === 'TemplateLiteral' ? v.quasis.map((q: any) => q.value.cooked).join('') : null;
      if (text) scanAngularTemplate(ctx, file, text, (v.loc?.start.line ?? 1) - 1);
    }
  });
}

/** Whether the element is the value of a `render` prop, the element a component draws as. */
function inRenderProp(ancestors: any[]): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type === 'JSXAttribute') return a.name?.name === 'render';
    if (a.type === 'JSXElement' || a.type === 'JSXFragment') return false;
  }
  return false;
}

/** All string fragments inside an attribute value: "a b", cn('a', cond && 'b'), `a ${x} b`. */
function stringsIn(node: any): string {
  const parts: string[] = [];
  if (!node) return '';
  if (node.type === 'StringLiteral') return node.value;
  visit(node, (n: any) => {
    if (n.type === 'StringLiteral') parts.push(n.value);
    else if (n.type === 'TemplateLiteral') for (const q of n.quasis) parts.push(q.value.cooked ?? '');
  });
  return parts.join(' ');
}

function onJsx(ctx: Ctx, file: string, node: any, bindings: Map<string, ImportBinding>) {
  const line = node.loc?.start.line ?? 0;
  const n = node.name;
  let pkg: string | null = null;
  let component: string | null = null;
  if (n.type === 'JSXIdentifier') {
    const b = bindings.get(n.name);
    if (b && !b.namespace) { pkg = b.pkg; component = b.imported; }
    else if (/^[a-z]/.test(n.name)) return; // handled at the JSXElement, where children are visible
  } else if (n.type === 'JSXMemberExpression' && n.object.type === 'JSXIdentifier') {
    const b = bindings.get(n.object.name);
    if (b?.namespace) { pkg = b.pkg; component = n.property.name; }
  }
  if (!pkg || !component) return;
  const overrides: string[] = [];
  for (const a of node.attributes) {
    // Spreads inside a shim/wrapper module are prop forwarding, not misuse.
    if (a.type === 'JSXSpreadAttribute') { if (!ctx.shims.has(file)) overrides.push('spread'); }
    else if (a.type === 'JSXAttribute' && OVERRIDE_PROPS[a.name?.name]) {
      const kind = OVERRIDE_PROPS[a.name.name]!;
      // With a Tailwind reader, className is composition unless it skips the semantic tier.
      if (kind === 'className' && ctx.leakyClassOnly) { if (ctx.classReader!.isDrift(stringsIn(a.value))) overrides.push('className'); }
      else overrides.push(kind);
    }
  }
  pushInstance(ctx, file, line, pkg, component, 'react', overrides);
}

/** Generic AST walk without @babel/traverse (keeps dependencies small). */
function visit(node: any, fn: (n: any) => void) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key.endsWith('Comments') || key === 'extra') continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) visit(c, fn);
    else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, fn);
  }
}

// ---------- Vue single-file components ----------

function scanVue(ctx: Ctx, file: string, src: string) {
  const { descriptor } = parseSfc(src, { filename: file });
  const bindings = new Map<string, ImportBinding>();
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue;
    const ast = babelParse(block.content, { sourceType: 'module', errorRecovery: true, plugins: ['typescript', 'decorators-legacy'] });
    for (const node of ast.program.body as any[]) {
      if (node.type !== 'ImportDeclaration') continue;
      const pkg = dsPackageOf(ctx, node.source.value);
      if (!pkg) continue;
      for (const s of node.specifiers) {
        const imported = s.type === 'ImportSpecifier' ? (s.imported.name ?? s.imported.value) : s.local.name;
        bindings.set(s.local.name, { pkg, imported, namespace: s.type === 'ImportNamespaceSpecifier' });
        // <data-table> resolves to DataTable in Vue; single-word names stay native (<select> is never Select).
        if (kebab(s.local.name).includes('-')) bindings.set(kebab(s.local.name), { pkg, imported, namespace: s.type === 'ImportNamespaceSpecifier' });
      }
    }
  }
  const tpl = descriptor.template?.ast as any;
  if (!tpl) return;
  const walkTpl = (node: any) => {
    if (node.type === 1 /* ELEMENT */) {
      const tag: string = node.tag;
      const line = node.loc?.start.line ?? 0;
      const attrs: Record<string, string> = {};
      const overrides: string[] = [];
      for (const p of node.props ?? []) {
        if (p.type === 6) {
          attrs[p.name] = p.value?.content ?? '';
          if (p.name === 'class' && (!ctx.leakyClassOnly || ctx.classReader!.isDrift(attrs.class!))) overrides.push('className');
          if (p.name === 'style') overrides.push('style');
        }
        if (p.type === 7 && p.name === 'bind') {
          const arg = p.arg?.content;
          if (!arg) overrides.push('spread');
          else if (arg === 'class') { if (!ctx.leakyClassOnly || ctx.classReader!.isDrift(p.exp?.content ?? '')) overrides.push('className'); }
          else if (arg === 'style') overrides.push('style');
        }
      }
      const b = bindings.get(tag);
      const pref = matchPrefix(ctx, tag);
      if (b && !b.namespace) pushInstance(ctx, file, line, b.pkg, b.imported, 'vue', overrides);
      else if (tag.includes('.') && bindings.get(tag.split('.')[0]!)?.namespace) pushInstance(ctx, file, line, bindings.get(tag.split('.')[0]!)!.pkg, tag.split('.')[1]!, 'vue', overrides);
      else if (pref) pushInstance(ctx, file, line, pref.pkg, pref.component, 'vue', overrides);
      else if (/^[a-z]+$/.test(tag)) pushLookalike(ctx, file, line, tag, attrs, templateFeatures(tag, attrs, 'vue', String(node.loc?.source ?? `<${tag}>`).split('>')[0] + '>'));
    }
    for (const c of node.children ?? []) walkTpl(c);
    for (const b of node.branches ?? []) walkTpl(b); // v-if branches
  };
  walkTpl(tpl);
}

function matchPrefix(ctx: Ctx, tag: string): { pkg: string; component: string } | null {
  const t = tag.includes('-') ? tag : kebab(tag);
  for (const { prefix, lib } of ctx.prefixes) {
    if (t.startsWith(prefix) && t.length > prefix.length) {
      const pkg = (lib.packages.find(p => p in ctx.target.deps) ?? lib.packages[0])!;
      return { pkg, component: pascal(t.slice(prefix.length)) };
    }
  }
  return null;
}

// ---------- Angular templates (.html files and inline templates) ----------

const NG_OVERRIDE = (name: string): string | null => {
  if (name === 'class' || name === '[class]' || name === '[ngClass]' || name.startsWith('[class.')) return 'className';
  if (name === 'style' || name === '[style]' || name === '[ngStyle]' || name.startsWith('[style.')) return 'style';
  return null;
};

function scanAngularTemplate(ctx: Ctx, file: string, src: string, lineOffset: number) {
  const nl: number[] = [];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') nl.push(i);
  const lineAt = (idx: number) => { let lo = 0, hi = nl.length; while (lo < hi) { const m = (lo + hi) >> 1; if (nl[m]! < idx) lo = m + 1; else hi = m; } return lo + 1 + lineOffset; };
  const parser = new HtmlParser(
    {
      onopentag(name, attribs) {
        const line = lineAt(parser.startIndex);
        const pref = matchPrefix(ctx, name);
        if (pref) {
          const overrides = Object.keys(attribs)
            .filter(k => !(ctx.leakyClassOnly && NG_OVERRIDE(k) === 'className' && !ctx.classReader!.isDrift(attribs[k]!)))
            .map(NG_OVERRIDE).filter(Boolean) as string[];
          pushInstance(ctx, file, line, pref.pkg, pref.component, 'angular', overrides);
        } else if (/^[a-z]+$/.test(name)) {
          pushLookalike(ctx, file, line, name, attribs, templateFeatures(name, attribs, 'angular', `<${name} ${Object.entries(attribs).map(([k, v]) => `${k}="${v}"`).join(' ')}>`));
        }
      },
    },
    { lowerCaseAttributeNames: false, lowerCaseTags: true, recognizeSelfClosing: true }
  );
  parser.write(src);
  parser.end();
}
