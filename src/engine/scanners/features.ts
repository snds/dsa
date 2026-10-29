import fs from 'node:fs';
import { parse as babelParse } from '@babel/parser';
import { resolveSpecifier } from '../modules.js';
import { collapse, jsxName, memberName, visit } from './ast.js';
import { childInfo, ICON_PACKAGE, type ChildInfo } from './children.js';
import { regionsOfAncestors } from '../placement.js';
import { tableInfo } from './table.js';
import { isSystemIcon, isSystemSource } from '../system.js';
import { handlerIntentOf, mapParamsOf, setContextOf, strongerSwitch, switchKindOf, switchNamesOf, TRANSFORM_ONLY, type HandlerIntent, type SwitchKind } from './semantics.js';

export { visit, visitWithAncestors } from './ast.js';
export type { ChildInfo } from './children.js';
export type { HandlerIntent, SwitchKind } from './semantics.js';

/**
 * Mechanical facts about one native element, read from the AST. No judgment here:
 * the classifier (classify.ts) turns these into a recommendation and a confidence.
 *
 * Class names are resolved through same-file constants, imported constants, clsx/cn calls,
 * and conditionals, because real code rarely puts classes inline (CRUMB_LINK, CELL_ICON_BUTTON_CLASS…).
 */
export interface ElementFeatures {
  element: string;
  framework: 'react' | 'vue' | 'angular';
  /** Literal attribute values; "\u0000dynamic" when computed. */
  attrs: Record<string, string>;
  /** For computed ARIA/role attributes, the string literals they can take (aria-current={x ? 'step' : undefined} → ['step']). */
  attrLiterals?: Record<string, string[]> | undefined;
  handlers: string[];
  /** What onClick does, from the names it calls (semantics.ts). Absent when unknown. */
  handlerIntent?: HandlerIntent | undefined;
  hasSpread: boolean;
  classes: ClassInfo;
  children: ChildInfo;
  context: ContextInfo;
  /** The opening tag, whitespace collapsed (for fingerprints and the report). */
  openTag: string;
  /** The whole element, whitespace collapsed, capped. */
  source: string;
  col: number;
  /** Table structure, when element is <table>. */
  table?: TableInfo | undefined;
  /** <select>: option count when literal. */
  optionCount?: number | undefined;
  /** The file calls .showModal() somewhere (dialogs). */
  fileUsesShowModal?: boolean | undefined;
}

export interface ClassInfo {
  /** Every class token that can appear, variant prefixes kept (hover:bg-accent). */
  tokens: string[];
  /** Tokens that only apply under a condition (ternary / && branches). */
  conditional: string[];
  /**
   * The conditional tokens of the "on" branch (a ternary's first branch, the right of &&, clsx object keys).
   * When nothing at rest draws a box, this is the resting look to compare (a primary "Select Image" that is
   * only filled once something is picked). Optional for old rows.
   */
  onBranch?: string[] | undefined;
  /** A branch flips on equality or a state flag. Kept for old consumers: true whenever switchKind isn't 'none'. */
  selectedSwitch: boolean;
  /** Which state the class condition reads (semantics.ts). Optional on rows written before it existed. */
  switchKind?: SwitchKind | undefined;
  /** The state flags the class conditions read (active, isOpen, selected). */
  switchNames?: string[] | undefined;
  /** Every conditional class only rotates/scales/translates/animates (a turning chevron, not a selected look). */
  switchTokensOnlyTransform?: boolean | undefined;
  /** Constants the classes came from (CRUMB_LINK, ./styles#PILL). */
  viaConst: string[];
  /** Parts that could not be resolved statically (helper(), props.className, styles.x). */
  unresolved: string[];
  /** className was present at all. */
  present: boolean;
}

