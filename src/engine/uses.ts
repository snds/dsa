import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import { readAliases, resolveSpecifier } from './modules.js';
import { allDsPackages, type Config } from './config.js';
import { defaultExcludes, displayPath, usageExcludes, walk } from './paths.js';
import type { Target } from './types.js';
import { visit } from './scanners/features.js';
import { canonicalProps } from '../bootstrap-labels.js';

/**
 * Where an app already uses the system's components, with the props each use sets, read from its source.
 * It follows what the app actually imports: the system's packages, local files that re-export them
 * (`export * from "<pkg>/button"`, three hops or more), thin wrappers of the same name, and vendored copies of the packages. It says how
 * much of the app it read, so a caller can only say "the app doesn't use this" when it read the app.
 */
export interface AppUse {
  /** Absolute path. */
  file: string;
  line: number;
  /** The system's name for it, without dots: ContextMenu.Item is ContextMenuItem. */
  component: string;
  /** Props set to a literal value, across however many lines the element opens over. */
  props: Record<string, string>;
  /** Props set from the code, so their value isn't known; a spread counts as "...". */
  dynamic: string[];
}
export interface UsesFound { uses: AppUse[]; files: number; unread: number }

const EXTS = new Set(['.tsx', '.jsx']);
const LOOK_EXTS = new Set(['.tsx', '.jsx', '.ts', '.js', '.mjs']);
const NOT_A_PROP = /^(className|key|ref|id|style|children|on[A-Z]\w*|data-[\w-]+|aria-[\w-]+|title)$/;

const parse = (src: string) => babelParse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: false });

/** What a module exports from the system: a name it re-exports, or every name (`export *`). */
interface Exported { all: boolean; names: Map<string, string> }

function literalOf(v: any): string | undefined {
  if (!v) return 'true';
  if (v.type === 'StringLiteral') return v.value;
  if (v.type !== 'JSXExpressionContainer') return undefined;
  const x = v.expression;
  if (x?.type === 'StringLiteral') return x.value;
  if (x?.type === 'BooleanLiteral' || x?.type === 'NumericLiteral') return String(x.value);
  if (x?.type === 'TemplateLiteral' && !x.expressions.length) return x.quasis[0].value.cooked;
  return undefined;
}

export function findUses(o: { dir: string; packages: string[]; wanted?: Set<string> | undefined; exclude?: string[] | undefined; aliases?: Record<string, string> | undefined }): UsesFound {
  const aliases = readAliases(o.dir, o.aliases ?? {});
  const isPkg = (s: string) => o.packages.some(p => s === p || s.startsWith(p + '/'));
  // A file inside a copy of a system package (vendored, or a workspace neighbour), by its package.json.
  const inPkg = new Map<string, boolean>();
  const vendored = (file: string): boolean => {
    const dir = path.dirname(file);
    if (inPkg.has(dir)) return inPkg.get(dir)!;
    let hit = false;
    if (dir !== o.dir && dir !== path.dirname(dir)) {
      const pj = path.join(dir, 'package.json');
      let name: string | null = null;
      if (fs.existsSync(pj)) { try { name = JSON.parse(fs.readFileSync(pj, 'utf8')).name ?? ''; } catch { name = ''; } }
      hit = name !== null ? Boolean(name) && o.packages.includes(name!) : vendored(dir);
    }
    inPkg.set(dir, hit);
    return hit;
  };
  const asts = new Map<string, any>();
  const astOf = (file: string) => {
    if (!asts.has(file)) { try { asts.set(file, parse(fs.readFileSync(file, 'utf8'))); } catch { asts.set(file, null); } }
    return asts.get(file);
  };
  const memo = new Map<string, Exported>();
  const exportsOf = (file: string, seen = new Set<string>()): Exported => {
    if (memo.has(file)) return memo.get(file)!;
    const out: Exported = { all: false, names: new Map() };
    if (seen.has(file) || !LOOK_EXTS.has(path.extname(file))) return out;
    seen.add(file);
    if (vendored(file)) { out.all = true; memo.set(file, out); return out; }
    const ast = astOf(file);
    if (!ast) return out;
    const from = (src: string): Exported | null => isPkg(src) ? { all: true, names: new Map() } : (() => { const t = resolveSpecifier(file, src, aliases); return t ? exportsOf(t, seen) : null; })();
    const imported = new Map<string, string>();
    const wraps = new Set<string>();
    for (const n of ast.program.body as any[]) {
      if (n.type === 'ImportDeclaration' && n.importKind !== 'type') {
        const m = from(n.source.value);
        if (!m) continue;
        for (const s of n.specifiers) if (s.type === 'ImportSpecifier') { const nm = s.imported.name ?? s.imported.value; const real = m.names.get(nm) ?? (m.all ? nm : null); if (real) { imported.set(s.local.name, real); if (s.local.name !== real) wraps.add(real); } }
      }
      if (n.type === 'ExportAllDeclaration' && n.exportKind !== 'type') {
        const m = from(n.source.value);
        if (m) { out.all = out.all || m.all; for (const [k, v] of m.names) out.names.set(k, v); }
      }
      if (n.type === 'ExportNamedDeclaration' && n.exportKind !== 'type') {
        const m = n.source ? from(n.source.value) : null;
        for (const s of n.specifiers ?? []) {
          const local = s.local?.name, name = s.exported?.name ?? s.exported?.value;
          if (!local || !name) continue;
          const real = n.source ? (m ? m.names.get(local) ?? (m.all ? local : null) : null) : imported.get(local) ?? (wraps.has(local) ? local : null);
          if (real) out.names.set(name, real);
        }
        // `export const Input = …` around the system's Input: a thin local wrapper of the same name.
        const d = n.declaration;
        const made: string[] = d?.type === 'FunctionDeclaration' && d.id ? [d.id.name] : d?.type === 'VariableDeclaration' ? d.declarations.map((v: any) => v.id?.name).filter(Boolean) : [];
        for (const name of made) if (wraps.has(name)) out.names.set(name, name);
      }
    }
    memo.set(file, out);
    return out;
  };

  const files = walk(o.dir, EXTS, o.exclude ?? []);
  const uses: AppUse[] = [];
  let unread = 0;
  for (const file of files) {
    const ast = astOf(file);
    if (!ast) { unread++; continue; }
    const bound = new Map<string, string>();
    for (const n of ast.program.body as any[]) {
      if (n.type !== 'ImportDeclaration' || n.importKind === 'type') continue;
      const src: string = n.source.value;
      const t = isPkg(src) ? null : resolveSpecifier(file, src, aliases);
      const m: Exported | null = isPkg(src) ? { all: true, names: new Map() } : t ? exportsOf(t) : null;
      if (!m) continue;
      for (const s of n.specifiers) {
        if (s.importKind === 'type') continue;
        if (s.type === 'ImportSpecifier') { const nm = s.imported.name ?? s.imported.value; const real = m.names.get(nm) ?? (m.all ? nm : null); if (real) bound.set(s.local.name, real); }
        else if (s.type === 'ImportNamespaceSpecifier' && m.all) bound.set(s.local.name, '');
        else if (s.type === 'ImportDefaultSpecifier' && isPkg(src)) bound.set(s.local.name, s.local.name);
      }
    }
    if (!bound.size) continue;
    visit(ast.program, (x: any) => {
      if (x.type !== 'JSXElement') return;
      const nm = x.openingElement.name;
      let name: string | null = null;
      if (nm.type === 'JSXIdentifier') name = bound.get(nm.name) || null;
      else if (nm.type === 'JSXMemberExpression' && nm.object.type === 'JSXIdentifier' && bound.has(nm.object.name)) name = `${bound.get(nm.object.name)}${nm.property.name}`;
      if (!name || (o.wanted && !o.wanted.has(name))) return;
      const props: Record<string, string> = {};
      const dynamic: string[] = [];
      for (const a of x.openingElement.attributes) {
        if (a.type === 'JSXSpreadAttribute') { dynamic.push('...'); continue; }
        if (a.name?.type !== 'JSXIdentifier') continue;
        const k: string = a.name.name;
        if (NOT_A_PROP.test(k)) continue;
        const v = literalOf(a.value);
        if (v === undefined) dynamic.push(k); else props[k] = v;
      }
      uses.push({ file, line: x.loc?.start.line ?? 0, component: name, props, dynamic });
    });
  }
  return { uses, files: files.length, unread };
}

