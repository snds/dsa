import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { ElementFeatures } from './scanners/features.js';
import type { Instance, Lookalike } from './types.js';

/**
 * The TypeScript checker, run with the consumer's own tsconfig (review item 17). Babel reads the code as
 * written; the checker knows what it means. It resolves, for raw elements the Babel pass couldn't read:
 *
 * - spreads: `<input {...getInputProps()} />` carries `type: "file"`; a wrapper's `{...props}` carries
 *   whatever its props type allows.
 * - class constants: `className={BTN}` where BTN's type is a string literal (or a union of them).
 * - the system's prop unions: the values a component's props accept (Button size "xs" | "sm" | …), read
 *   from a use of the component in the consumer's code.
 *
 * Optional and fast: it runs only when the app has a tsconfig and a `typescript` package can be loaded
 * (the app's own first), only over files with something to resolve, and it says so when it skips.
 * What it can't resolve is reported as unresolved, and the classifier abstains on it.
 */

/** Attributes that change what an element is (and so what replaces it). */
const DECIDING = ['type', 'role', 'aria-pressed', 'aria-current', 'aria-selected', 'aria-expanded'];

export interface TypedFacts {
  /** The spread, as the checker sees it: resolved (every deciding attribute is fixed or absent), or not. */
  spread?: { resolved: boolean; attrs: Record<string, string>; open: string[]; text: string } | undefined;
  /** className parts the checker turned into literal classes, and constants it couldn't. */
  classes?: { tokens: string[]; conditional: string[]; via: string[]; unresolved: string[] } | undefined;
}

export interface Checker {
  ok: true;
  facts(absFile: string, line: number, col: number | undefined, tag: string): TypedFacts | undefined;
  /** Allowed literal values per prop of a JSX component used at this place (its props' unions). */
  propUnions(absFile: string, line: number, component: string): Record<string, string[]> | undefined;
}
export type CheckerResult = Checker | { ok: false; note: string };

function loadTs(appDir: string): any {
  for (const from of [path.join(appDir, 'package.json'), import.meta.url]) {
    try { return createRequire(from)('typescript'); } catch { /* try the next */ }
  }
  return null;
}

/** Nearest tsconfig.json at or above the app's folder, but not above `stop`. */
function tsconfigFor(appDir: string, stop: string): string | undefined {
  let d = path.resolve(appDir);
  const end = path.resolve(stop);
  for (;;) {
    const f = path.join(d, 'tsconfig.json');
    if (fs.existsSync(f)) return f;
    const up = path.dirname(d);
    if (up === d || !(d + path.sep).startsWith(end + path.sep) || d === end) return undefined;
    d = up;
  }
}

/**
 * Open a checker over `files` (absolute paths) with the app's tsconfig. Returns a note instead when there
 * is no tsconfig, no `typescript`, or the program can't be built.
 */
