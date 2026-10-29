import { jsxName, memberName, visit } from './ast.js';

/**
 * Which state a className condition reads. Four ARIA contracts look alike in markup and must not be
 * collapsed into "toggle": disclosure (expanded), a pressed latch, one-of-set selection (equality),
 * and the current location (nav). Strongest wins when a test reads several.
 */
export type SwitchKind = 'none' | 'equality' | 'pressed' | 'expanded' | 'current';
const RANK: Record<SwitchKind, number> = { none: 0, equality: 1, pressed: 2, current: 3, expanded: 4 };
const EXPANDED_ID = /^(is)?(open|opened|expanded|collapsed|shown|visible)$|^getIs(Expanded|Open)$/i;
const PRESSED_ID = /^(is)?(pressed|on|checked|selected|active|enabled)$/i;
const CURRENT_ID = /^(is)?current$/i;

export function switchKindOf(test: any): SwitchKind {
  let k: SwitchKind = 'none';
  const bump = (x: SwitchKind) => { if (RANK[x] > RANK[k]) k = x; };
  visit(test, (t: any) => {
    if (t.type === 'BinaryExpression' && (t.operator === '===' || t.operator === '==')) bump('equality');
    if (t.type === 'Identifier') {
      if (EXPANDED_ID.test(t.name)) bump('expanded');
      else if (CURRENT_ID.test(t.name)) bump('current');
      else if (PRESSED_ID.test(t.name)) bump('pressed');
    }
    if (t.type === 'MemberExpression') {
      const m = memberName(t);
      if (/current/i.test(m)) bump('current');
      else if (/selected|active|checked|pressed/i.test(m)) bump('pressed');
    }
  });
  return k;
}
/** The flags a class condition reads (`active`, `isOpen`, `item.selected` → selected), for the rules' reasons and vocabulary checks. */
export function switchNamesOf(test: any): string[] {
  const out = new Set<string>();
  visit(test, (t: any) => {
    if (t.type === 'Identifier' && (EXPANDED_ID.test(t.name) || CURRENT_ID.test(t.name) || PRESSED_ID.test(t.name))) out.add(t.name);
  });
  return [...out];
}
export const strongerSwitch = (a: SwitchKind, b: SwitchKind): SwitchKind => RANK[b] > RANK[a] ? b : a;

/** Classes that only move or animate (rotate a chevron); a switch on these alone isn't a selected look. */
export const TRANSFORM_ONLY = /^-?(rotate|scale|translate)-|^-?translate-|^transition|^duration-/;

export type HandlerIntent = 'disclose' | 'toggle' | 'select' | 'navigate' | 'open' | 'back';
const DISCLOSE = /^set(Is)?(Open|Opened|Expanded|Collapsed)$|^toggle(Sidebar|Expanded|Open|Panel|View|Collapsed|Collapse|Expand|Section|Details?|Drawer|Rail)\w*$|^on(Expand|Collapse)\w*$|^onToggle(Expand|Open|Panel|View|Sidebar|Collapse|Section|Details?|Drawer|Rail)\w*$/;
// openRow, onOpenMaterial, and a bare onOpen (opts.onOpen(row), args.onOpen?.()). onOpenChange opens a popover, not a record.
const OPEN_RECORD = /^(open[A-Z]\w*|onOpen(?!Change$)(?:[A-Z]\w*)?|handleOpen(?:[A-Z]\w*)?)$/;
const BACK = /^(onBack|goBack|handleBack|navigateBack)$/;
const NAVIGATE = /^(navigate|onNavigate|go(To)?[A-Z]\w*)$|(^|\.)(router|history)\./;

/**
 * What the onClick handler does, read from the names it calls: opens/closes something (disclose),
 * picks a value from the set it's rendered in (select), moves somewhere (navigate), opens a record
 * (open: openRow, onOpenMaterial), leaves a detail view (back: onBack, setOpenId(null)), or flips
 * a flag it doesn't name as a panel (toggle: onToggle, setBold(!bold)). `setOpen(false)` beside another
 * call is closing a popover on the way somewhere, not a disclosure.
 */
