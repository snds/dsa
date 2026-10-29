import { collapse, jsxName, visit } from './ast.js';

/** What a native element renders inside it: label text, icons, badges, structure. */
export interface ChildInfo {
  /** Small count/status badges next to an icon or label (decoration, not structure). */
  badges: number;
  /** size props on icon children (xs, sm…). */
  iconSizes: string[];
  /** Literal text, trimmed and joined. Visually hidden text is not here (see srLabel). */
  text: string;
  /** {expressions} rendered as children that are not JSX (labels, counts). */
  dynamicText: number;
  /** Icon-like children: <Icon>, *Icon, svg, material-symbols spans, anything imported from an icon package. */
  icons: number;
  /** Other element children (div, span with content, img, components). */
  elements: string[];
  images: number;
  /** System components rendered inside (Avatar, ObjectThumb): the content is already composed from the system, not raw images. Optional for old rows. */
  systemParts?: string[] | undefined;
  /** Nested interactive elements (button, a, input) — invalid inside <button>, a sign of a region. */
  interactive: number;
  /**
   * Text inside `sr-only` / `visually-hidden` spans: an accessible name, not visible text, so an
   * icon with one is still icon-only. "{…}" stands for a computed label. Optional for old rows.
   */
  srLabel?: string | undefined;
  /** An icon child whose classes rotate under a condition (chevron that turns when open). */
  rotatingIcon?: boolean | undefined;
  /** The first child is a back arrow (arrow_back, ArrowLeft, chevron_left): a back control, whatever its classes. */
  backIcon?: boolean | undefined;
  /**
   * Everything a screen reader can read inside, at any depth: text, {…} for computed text, and the
   * alt / aria-label / title / label of nested elements. Optional for old rows.
   */
  nameText?: string | undefined;
}

/** Icon components by name. Phosphor names don't end in Icon (SidebarSimple, X, List), hence the extra anchors. */
// StepGlyph draws a step's number or check mark: content, not an icon.
export const ICON_NAME = /(^Icon$|Icon$|^Icon[A-Z]|^svg$|(?<!Step)Glyph$|^Lucide|^Ph[A-Z]|Chevron|Caret|Spinner|^Arrow[A-Z]|^Sidebar[A-Z]|^DotsThree|^X$|^List$)/;
/** Packages whose JSX exports are icons whatever they're called. */
export const ICON_PACKAGE = /^(@phosphor-icons\/react(\/[\w-]+)?|lucide-react)$/;
/** A leading back arrow, by component name or glyph name. */
const BACK_ICON = /^(ArrowLeft|ArrowBack|ChevronLeft|CaretLeft|ArrowUUpLeft)|^(arrow_back(_ios(_new)?)?|chevron_left|keyboard_arrow_left|keyboard_backspace|west)$/;
const INTERACTIVE = new Set(['button', 'a', 'input', 'select', 'textarea']);
const SR_ONLY = /(^|\s)(sr-only|visually-hidden)(\s|$)/;

/**
 * `isIcon` answers for names the file imports (an import from an icon package makes it an icon);
 * `isSystem` for names it imports from the system (its Avatar is a system part, not a raw picture).
 */