export interface ContextInfo {
  /** Nearest JSX ancestors, innermost first (tags and component names). */
  ancestors: string[];
  /** Rendered inside .map() — one of a repeated set. */
  inMap: boolean;
  inTableCell: boolean;
  inList: boolean;
  inNav: boolean;
  inForm: boolean;
  /** A literal role on a wrapper within 4 levels (group, radiogroup, toolbar, tablist…). */
  parentRole?: string | undefined;
  /** Other <button>s directly beside it in the same parent (a hand-built segmented control). */
  siblingButtons?: number | undefined;
  /** The nearest wrapper holding this control's parts (a menu surface, a group, buttons side by side), for grouping the review. */
  container?: { name: string; line: number } | undefined;
  /** Inside a system Sidebar part (Sidebar, SidebarContent…), or a rail the page measured (placement.ts). */
  inSidebar?: boolean | undefined;
  /** Regions around it (placement.ts), innermost first: from this file, then the render chain and the page. */
  regions?: import('../placement.js').Region[] | undefined;
  /** Enclosing component or function name. */
  within: string;
  /**
   * What has to be true for the element to render, innermost first: {cond && <x/>}, ternaries,
   * `if (!open) return null` before the JSX, and an enclosing overlay (Dialog, Sheet, Popover…).
   */
  gates?: Gate[] | undefined;
}

export interface Gate {
  kind: 'cond' | 'early-return' | 'overlay';
  /** The condition's source, collapsed and capped (`isEditing`, `!value`, `mode === 'edit'`). */
  test: string;
  /** Renders when the test is false (`else` branch, `if (x) return null`). */
  negated: boolean;
  /** Identifiers the test reads (state, props, member names), for tracing who sets them. */
  ids: string[];
  /** For overlays: the container (Dialog, Sheet…) and the label of its trigger in the same JSX, if any. */
  overlay?: string | undefined;
  trigger?: string | undefined;
  /** Source range of what the gate guards (the branch, or the overlay): controls inside it can't open it. */
  at?: [number, number] | undefined;
}

export interface TableInfo {
  hasThead: boolean;
  /** <th> written in the code (not rendered from a loop). */
  headerCells: number;
  /** A loop renders rows in the body: <tr>s or a row component ({tokens.map(t => <TokenRow/>)}). */
  rowsMapped: boolean;
  /** Body <tr>s written in the code (not rendered from a loop, not the header row). */
  literalRows: number;
  rowClick: boolean;
  headerClick: boolean;
  hasCheckbox: boolean;
  /** Header cells rendered from a loop: the columns come from data. Optional on old rows. */
  headersMapped?: boolean | undefined;
  /** Body cells rendered from a loop inside a row (a comparison table's columns). */
  cellsMapped?: boolean | undefined;
  /** Where checkboxes sit: the first column only (row selection), or other cells too (a form grid). */
  checkboxes?: 'selection' | 'grid' | undefined;
  /** Editors inside body cells: inputs, selects, inline editors, contentEditable. */
  cellEditors?: number | undefined;
  /** Buttons and links inside body cells (row actions, row-header buttons). */
  cellButtons?: number | undefined;
  /** Rows open and close: aria-expanded, an expand handler, or a row rendered only when expanded. */
  expandableRows?: boolean | undefined;
  /** The header sorts: aria-sort, or a header handler that names sorting. */
  sortable?: boolean | undefined;
}

export const DYNAMIC = '\u0000dynamic';

// ---------- constants: same file and imported ----------

interface FileConsts { strings: Map<string, { tokens: string[]; conditional: string[] }>; helpers: Map<string, string[]>; imports: Map<string, { spec: string; name: string }>; aliases: Map<string, string>; reexports: Map<string, { spec: string; name: string }> }
const constCache = new Map<string, FileConsts>();

