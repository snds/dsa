import path from "node:path";
import fg from "fast-glob";
import { Node, Project, SyntaxKind, ts, type JsxAttribute, type SourceFile } from "ts-morph";
import type { DsaConfig } from "../config.js";
import { adapterFor, type FileReader, type ReaderContext, type SourceAdapter } from "./adapter.js";
import { collectImports, createResolver, dsSourceDirs, isUnder, localPrefixes, type Resolver } from "./resolve.js";
import type { CompositionGraph, ElementNode, FileGraph, LocalComponentDecl, Location } from "./types.js";

type JsxLike = import("ts-morph").JsxElement | import("ts-morph").JsxSelfClosingElement;

export interface BuildGraphOptions {
  /** Absolute directory the include globs are relative to. */
  root: string;
  config: DsaConfig;
  /** Only keep files under this absolute directory (default: all of root). */
  within?: string;
  /** Explicit file list (absolute); skips globbing. */
  files?: string[];
  /** Readers for other markup languages (Vue, Angular). React is built in and reads everything unclaimed. */
  adapters?: SourceAdapter[];
}

export function listSourceFiles(root: string, config: DsaConfig, within?: string): string[] {
  const files = fg.sync(config.scan.include, {
    cwd: root,
    ignore: config.scan.exclude,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  const scope = within ? path.resolve(within) : null;
  return files
    .filter((f) => !scope || f === scope || f.startsWith(scope + path.sep))
    .sort();
}

/** Parse every matching file and return its composition trees. */
export function buildGraph(options: BuildGraphOptions): CompositionGraph {
  const root = path.resolve(options.root);
  const files = options.files ?? listSourceFiles(root, options.config, options.within);
  const ctx: ReaderContext = { root, config: options.config, prefixes: localPrefixes(root) };
  const adapters = options.adapters ?? [];
  const readers = new Map<SourceAdapter, FileReader>();
  const dsDirs = dsSourceDirs(root, options.config);
  const graphs: FileGraph[] = [];
  const skipped: { file: string; message: string }[] = [];
  try {
    for (const file of files) {
      const adapter = adapterFor(file, adapters, reactAdapter);
      let reader = readers.get(adapter);
      if (!reader) {
        reader = adapter.createReader(ctx);
        readers.set(adapter, reader);
      }
      let graph: FileGraph;
      try {
        graph = reader.read(file);
      } catch (e) {
        // One file the reader can't read (a computed import specifier, a syntax it doesn't know) is skipped and listed.
        skipped.push({ file: path.relative(root, file), message: String((e as Error)?.message ?? e).split("\n")[0]! });
        continue;
      }
      if (isUnder(path.resolve(file), dsDirs)) graph.role = "ds-source";
      graphs.push(graph);
    }
  } finally {
    for (const reader of readers.values()) reader.dispose?.();
  }
  return skipped.length ? { root, files: graphs, skipped } : { root, files: graphs };
}

/** The built-in reader: TSX / JSX (and plain TS / JS) through ts-morph. */
export const reactAdapter: SourceAdapter = {
  framework: "react",
  extensions: [".tsx", ".jsx", ".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"],
  createReader(ctx) {
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: {
        jsx: ts.JsxEmit.Preserve,
        allowJs: true,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
    });
    return {
      read(file) {
        const sf = project.addSourceFileAtPath(file);
        const graph = buildFileGraph(sf, ctx.root, ctx.config, ctx.prefixes);
        project.removeSourceFile(sf);
        return graph;
      },
    };
  },
};

export function buildFileGraph(sf: SourceFile, root: string, config: DsaConfig, prefixes: string[]): FileGraph {
  const rel = toRel(root, sf.getFilePath());
  const imports = collectImports(sf, config, prefixes);
  const declared = findDeclaredComponents(sf);
  const resolver = createResolver(imports, new Set(declared.map((d) => d.decl.name)));

  // One pass: for every JSX element, find the JSX element it renders inside
  // (skipping fragments, which are transparent, and skipping anything that sits
  // inside a prop such as `icon={<Icon/>}` — prop children are not composition).
  const all = sf.getDescendants().filter(isJsxLike) as JsxLike[];
  const parentOf = new Map<JsxLike, JsxLike | null>();
  for (const el of all) {
    const parent = nearestJsxParent(el);
    if (parent !== "in-attribute") parentOf.set(el, parent);
  }
  const childrenOf = new Map<JsxLike | null, JsxLike[]>();
  for (const [el, parent] of parentOf) {
    const list = childrenOf.get(parent) ?? [];
    list.push(el);
    childrenOf.set(parent, list);
  }
  type Built = ElementNode & { __el?: JsxLike };
  const build = (el: JsxLike): Built => {
    const node = toElementNode(el, sf, rel, resolver);
    node.children = (childrenOf.get(el) ?? []).sort((a, b) => a.getStart() - b.getStart()).map(build);
    return node;
  };
  const roots: Built[] = (childrenOf.get(null) ?? []).sort((a, b) => a.getStart() - b.getStart()).map(build);

  // Attach each declared component's first rendered root so look-alike and
  // nearest-existing checks can compare anatomies.
  for (const decl of declared) {
    decl.decl.loc.file = rel;
    const declNode = decl.node;
    const first = roots.find((r) => {
      const el = r.__el;
      return el !== undefined && isWithin(el, declNode);
    });
    decl.decl.root = first ?? null;
  }
  for (const r of roots) stripInternal(r);

  return { file: rel, framework: "react", role: "consumer", roots, declared: declared.map((d) => d.decl), imports };
}

function stripInternal(node: ElementNode): void {
  delete (node as { __el?: unknown }).__el;
  for (const c of node.children) stripInternal(c);
}

function isWithin(node: Node, ancestor: Node): boolean {
  return node.getStart() >= ancestor.getStart() && node.getEnd() <= ancestor.getEnd();
}

function isJsxLike(n: Node): n is JsxLike {
  return Node.isJsxElement(n) || Node.isJsxSelfClosingElement(n);
}

function nearestJsxParent(el: JsxLike): JsxLike | null | "in-attribute" {
  let cur: Node | undefined = el.getParent();
  while (cur) {
    if (Node.isJsxAttribute(cur)) return "in-attribute";
    if (isJsxLike(cur)) return cur;
    cur = cur.getParent();
  }
  return null;
}

const NON_SHAPE_PROPS = new Set([
  "className",
  "class",
  "style",
  "key",
  "ref",
  "id",
  "children",
  "placeholder",
  "title",
  "alt",
  "href",
  "src",
  "label",
  "name",
  "value",
  "defaultValue",
  "htmlFor",
  "for",
  "testid",
]);

function isShapeProp(name: string): boolean {
  if (NON_SHAPE_PROPS.has(name)) return false;
  if (name.startsWith("data-") || name.startsWith("aria-")) return false;
  return true;
}

function literalValue(attr: JsxAttribute): string | undefined {
  const init = attr.getInitializer();
  if (!init) return "true"; // `<Button disabled>` is boolean true
  if (Node.isStringLiteral(init)) return init.getLiteralText();
  if (Node.isJsxExpression(init)) {
    const expr = init.getExpression();
    if (!expr) return undefined;
    if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) return expr.getLiteralText();
    if (Node.isNumericLiteral(expr)) return String(expr.getLiteralValue());
    if (expr.getKind() === SyntaxKind.TrueKeyword) return "true";
    if (expr.getKind() === SyntaxKind.FalseKeyword) return "false";
    if (Node.isPrefixUnaryExpression(expr) && Node.isNumericLiteral(expr.getOperand())) return expr.getText();
  }
  return undefined;
}

