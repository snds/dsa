import crypto from "node:crypto";
import { parse } from "@babel/parser";

/**
 * Labels for free, from code that already answers the question (`dsa labels`):
 *
 *   migrated  An element already on a system component is stripped back to the raw markup it renders
 *             (its host tag and the classes its variant and size put there), and the scanner is run on
 *             the stripped copy. The true answer is the component and props that were there.
 *   history   A commit that turned a raw element into a system component: the raw element, at the
 *             parent commit, is labelled with the component it became.
 *
 * Both only label what they can read for certain: string-literal props, no `asChild` or `render`.
 */

/** What a component draws: its host tag, its prop axes and defaults, and the classes for a variant and size. */
export interface StripTarget {
  tag: string;
  axes: Record<string, string[]>;
  defaults: Record<string, string>;
  classes: (variant: string, size: string) => string[] | null;
  /**
   * The pixel height and width a class list renders (later classes win, as cn() resolves them), when the
   * system's tokens resolve. With it, a className that overrides the size makes the size whose pixels
   * match the render an acceptable answer too.
   */
  px?: ((classes: string[]) => { height?: number | undefined; width?: number | undefined }) | undefined;
}

export interface Stripped {
  /** 1-based line of the opening tag (unchanged by the strip). */
  line: number;
  component: string;
  /** Every axis, with its default filled in where the code left it out. */
  props: Record<string, string>;
  /** A hash of the component element's original source text. */
  elementHash: string;
  /**
   * Other props that render the same pixels: when its className overrides height or width (size="icon"
   * className="size-7"), the size whose own pixels match the render is as right as the size it names.
   */
  alts?: Record<string, string>[] | undefined;
}

export const hashText = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

const parseTsx = (src: string) => parse(src, { sourceType: "module", plugins: ["jsx", "typescript"], errorRecovery: true }) as any;

function walk(node: any, fn: (n: any) => void) {
  if (!node || typeof node.type !== "string") return;
  fn(node);
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "start" || k === "end" || k === "extra") continue;
    const v = node[k];
    if (Array.isArray(v)) for (const c of v) walk(c, fn);
    else if (v && typeof v === "object" && typeof v.type === "string") walk(v, fn);
  }
}

/**
 * The app's own copy of the system's components (shadcn-style owned source: ~/components/ui/button,
 * @/components/ui/button). Older code often imported the system through it, so history reads it as the
 * system when the imported name is one of the system's components.
 */
export const OWNED_UI = /^(\.{1,2}\/|[~@]\/)(.*\/)?components\/ui(\/|$)/;

/** Local names imported from the system's packages (or, with `owned`, the app's owned copy), to the component each one is. */
export function systemImports(src: string, packages: string[], owned?: { pattern: RegExp; names: Set<string> }): Map<string, string> {
  const out = new Map<string, string>();
  let ast: any;
  try { ast = parseTsx(src); } catch { return out; }
  const fromSystem = (m: string) => packages.some((p) => m === p || m.startsWith(`${p}/`));
  for (const n of ast.program.body) {
    if (n.type !== "ImportDeclaration") continue;
    const sys = fromSystem(n.source.value), own = !sys && owned?.pattern.test(n.source.value);
    if (!sys && !own) continue;
    for (const s of n.specifiers) {
      if (s.type !== "ImportSpecifier") continue;
      const name = s.imported.name ?? s.imported.value;
      if (sys || owned!.names.has(name)) out.set(s.local.name, name);
    }
  }
  return out;
}

/** A literal string prop value, or undefined when it isn't one. */
function literal(v: any): string | undefined {
  if (!v) return undefined;
  if (v.type === "StringLiteral") return v.value;
  if (v.type === "JSXExpressionContainer" && v.expression?.type === "StringLiteral") return v.expression.value;
  if (v.type === "JSXExpressionContainer" && v.expression?.type === "TemplateLiteral" && !v.expression.expressions.length) return v.expression.quasis[0].value.cooked;
  return undefined;
}

