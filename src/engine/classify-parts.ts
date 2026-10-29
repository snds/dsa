import type { Evaluation, Recommendation } from './classify.js';
import type { Candidate, RoleFn } from './classify-button.js';
import { DYNAMIC, type ElementFeatures } from './scanners/features.js';
import { system } from './system.js';

/** Where the system's container component is imported from (the profile's containers), when it says. */
const at = (use: string): { from?: string } => { const from = system().profile.containers?.[use]; return from ? { from } : {}; };

/**
 * Part components only work inside their container: a DropdownMenuItem outside DropdownMenu does
 * nothing, and SidebarMenuButton throws outside SidebarProvider (useSidebar). The 2026-10-13 audit
 * (docs/element-review-audit/buttons-menus-toggles.md) found every part recommended with no check
 * that its container exists: none of 12 "menu items" sat in a menu, CollapsibleTrigger was proposed
 * around <tr> rows, and 7 of 8 auto-approved calls were wrong or would crash.
 *
 * Two steps:
 *   1. refineParts: name the right part for the kind of row (a right-click menu, an on/off row, a
 *      pick-one row, a row that opens another menu, a picker option, a table-row expander).
 *   2. requireContainer: when the code has no container around the part, recommend the container
 *      with it (Recommendation.parent) and keep the call below the review threshold, so a person
 *      decides the container and its parts together.
 */

export type Parent = NonNullable<Recommendation['parent']>;

interface PartRule {
  /** Ancestor names (in this file) that are the container already. */
  have: RegExp;
  parent: (f: ElementFeatures, e: Recommendation) => Parent;
}

const menu = (): Parent => ({
  use: 'DropdownMenu', ...at('DropdownMenu'),
  how: 'Build the menu with DropdownMenu: DropdownMenuTrigger opens DropdownMenuContent, and each row is a DropdownMenuItem (CheckboxItem for on/off rows, RadioGroup with RadioItem for pick-one rows, Sub with SubTrigger for rows that open another menu).',
});
const sidebar = (part: string): Parent => ({
  use: 'SidebarProvider', ...at('SidebarProvider'),
  how: `${part} only works inside the ${system().label} sidebar, and throws outside SidebarProvider (it reads the sidebar's state). Build the shell first: SidebarProvider > Sidebar > SidebarMenu > SidebarMenuItem > SidebarMenuButton (isActive marks the current place).`,
});
/** Sidebar parts only: the host's own component called Sidebar is not the system's shell. */
const SIDEBAR_SHELL = /^(SidebarProvider|SidebarMenu|SidebarMenuItem|SidebarMenuSub|SidebarContent|SidebarGroup)$/;