function toElementNode(el: JsxLike, sf: SourceFile, file: string, resolver: Resolver): ElementNode & { __el?: JsxLike } {
  const opening = Node.isJsxElement(el) ? el.getOpeningElement() : el;
  const component = opening.getTagNameNode().getText();
  const { kind, source } = resolver.resolve(component);
  const shapeProps: Record<string, string> = {};
  let className = false;
  let style = false;
  let spread = false;
  for (const attr of opening.getAttributes()) {
    if (Node.isJsxSpreadAttribute(attr)) {
      spread = true;
      continue;
    }
    const name = attr.getNameNode().getText();
    if (name === "className" || name === "class") className = true;
    if (name === "style") style = true;
    if (!isShapeProp(name)) continue;
    const value = literalValue(attr);
    if (value !== undefined) shapeProps[name] = value;
  }
  const pos = sf.getLineAndColumnAtPos(opening.getStart());
  const loc: Location = { file, line: pos.line, column: pos.column };
  return { component, kind, source, shapeProps: sortRecord(shapeProps), children: [], loc, overrides: { className, style }, spread, __el: el };
}

function sortRecord(r: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

interface DeclaredWithNode {
  decl: LocalComponentDecl;
  node: Node;
}

/** PascalCase functions / consts that contain JSX are treated as components. */
function findDeclaredComponents(sf: SourceFile): DeclaredWithNode[] {
  const out: DeclaredWithNode[] = [];
  const seen = new Set<string>();
  const containsJsx = (n: Node) => n.getFirstDescendant(isJsxLike) !== undefined;
  const add = (name: string, node: Node, exported: boolean) => {
    if (!/^[A-Z]/.test(name) || seen.has(name) || !containsJsx(node)) return;
    seen.add(name);
    const pos = sf.getLineAndColumnAtPos(node.getStart());
    out.push({ decl: { name, loc: { file: "", line: pos.line, column: pos.column }, root: null, exported }, node });
  };
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (name) add(name, fn, fn.isExported() || fn.isDefaultExport());
  }
  for (const stmt of sf.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      const init = decl.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init) || Node.isCallExpression(init))) {
        add(decl.getName(), decl, stmt.isExported());
      }
    }
  }
  return out;
}

export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}