export function fileConsts(file: string, ast?: any): FileConsts {
  const hit = constCache.get(file);
  if (hit) return hit;
  const out: FileConsts = { strings: new Map(), helpers: new Map(), imports: new Map(), aliases: new Map(), reexports: new Map() };
  constCache.set(file, out);
  if (!ast) {
    try { ast = babelParse(fs.readFileSync(file, 'utf8'), { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'typescript'] }); } catch { return out; }
  }
  for (const stmt of ast.program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (stmt.type === 'ExportNamedDeclaration' && stmt.source) {
      for (const sp of stmt.specifiers ?? []) out.reexports.set(sp.exported.name ?? sp.exported.value, { spec: stmt.source.value, name: sp.local.name ?? sp.local.value });
      continue;
    }
    if (stmt.type === 'ImportDeclaration') {
      for (const sp of stmt.specifiers ?? []) if (sp.type === 'ImportSpecifier') out.imports.set(sp.local.name, { spec: stmt.source.value, name: sp.imported.name ?? sp.imported.value });
      continue;
    }
    if (!decl) continue;
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id?.type !== 'Identifier' || !d.init) continue;
        const init = d.init.type === 'TSAsExpression' ? d.init.expression : d.init;
        if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') out.helpers.set(d.id.name, literalsIn(init.body));
        else if (init.type === 'Identifier') out.aliases.set(d.id.name, init.name);
        else {
          const parts = { tokens: [] as string[], conditional: [] as string[] };
          collectLiteral(init, parts, false);
          if (parts.tokens.length || parts.conditional.length) out.strings.set(d.id.name, parts);
        }
      }
    }
    if (decl.type === 'FunctionDeclaration' && decl.id) out.helpers.set(decl.id.name, literalsIn(decl.body));
  }
  // Component-local constants (const plusNoun = SC_LINK inside a function). Top-level wins on name clashes.
  visit(ast.program, (n: any) => {
    if (n.type !== 'VariableDeclarator' || n.id?.type !== 'Identifier' || !n.init) return;
    const name = n.id.name;
    if (out.strings.has(name) || out.helpers.has(name) || out.aliases.has(name)) return;
    const init = n.init.type === 'TSAsExpression' ? n.init.expression : n.init;
    if (init.type === 'Identifier') { out.aliases.set(name, init.name); return; }
    if (init.type === 'StringLiteral' || init.type === 'TemplateLiteral' || (init.type === 'CallExpression' && isClassFn(init.callee))) {
      const parts = { tokens: [] as string[], conditional: [] as string[] };
      collectLiteral(init, parts, false);
      if (parts.tokens.length || parts.conditional.length) out.strings.set(name, parts);
    }
  });
  return out;
}

function literalsIn(node: any): string[] {
  const t: string[] = [];
  visit(node, (n: any) => {
    if (n.type === 'StringLiteral') t.push(...split(n.value));
    else if (n.type === 'TemplateLiteral') for (const q of n.quasis) t.push(...split(q.value.cooked ?? ''));
  });
  return t;
}

/** Literal-only class collection for constants (no identifiers resolved at this level). */
function collectLiteral(n: any, parts: { tokens: string[]; conditional: string[] }, cond: boolean) {
  if (!n) return;
  if (n.type === 'StringLiteral') (cond ? parts.conditional : parts.tokens).push(...split(n.value));
  else if (n.type === 'TemplateLiteral') for (const q of n.quasis) (cond ? parts.conditional : parts.tokens).push(...split(q.value.cooked ?? ''));
  else if (n.type === 'CallExpression' && isClassFn(n.callee)) for (const a of n.arguments) collectLiteral(a, parts, cond);
  else if (n.type === 'ConditionalExpression') { collectLiteral(n.consequent, parts, true); collectLiteral(n.alternate, parts, true); }
  else if (n.type === 'LogicalExpression') collectLiteral(n.right, parts, true);
  else if (n.type === 'ArrayExpression') for (const e of n.elements) collectLiteral(e, parts, cond);
}

const isClassFn = (c: any) => c?.type === 'Identifier' && /^(clsx|cn|cx|classnames|classNames|twMerge|tw)$/.test(c.name);
const split = (s: string) => s.split(/\s+/).filter(Boolean);