export function childInfo(children: any[], isIcon: (name: string) => boolean = () => false, isSystem: (name: string) => boolean = () => false): ChildInfo {
  const info: ChildInfo = { text: '', dynamicText: 0, icons: 0, elements: [], images: 0, interactive: 0, iconSizes: [], badges: 0, srLabel: '', rotatingIcon: false };
  const texts: string[] = [];
  const sr: string[] = [];
  const onChild = (c: any, top: boolean) => {
    if (c.type === 'JSXText') { const t = c.value.trim(); if (t) texts.push(t); return; }
    if (c.type === 'JSXExpressionContainer') return onExpr(c.expression, top);
    if (c.type === 'JSXFragment') { for (const k of c.children) onChild(k, top); return; }
    if (c.type === 'JSXElement') {
      const nm = jsxName(c.openingElement.name);
      const cls = c.openingElement.attributes.find((a: any) => a.name?.name === 'className');
      const clsText = cls?.value?.type === 'StringLiteral' ? cls.value.value : '';
      const kids = (c.children ?? []).filter((k: any) => !(k.type === 'JSXText' && !k.value.trim()));
      if (ICON_NAME.test(nm) || isIcon(nm) || /material-symbols|material-icons/.test(clsText)) {
        const glyph = c.openingElement.attributes.find((x: any) => x.name?.name === 'name')?.value;
        const glyphName = glyph?.type === 'StringLiteral' ? glyph.value : '';
        if (top && !info.icons && !texts.length && (BACK_ICON.test(nm) || BACK_ICON.test(glyphName))) info.backIcon = true;
        info.icons++;
        const sz = c.openingElement.attributes.find((a: any) => a.name?.name === 'size');
        if (sz?.value?.type === 'StringLiteral') info.iconSizes.push(sz.value.value);
        else if (sz?.value?.expression?.type === 'NumericLiteral') info.iconSizes.push(String(sz.value.expression.value));
        // Only a chevron/caret that turns reads as disclosure (a sort arrow that flips doesn't).
        const chevron = /Chevron|Caret|Expand/.test(nm) || /chevron|expand|caret|arrow_drop|keyboard_arrow/.test(glyph?.type === 'StringLiteral' ? glyph.value : '');
        if (chevron && cls && cls.value?.type !== 'StringLiteral' && conditionalRotate(cls.value)) info.rotatingIcon = true;
        return;
      }
      // Visually hidden label: names the control for assistive tech; it isn't visible text.
      if ((nm === 'span' && SR_ONLY.test(clsText)) || nm === 'VisuallyHidden') {
        for (const k of kids) {
          if (k.type === 'JSXText') sr.push(k.value.trim());
          else if (k.type === 'JSXExpressionContainer' && k.expression.type === 'StringLiteral') sr.push(k.expression.value);
          else sr.push('{…}');
        }
        if (!kids.length) sr.push('{…}');
        return;
      }
      // Label wrappers render text: <TruncatingLabel>{name}</TruncatingLabel>, <Trans>, <FormattedMessage>.
      if (/(Label|Text|Truncat|Trans|FormattedMessage|Ellipsis)$/.test(nm) || /^(Trans|Truncat)/.test(nm)) {
        for (const k of kids) onChild(k, false);
        if (!kids.length) info.dynamicText++;
        return;
      }
      // A system Avatar or ObjectThumb is the system already, not a raw picture: only the control around it is hand-built.
      if (nm === 'img' || /Thumb|Avatar|Image|Swatch/.test(nm)) {
        if (nm !== 'img' && isSystem(nm)) (info.systemParts ??= []).push(nm); else info.images++;
        info.elements.push(nm);
        return;
      }
      if (INTERACTIVE.has(nm)) info.interactive++;
      // Count badges: <span className="… rounded-full … text-[10px]">{count}</span>, <Badge>, dots.
      if ((nm === 'span' && /rounded-full|badge|count|dot|\bsize-[12](\.5)?\b/.test(clsText) && /absolute|text-\[(9|10|11)px\]|size-[12]|min-w-|badge|count|dot/.test(clsText)) || /^(Badge|CountBadge|Dot|StatusDot)$/.test(nm)) { info.badges++; return; }
      // A span wrapping just text is still text (badges/counts count as elements).
      if ((nm === 'span' || nm === 'strong' || nm === 'em' || nm === 'b') && kids.every((k: any) => k.type === 'JSXText' || (k.type === 'JSXExpressionContainer' && k.expression.type !== 'JSXElement'))) {
        if (!/rounded|bg-|border|px-|badge|count/.test(clsText)) { for (const k of kids) onChild(k, false); return; }
      }
      info.elements.push(nm);
    }
  };
  // {cond ? '→' : <StepGlyph/>}: every branch can render, so text in any branch is text. Icons don't add up
  // across branches ({open ? <ChevronUp/> : <ChevronDown/>} is one icon).
  // A string in a branch is text that changes with state ({empty ? '—' : label}): computed text, not the literal label.
  const onExpr = (e: any, top: boolean, branch = false): void => {
    if (!e || e.type === 'JSXEmptyExpression' || e.type === 'NullLiteral' || e.type === 'BooleanLiteral' || (e.type === 'Identifier' && e.name === 'undefined')) return;
    if (e.type === 'StringLiteral' || (e.type === 'TemplateLiteral' && !e.expressions.length)) {
      const v = e.type === 'StringLiteral' ? e.value : e.quasis[0].value.cooked ?? '';
      if (v.trim()) { if (branch) info.dynamicText++; else texts.push(v); }
      return;
    }
    if (e.type === 'JSXElement' || e.type === 'JSXFragment') return onChild(e, top);
    if (e.type === 'TSAsExpression' || e.type === 'ParenthesizedExpression') return onExpr(e.expression, top, branch);
    if (e.type === 'ConditionalExpression' || (e.type === 'LogicalExpression' && e.operator !== '&&')) {
      const [a, b] = e.type === 'ConditionalExpression' ? [e.consequent, e.alternate] : [e.left, e.right];
      const before = info.icons;
      onExpr(a, top, true);
      const fromA = info.icons - before;
      info.icons = before;
      // The other branch is a fallback ({label || <span>Missing label</span>}): its text is computed, not the label.
      const t0 = texts.length;
      onExpr(b, top, true);
      if (texts.length > t0) { texts.splice(t0); info.dynamicText++; }
      info.icons = before + Math.max(fromA, info.icons - before);
      return;
    }
    // {cond && <X/>}: the left side is the condition, the right is what renders.
    if (e.type === 'LogicalExpression') return onExpr(e.right, top, true);
    // {items.map(i => <Chip/>)} or a call that returns JSX: read its first element.
    const jsx: any[] = [];
    visit(e, (x: any) => { if (x.type === 'JSXElement') jsx.push(x); });
    if (jsx.length) { onChild(jsx[0], top); return; }
    info.dynamicText++;
  };
  for (const c of children) onChild(c, true);
  info.nameText = accessibleText(children);
  info.text = collapse(texts.join(' '));
  info.srLabel = collapse(sr.filter(Boolean).join(' '));
  return info;
}