const blank = (s: string) => s.replace(/[^\n]/g, " ");
const attr = (v: string) => v.replace(/"/g, "&quot;");

/**
 * Strip every system component in a file back to the raw markup it renders. Lines stay where they are,
 * so a scan of the stripped file places each element on the line its component was on.
 */
export function stripSystemComponents(src: string, imports: Map<string, string>, targets: Map<string, StripTarget>): { text: string; stripped: Stripped[] } {
  let ast: any;
  try { ast = parseTsx(src); } catch { return { text: src, stripped: [] }; }
  const edits: { start: number; end: number; text: string }[] = [];
  const stripped: Stripped[] = [];
  // render={<Button/>}: the element another component draws as. The scanner never counts that slot (it is
  // the component's own element), so a label there could never match: skip it.
  const renderSlots = new Set<any>();
  walk(ast.program, (n) => {
    if (n.type === "JSXAttribute" && n.name?.name === "render" && n.value?.type === "JSXExpressionContainer" && n.value.expression?.type === "JSXElement") renderSlots.add(n.value.expression);
  });
  walk(ast.program, (n) => {
    if (n.type !== "JSXElement" || n.openingElement.name.type !== "JSXIdentifier" || renderSlots.has(n)) return;
    const local = n.openingElement.name.name as string;
    const component = imports.get(local);
    const t = component ? targets.get(component) : undefined;
    if (!component || !t) return;
    const props: Record<string, string> = {};
    const mine: typeof edits = [];
    let className: any = null, sure = true;
    for (const a of n.openingElement.attributes) {
      if (a.type !== "JSXAttribute") continue;
      const name = a.name.type === "JSXIdentifier" ? a.name.name : null;
      if (name === "asChild" || name === "render") { sure = false; break; }
      if (name === "className") { className = a; continue; }
      if (name && name in t.axes) {
        const v = literal(a.value);
        if (v === undefined) { sure = false; break; }
        props[name] = v;
        mine.push({ start: a.start, end: a.end, text: blank(src.slice(a.start, a.end)) });
      }
    }
    if (!sure) return;
    for (const [axis, values] of Object.entries(t.axes)) {
      props[axis] ??= t.defaults[axis] ?? values[0] ?? "default";
      // Only variant and size are drawn per combination; another axis must sit at its default.
      if (axis !== "variant" && axis !== "size" && props[axis] !== (t.defaults[axis] ?? values[0])) sure = false;
    }
    const classes = sure ? t.classes(props.variant ?? "default", props.size ?? "default") : null;
    // Nothing to recognize it by (a component that adds no classes of its own): no label.
    if (!classes?.length) return;
    const cls = classes.join(" ");
    const name = n.openingElement.name;
    mine.push({ start: name.start, end: name.end, text: t.tag });
    // Type arguments (<Table<Row> …>) don't belong on a host tag.
    const typeArgs = n.openingElement.typeArguments ?? n.openingElement.typeParameters;
    if (typeArgs) mine.push({ start: typeArgs.start, end: typeArgs.end, text: blank(src.slice(typeArgs.start, typeArgs.end)) });
    const afterName = typeArgs ? typeArgs.end : name.end;
    if (n.closingElement) mine.push({ start: n.closingElement.name.start, end: n.closingElement.name.end, text: t.tag });
    const own = className && literal(className.value);
    if (!className) mine.push({ start: afterName, end: afterName, text: ` className="${attr(cls)}"` });
    else if (own !== undefined) mine.push({ start: className.value.start, end: className.value.end, text: `"${attr(`${cls} ${own}`.trim())}"` });
    else if (className.value?.type === "JSXExpressionContainer") {
      const e = className.value.expression;
      mine.push({ start: className.value.start, end: className.value.end, text: `{\`${cls.replace(/[`$\\]/g, (c) => `\\${c}`)} \${${src.slice(e.start, e.end)}}\`}` });
    } else return;
    edits.push(...mine);
    const alts = typeof own === "string" ? sameSizeAlts(t, props, classes, own) : [];
    stripped.push({ line: n.loc.start.line, component, props, elementHash: hashText(src.slice(n.start, n.end)), ...(alts.length ? { alts } : {}) });
  });
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let text = src;
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return { text, stripped };
}

const SIZE_TOKEN = /^(h|w|size)-/;
/**
 * The sizes whose own pixels equal what the element renders once its className override applies. Height
 * decides; a size that sets a width (an icon size) must match the width too.
 */