function lookupConst(file: string, name: string, aliases: [string, string][], depth = 0): { tokens: string[]; conditional: string[]; helper?: boolean | undefined; from: string } | null {
  const fc = fileConsts(file);
  const s = fc.strings.get(name);
  if (s) return { ...s, from: name };
  const h = fc.helpers.get(name);
  if (h) return { tokens: [], conditional: h, helper: true, from: `${name}()` };
  const alias = fc.aliases.get(name);
  if (alias && alias !== name && depth < 4) { const r = lookupConst(file, alias, aliases, depth + 1); if (r) return { ...r, from: `${name}=${r.from}` }; }
  const imp = fc.imports.get(name) ?? fc.reexports.get(name);
  if (imp && depth < 4) {
    const target = resolveSpecifier(file, imp.spec, aliases);
    if (target) {
      const r = lookupConst(target, imp.name, aliases, depth + 1);
      if (r) return { ...r, from: `${imp.spec}#${r.from}` };
    }
  }
  return null;
}

// ---------- className analysis ----------

export function classInfo(value: any, file: string, aliases: [string, string][]): ClassInfo {
  const info: ClassInfo = { tokens: [], conditional: [], onBranch: [], selectedSwitch: false, switchKind: 'none', switchTokensOnlyTransform: false, viaConst: [], unresolved: [], present: Boolean(value) };
  // on: every condition above this node is on its "on" side (a ternary's first branch, the right of &&).
  const push = (list: string[], cond: boolean, on: boolean) => {
    (cond ? info.conditional : info.tokens).push(...list);
    if (cond && on) info.onBranch!.push(...list);
  };
  const walkVal = (n: any, cond: boolean, on = true) => {
    if (!n) return;
    switch (n.type) {
      case 'JSXExpressionContainer': return walkVal(n.expression, cond, on);
      case 'StringLiteral': push(split(n.value), cond, on); return;
      case 'TemplateLiteral':
        for (const q of n.quasis) push(split(q.value.cooked ?? ''), cond, on);
        for (const e of n.expressions) walkVal(e, true, on);
        return;
      case 'Identifier': {
        const c = lookupConst(file, n.name, aliases);
        if (!c) { info.unresolved.push(n.name); return; }
        info.viaConst.push(c.from);
        push(c.tokens, cond, on);
        info.conditional.push(...c.conditional);
        if (c.helper) info.unresolved.push(c.from + ' (branches unknown)');
        return;
      }
      case 'CallExpression':
        if (isClassFn(n.callee)) { for (const a of n.arguments) walkVal(a, cond, on); return; }
        if (n.callee.type === 'Identifier') {
          const c = lookupConst(file, n.callee.name, aliases);
          if (c) { info.viaConst.push(c.from.endsWith(')') ? c.from : `${c.from}()`); info.conditional.push(...c.tokens, ...c.conditional); }
          info.unresolved.push(`${n.callee.name}()`);
          for (const a of n.arguments) if (a.type === 'BinaryExpression' || a.type === 'Identifier' || a.type === 'MemberExpression') markSelected(a);
          return;
        }
        info.unresolved.push('call');
        return;
      case 'ConditionalExpression':
        markSelected(n.test);
        walkVal(n.consequent, true, on); walkVal(n.alternate, true, false);
        return;
      case 'LogicalExpression':
        if (n.operator === '&&') { markSelected(n.left); walkVal(n.right, true, on); }
        else { walkVal(n.left, cond, on); walkVal(n.right, true, false); }
        return;
      case 'ArrayExpression': for (const e of n.elements) walkVal(e, cond, on); return;
      case 'ObjectExpression':
        // clsx({ 'bg-primary': active })
        for (const p of n.properties) if (p.type === 'ObjectProperty') {
          const k = p.key.type === 'StringLiteral' ? p.key.value : p.key.name;
          if (k) push(split(k), true, on);
          markSelected(p.value);
        }
        return;
      case 'TSAsExpression': return walkVal(n.expression, cond, on);
      case 'MemberExpression': info.unresolved.push(memberName(n)); return;
      default: info.unresolved.push(n.type);
    }
  };
  const markSelected = (test: any) => {
    const k = switchKindOf(test);
    if (k === 'none') return;
    info.selectedSwitch = true;
    info.switchKind = strongerSwitch(info.switchKind ?? 'none', k);
    info.switchNames = [...new Set([...(info.switchNames ?? []), ...switchNamesOf(test)])];
  };
  walkVal(value, false);
  info.tokens = [...new Set(info.tokens)];
  info.conditional = [...new Set(info.conditional)].filter(t => !info.tokens.includes(t));
  info.onBranch = [...new Set(info.onBranch)].filter(t => !info.tokens.includes(t));
  info.switchTokensOnlyTransform = info.selectedSwitch && info.conditional.length > 0 && info.conditional.every(t => TRANSFORM_ONLY.test(t.replace(/^([a-z-]+:)+/, '')));
  return info;
}

