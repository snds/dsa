import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import type { ContentSpec, Recommendation } from './classify.js';
import { LAYOUT_ONLY, type ElementEval } from './elements.js';
import { visit } from './scanners/features.js';
import { walk } from './paths.js';

/**
 * What one element becomes under a decision: the component, its props, and the element's own content
 * carried over (label, icons, handlers, aria, layout classes), with every judgment call flagged.
 *
 * Mechanical and per instance, so a pattern decision for 41 elements shows exactly what each of the
 * 41 turns into, and which ones need a look before an agent applies it.
 */

export interface Mapping {
  id: string;
  file: string;
  line: number;
  /** The replacement JSX, ready to paste (imports not included). */
  jsx: string;
  /** What the element had, in content terms. */
  had: { label: string; leading?: string | undefined; trailing?: string | undefined; iconOnly: boolean };
  kept: string[];
  dropped: string[];
  flags: string[];
  status: 'clean' | 'check' | 'unreadable';
}

const KEEP_ATTR = /^(on[A-Z]\w*|aria-[\w-]+|data-[\w-]+|id|title|disabled|type|ref|key|tabIndex|form\w*|name|value|autoFocus|href|target|rel|download|style)$/;
const ICON_TAG = /(^Icon$|Icon$|^svg$)/;

interface Comp { component: string; tag?: string | undefined; childSlots?: string[]; defaults?: Record<string, string> }

const cssCache = new Map<string, Map<string, string>>();
/** Class names the app's own CSS styles (`.plus-noun-link { … }`), with the file that styles them. */
function appCssClasses(dir: string): Map<string, string> {
  if (cssCache.has(dir)) return cssCache.get(dir)!;
  const m = new Map<string, string>();
  for (const f of walk(path.join(dir, 'src'), new Set(['.css', '.scss'])).slice(0, 400)) {
    let css = '';
    try { css = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const x of css.matchAll(/\.([a-zA-Z][\w-]*)(?=[\s{:,.>+~[)])/g)) if (!m.has(x[1]!)) m.set(x[1]!, path.relative(dir, f));
  }
  cssCache.set(dir, m);
  return m;
}

const astCache = new Map<string, { src: string; ast: any } | null>();
function parsed(file: string) {
  if (!astCache.has(file)) {
    try { const src = fs.readFileSync(file, 'utf8'); astCache.set(file, { src, ast: babelParse(src, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['jsx', 'typescript'] }) }); }
    catch { astCache.set(file, null); }
  }
  return astCache.get(file)!;
}
export function clearMappingCache() { astCache.clear(); cssCache.clear(); }

const nameOf = (n: any): string => n?.type === 'JSXIdentifier' ? n.name : n?.type === 'JSXMemberExpression' ? `${nameOf(n.object)}.${n.property.name}` : '';