export function handlerIntentOf(onClick: any, mapParams: Set<string>, hasAriaCurrent: boolean): HandlerIntent | undefined {
  if (!onClick) return undefined;
  const expr = onClick.type === 'JSXExpressionContainer' ? onClick.expression : onClick;
  const calls: { name: string; full: string; args: any[] }[] = [];
  if (expr.type === 'Identifier') calls.push({ name: expr.name, full: expr.name, args: [] });
  else if (expr.type === 'MemberExpression' || expr.type === 'OptionalMemberExpression') { const full = memberName(expr); calls.push({ name: full.split('.').pop()!, full, args: [] }); }
  else visit(expr, (n: any) => {
    // onOpen?.(row) parses as an OptionalCallExpression, and opts?.onOpen() has an optional member callee.
    if (n.type !== 'CallExpression' && n.type !== 'OptionalCallExpression') return;
    const full = n.callee.type === 'Identifier' ? n.callee.name : /^(Optional)?MemberExpression$/.test(n.callee.type) ? memberName(n.callee) : '';
    if (full) calls.push({ name: full.split('.').pop()!, full, args: n.arguments });
  });
  const literalBool = (c: { args: any[] }) => c.args.length === 1 && c.args[0].type === 'BooleanLiteral';
  if (calls.some(c => DISCLOSE.test(c.name) && !(/^set/.test(c.name) && literalBool(c)))) return 'disclose';
  if (calls.some(c => BACK.test(c.name) || (/^set[A-Z]\w*(Id|Selected|Open)$/.test(c.name) && c.args.length === 1 && c.args[0].type === 'NullLiteral'))) return 'back';
  if (calls.some(c => OPEN_RECORD.test(c.name))) return 'open';
  const negates = (a: any) => { let n = false; visit(a, (x: any) => { if (x.type === 'UnaryExpression' && x.operator === '!') n = true; }); return n; };
  if (calls.some(c => /^(on)?[Tt]oggle\w*$/.test(c.name) || (/^set[A-Z]/.test(c.name) && c.args.length === 1 && negates(c.args[0])))) return 'toggle';
  if (calls.some(c => NAVIGATE.test(c.full) || NAVIGATE.test(c.name)) || (hasAriaCurrent && calls.some(c => /^on(Select|SectionChange|Change)$/.test(c.name)))) return 'navigate';
  const fromSet = (a: any) => {
    let hit = a.type === 'StringLiteral' || a.type === 'NumericLiteral';
    visit(a, (x: any) => { if (x.type === 'Identifier' && mapParams.has(x.name)) hit = true; });
    return hit;
  };
  if (calls.some(c => /^(set|on|select|pick|choose)[A-Z]?/.test(c.name) && c.args.length && c.args.every(fromSet))) return 'select';
  return undefined;
}

/** Parameter names of the innermost .map() callback around the element (its item, index…). */
export function mapParamsOf(ancestors: any[]): Set<string> {
  const out = new Set<string>();
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type !== 'CallExpression' || a.callee?.property?.name !== 'map') continue;
    const fn = a.arguments?.[0];
    for (const p of fn?.params ?? []) visit(p, (x: any) => { if (x.type === 'Identifier') out.add(x.name); });
    break;
  }
  return out;
}

const literalAttr = (el: any, name: string): string | undefined => {
  const a = el.openingElement.attributes.find((x: any) => x.name?.name === name);
  const v = a?.value;
  return v?.type === 'StringLiteral' ? v.value : v?.expression?.type === 'StringLiteral' ? v.expression.value : undefined;
};

/** Set and nav context the class names can't show: a role on a wrapper, sibling buttons, a sidebar. */
/** Wrappers that hold one control's parts: a menu or popup surface, a group, a toolbar, a segmented set. */
const CONTAINER_NAME = /(Menu|Popover|Popup|Float|Dropdown|ToggleGroup|ButtonGroup|Toolbar|Segment|TabsList|TabList|RadioGroup|InputGroup|Listbox)/;

export function setContextOf(ancestors: any[], el: any): { parentRole?: string | undefined; siblingButtons: number; inSidebar: boolean; container?: { name: string; line: number } } {
  let parentRole: string | undefined;
  let seen = 0, parent: any = null, inSidebar = false, container: { name: string; line: number } | undefined;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type !== 'JSXElement') continue;
    if (!parent) parent = a;
    const nm = jsxName(a.openingElement.name);
    // Structure only: the system's own Sidebar parts. An <aside> is any side panel (placement.ts); host names don't count.
    if (/^Sidebar/.test(nm)) inSidebar = true;
    const near = seen++ < 4;
    const r = near ? literalAttr(a, 'role') : undefined;
    if (r && !parentRole && /^(group|radiogroup|toolbar|tablist|listbox|menu|menubar|navigation)$/.test(r)) parentRole = r;
    // For grouping the review, not for classifying: the nearest wrapper that holds this control's parts.
    if (near && !container && ((r && /^(group|radiogroup|toolbar|tablist|listbox|menu|menubar)$/.test(r)) || CONTAINER_NAME.test(nm))) container = { name: r ? `role=${r}` : nm, line: a.loc?.start.line ?? 0 };
  }
  // Only look-alike siblings make a set: same attributes (Cancel beside Save, or a row's expander, don't).
  const attrNames = (x: any) => x.openingElement.attributes.map((a: any) => a.name?.name).filter((n: any) => n && n !== 'key').sort().join(',');
  const mine = attrNames(el);
  const siblingButtons = parent ? (parent.children ?? []).filter((c: any) => c !== el && c.type === 'JSXElement' && jsxName(c.openingElement.name) === 'button' && attrNames(c) === mine).length : 0;
  // Buttons side by side in one parent (a confirm/cancel pair, a hand-built segmented control) are one control too.
  const buttonsBeside = parent ? (parent.children ?? []).filter((c: any) => c !== el && c.type === 'JSXElement' && jsxName(c.openingElement.name) === 'button').length : 0;
  if (!container && parent && buttonsBeside > 0) container = { name: jsxName(parent.openingElement.name), line: parent.loc?.start.line ?? 0 };
  return { parentRole, siblingButtons, inSidebar, ...(container ? { container } : {}) };
}
