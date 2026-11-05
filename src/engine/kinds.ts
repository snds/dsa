import { DYNAMIC, type ElementFeatures } from './scanners/features.js';

/**
 * Scan kinds beyond the element map's tags (review round 4): elements that are only a look-alike when
 * their own markup says so, since a <div> or <label> by itself is nothing to migrate.
 *
 * - Skeleton: animate-pulse, a muted fill, and no children. All three are required.
 * - Label: a <label> with htmlFor, or one wrapping a text field (input, textarea, select). Never one that
 *   holds a choice control or a button (that label is the control's own anatomy, e.g. a Checkbox's), and
 *   never one inside a Field component (the field owns its label).
 */

export type ExtraKind = 'skeleton' | 'label';

const MUTED_FILL = /^bg-(muted|secondary|accent|(gray|zinc|neutral|slate|stone)-\d+)(\/\d+)?$/;
const CHOICE_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden', 'range', 'color']);

/** The JSX elements inside a node (names, and an input's literal type), not entering other components' props. */
function descendants(node: any): { name: string; type?: string | undefined }[] {
  const out: { name: string; type?: string | undefined }[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'JSXElement') {
      const nm = n.openingElement.name;
      const name = nm.type === 'JSXIdentifier' ? nm.name : nm.type === 'JSXMemberExpression' ? `${nm.object?.name}.${nm.property?.name}` : '';
      const typeAttr = n.openingElement.attributes.find((a: any) => a.name?.name === 'type');
      const type = typeAttr?.value?.type === 'StringLiteral' ? typeAttr.value.value : typeAttr ? DYNAMIC : undefined;
      out.push({ name, type });
    }
    for (const k of Object.keys(n)) { if (k === 'loc' || k === 'start' || k === 'end') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
  };
  for (const c of node.children ?? []) walk(c);
  return out;
}

/** Which extra kind a native element is, if any. `node` is its JSXElement; `f` its features. */
export function extraKindOf(node: any, f: ElementFeatures): ExtraKind | undefined {
  if (f.element === 'div' || f.element === 'span') {
    const tokens = f.classes.tokens;
    const empty = !(node.children ?? []).some((c: any) => c.type !== 'JSXText' || c.value.trim());
    return empty && tokens.includes('animate-pulse') && tokens.some(t => MUTED_FILL.test(t)) ? 'skeleton' : undefined;
  }
  if (f.element === 'label') {
    if (f.context.ancestors.some(a => /^Field(Set)?$|^FormField$|^FormItem$/.test(a.split('.').pop() ?? ''))) return undefined;
    const inside = descendants(node);
    const choice = inside.some(d => d.name === 'button' || /^(Checkbox|Switch|Radio\w*|Button|Toggle\w*)$/.test(d.name) || (d.name === 'input' && d.type !== undefined && (d.type === DYNAMIC || CHOICE_TYPES.has(d.type.toLowerCase()))));
    if (choice) return undefined;
    const field = inside.some(d => d.name === 'textarea' || d.name === 'select' || (d.name === 'input' && d.type === undefined) || (d.name === 'input' && !CHOICE_TYPES.has((d.type ?? '').toLowerCase())) || /^(Input|Textarea|Select|Combobox)$/.test(d.name));
    return f.attrs.htmlFor !== undefined || field ? 'label' : undefined;
  }
  return undefined;
}

export const KIND_COMPONENT: Record<ExtraKind, string> = { skeleton: 'Skeleton', label: 'Label' };