// ---------- the element ----------

export function reactFeatures(el: any, ancestors: any[], src: string, file: string, aliases: [string, string][]): ElementFeatures {
  const open = el.openingElement;
  const element = open.name.name as string;
  const attrs: Record<string, string> = {};
  const attrLiterals: Record<string, string[]> = {};
  const handlers: string[] = [];
  let hasSpread = false;
  let classAttr: any = null, onClick: any = null;
  for (const a of open.attributes) {
    if (a.type === 'JSXSpreadAttribute') { hasSpread = true; continue; }
    const name = typeof a.name?.name === 'string' ? a.name.name : null;
    if (!name) continue;
    if (/^on[A-Z]/.test(name)) handlers.push(name);
    if (name === 'className' || name === 'class') classAttr = a.value;
    if (name === 'onClick') onClick = a.value;
    const v = a.value, e = v?.type === 'JSXExpressionContainer' ? v.expression : null;
    if (!v) attrs[name] = '';
    else if (v.type === 'StringLiteral') attrs[name] = v.value;
    else if (e?.type === 'StringLiteral') attrs[name] = e.value;
    else if (e?.type === 'TemplateLiteral' && !e.expressions.length) attrs[name] = e.quasis[0].value.cooked;
    else if (e?.type === 'BooleanLiteral' || e?.type === 'NumericLiteral') attrs[name] = String(e.value);
    else {
      attrs[name] = DYNAMIC;
      if (/^(aria-|role$|data-state$)/.test(name)) { const lits: string[] = []; visit(e, (x: any) => { if (x.type === 'StringLiteral') lits.push(x.value); }); if (lits.length) attrLiterals[name] = lits; }
    }
  }
  const fc = fileConsts(file);
  const isIcon = (nm: string) => { const imp = fc.imports.get(nm); return Boolean(imp && (ICON_PACKAGE.test(imp.spec) || isSystemIcon(imp.spec, imp.name))); };
  const isSys = (nm: string) => importedFromSystem(file, nm, aliases);
  const classes = classInfo(classAttr, file, aliases);
  // `active` on an element that also carries aria-current is the current location, not a pressed state.
  if (classes.switchKind === 'pressed' && attrs['aria-current'] !== undefined) classes.switchKind = 'current';
  const f: ElementFeatures = {
    element, framework: 'react', attrs, attrLiterals, handlers, hasSpread,
    handlerIntent: handlerIntentOf(onClick, mapParamsOf(ancestors), attrs['aria-current'] !== undefined),
    classes,
    children: childInfo(el.children ?? [], isIcon, isSys),
    context: { ...contextInfo(ancestors), ...setContextOf(ancestors, el), gates: gatesFrom(ancestors, el, src), regions: regionsOfAncestors(ancestors) },
    openTag: collapse(src.slice(open.start, open.end)).slice(0, 400),
    source: collapse(src.slice(el.start, el.end)).slice(0, 700),
    col: (open.loc?.start.column ?? 0) + 1,
  };
  if (element === 'table') f.table = tableInfo(el);
  if (element === 'select') {
    let n = 0, mapped = false;
    visit(el, (x: any) => { if (x.type === 'JSXOpeningElement' && x.name?.name === 'option') n++; if (x.type === 'CallExpression' && x.callee?.property?.name === 'map') mapped = true; });
    f.optionCount = mapped ? -1 : n;
  }
  if (element === 'dialog') f.fileUsesShowModal = /\.showModal\(/.test(src);
  return f;
}

function contextInfo(ancestors: any[]): ContextInfo {
  const names: string[] = [];
  let inMap = false, within = '';
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type === 'JSXElement') names.push(jsxName(a.openingElement.name));
    if (a.type === 'CallExpression' && a.callee?.property?.name === 'map') inMap = true;
    if (!within) {
      if ((a.type === 'FunctionDeclaration' || a.type === 'ClassDeclaration') && a.id) within = a.id.name;
      if (a.type === 'VariableDeclarator' && a.id?.type === 'Identifier' && /Function|Arrow|Call/.test(a.init?.type ?? '')) within = a.id.name;
    }
  }
  const near = names.slice(0, 12);
  return {
    ancestors: near,
    inMap,
    inTableCell: near.some(n => n === 'td' || n === 'th' || /Cell$|TableCell/.test(n)),
    inList: near.some(n => n === 'ul' || n === 'ol' || n === 'li' || /List|Menu|Popover|Command/.test(n)),
    inNav: near.some(n => n === 'nav' || /Breadcrumb|Nav/.test(n)),
    inForm: near.some(n => n === 'form' || /Form/.test(n)),
    within,
  };
}

