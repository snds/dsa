export type ElementKind = "ds" | "local" | "html" | "external";

export interface Location {
  /** Path relative to the scan root, with forward slashes. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

/** One JSX element as written, with its nested JSX children. */
export interface ElementNode {
  /** Tag as written, e.g. `Button`, `Dialog.Title`, `div`. */
  component: string;
  kind: ElementKind;
  /** Import source the tag resolved to (null for html and same-file declarations). */
  source: string | null;
  /** Props whose value is a string / number / boolean literal, stringified. */
  shapeProps: Record<string, string>;
  children: ElementNode[];
  loc: Location;
  /** `className` / `style` props present on the element. */
  overrides: { className: boolean; style: boolean };
  /** The element has at least one `{...spread}` attribute. */
  spread: boolean;
}

/** A component declared in a scanned file (PascalCase function or const with JSX). */
export interface LocalComponentDecl {
  name: string;
  loc: Location;
  /** The first JSX root the declaration renders, if any. */
  root: ElementNode | null;
  exported: boolean;
}

export interface ImportBinding {
  /** Local identifier, e.g. `Button` or the namespace name. */
  local: string;
  source: string;
  kind: ElementKind;
}

/** The language a file's markup is written in; each has its own reader (see adapter.ts). */
export type Framework = "react" | "vue" | "angular";

export interface FileGraph {
  file: string;
  framework: Framework;
  /** DS source files are parsed for names but left out of adoption and pattern counts. */
  role: "consumer" | "ds-source";
  roots: ElementNode[];
  declared: LocalComponentDecl[];
  imports: ImportBinding[];
}

export interface CompositionGraph {
  /** Absolute scan root. */
  root: string;
  files: FileGraph[];
}

export function walk(node: ElementNode, fn: (n: ElementNode, depth: number) => void, depth = 0): void {
  fn(node, depth);
  for (const child of node.children) walk(child, fn, depth + 1);
}

export function countNodes(node: ElementNode): number {
  let n = 0;
  walk(node, () => n++);
  return n;
}