function sameSizeAlts(t: StripTarget, props: Record<string, string>, base: string[], own: string): Record<string, string>[] {
  const extra = own.split(/\s+/).filter(Boolean);
  if (!t.px || !t.axes.size || !extra.some((x) => SIZE_TOKEN.test(x))) return [];
  const rendered = t.px([...base, ...extra]);
  const named = t.px(base);
  if (rendered.height === undefined || (rendered.height === named.height && rendered.width === named.width)) return [];
  const out: Record<string, string>[] = [];
  for (const s of t.axes.size) {
    if (s === props.size) continue;
    const c = t.classes(props.variant ?? "default", s);
    if (!c) continue;
    const p = t.px(c);
    const same = (a?: number, b?: number) => a !== undefined && b !== undefined && Math.abs(a - b) <= 0.5;
    if (same(p.height, rendered.height) && (p.width === undefined || same(p.width, rendered.width))) out.push({ ...props, size: s });
  }
  return out;
}

/** One raw element that a commit turned into a system component. */
export interface HistoryPair {
  file: string;
  /** Its line in the parent commit. */
  line: number;
  rawTag: string;
  component: string;
  props: Record<string, string>;
  elementHash: string;
}

/** Tags the scanner reads as raw elements (by tag, or by their own markup). Other tags never pair. */
const RAW_TAGS = new Set(["button", "input", "select", "textarea", "a", "label", "table", "dialog", "div", "span"]);

/**
 * Props as compared, on both sides of every comparison (labels and the bench): the component's own
 * defaults filled in (its cva defaultVariants, or the signature's defaults), then routing-only props and
 * empty values dropped. One rule, so `size` left out and `size="default"` compare equal.
 */