/**
 * What assistive tech can read inside an element at any depth: text nodes, string children, {…} for computed
 * children, and the naming attributes of nested elements (an <img alt>, an <Icon label>, a nested title).
 */
export function accessibleText(children: any[]): string {
  const parts: string[] = [];
  const walk = (n: any): void => {
    if (!n) return;
    if (n.type === 'JSXText') { if (n.value.trim()) parts.push(n.value.trim()); return; }
    if (n.type === 'JSXFragment') { for (const k of n.children) walk(k); return; }
    if (n.type === 'JSXExpressionContainer') return expr(n.expression);
    if (n.type !== 'JSXElement') return;
    for (const a of n.openingElement.attributes) {
      if (a.type !== 'JSXAttribute' || !NAMING.test(a.name?.name ?? '') || !a.value) continue;
      const v = a.value.type === 'StringLiteral' ? a.value.value : a.value.expression?.type === 'StringLiteral' ? a.value.expression.value : '{…}';
      if (v.trim()) parts.push(v.trim());
    }
    for (const k of n.children ?? []) walk(k);
  };
  const expr = (e: any): void => {
    if (!e || e.type === 'JSXEmptyExpression' || e.type === 'NullLiteral' || e.type === 'BooleanLiteral' || (e.type === 'Identifier' && e.name === 'undefined')) return;
    if (e.type === 'StringLiteral') { if (e.value.trim()) parts.push(e.value.trim()); return; }
    if (e.type === 'TemplateLiteral') { parts.push(e.expressions.length ? '{…}' : e.quasis[0].value.cooked ?? ''); return; }
    if (e.type === 'JSXElement' || e.type === 'JSXFragment') return walk(e);
    if (e.type === 'TSAsExpression' || e.type === 'ParenthesizedExpression') return expr(e.expression);
    if (e.type === 'ConditionalExpression') { expr(e.consequent); expr(e.alternate); return; }
    if (e.type === 'LogicalExpression') { if (e.operator !== '&&') expr(e.left); expr(e.right); return; }
    let first: any = null;
    visit(e, (x: any) => { if (!first && (x.type === 'JSXElement' || x.type === 'JSXFragment')) first = x; });
    if (first) walk(first); else parts.push('{…}');
  };
  for (const c of children) walk(c);
  return collapse(parts.join(' '));
}
const NAMING = /^(alt|aria-label|title|label)$/;

/** A computed className that adds a rotate-* class under some condition (a ternary or && branch). */
function conditionalRotate(value: any): boolean {
  const rotates = (n: any) => { let r = false; visit(n, (x: any) => { if (x.type === 'StringLiteral' && /(^|\s)-?rotate-/.test(x.value)) r = true; }); return r; };
  let hit = false;
  visit(value, (n: any) => {
    if (n.type === 'ConditionalExpression' && (rotates(n.consequent) || rotates(n.alternate))) hit = true;
    if (n.type === 'LogicalExpression' && rotates(n.right)) hit = true;
    if (n.type === 'ObjectProperty' && rotates(n.key)) hit = true;
  });
  return hit;
}
