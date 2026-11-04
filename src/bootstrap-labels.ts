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
}

export interface Stripped {
  /** 1-based line of the opening tag (unchanged by the strip). */
  line: number;
  component: string;
  /** Every axis, with its default filled in where the code left it out. */
  props: Record<string, string>;
  /** A hash of the component element's original source text. */
  elementHash: string;
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

/** Local names imported from the system's packages, to the component each one is. */
export function systemImports(src: string, packages: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let ast: any;
  try { ast = parseTsx(src); } catch { return out; }
  const fromSystem = (m: string) => packages.some((p) => m === p || m.startsWith(`${p}/`));
  for (const n of ast.program.body) {
    if (n.type !== "ImportDeclaration" || !fromSystem(n.source.value)) continue;
    for (const s of n.specifiers) if (s.type === "ImportSpecifier") out.set(s.local.name, s.imported.name ?? s.imported.value);
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
  walk(ast.program, (n) => {
    if (n.type !== "JSXElement" || n.openingElement.name.type !== "JSXIdentifier") return;
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
    if (!classes) return;
    const cls = classes.join(" ");
    const name = n.openingElement.name;
    mine.push({ start: name.start, end: name.end, text: t.tag });
    if (n.closingElement) mine.push({ start: n.closingElement.name.start, end: n.closingElement.name.end, text: t.tag });
    const own = className && literal(className.value);
    if (!className) mine.push({ start: name.end, end: name.end, text: ` className="${attr(cls)}"` });
    else if (own !== undefined) mine.push({ start: className.value.start, end: className.value.end, text: `"${attr(`${cls} ${own}`.trim())}"` });
    else if (className.value?.type === "JSXExpressionContainer") {
      const e = className.value.expression;
      mine.push({ start: className.value.start, end: className.value.end, text: `{\`${cls.replace(/[`$\\]/g, (c) => `\\${c}`)} \${${src.slice(e.start, e.end)}}\`}` });
    } else return;
    edits.push(...mine);
    stripped.push({ line: n.loc.start.line, component, props, elementHash: hashText(src.slice(n.start, n.end)) });
  });
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let text = src;
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return { text, stripped };
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

/**
 * Raw-to-component swaps in one commit's diff (`git show -U0`): in a hunk, a removed line opening a raw
 * element and an added line opening one of `components` with literal props. Paired in order, one to one.
 */
export function historyPairs(diff: string, components: Set<string>): HistoryPair[] {
  const out: HistoryPair[] = [];
  let file: string | null = null;
  let removed: { line: number; tag: string; text: string }[] = [], added: { component: string; props: Record<string, string> }[] = [];
  let oldLine = 0;
  const flush = () => {
    for (let i = 0; i < Math.min(removed.length, added.length); i++) {
      const r = removed[i]!, a = added[i]!;
      if (file) out.push({ file, line: r.line, rawTag: r.tag, component: a.component, props: a.props, elementHash: hashText(r.text.trim()) });
    }
    removed = []; added = [];
  };
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git")) { flush(); file = null; continue; }
    if (l.startsWith("--- ")) continue;
    if (l.startsWith("+++ ")) { file = l.startsWith("+++ b/") ? l.slice(6) : null; continue; }
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (h) { flush(); oldLine = Number(h[1]); continue; }
    if (l.startsWith("-")) {
      const m = l.slice(1).match(/<([a-z][a-z0-9]*)\b/);
      if (m) removed.push({ line: oldLine, tag: m[1]!, text: l.slice(1) });
      oldLine++;
    } else if (l.startsWith("+")) {
      const m = l.slice(1).match(/<([A-Z][\w]*)\b([^>]*)/);
      if (m && components.has(m[1]!)) {
        const props: Record<string, string> = {};
        for (const p of m[2]!.matchAll(/\b([a-z][\w]*)=(?:"([^"]*)"|\{["'`]([^"'`]*)["'`]\})/g)) if (p[1] !== "className") props[p[1]!] = p[2] ?? p[3] ?? "";
        added.push({ component: m[1]!, props });
      }
    } else if (l.startsWith(" ")) oldLine++;
  }
  flush();
  return out;
}