export function canonicalProps(props: Record<string, unknown> | null | undefined, defaults: Record<string, string> = {}): Record<string, string> {
  const filled: Record<string, unknown> = { ...defaults, ...(props ?? {}) };
  return Object.fromEntries(Object.entries(filled)
    .filter(([k, v]) => !["render", "asChild", "children"].includes(k) && v != null && v !== "")
    .map(([k, v]): [string, string] => [k, String(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/** A diff hunk's line ranges (`git show -U0`): old [oldStart, oldStart+oldLines), new likewise. */
export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number }

/** The hunks of each file in a `git show -U0` diff. */
export function parseHunks(diff: string): Map<string, Hunk[]> {
  const out = new Map<string, Hunk[]>();
  let file: string | null = null;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git")) { file = null; continue; }
    if (l.startsWith("+++ ")) { file = l.startsWith("+++ b/") ? l.slice(6) : null; continue; }
    const h = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) out.set(file, [...(out.get(file) ?? []), { oldStart: Number(h[1]), oldLines: h[2] === undefined ? 1 : Number(h[2]), newStart: Number(h[3]), newLines: h[4] === undefined ? 1 : Number(h[4]) }]);
  }
  return out;
}

/** JSX elements of a file with their opening line, closing line of the opening tag, and name; render slots left out. */
function elementsOf(src: string): { node: any; line: number; openEnd: number; name: string }[] {
  let ast: any;
  try { ast = parseTsx(src); } catch { return []; }
  const slots = new Set<any>();
  walk(ast.program, (n) => {
    if (n.type === "JSXAttribute" && n.name?.name === "render" && n.value?.type === "JSXExpressionContainer" && n.value.expression?.type === "JSXElement") slots.add(n.value.expression);
  });
  const out: { node: any; line: number; openEnd: number; name: string }[] = [];
  walk(ast.program, (n) => {
    if (n.type !== "JSXElement" || slots.has(n) || n.openingElement.name.type !== "JSXIdentifier") return;
    out.push({ node: n, line: n.loc.start.line, openEnd: n.openingElement.loc.end.line, name: n.openingElement.name.name });
  });
  return out;
}

/**
 * A part (a *Trigger, *Content or *Item) gets its host tag from its signature, which says little: a raw
 * <button> becomes one only when it already played that part.
 * - Trigger: the button opens something: aria-haspopup or aria-expanded on it, or an onClick that sets or
 *   toggles an open/expanded state (setOpen(…), setMenuOpen(!…), toggle…()).
 * - Item: the button is an item already: role menuitem, menuitemcheckbox, menuitemradio, option or tab.
 * - Content: never from a raw button (content is the panel, not its opener).
 */
function partFits(component: string, r: { name: string; node: any; text: string }): boolean {
  const part = /(Trigger|Content|Item)$/.exec(component)?.[1];
  if (!part || r.name !== "button") return true;
  if (part === "Content") return false;
  const attrs = new Map<string, any>();
  for (const a of r.node.openingElement.attributes) if (a.type === "JSXAttribute" && a.name.type === "JSXIdentifier") attrs.set(a.name.name, a.value);
  if (part === "Item") { const role = literal(attrs.get("role")); return Boolean(role && /^(menuitem|menuitemcheckbox|menuitemradio|option|tab)$/.test(role)); }
  if (attrs.has("aria-haspopup") || attrs.has("aria-expanded")) return true;
  const click = attrs.get("onClick");
  const code = click ? r.text.slice(click.start - r.node.start, click.end - r.node.start) : "";
  return /\bset\w*(Open|Expanded|Shown|Visible)\s*\(|\btoggle\w*\s*\(/.test(code);
}

/**
 * Raw-to-component swaps in one file of one commit, read from both versions of the file, never from diff
 * text alone:
 *
 * - A raw element counts as removed when its opening tag starts on a removed line; a system component as
 *   added when its opening tag starts on an added line. Render slots (render={<X/>}) never count.
 * - In each hunk, a removed raw element pairs with an added component whose host tag is the same (the
 *   component renders a <button>, the element was one), nearest first by position in the hunk, one to one.
 * - A raw element that is still there afterwards (a raw element of its tag at its place in the new
 *   version: only a child changed, e.g. an icon swap) is not a label.
 * - Props are literal or the pair is skipped, with the component's defaults filled in (canonicalProps).
 * - A component imported from the app's owned copy of the system (OWNED_UI) counts when its name is one
 *   of the system's components.
 */
export function historyPairsInFile(o: { file: string; before: string; after: string; hunks: Hunk[]; packages: string[]; targets: Map<string, StripTarget> }): HistoryPair[] {
  const imports = systemImports(o.after, o.packages, { pattern: OWNED_UI, names: new Set(o.targets.keys()) });
  const inOld = (line: number) => o.hunks.find((h) => h.oldLines > 0 && line >= h.oldStart && line < h.oldStart + h.oldLines);
  const inNew = (line: number) => o.hunks.find((h) => h.newLines > 0 && line >= h.newStart && line < h.newStart + h.newLines);
  const before = elementsOf(o.before), after = elementsOf(o.after);
  const removed = before.filter((e) => RAW_TAGS.has(e.name) && inOld(e.line)).map((e) => ({ ...e, hunk: inOld(e.line)!, text: o.before.slice(e.node.start, e.node.end) }));
  const rawAfter = after.filter((e) => RAW_TAGS.has(e.name));
  const added: { line: number; hunk: Hunk; component: string; tag: string; props: Record<string, string> }[] = [];
  for (const e of after) {
    const component = imports.get(e.name);
    const t = component ? o.targets.get(component) : undefined;
    const h = inNew(e.line);
    if (!component || !t || !h) continue;
    const props: Record<string, string> = {};
    let sure = true;
    for (const a of e.node.openingElement.attributes) {
      if (a.type !== "JSXAttribute") continue;
      const k = a.name.type === "JSXIdentifier" ? a.name.name : null;
      if (k === "asChild") { sure = false; break; }
      if (!k || !(k in t.axes)) continue;
      const v = literal(a.value);
      if (v === undefined) { sure = false; break; }
      props[k] = v;
    }
    if (sure) added.push({ line: e.line, hunk: h, component, tag: t.tag, props: canonicalProps(props, t.defaults) });
  }
  const out: HistoryPair[] = [];
  for (const h of new Set([...removed.map((r) => r.hunk), ...added.map((a) => a.hunk)])) {
    const rs = removed.filter((r) => r.hunk === h), as = added.filter((a) => a.hunk === h);
    // Still there afterwards: a raw element of the same tag at the same place in the hunk.
    const kept = (r: (typeof rs)[number]) => rawAfter.some((x) => x.name === r.name && Math.abs((x.line - h.newStart) - (r.line - h.oldStart)) <= 1);
    const cands: { r: (typeof rs)[number]; a: (typeof as)[number]; d: number }[] = [];
    for (const r of rs) if (!kept(r)) for (const a of as) if (a.tag === r.name && partFits(a.component, r)) cands.push({ r, a, d: Math.abs((r.line - h.oldStart) - (a.line - h.newStart)) });
    cands.sort((x, y) => x.d - y.d || x.r.line - y.r.line);
    const usedR = new Set<any>(), usedA = new Set<any>();
    for (const c of cands) {
      if (usedR.has(c.r) || usedA.has(c.a)) continue;
      usedR.add(c.r); usedA.add(c.a);
      out.push({ file: o.file, line: c.r.line, rawTag: c.r.name, component: c.a.component, props: c.a.props, elementHash: hashText(c.r.text.trim()) });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