export function mapInstance(e: ElementEval, absFile: string, appDir: string, decision: Recommendation, comp?: Comp): Mapping {
  const base: Mapping = { id: e.id, file: e.file, line: e.line, jsx: '', had: { label: '', iconOnly: false }, kept: [], dropped: [], flags: [], status: 'unreadable' };
  const p = parsed(absFile);
  if (!p) return { ...base, flags: ['Could not read the file.'] };
  const { src, ast } = p;
  let el: any = null;
  visit(ast.program, (n: any) => {
    if (el || n.type !== 'JSXElement') return;
    const o = n.openingElement;
    if (o.loc?.start.line === e.line && nameOf(o.name) === e.element && (!e.col || o.loc.start.column + 1 === e.col)) el = n;
  });
  if (!el) visit(ast.program, (n: any) => { if (!el && n.type === 'JSXElement' && n.openingElement.loc?.start.line === e.line && nameOf(n.openingElement.name) === e.element) el = n; });
  if (!el) return { ...base, flags: ['The element is no longer at this line; rescan.'] };
  const text = (n: any) => src.slice(n.start, n.end);
  const spec: ContentSpec = decision.content ?? {};
  const out: Mapping = { ...base, status: 'clean' };
  const Use = decision.use ?? 'Component';
  const componentSizesIcons = (comp?.childSlots ?? []).includes('icon') || /button|badge|chip|tab|menu/i.test(Use);
  const iconSizeMode = spec.iconSize ?? (componentSizesIcons ? 'component' : 'source');

  // ---- attributes
  const attrs: string[] = [];
  const o = el.openingElement;
  for (const a of o.attributes) {
    if (a.type === 'JSXSpreadAttribute') { attrs.push(text(a)); out.kept.push(text(a)); out.flags.push(`Spread props (${text(a)}): check they don't pass className or styling the component now owns.`); continue; }
    const k = typeof a.name?.name === 'string' ? a.name.name : nameOf(a.name);
    if (k === 'className' || k === 'class') continue;
    if (k === 'role') {
      const v = a.value?.value;
      if (v && (v === comp?.tag || (v === 'button' && /button/i.test(Use)))) { out.dropped.push(text(a) + ' (the component sets it)'); continue; }
      attrs.push(text(a)); out.kept.push(text(a)); out.flags.push(`Kept ${text(a)}: confirm the component should carry that role.`); continue;
    }
    if (KEEP_ATTR.test(k)) {
      attrs.push(text(a)); out.kept.push(k);
      if (k === 'style') out.flags.push('Inline style kept: it may fight the component\'s tokens.');
      continue;
    }
    attrs.push(text(a)); out.kept.push(k);
    out.flags.push(`Passed ${k} through: check ${Use} accepts it.`);
  }
  // className: layout utilities stay (margins, widths, flex), visual styling is the component's job now.
  const tokens = e.classTokens ?? [];
  const layout = tokens.filter(t => LAYOUT_ONLY.test(t));
  const css = appCssClasses(appDir);
  const styledByApp = tokens.filter(t => css.has(t));
  const visual = tokens.filter(t => !LAYOUT_ONLY.test(t));
  if (visual.length) out.dropped.push(`classes ${visual.slice(0, 8).join(' ')}${visual.length > 8 ? ' …' : ''}`);
  for (const t of styledByApp) out.flags.push(`Dropped \`${t}\`, which the app's CSS styles (${css.get(t)}): move what it does into ${Use} or a variant, or the look changes.`);
  const cond = (e.conditionalTokens ?? []).filter(t => !LAYOUT_ONLY.test(t));
  if (cond.length) out.flags.push(`Classes that switch with state (${cond.slice(0, 4).join(' ')}): ${Use}'s variants don't do that by themselves.`);
  if (layout.length) out.kept.push(`layout classes ${layout.join(' ')}`);

  // ---- children: icons at the ends, the label in between
  const kids = (el.children ?? []).filter((c: any) => !(c.type === 'JSXText' && !c.value.trim()) && !(c.type === 'JSXExpressionContainer' && c.expression.type === 'JSXEmptyExpression'));
  const isIcon = (c: any) => {
    const n = c.type === 'JSXElement' ? c : c.type === 'JSXExpressionContainer' && c.expression.type === 'JSXElement' ? c.expression : null;
    if (!n) return false;
    const nm = nameOf(n.openingElement.name);
    const cls = n.openingElement.attributes.find((x: any) => x.name?.name === 'className')?.value?.value ?? '';
    return ICON_TAG.test(nm) || /material-symbols|material-icons/.test(cls);
  };
  const others = kids.filter((c: any) => !isIcon(c));
  const leadingNode = kids.length && isIcon(kids[0]) ? kids[0] : null;
  const trailingNode = kids.length > 1 && isIcon(kids[kids.length - 1]) ? kids[kids.length - 1] : null;
  const labelNodes = kids.filter((c: any) => c !== leadingNode && c !== trailingNode);
  const middleIcons = labelNodes.filter(isIcon);
  if (middleIcons.length) out.flags.push(`An icon in the middle of the label (${text(middleIcons[0]).slice(0, 40)}): the component places icons at the ends.`);
  const nested = others.filter((c: any) => c.type === 'JSXElement' && !/^(Trans|T|FormattedMessage)$/.test(nameOf(c.openingElement.name)));
  if (nested.length) out.flags.push(`Other elements inside (${nested.map((c: any) => '<' + nameOf(c.openingElement.name) + '>').slice(0, 3).join(', ')}): check they belong inside ${Use}'s label.`);
  const labelSrc = labelNodes.length ? src.slice(labelNodes[0].start, labelNodes[labelNodes.length - 1].end).trim() : '';
  const iconSrc = (n: any) => {
    let s = text(n);
    if (iconSizeMode === 'component' && /\ssize=/.test(s)) {
      const sz = s.match(/\ssize=(\{[^}]*\}|"[^"]*"|'[^']*')/)?.[1];
      s = s.replace(/\s+size=(\{[^}]*\}|"[^"]*"|'[^']*')/, '');
      out.dropped.push(`icon size=${sz} (${Use} sizes its icons)`);
    }
    return s;
  };
  const iconName = (n: any) => { const m = text(n).match(/name=["']([^"']+)["']/); return m ? m[1] : nameOf((n.expression ?? n).openingElement?.name); };
  out.had = { label: labelSrc, leading: leadingNode ? iconName(leadingNode) : undefined, trailing: trailingNode ? iconName(trailingNode) : undefined, iconOnly: !labelSrc && !!(leadingNode || trailingNode) };
  if (!labelSrc && !leadingNode && !trailingNode) out.flags.push('No content: nothing to label it with.');
  if (/^\+\s/.test(labelSrc) && !leadingNode) out.flags.push('Label starts with a literal "+": use a leading add icon instead?');
  if (out.had.iconOnly && !o.attributes.some((a: any) => a.name?.name === 'aria-label') && !o.attributes.some((a: any) => a.name?.name === 'title')) out.flags.push('Icon only, with no aria-label: give it an accessible name.');

  const pick = (which: 'leading' | 'trailing', node: any) => {
    const s = spec[which] ?? 'source';
    if (s === 'none') { if (node) out.dropped.push(`${which} icon ${iconName(node)}`); return ''; }
    if (typeof s === 'object') return `<Icon name="${s.icon}" />`;
    return node ? iconSrc(node) : '';
  };
  const lead = pick('leading', leadingNode);
  const trail = pick('trailing', trailingNode);
  const label = spec.label && typeof spec.label === 'object' ? spec.label.text : labelSrc;
  if (spec.label && typeof spec.label === 'object' && labelSrc && labelSrc !== spec.label.text) out.flags.push(`Label replaced: was ${labelSrc.slice(0, 40)}.`);

  // ---- props from the decision, defaults left out
  const propAttrs = Object.entries(decision.props ?? {}).filter(([k, v]) => comp?.defaults?.[k] !== v).map(([k, v]) => v === 'true' ? k : /^(false|-?\d+(\.\d+)?)$/.test(v) || /^<[\s\S]*>$/.test(v) ? `${k}={${v}}` : `${k}="${v}"`);
  const cls = layout.length ? [`className="${layout.join(' ')}"`] : [];
  const tag = (name: string, props: string[], body: string) => {
    const head = `<${name}${props.length ? ' ' + props.join(' ') : ''}`;
    if (!body) return `${head} />`;
    const oneLine = `${head}>${body}</${name}>`;
    return oneLine.length <= 100 && !body.includes('\n') ? oneLine : `${head}>\n  ${body.split('\n').join('\n  ')}\n</${name}>`;
  };
  // A link styled as something else: the component renders a <button>, so it renders the anchor instead
  // (render={<a … />}: a Base UI Button takes render, not asChild). nativeButton={false} says it isn't a <button>.
  const asLink = e.element === 'a' && (comp?.tag ?? 'button') === 'button';
  if (asLink) out.flags.push(`<a> becomes ${Use} render={<a … />}, so it stays a link.`);
  const inner = [lead, label, trail].filter(Boolean).join(lead || trail ? ' ' : '');
  const openProps = asLink ? [...propAttrs, 'nativeButton={false}', `render={${tag('a', attrs, '')}}`, ...cls] : [...propAttrs, ...attrs, ...cls];
  out.jsx = tag(Use, openProps, inner);
  if (decision.verdict !== 'replace') { out.jsx = ''; }
  out.status = out.flags.length ? 'check' : 'clean';
  return out;
}

/** Map many instances; each file is parsed once. */
export function mapInstances(items: { e: ElementEval; abs: string; appDir: string }[], decision: Recommendation, comp?: Comp): Mapping[] {
  return items.map(x => mapInstance(x.e, x.abs, x.appDir, decision, comp));
}