const OVERLAY = /^(Dialog|AlertDialog|Sheet|Drawer|Modal|Popover|DropdownMenu|ContextMenu|HoverCard|Tooltip|Collapsible|Accordion|Command|Menubar|NavigationMenu)/;
const CONTENT = /(Content|Panel|Body|Portal|Popup|SubContent)$/;

export function gatesFrom(ancestors: any[], el: any, src: string): Gate[] {
  const out: Gate[] = [];
  const text = (n: any) => collapse(src.slice(n.start, n.end)).slice(0, 80);
  const idsOf = (n: any) => { const ids = new Set<string>(); visit(n, (x: any) => { if (x.type === 'Identifier' && !/^(undefined|null|true|false)$/.test(x.name)) ids.add(x.name); if (x.type === 'MemberExpression' && x.property?.type === 'Identifier') ids.add(x.property.name); }); return [...ids]; };
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i], child = ancestors[i + 1] ?? el;
    if (a.type === 'LogicalExpression' && a.right === child) {
      out.push({ kind: 'cond', test: text(a.left), negated: a.operator !== '&&', ids: idsOf(a.left), at: [child.start, child.end] });
    } else if (a.type === 'ConditionalExpression' && (a.consequent === child || a.alternate === child)) {
      out.push({ kind: 'cond', test: text(a.test), negated: a.alternate === child, ids: idsOf(a.test), at: [child.start, child.end] });
    } else if (a.type === 'IfStatement' && (a.consequent === child || a.alternate === child)) {
      out.push({ kind: 'cond', test: text(a.test), negated: a.alternate === child, ids: idsOf(a.test), at: [child.start, child.end] });
    } else if (a.type === 'BlockStatement' && /Function|Arrow/.test(ancestors[i - 1]?.type ?? '')) {
      // Guards before the JSX: `if (!open) return null;` means it renders only when open.
      const idx = a.body.indexOf(child);
      for (const st of a.body.slice(0, Math.max(0, idx))) {
        if (st.type !== 'IfStatement' || st.alternate) continue;
        const c = st.consequent.type === 'BlockStatement' ? st.consequent.body[0] : st.consequent;
        if (c?.type !== 'ReturnStatement') continue;
        // `if (!open) return null` reads as "only when open".
        const t = st.test.type === 'UnaryExpression' && st.test.operator === '!' ? st.test.argument : null;
        out.push({ kind: 'early-return', test: text(t ?? st.test), negated: !t, ids: idsOf(st.test) });
      }
    } else if (a.type === 'JSXElement') {
      const nm = jsxName(a.openingElement.name);
      if (!OVERLAY.test(nm) || CONTENT.test(nm) || /Trigger$/.test(nm)) continue;
      // The root of an overlay (Dialog, not DialogContent): its open prop and its trigger's label.
      const attr = (n: string) => a.openingElement.attributes.find((x: any) => x.name?.name === n);
      const open = attr('open') ?? attr('isOpen') ?? attr('show');
      const g: Gate = { kind: 'overlay', overlay: nm, test: open?.value ? text(open.value.expression ?? open.value) : '', negated: false, ids: open?.value ? idsOf(open.value) : [], at: [a.start, a.end] };
      let trig: any = null;
      visit(a, (x: any) => { if (!trig && x.type === 'JSXElement' && /Trigger$/.test(jsxName(x.openingElement.name))) trig = x; });
      if (trig && !(trig.start <= el.start && el.end <= trig.end)) g.trigger = labelOf(trig);
      else if (trig) continue; // the element is the trigger itself: always visible
      out.push(g);
    }
  }
  return out;
}

