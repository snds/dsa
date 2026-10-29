/** AST helpers shared by the feature scanners (no @babel/traverse, to keep dependencies small). */

export const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

export const jsxName = (n: any): string => n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? `${jsxName(n.object)}.${n.property.name}` : n.type === 'JSXNamespacedName' ? `${n.namespace.name}:${n.name.name}` : '?';

export const memberName = (n: any): string => n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression' ? `${memberName(n.object)}.${n.property?.name ?? '?'}` : n.type === 'Identifier' ? n.name : n.type === 'ThisExpression' ? 'this' : '?';

export function visit(node: any, fn: (n: any) => void) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key.endsWith('Comments') || key === 'extra') continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) visit(c, fn);
    else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, fn);
  }
}

/** Walk with an ancestor stack (innermost last). */
export function visitWithAncestors(node: any, fn: (n: any, ancestors: any[]) => void, stack: any[] = []) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, stack);
  stack.push(node);
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key.endsWith('Comments') || key === 'extra') continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) visitWithAncestors(c, fn, stack);
    else if (v && typeof v === 'object' && typeof v.type === 'string') visitWithAncestors(v, fn, stack);
  }
  stack.pop();
}