/** Props that say what an element does, not how it looks. */
export const NOT_LOOK = /^(type|form|name|value|disabled|tabIndex|role|href|to|target|rel|htmlFor|placeholder|autoFocus|asChild|render|open|defaultOpen|checked|defaultChecked)$/;
/** What the system says about one component's look: the axes it has, and the value each takes when none is set. */
export interface SystemLook { component: string; axes?: Record<string, string[]> | undefined; defaults?: Record<string, string> | undefined }
/**
 * What counts as the same look, one rule for what the crawler looks for and what a card shows: a use matches
 * on the system's axes with their defaults filled in, so `variant="link"` is the look a card calls
 * `variant link, size default`, and `disabled={busy}` says nothing about it.
 */
export function lookRules(system: readonly SystemLook[] | null | undefined) {
  const axesOf = new Map((system ?? []).map((c) => [c.component, Object.keys({ ...(c.axes ?? {}), ...(c.defaults ?? {}) })]));
  const defaultsOf = new Map((system ?? []).map((c) => [c.component, c.defaults ?? {}]));
  const counts = (use: string, k: string) => { const axes = axesOf.get(use); return axes?.length ? axes.includes(k) : !NOT_LOOK.test(k); };
  const look = (use: string, props: Record<string, unknown> | null | undefined) => canonicalProps(Object.fromEntries(Object.entries(props ?? {}).filter(([k]) => counts(use, k))), defaultsOf.get(use) ?? {});
  return {
    look,
    key: (use: string, props: Record<string, unknown> | null | undefined) => `${use}|${JSON.stringify(look(use, props))}`,
    /** An axis set from the code, or a spread, might be anything: its look isn't known. */
    unknown: (use: string, dynamic: readonly string[] | null | undefined) => (dynamic ?? []).some((k) => k === '...' || counts(use, k)),
    defaults: (use: string) => defaultsOf.get(use) ?? {},
  };
}

/** One app's uses of the system's components, each with the key a photo of it is stored under ("file:line", as the tagger names the file). */
export function appUses(root: string, config: Config, t: Target, wanted: Set<string>) {
  const found = findUses({ dir: t.dir, packages: allDsPackages(config), wanted, exclude: [...defaultExcludes(root), ...(config.exclude ?? []).map((e: string) => path.resolve(root, e)), ...(t.exclude ?? []), ...usageExcludes(t.dir)], aliases: t.aliases });
  return { files: found.files, unread: found.unread, uses: found.uses.map(u => ({ ...u, shown: displayPath(root, u.file, t.dir), key: `${displayPath(root, u.file, t.dir)}:${u.line}` })) };
}
