import fs from 'node:fs';
import path from 'node:path';
import { jsxName } from './scanners/ast.js';
import { DYNAMIC, type ElementFeatures } from './scanners/features.js';

/**
 * Placement: where an element sits, which says as much about what it is as its classes do. A row of
 * buttons in the left rail is navigation; the same row in a dialog body is a set of choices.
 *
 * Two sources, merged before classification:
 *  - code: the JSX around every component on the way up to the page (reach.ts walks the chain), so
 *    SideNav's buttons learn that Sidebar renders SideNav inside an <aside>;
 *  - page: what the crawler saw in the running app — landmark ancestors, live ARIA state, and
 *    geometry (a narrow full-height column at the edge is a sidebar whatever its markup says).
 *
 * Structure only: HTML landmarks, ARIA roles, the design system's own parts (Sidebar, Dialog…), and
 * measured boxes. A host component's name is a choice, not evidence.
 */

export type Region = 'sidebar' | 'aside' | 'nav' | 'header' | 'footer' | 'toolbar' | 'dialog' | 'popover' | 'menu' | 'tablist' | 'table' | 'list' | 'form';

export interface Placement {
  /** Regions around the element, innermost first, without repeats. */
  regions: Region[];
  /** One plain sentence per region source, for the reasons. */
  from: string[];
}

/** What the crawler records about a found element (shots.ts PLACE_IN_PAGE). */
export interface PagePlacement {
  regions: Region[];
  /** Live ARIA and state attributes on the element (aria-expanded="false", role="tab"…). */
  attrs: Record<string, string>;
  /** A role on a wrapper within four levels (group, radiogroup, toolbar, tablist, menu…). */
  parentRole?: string | undefined;
  /** Look-alike siblings in the same parent (same tag and classes). */
  siblings: number;
  /** Geometry facts in words ("left rail 240×900 at the window edge"). */
  geometry: string[];
}

/** The screenshot match score below which the page says nothing about an element (the UI hides those shots too). */
export const PLACEMENT_MIN_MATCH = 0.8;

/** Page placement per element id from the last crawl (shots/index.json), for the next evaluation. */
export function readPagePlacement(dataDir: string): Map<string, PagePlacement> {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(dataDir, 'shots', 'index.json'), 'utf8'));
    // Only what the crawler is sure is this element. Below a 0.8 match the screenshot may show another
    // element (a swatch "matched" a stepper step), so it says nothing about where this one sits.
    // Live ARIA also needs a unique match; regions survive a tie between look-alikes.
    const out = new Map<string, PagePlacement>();
    for (const [id, v] of Object.entries<any>(idx.shots ?? {})) {
      if (!v?.placement || (v.matchScore ?? 0) < PLACEMENT_MIN_MATCH) continue;
      const sure = (v.ties ?? 1) <= 1;
      out.set(id, sure ? v.placement : { ...v.placement, attrs: {}, parentRole: undefined, siblings: 0 });
    }
    return out;
  } catch { return new Map(); }
}

/** A fingerprint of the page placement on file: when a crawl changes it, the element review is re-evaluated. */
export function pagePlacementKey(dataDir: string): string {
  const m = readPagePlacement(dataDir);
  return [...m.keys()].sort().map(k => k + JSON.stringify(m.get(k))).join('\n');
}

const ROLE_REGION: Record<string, Region> = {
  navigation: 'nav', banner: 'header', contentinfo: 'footer', toolbar: 'toolbar', menubar: 'toolbar',
  dialog: 'dialog', alertdialog: 'dialog', menu: 'menu', listbox: 'menu', tablist: 'tablist',
  grid: 'table', table: 'table', row: 'table', list: 'list', form: 'form',
};

/** One JSX ancestor → the region it opens, if any. */
export function regionOfJsx(node: any): Region | undefined {
  if (node?.type !== 'JSXElement') return;
  const nm = jsxName(node.openingElement.name).split('.').pop()!;
  const role = node.openingElement.attributes.find((a: any) => a.name?.name === 'role');
  const r = role?.value?.type === 'StringLiteral' ? role.value.value : role?.value?.expression?.type === 'StringLiteral' ? role.value.expression.value : undefined;
  if (r && ROLE_REGION[r]) return ROLE_REGION[r];
  // <aside> is complementary content (a side panel, a conversation): only the system's Sidebar parts, or a
  // rail the page measures, make a sidebar.
  if (/^Sidebar/.test(nm)) return 'sidebar';
  if (nm === 'aside') return 'aside';
  if (nm === 'nav' || /^NavigationMenu/.test(nm)) return 'nav';
  if (nm === 'header') return 'header';
  if (nm === 'footer') return 'footer';
  if (/^(Toolbar|Menubar)/.test(nm)) return 'toolbar';
  if (nm === 'dialog' || /^(Dialog|AlertDialog|Sheet|Drawer)/.test(nm)) return 'dialog';
  if (/^(Popover|HoverCard)/.test(nm)) return 'popover';
  if (/^(DropdownMenu|ContextMenu|Command)/.test(nm)) return 'menu';
  if (/^Tabs?List$/.test(nm)) return 'tablist';
  if (/^(table|td|th|tr|tbody|thead)$/.test(nm) || /^(Table|DataTable)/.test(nm)) return 'table';
  if (/^(ul|ol|li)$/.test(nm)) return 'list';
  if (nm === 'form') return 'form';
  return undefined;
}

