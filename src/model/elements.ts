import path from "node:path";
import { Parser } from "htmlparser2";
import { parse as parseSfc } from "@vue/compiler-sfc";
import { lineAt, parseTs } from "./extract.js";
import type { Declaration, Element } from "./types.js";

/**
 * Consumer-side readers: every markup language read into one element model (tag, attributes,
 * classes, line, and for component tags the import that binds them). Identity is decided later,
 * against the system model, so a reader only reports what is written.
 *
 *   .tsx .jsx .ts .js .mjs   JSX elements, plus Lit `html\`…\`` templates
 *   .vue                      the <template> block
 *   .svelte                   markup, with imports from <script>
 *   .html .htm .md .mdx .astro .njk   HTML wherever it appears; .njk also macro calls
 *
 * A file with any other extension is not read.
 */
export const READABLE = /\.(tsx|jsx|ts|js|mjs|vue|svelte|html?|md|mdx|astro|njk)$/;

type Imports = Map<string, { source: string; imported: string }>;

export function readElements(file: string, text: string): Element[] {
  return readFile(file, text).elements;
}

/** Elements and, for script files, the components the file declares. */
export function readFile(file: string, text: string): { elements: Element[]; declared: Declaration[] } {
  const ext = path.extname(file).toLowerCase();
  if (/\.(tsx|jsx|ts|js|mjs)$/.test(ext)) return readScript(file, text);
  return { elements: readMarkup(file, text, ext), declared: [] };
}

function readMarkup(file: string, text: string, ext: string): Element[] {
  if (ext === ".vue") return readVue(file, text);
  if (ext === ".svelte") return readSvelte(file, text);
  if (/\.(html?|md|mdx|astro|njk)$/.test(ext)) {
    const imports = /\.(mdx|astro)$/.test(ext) ? importsFromText(text) : new Map();
    const body = ext === ".astro" ? text.replace(/^---[\s\S]*?\n---/, (m) => m.replace(/[^\n]/g, " ")) : text;
    const out = readHtml(file, body, 0, imports);
    if (ext === ".njk") out.push(...readMacroCalls(file, text));
    return out;
  }
  return [];
}

// ---------- HTML ----------

function readHtml(file: string, text: string, baseOffset: number, imports: Imports, full?: string): Element[] {
  const out: Element[] = [];
  const whole = full ?? text;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name;
        const classes = (attribs.class ?? attribs.className ?? "").split(/\s+/).filter((c) => /^[a-zA-Z_-][\w-]*$/.test(c));
        const head = tag.split(".")[0]!;
        const imp = imports.get(head);
        // `v-bind="obj"`, Svelte `{...props}`: the prop list can't be read.
        const spread = Object.keys(attribs).some((a) => a === "v-bind" || a.startsWith("{...") || a.startsWith("..."));
        const at = baseOffset + parser.startIndex;
        out.push({ file, line: lineAt(whole, at), column: at - whole.lastIndexOf("\n", at - 1), tag, attributes: attribs, classes, importSource: imp?.source, importedName: imp?.imported, ...(spread ? { spread } : {}) });
      },
    },
    { lowerCaseTags: false, lowerCaseAttributeNames: false, recognizeSelfClosing: true, decodeEntities: true },
  );
  parser.write(text);
  parser.end();
  return out;
}

