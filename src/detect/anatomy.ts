import { createHash } from "node:crypto";
import type { ElementNode } from "../graph/types.js";

export type AnatomyKind = "ds" | "local" | "html";

/** The slot tree of a composition: what is composed, not where or with what text. */
export interface AnatomyNode {
  component: string;
  kind: AnatomyKind;
  shapeProps: Record<string, string>;
  children: AnatomyNode[];
}

/**
 * Convert an element subtree into its anatomy. External elements (a router
 * Link, a motion wrapper) are not part of the design-system composition, so
 * they are transparent: their children are hoisted into the parent.
 */
export function toAnatomy(node: ElementNode): AnatomyNode[] {
  if (node.kind === "external") return node.children.flatMap(toAnatomy);
  return [
    {
      component: node.component,
      kind: node.kind,
      shapeProps: { ...node.shapeProps },
      children: node.children.flatMap(toAnatomy),
    },
  ];
}

/** Deterministic text form used for hashing and equality. */
export function serializeAnatomy(node: AnatomyNode): string {
  const props = Object.entries(node.shapeProps)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(",");
  const children = node.children.map(serializeAnatomy).join("");
  return `<${node.kind}:${node.component}{${props}}>${children}</>`;
}

/** Stable id: first 12 hex chars of the sha256 of the canonical serialization. */
export function anatomyId(node: AnatomyNode): string {
  return createHash("sha256").update(serializeAnatomy(node)).digest("hex").slice(0, 12);
}

export function walkAnatomy(node: AnatomyNode, fn: (n: AnatomyNode, depth: number) => void, depth = 0): void {
  fn(node, depth);
  for (const c of node.children) walkAnatomy(c, fn, depth + 1);
}

export function anatomyNodes(node: AnatomyNode): AnatomyNode[] {
  const out: AnatomyNode[] = [];
  walkAnatomy(node, (n) => out.push(n));
  return out;
}

/** Pretty one-line rendering for human summaries: `div > Search + Chip + Toolbar(Button)`. */
export function renderAnatomy(node: AnatomyNode, depth = 0): string {
  const kids = node.children.map((c) => renderAnatomy(c, depth + 1));
  if (kids.length === 0) return node.component;
  return depth === 0 ? `${node.component} > ${kids.join(" + ")}` : `${node.component}(${kids.join(" + ")})`;
}