/** Regions from an ancestor stack (innermost last, as visitWithAncestors gives it), innermost first. */
export function regionsOfAncestors(ancestors: any[]): Region[] {
  const out: Region[] = [];
  for (let i = ancestors.length - 1; i >= 0; i--) { const r = regionOfJsx(ancestors[i]); if (r && !out.includes(r)) out.push(r); }
  return out;
}

const LABEL: Record<Region, string> = {
  sidebar: 'a sidebar', aside: 'a side panel', nav: 'navigation', header: 'the page header', footer: 'the footer', toolbar: 'a toolbar',
  dialog: 'a dialog', popover: 'a popover', menu: 'a menu', tablist: 'a tab list', table: 'a table', list: 'a list', form: 'a form',
};
export const regionLabel = (r: Region) => LABEL[r];

/**
 * The element's features with placement folded in, plus the reasons that say so. The element's own
 * file already gave its local context (features.context); this adds what only the chain or the page
 * knows. Live ARIA fills attributes the source leaves to props or computes at runtime.
 */
export function withPlacement(f: ElementFeatures, code?: Placement, page?: PagePlacement): { f: ElementFeatures; reasons: { text: string; delta: number }[] } {
  if (!code?.regions.length && !page) return { f, reasons: [] };
  const ctx = { ...f.context };
  const attrs = { ...f.attrs };
  const reasons: { text: string; delta: number }[] = [];
  const has = (r: Region) => Boolean(code?.regions.includes(r) || page?.regions.includes(r));
  const before = { inSidebar: ctx.inSidebar, inNav: ctx.inNav, inList: ctx.inList, inTableCell: ctx.inTableCell };
  if (has('sidebar')) ctx.inSidebar = true;
  if (has('nav')) ctx.inNav = true;
  if (has('menu')) ctx.inList = true;
  if (page?.regions.includes('table') && !ctx.inTableCell && /\b(td|th|cell)\b/.test(page.geometry.join(' '))) ctx.inTableCell = true;
  ctx.regions = [...new Set([...(code?.regions ?? []), ...(page?.regions ?? []), ...(ctx.regions ?? [])])];
  if (page?.parentRole && !ctx.parentRole) ctx.parentRole = page.parentRole;
  if (page && page.siblings > (ctx.siblingButtons ?? 0) && f.element === 'button') ctx.siblingButtons = page.siblings;
  const filled: string[] = [];
  for (const [k, v] of Object.entries(page?.attrs ?? {})) {
    if (attrs[k] === undefined || attrs[k] === DYNAMIC) { if (attrs[k] === undefined) filled.push(`${k}="${v}"`); attrs[k] = attrs[k] === DYNAMIC ? attrs[k] : v; }
  }
  const attrLiterals = { ...(f.attrLiterals ?? {}) };
  // A computed attribute the page showed with a value: keep it computed, and add the value seen.
  for (const [k, v] of Object.entries(page?.attrs ?? {})) if (f.attrs[k] === DYNAMIC) attrLiterals[k] = [...new Set([...(attrLiterals[k] ?? []), v])];
  const gained = (Object.keys(before) as (keyof typeof before)[]).filter(k => !before[k] && ctx[k]);
  if (code?.from.length && gained.length) reasons.push({ text: `Placement (code): ${code.from[0]}.`, delta: 0 });
  if (page?.geometry.length) reasons.push({ text: `Placement (page): ${page.geometry.join('; ')}.`, delta: 0 });
  else if (page?.regions.length && gained.length) reasons.push({ text: `Placement (page): inside ${page.regions.slice(0, 2).map(regionLabel).join(' within ')}.`, delta: 0 });
  if (filled.length) reasons.push({ text: `On the page it carries ${filled.slice(0, 4).join(' ')}, which the source passes in or computes.`, delta: 0 });
  return { f: { ...f, attrs, attrLiterals, context: ctx }, reasons };
}