const PARTS: Record<string, PartRule> = {
  DropdownMenuItem: { have: /^(DropdownMenu|Menubar)/, parent: menu },
  DropdownMenuCheckboxItem: { have: /^(DropdownMenu|Menubar)/, parent: menu },
  DropdownMenuRadioItem: { have: /^(DropdownMenu|Menubar)/, parent: menu },
  DropdownMenuSubTrigger: { have: /^(DropdownMenu|Menubar)/, parent: menu },
  ContextMenuItem: {
    have: /^ContextMenu/,
    parent: () => ({ use: 'ContextMenu', ...at('ContextMenu'), how: 'Build the right-click menu with ContextMenu: ContextMenuTrigger wraps the target, and ContextMenuContent holds a ContextMenuItem per row (ContextMenuLabel and ContextMenuSeparator for headings and lines).' }),
  },
  ToggleGroupItem: {
    have: /^ToggleGroup$/,
    parent: f => {
      const joined = joinedSegments(f);
      return {
        use: 'ToggleGroup', ...at('ToggleGroup'), ...(joined ? { props: { fit: 'flush', variant: 'outline' } } : {}),
        how: `Wrap the set in ToggleGroup; each option is a ToggleGroupItem with a value. Variant and size go on the group.${joined ? ' The options touch inside one frame: fit="flush".' : ''}`,
      };
    },
  },
  TabsTrigger: {
    have: /^(Tabs|TabsList)$/,
    parent: (f, e) => {
      const vertical = /dialog-tabs|list-nav/.test((e as Evaluation).ruleId ?? '') || (f.classes.tokens.includes('w-full') && f.classes.tokens.includes('text-left'));
      return {
        use: 'Tabs', ...at('Tabs'), ...(vertical ? { props: { orientation: 'vertical' } } : {}),
        how: `Wrap the set in Tabs: TabsList holds a TabsTrigger per tab, and each panel is a TabsContent with the same value.${vertical ? ' The tabs stack in a column: orientation="vertical".' : ''}`,
      };
    },
  },
  CollapsibleTrigger: {
    have: /^Collapsible$/,
    parent: () => ({ use: 'Collapsible', ...at('Collapsible'), how: 'Wrap the button and the part it shows in Collapsible: the button becomes CollapsibleTrigger and the shown part CollapsibleContent.' }),
  },
  SidebarMenuButton: { have: SIDEBAR_SHELL, parent: () => sidebar('SidebarMenuButton') },
  SidebarTrigger: { have: SIDEBAR_SHELL, parent: () => sidebar('SidebarTrigger') },
  ComboboxItem: {
    have: /^Combobox/,
    parent: f => {
      const multiple = f.children.elements.some(n => /Checkbox/.test(n)) || f.attrs['aria-checked'] !== undefined;
      return {
        use: 'Combobox', ...at('Combobox'), ...(multiple ? { props: { multiple: 'true' } } : {}),
        how: `Build the picker with Combobox${multiple ? ' (multiple: several can be picked)' : ''}: ComboboxContent > ComboboxList holds a ComboboxItem per option; indicatorSide="start" puts the check first.`,
      };
    },
  },
  RadioGroupItem: {
    have: /^RadioGroup$/,
    parent: () => ({ use: 'RadioGroup', ...at('RadioGroup'), how: 'Wrap the options in RadioGroup; each option is a RadioGroupItem with a value and a Label.' }),
  },
  GroupRow: {
    have: /^DataTable$/,
    parent: () => ({ use: 'DataTable', ...at('DataTable'), how: 'GroupRow comes with DataTable grouping: move the table to DataTable and group its rows. Until then, a Button ghost xs with aria-expanded.' }),
  },
};

/** The parts this module checks, by component name. */
export const PART_COMPONENTS = new Set(Object.keys(PARTS));

const nameOf = (a: string) => a.split('.').pop() ?? a;

/**
 * The container a part needs, when the code doesn't have it yet. Null when the recommendation isn't a
 * part, or the part already sits in its container in this file.
 */
export function missingParent(f: ElementFeatures, rec: Recommendation): Parent | null {
  if (rec.verdict !== 'replace' || !rec.use) return null;
  const rule = PARTS[rec.use];
  if (!rule) return null;
  if (f.context.ancestors.some(a => rule.have.test(nameOf(a)))) return null;
  return rule.parent(f, rec);
}

/**
 * A part without its container: name the container with it and keep the call below the review
 * threshold. Applied after ranking, so it never changes which component wins, only how sure it is.
 */
export function requireContainer(e: Evaluation, f: ElementFeatures, threshold: number): Evaluation {
  const parent = missingParent(f, e);
  if (!parent) return e;
  const cap = Math.round((threshold - 0.05) * 100) / 100;
  const delta = Math.round((Math.min(e.confidence, cap) - e.confidence) * 100) / 100;
  const surface = menuSurface(f);
  const reasons = [...e.reasons, { text: `${e.use} only works inside ${parent.use}, and this code has none around it. Migrate ${parent.use} with its parts: ${parent.how}`, delta }];
  if (/^(DropdownMenu|ContextMenu)/.test(e.use ?? '') && !surface) reasons.push({ text: 'No menu surface around it in the code either: check that it is a menu at all (a page index or a step list is not).', delta: 0 });
  return { ...e, parent, confidence: Math.round((e.confidence + delta) * 100) / 100, reasons };
}

// ---------- 1. The right part for the kind of row ----------

/**
 * Re-point menu rows by kind and table-row expanders to GroupRow. Runs over the button rules'
 * candidates, before ranking.
 */
export function refineParts(f: ElementFeatures, cands: Candidate[], role: RoleFn): Candidate[] {
  const out = [...cands];
  for (const c of cands) {
    if (c.role === 'menu-item') {
      const kind = menuKind(f);
      const destructive = f.classes.tokens.some(t => /^text-destructive$/.test(t));
      const props = destructive ? { variant: 'destructive' } : undefined;
      if (kind) Object.assign(c, role(kind.role, `${c.ruleId}.${kind.id}`, c.prior, [...c.reasons, { text: kind.why, delta: 0 }], props));
      else if (props) c.props = { ...(c.props ?? {}), ...props };
      if (destructive) c.reasons.push({ text: 'Red text: a destructive row (variant="destructive").', delta: 0 });
    }
    if ((c.role === 'disclosure' || c.role === 'disclosure-icon') && inTableRow(f)) {
      Object.assign(c, role('row-expander', `${c.ruleId}.row`, c.prior, [...c.reasons, { text: 'Opens and closes rows inside a table: a group row\'s expander. Collapsible can\'t wrap table rows (a div inside tbody is invalid).', delta: 0 }]));
      out.push(role('button', `${c.ruleId}.row-button`, c.prior - 0.1, [{ text: 'Until the table is a DataTable: a Button ghost xs with aria-expanded.', delta: 0 }], { variant: 'ghost', size: 'xs' }));
    }
  }
  return out;
}