export function openChecker(appDir: string, files: string[], root = appDir): CheckerResult {
  const config = tsconfigFor(appDir, root);
  if (!config) return { ok: false, note: 'no tsconfig.json for the app' };
  const ts = loadTs(appDir);
  if (!ts) return { ok: false, note: 'no typescript package to load' };
  if (!files.length) return { ok: false, note: 'nothing to resolve' };
  let program: any;
  try {
    const parsed = ts.getParsedCommandLineOfConfigFile(config, { noEmit: true, skipLibCheck: true }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    const options = { ...(parsed?.options ?? {}), noEmit: true, skipLibCheck: true, allowJs: true, jsx: parsed?.options?.jsx ?? ts.JsxEmit.Preserve };
    program = ts.createProgram({ rootNames: files, options });
  } catch (e: any) {
    return { ok: false, note: `the program didn't build (${String(e?.message ?? e).split('\n')[0]!.slice(0, 120)})` };
  }
  const checker = program.getTypeChecker();

  const literals = (t: any): string[] | undefined => {
    if (!t) return undefined;
    if (t.isUnion?.()) {
      const parts = t.types.filter((x: any) => !(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
      const out: string[] = [];
      for (const p of parts) { const l = literals(p); if (!l) return undefined; out.push(...l); }
      return out;
    }
    if (t.isStringLiteral?.()) return [t.value];
    if (t.flags & ts.TypeFlags.BooleanLiteral) return [checker.typeToString(t)];
    if (t.isNumberLiteral?.()) return [String(t.value)];
    return undefined;
  };

  const find = (absFile: string, line: number, col: number | undefined, pred: (n: any) => boolean): any => {
    const sf = program.getSourceFile(absFile);
    if (!sf) return undefined;
    let hit: any;
    const walk = (n: any) => {
      if (hit) return;
      if (pred(n)) {
        const at = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        if (at.line + 1 === line && (!col || at.character + 1 === col)) { hit = n; return; }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return hit;
  };
  const opening = (n: any) => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n);

  return {
    ok: true,
    facts(absFile, line, col, tag) {
      const el = find(absFile, line, col, n => opening(n) && n.tagName.getText() === tag);
      if (!el) return undefined;
      const out: TypedFacts = {};
      for (const a of el.attributes.properties) {
        if (ts.isJsxSpreadAttribute(a)) {
          const t = checker.getTypeAtLocation(a.expression);
          const attrs: Record<string, string> = {}, open: string[] = [];
          const text = a.expression.getText().slice(0, 60);
          if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) { out.spread = { resolved: false, attrs, open: ['any'], text }; continue; }
          for (const k of DECIDING) {
            const p = t.getProperty?.(k) ?? checker.getPropertyOfType(t, k);
            if (!p) continue;
            const vt = checker.getTypeOfSymbolAtLocation(p, a.expression);
            const l = literals(vt);
            if (l && l.length === 1) attrs[k] = l[0]!;
            else open.push(k);
          }
          // An index signature can carry anything.
          if (checker.getIndexInfosOfType?.(t)?.some((i: any) => i.keyType.flags & ts.TypeFlags.String)) open.push('index');
          // A spread of an element's own HTML attributes passes type and role through from callers.
          out.spread = { resolved: open.length === 0, attrs, open, text };
        } else if (a.name?.getText() === 'className' && a.initializer) {
          const expr = ts.isJsxExpression(a.initializer) ? a.initializer.expression : a.initializer;
          if (!expr || ts.isStringLiteral(expr)) continue;
          const cls = { tokens: [] as string[], conditional: [] as string[], via: [] as string[], unresolved: [] as string[] };
          const visit = (n: any) => {
            if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
              // A callee is a helper, not a value; a prop (a parameter) is an extension point, not a constant.
              if (ts.isCallExpression(n.parent) && n.parent.expression === n) return;
              if (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) return;
              const sym = checker.getSymbolAtLocation(n);
              const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
              if (!decl || ts.isParameter(decl) || (ts.isBindingElement(decl) && isParamBinding(ts, decl)) || (ts.isPropertySignature?.(decl))) return;
              const l = literals(checker.getTypeAtLocation(n));
              const words = (xs: string[]) => xs.flatMap(x => x.split(/\s+/)).filter(Boolean);
              if (l?.length === 1) { cls.tokens.push(...words(l)); cls.via.push(n.getText()); }
              else if (l && l.length > 1) { cls.conditional.push(...words(l)); cls.via.push(n.getText()); }
              else if (/^[A-Z][A-Z0-9_]*$|\./.test(n.getText()) || ts.isVariableDeclaration(decl)) cls.unresolved.push(n.getText());
              return;
            }
            ts.forEachChild(n, visit);
          };
          visit(expr);
          if (cls.tokens.length || cls.conditional.length || cls.unresolved.length) out.classes = cls;
        }
      }
      return out;
    },
    propUnions(absFile, line, component) {
      const el = find(absFile, line, undefined, n => opening(n) && n.tagName.getText() === component);
      if (!el) return undefined;
      const sig = checker.getResolvedSignature(el);
      const props = sig?.parameters?.[0] && checker.getTypeOfSymbolAtLocation(sig.parameters[0], el);
      if (!props) return undefined;
      const out: Record<string, string[]> = {};
      for (const p of checker.getPropertiesOfType(props)) {
        const l = literals(checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(p, el)));
        if (l && l.length > 1 && l.every(x => !/^(true|false)$/.test(x))) out[p.getName()] = [...new Set(l)];
      }
      return out;
    },
  };
}

function isParamBinding(ts: any, n: any): boolean {
  let p = n.parent;
  while (p && (ts.isObjectBindingPattern(p) || ts.isArrayBindingPattern(p) || ts.isBindingElement(p))) p = p.parent;
  return Boolean(p && ts.isParameter(p));
}

/** What a row needs from the checker: a spread, or className parts Babel couldn't read. */
export const needsTypes = (f: ElementFeatures) => f.framework === 'react' && (f.hasSpread || f.classes.unresolved.length > 0);

export interface TypeRefinement {
  checked: number; resolvedSpreads: number; unresolved: number; dropped: Lookalike[]; note?: string | undefined;
  /** The system's prop unions, per component, read at one use of each in the app. */
  unions: Map<string, Record<string, string[]>>;
}

/**
 * Fold the checker's facts into each row's features (in place): attributes a spread fixes, classes a
 * constant holds, and what stayed unresolved (features.typed). Inputs whose resolved type the element map
 * allows (a file input) are returned in `dropped`: they aren't look-alikes.
 */
export function refineWithTypes(rows: Lookalike[], absOf: (r: { file: string }) => string, appDir: string, root: string, allowTypes: string[], inputTypes: Record<string, string>, instances: Instance[] = [], want: Set<string> = new Set()): TypeRefinement {
  const todo = rows.filter(r => r.features && needsTypes(r.features));
  const res: TypeRefinement = { checked: 0, resolvedSpreads: 0, unresolved: 0, dropped: [], unions: new Map() };
  // One use per system component the recommendations can name, to read its prop unions.
  const uses = new Map<string, Instance>();
  for (const i of instances) if (want.has(i.component) && !uses.has(i.component)) uses.set(i.component, i);
  if (!todo.length && !uses.size) return res;
  const checker = openChecker(appDir, [...new Set([...todo.map(absOf), ...[...uses.values()].map(absOf)])], root);
  if (!checker.ok) { res.note = checker.note; return res; }
  for (const [name, i] of uses) {
    try { const u = checker.propUnions(absOf(i), i.line, name); if (u && Object.keys(u).length) res.unions.set(name, u); } catch { /* a use the checker can't read */ }
  }
  for (const r of todo) {
    const f = r.features!;
    const facts = checker.facts(absOf(r), r.line, r.col ?? f.col, f.element);
    if (!facts) continue;
    res.checked++;
    const typed: NonNullable<ElementFeatures['typed']> = {};
    if (facts.spread && f.hasSpread) {
      for (const [k, v] of Object.entries(facts.spread.attrs)) if (f.attrs[k] === undefined) f.attrs[k] = v;
      typed.spread = facts.spread.resolved ? 'resolved' : 'unresolved';
      typed.spreadText = facts.spread.text;
      if (!facts.spread.resolved) typed.open = facts.spread.open;
      if (facts.spread.resolved) res.resolvedSpreads++; else res.unresolved++;
    }
    if (facts.classes) {
      const c = f.classes;
      c.tokens = [...new Set([...c.tokens, ...facts.classes.tokens, ...facts.classes.conditional])];
      c.conditional = [...new Set([...c.conditional, ...facts.classes.conditional])];
      c.viaConst = [...new Set([...c.viaConst, ...facts.classes.via])];
      c.unresolved = c.unresolved.filter(u => !facts.classes!.via.includes(u));
      if (facts.classes.unresolved.length) { typed.classes = facts.classes.unresolved; res.unresolved++; }
    }
    f.typed = typed;
    if (f.element === 'input' && f.attrs.type) {
      const type = f.attrs.type.toLowerCase();
      if (allowTypes.includes(type)) res.dropped.push(r);
      else if (inputTypes[type]) r.component = inputTypes[type]!;
    }
  }
  return res;
}