/** `acmeButton({ … })`, `{% call acmeFieldset({ … }) %}`: a macro call is an element named by the macro. */
function readMacroCalls(file: string, text: string): Element[] {
  const out: Element[] = [];
  for (const m of text.matchAll(/(?:\{\{-?|\{%-?\s*call|\{%-?\s*set\s+\w+\s*=)\s*([A-Za-z_]\w*)\s*\(/g)) {
    out.push({ file, line: lineAt(text, m.index! + m[0].length - m[1]!.length - 1), tag: m[1]!, attributes: {}, classes: [], macro: true });
  }
  // A call nested inside another call's options or a {% set %} block: `x: acmeButton({`.
  for (const m of text.matchAll(/[:,(]\s*([a-z]+[A-Z]\w*)\s*\(\s*\{/g)) {
    const line = lineAt(text, m.index!);
    if (!out.some((e) => e.line === line && e.tag === m[1])) out.push({ file, line, tag: m[1]!, attributes: {}, classes: [], macro: true });
  }
  return out;
}

// ---------- JSX and Lit ----------

function readScript(file: string, text: string): { elements: Element[]; declared: Declaration[] } {
  const ast = parseTs(text, file);
  if (!ast) return { elements: [], declared: [] };
  const imports: Imports = new Map();
  for (const st of ast.program.body) {
    if (st.type !== "ImportDeclaration") continue;
    for (const sp of st.specifiers ?? []) {
      const imported = sp.type === "ImportDefaultSpecifier" ? "default" : sp.type === "ImportNamespaceSpecifier" ? "*" : (sp.imported?.name ?? sp.imported?.value);
      imports.set(sp.local.name, { source: st.source.value, imported });
    }
  }
  const out: Element[] = [];
  const walk = (node: any, inAttr = false) => {
    if (!node || typeof node.type !== "string") return;
    // Record at the JSXElement, whose flag is its own; its opening tag's attributes are walked below.
    if (node.type === "JSXElement") { const el = jsxElement(file, node.openingElement, imports); out.push(inAttr ? { ...el, inAttribute: true } : el); }
    // Angular inline templates: `@Component({ template: `…` })`.
    if ((node.type === "ObjectProperty" || node.type === "Property") && (node.key?.name === "template" || node.key?.value === "template") && (node.value?.type === "TemplateLiteral" || node.value?.type === "StringLiteral")) {
      const v = node.value;
      const start: number = v.type === "StringLiteral" ? v.start + 1 : v.quasis[0].start;
      const end: number = v.type === "StringLiteral" ? v.end - 1 : v.quasis[v.quasis.length - 1].end;
      let src = text.slice(start, end);
      if (v.type === "TemplateLiteral") for (let i = 0; i < v.quasis.length - 1; i++) { const a = v.quasis[i].end - start, b = v.quasis[i + 1].start - start; src = src.slice(0, a) + "x".repeat(b - a) + src.slice(b); }
      out.push(...readHtml(file, src, start, imports, text));
    }
    if (node.type === "TaggedTemplateExpression" && node.tag?.type === "Identifier" && /^(html|svg)$/.test(node.tag.name)) {
      // Lit: read the template as HTML, each `${…}` blanked to x's of the same length so offsets stay true.
      const q = node.quasi;
      const start: number = q.quasis[0]?.start ?? 0;
      const end: number = q.quasis[q.quasis.length - 1]?.end ?? start;
      let src = text.slice(start, end);
      for (let i = 0; i < q.quasis.length - 1; i++) {
        const a = q.quasis[i].end - start, b = q.quasis[i + 1].start - start;
        src = src.slice(0, a) + "x".repeat(b - a) + src.slice(b);
      }
      out.push(...readHtml(file, src, start, imports, text));
    }
    // An element inside an attribute's value is that prop's, not a child; inside it, children are children again.
    const next = node.type === "JSXAttribute" ? true : node.type === "JSXElement" ? false : inAttr;
    for (const k in node) {
      if (k === "loc" || k === "start" || k === "end" || k.endsWith("Comments")) continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, next));
      else if (v && typeof v.type === "string") walk(v, next);
    }
  };
  walk(ast.program);
  return { elements: out, declared: declarations(file, ast, imports) };
}

/** Top-level PascalCase components: `function X()`, `const X = () =>`, `const X = forwardRef(…)`. */
function declarations(file: string, ast: any, imports: Imports): Declaration[] {
  const out: Declaration[] = [];
  const add = (name: string, body: any, line: number) => {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name) || !body) return;
    let root: any;
    let size = 0;
    const visit = (n: any, inRoot: boolean) => {
      if (!n || typeof n.type !== "string") return;
      let now = inRoot;
      if (n.type === "JSXElement") { if (!root) { root = n; now = true; } if (now) size++; }
      for (const k in n) {
        if (k === "loc" || k === "start" || k === "end" || k.endsWith("Comments")) continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach((c) => visit(c, now));
        else if (v && typeof v.type === "string") visit(v, now);
      }
    };
    visit(body, false);
    if (!root) return;
    out.push({ file, line, name, root: jsxElement(file, root.openingElement, imports), size });
  };
  for (const st0 of ast.program.body) {
    const st = st0.type === "ExportNamedDeclaration" || st0.type === "ExportDefaultDeclaration" ? st0.declaration : st0;
    if (!st) continue;
    if (st.type === "FunctionDeclaration" && st.id) add(st.id.name, st.body, st.loc?.start.line ?? 0);
    if (st.type === "VariableDeclaration") for (const d of st.declarations) if (d.id?.name && d.init) add(d.id.name, d.init, d.loc?.start.line ?? 0);
  }
  return out;
}

function jsxName(n: any): string {
  if (n.type === "JSXIdentifier") return n.name;
  if (n.type === "JSXMemberExpression") return `${jsxName(n.object)}.${n.property.name}`;
  if (n.type === "JSXNamespacedName") return `${n.namespace.name}:${n.name.name}`;
  return "?";
}

function jsxElement(file: string, node: any, imports: Imports): Element {
  const tag = jsxName(node.name);
  const attributes: Record<string, string> = {};
  let classes: string[] = [];
  let spread = false;
  for (const a of node.attributes ?? []) {
    if (a.type === "JSXSpreadAttribute") spread = true;
    if (a.type !== "JSXAttribute") continue;
    const name = a.name.type === "JSXNamespacedName" ? `${a.name.namespace.name}:${a.name.name.name}` : a.name.name;
    const v = a.value;
    const value = !v ? "true" : v.type === "StringLiteral" ? v.value : v.type === "JSXExpressionContainer" && v.expression.type === "StringLiteral" ? v.expression.value : v.type === "JSXExpressionContainer" && v.expression.type === "TemplateLiteral" ? v.expression.quasis.map((q: any) => q.value.cooked).join(" ") : "{expr}";
    attributes[name] = value;
    if (name === "className" || name === "class") classes = value.split(/\s+/).filter((c: string) => /^[a-zA-Z_-][\w-]*$/.test(c));
  }
  const imp = imports.get(tag.split(".")[0]!);
  return { file, line: node.loc?.start.line ?? 0, column: (node.loc?.start.column ?? 0) + 1, tag, attributes, classes, importSource: imp?.source, importedName: imp?.imported, ...(spread ? { spread } : {}) };
}

// ---------- Vue and Svelte ----------

function readVue(file: string, text: string): Element[] {
  try {
    const { descriptor } = parseSfc(text, { filename: file });
    const t = descriptor.template;
    if (!t) return [];
    const script = descriptor.scriptSetup?.content ?? descriptor.script?.content ?? "";
    return readHtml(file, t.content, t.loc.start.offset, importsFromText(script), text);
  } catch {
    return [];
  }
}

function readSvelte(file: string, text: string): Element[] {
  let imports: Imports = new Map();
  // Blank the script and style blocks so line numbers stay true, and read imports from the scripts.
  const markup = text.replace(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/g, (m, tag: string, body: string) => {
    if (tag === "script") imports = new Map([...imports, ...importsFromText(body)]);
    return m.replace(/[^\n]/g, " ");
  });
  // Svelte blocks ({#if}, {#each}, {@render}) are text to an HTML reader; drop them to keep tags intact.
  return readHtml(file, markup.replace(/\{[#:/@][^}]*\}/g, (m) => m.replace(/[^\n]/g, " ")), 0, imports, text);
}

function importsFromText(text: string): Imports {
  const out: Imports = new Map();
  for (const m of text.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1]!.trim();
    const source = m[2]!;
    const ns = clause.match(/\*\s+as\s+(\w+)/);
    if (ns) out.set(ns[1]!, { source, imported: "*" });
    const def = clause.match(/^([A-Za-z_]\w*)\s*(,|$)/);
    if (def) out.set(def[1]!, { source, imported: "default" });
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named) for (const part of named[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [imp, local] = part.replace(/^type\s+/, "").split(/\s+as\s+/);
      out.set((local ?? imp)!.trim(), { source, imported: imp!.trim() });
    }
  }
  return out;
}