/** Inside a table row in this file: <td>, <th> or <tr> close above it. */
export const inTableRow = (f: ElementFeatures) => f.context.ancestors.slice(0, 6).some(a => /^(td|th|tr)$/.test(a));

interface MenuKind { role: string; id: string; why: string }

function menuKind(f: ElementFeatures): MenuKind | null {
  const roleAttr = f.attrs.role;
  const gates = (f.context.gates ?? []).map(g => `${g.test} ${g.overlay ?? ''}`).join(' ');
  if (f.context.ancestors.some(a => /^ContextMenu/.test(nameOf(a))) || /\bctx\b|context-?menu|right-?click/i.test(gates) || /onContextMenu/.test(f.openTag)) {
    return { role: 'context-menu-item', id: 'context', why: 'The menu opens where the pointer right-clicked: a context menu (ContextMenu), not a menu behind a button.' };
  }
  if (roleAttr === 'menuitemcheckbox' || f.handlerIntent === 'toggle') {
    return { role: 'menu-checkbox-item', id: 'checkbox', why: 'The row turns a setting on and off: DropdownMenuCheckboxItem shows the check.' };
  }
  if (roleAttr === 'menuitemradio' || (f.context.inMap && f.handlerIntent === 'select')) {
    return { role: 'menu-radio-item', id: 'radio', why: 'One row of a pick-one set (one is checked): DropdownMenuRadioItem inside DropdownMenuRadioGroup.' };
  }
  if ((f.attrs['aria-haspopup'] !== undefined && f.attrs['aria-haspopup'] !== 'false') || /getBoundingClientRect/.test(f.openTag)) {
    return { role: 'menu-sub-trigger', id: 'sub', why: 'The row opens another menu next to itself: DropdownMenuSub with a DropdownMenuSubTrigger.' };
  }
  return null;
}

/** A hand-built or system menu surface around the row: a popup wrapper, a menu role, or an overlay gate. */
function menuSurface(f: ElementFeatures): boolean {
  const ctx = f.context;
  if (ctx.ancestors.some(a => /Menu|Popover|Popup|Float|Dropdown|Overlay|Listbox/.test(a))) return true;
  if (/^(menu|listbox|menubar)$/.test(ctx.parentRole ?? '')) return true;
  return (ctx.gates ?? []).some(g => g.kind === 'overlay' || /\b(menu|float|popup|ctx|open)\b/i.test(g.test));
}

/**
 * Segments that touch inside one frame (ToggleGroup fit="flush"): equal-width buttons with no box of
 * their own beside each other, or classes named for a flush/joined pill.
 */
export function joinedSegments(f: ElementFeatures): boolean {
  const base = f.classes.tokens.filter(t => !/^[a-z-]+:/.test(t));
  if (/flush|joined|segment|pill/i.test([...f.classes.viaConst, ...f.classes.unresolved].join(' '))) return true;
  if (f.classes.tokens.some(t => /^(rounded-none|-m[ls]-px|border-[lr]-0|first:rounded|last:rounded|rounded-[lrse]-none)/.test(t))) return true;
  // A one-side border is the divider between joined segments, not a box of its own.
  const ownBox = base.some(t => /^rounded/.test(t)) || base.includes('border');
  return base.includes('flex-1') && (f.context.siblingButtons ?? 0) > 0 && !ownBox;
}

/** Whether a label (static or any computed literal) reads as a select box: "Select", "Deselect". */
export function selectBoxLabel(f: ElementFeatures): boolean {
  const names = [f.attrs['aria-label'], ...(f.attrLiterals?.['aria-label'] ?? []), f.attrs.title, f.children.srLabel].filter(x => x && x !== DYNAMIC) as string[];
  return names.some(n => /^(de)?select( (this|item|row|all))?$/i.test(n.trim()));
}