/** Visible label of a JSX element: aria-label, title, or its text (including <Trans>…</Trans> and t`…`). */
export function labelOf(n: any): string {
  const attrs = n.openingElement?.attributes ?? [];
  for (const k of ['aria-label', 'title']) {
    const a = attrs.find((x: any) => x.name?.name === k);
    const v = a?.value?.type === 'StringLiteral' ? a.value.value : a?.value?.expression?.type === 'StringLiteral' ? a.value.expression.value : null;
    if (v) return v;
  }
  const parts: string[] = [];
  visit(n, (x: any) => {
    if (x.type === 'JSXText' && x.value.trim()) parts.push(x.value.trim());
    if (x.type === 'TaggedTemplateExpression' && x.tag?.name === 't') parts.push(x.quasi.quasis.map((q: any) => q.value.cooked).join(' ').trim());
  });
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Features for Vue/Angular templates, where only the tag and its attributes are known. */
export function templateFeatures(element: string, attrs: Record<string, string>, framework: 'vue' | 'angular', openTag: string): ElementFeatures {
  const cls = attrs.class ?? attrs[':class'] ?? '';
  return {
    element, framework, attrs, handlers: Object.keys(attrs).filter(k => /^(@|v-on:|\()/.test(k)), hasSpread: 'v-bind' in attrs,
    classes: { tokens: split(cls), conditional: [], selectedSwitch: false, switchKind: 'none', switchTokensOnlyTransform: false, viaConst: [], unresolved: attrs[':class'] ? [':class'] : [], present: Boolean(cls) },
    children: { text: '', dynamicText: 0, icons: 0, elements: [], images: 0, interactive: 0, iconSizes: [], badges: 0 },
    context: { ancestors: [], inMap: false, inTableCell: false, inList: false, inNav: false, inForm: false, within: '' },
    openTag: collapse(openTag).slice(0, 400), source: collapse(openTag).slice(0, 700), col: 1,
  };
}

export function resetFeatureCaches() { constCache.clear(); systemReexport.clear(); }

const systemReexport = new Map<string, boolean>();
/**
 * A name the file imports from the system: straight from one of its sources, or through a host file
 * that re-exports it (the host's ui/avatar.tsx: export * from "@acme/ui/avatar").
 */
export function importedFromSystem(file: string, name: string, aliases: [string, string][]): boolean {
  const imp = fileConsts(file).imports.get(name);
  if (!imp) return false;
  if (isSystemSource(imp.spec)) return true;
  if (!/^[.@~]/.test(imp.spec)) return false;
  const target = resolveSpecifier(file, imp.spec, aliases);
  if (!target) return false;
  const key = `${target}\u0001${imp.name}`;
  if (!systemReexport.has(key)) {
    const re = fileConsts(target).reexports.get(imp.name);
    let hit = Boolean(re && isSystemSource(re.spec));
    if (!hit) { try { hit = [...fs.readFileSync(target, 'utf8').matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)].some(m => isSystemSource(m[1]!)); } catch { /* unreadable: not the system */ } }
    systemReexport.set(key, hit);
  }
  return systemReexport.get(key)!;
}
