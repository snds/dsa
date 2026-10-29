import { system } from './system.js';
import type { RoleMap } from './roles.js';
import type { Candidate, RoleFn } from './classify-button.js';
import { DYNAMIC, type ElementFeatures, type SwitchKind } from './scanners/features.js';
import { selectBoxLabel } from './classify-parts.js';

/**
 * The semantic half of the button rules (classify-button.ts): which ARIA contract the element carries.
 * Disclosure (expanded), nav item (current), pressed latch, or one of a set (segmented) — decided from
 * attributes, the click handler, the class-switch kind, and structure (sets, rows, sidebars), never
 * from host component names. Icon-only is applied afterwards as a presentation of the winner.
 */

/** Classes that mark a navigation row: sidebar colour tokens, plus the profile's navTokens. */
const navRe = new WeakMap<object, RegExp>();
function navTokenRe(): RegExp {
  const s = system();
  let re = navRe.get(s);
  if (!re) { re = new RegExp(['sidebar-(selected|accent|foreground|primary)', ...s.navTokens].join('|')); navRe.set(s, re); }
  return re;
}

export interface Ctx { text: boolean; iconOnly: boolean; kind: SwitchKind; has: (re: RegExp) => boolean; constNames: string }

/** Disclosure → nav item → pressed toggle / segmented. The first that fires is the element's semantics. */
export function semanticCandidate(f: ElementFeatures, map: RoleMap, role: RoleFn, x: Ctx): Candidate | null {
  const a = f.attrs, c = f.children, ctx = f.context;
  const labelled = x.text || x.iconOnly || Boolean(c.srLabel);
  const pressedAttr = a['aria-pressed'] !== undefined;
  // aria-current="step" is a stepper, not a location in navigation.
  const currentValues = a['aria-current'] === undefined ? [] : a['aria-current'] === DYNAMIC ? (f.attrLiterals?.['aria-current'] ?? ['true']) : [a['aria-current']];
  const currentAttr = currentValues.length > 0 && !currentValues.includes('step') && !currentValues.every(v => v === 'false');

  // A popup trigger (aria-haspopup, or inside a Menu/Popover/Select trigger) opens a menu or dialog: its trigger
  // stays and only its look changes, so it isn't a disclosure even when it carries aria-expanded.
  if (isPopupTrigger(f)) return null;

  // 2. Disclosure: it opens and closes something. Enlarging an image opens a viewer instead (a lightbox).
  if (zooms(f)) return null;
  const aria = [a['aria-expanded'] !== undefined && 'aria-expanded', a['aria-controls'] !== undefined && 'aria-controls', /^(open|closed)$/.test(a['data-state'] ?? '') && `data-state="${a['data-state']}"`].filter(Boolean) as string[];
  const said = discloseWords(f);
  const soft = [
    f.handlerIntent === 'disclose' && 'the click handler opens/closes something',
    x.kind === 'expanded' && labelled && 'classes switch on an open/expanded flag',
    (f.classes.switchTokensOnlyTransform || c.rotatingIcon) && 'a chevron turns with the state',
    said && `its label says so (“${said}”)`,
  ].filter(Boolean) as string[];
  if (aria.length || soft.length) {
    const r: Candidate['reasons'] = aria.length
      ? [{ text: `${aria.join(', ')}: a disclosure (it shows or hides content).`, delta: 0 }, ...soft.map(s => ({ text: `Also: ${s}.`, delta: 0 }))]
      : [{ text: `Disclosure without ARIA: ${soft.join('; ')}. Add aria-expanded.`, delta: 0 }];
    if (pressedAttr) r.push({ text: 'aria-pressed is set, but the control opens a view: the contract is aria-expanded, not pressed.', delta: 0 });
    return role('disclosure', 'button.disclosure', aria.length ? 0.9 : 0.8, r);
  }

  // 3. Nav item: the current location in a list of places.
  const helperNames = [...f.classes.viaConst, ...f.classes.unresolved].join(' ');
  // Structural and token signals only; the enclosing component's name is a host choice, not evidence.
  const navTokens = x.has(navTokenRe());
  const navCtx = ctx.inNav || ctx.inSidebar || navTokens || /nav|sidebar/i.test(helperNames);
  // A row: full width, a nav/item helper, or (in navigation) an icon + label laid out in a flex row.
  const rowish = x.has(/^w-full$/) || /nav|item|link/i.test(helperNames) || (navCtx && x.has(/^(inline-)?flex$/) && c.icons > 0 && x.text);
  // Inside a dialog or popover, a list of places is a set of panels: vertical tabs, not app navigation.
  const panelSwitch = (ctx.regions ?? []).some(r => r === 'dialog' || r === 'popover') && !ctx.inSidebar && f.handlerIntent !== 'navigate';
  // A full-width row with a leading icon and a label that lights up on an `active` flag (SidebarMenuButton's
  // isActive vocabulary) and doesn't flip it on click: the current place in a list of places.
  const activeRow = x.has(/^w-full$/) && c.icons > 0 && x.text && (f.classes.switchNames ?? []).some(n => /^(is)?active$/i.test(n)) && f.handlerIntent !== 'toggle' && !ctx.inMap;
  const groupRole = /^(group|radiogroup|toolbar|tablist)$/.test(ctx.parentRole ?? '');
  if (currentAttr) {
    const r: Candidate['reasons'] = [{ text: 'aria-current: the current location in navigation.', delta: 0 }];
    if (f.handlerIntent === 'navigate') r.push({ text: 'Handler navigates.', delta: 0.02 });
    return role('nav-item', 'button.nav-current', 0.9, r);
  }
  // Equal-width neighbours (flex-1 beside look-alike buttons) are segments, wherever they sit.
  const segments = x.has(/^flex-1$/) && (ctx.siblingButtons ?? 0) > 0;
  if (labelled && (navCtx && rowish || activeRow) && !segments && !groupRole && !pressedAttr && (x.kind === 'current' || x.kind === 'equality' || x.kind === 'pressed')) {
    const why = [ctx.inSidebar && 'sidebar', ctx.inNav && 'nav', navTokens && 'sidebar tokens', /nav|sidebar/i.test(helperNames) && 'nav classes'].filter(Boolean).join(', ');
    if (panelSwitch) {
      return role('tab', 'button.dialog-tabs', 0.82, [
        { text: `Rows inside a ${(ctx.regions ?? []).find(r => r === 'dialog' || r === 'popover')} that mark the shown one and switch what the panel shows: vertical tabs (TabsTrigger in a vertical TabsList), not app navigation.`, delta: 0 },
      ]);
    }
    return role('nav-item', 'button.nav-item', navCtx ? 0.84 : 0.8, [
      { text: why ? `Full-width row in navigation (${why}) whose classes switch on the current item.` : 'Full-width icon + label row whose classes switch on an `active` flag the click doesn\'t flip: the current place in a list.', delta: 0 },
      { text: 'No aria-current: SidebarMenuButton isActive adds the state; add aria-current="page" for links.', delta: 0 },
    ]);
  }

  // 4. Pressed latch vs one of a set. A select box, a pin on a canvas and a stat tile aren't options of a set.
  if ((pressedAttr || x.kind !== 'none') && selectBoxLabel(f)) {
    return role('checkbox-role', 'button.select-box', 0.82, [{ text: 'A select box ("Select" / "Deselect"): it marks this one item as chosen. That is a Checkbox, not one option of a set.', delta: 0 }]);
  }
  if (notAnOption(f, x)) return null;
  const inSet = ctx.inMap || groupRole || (ctx.siblingButtons ?? 0) > 0;
  const setWhy = [ctx.inMap && 'rendered in a .map()', groupRole && `inside role="${ctx.parentRole}"`, (ctx.siblingButtons ?? 0) > 0 && `${ctx.siblingButtons} sibling button(s)`].filter(Boolean).join(', ');
  const switching = x.kind !== 'none' && labelled;
  if ((pressedAttr || (switching && (x.kind === 'equality' || x.kind === 'current'))) && inSet || (switching && x.kind === 'pressed' && groupRole)) {
    // Base classes only: a radius that switches on `shape` (BulkSelect) isn't a chip.
    const chip = f.classes.tokens.some(t => /^rounded-(full|\(--radius-chip\))$/.test(t)) || /chip/i.test(x.constNames);
    const r: Candidate['reasons'] = [{ text: `One of a set (${setWhy}) whose ${pressedAttr ? 'aria-pressed' : 'classes'} mark the chosen one: a segmented control / single-select group.`, delta: 0 }];
    if (pressedAttr) r.push({ text: 'Has aria-pressed.', delta: 0.04 });
    if (f.handlerIntent === 'select') r.push({ text: 'Handler sets the value from the set.', delta: 0.02 });
    if (chip) r.push({ text: 'Chip-shaped (full radius): no chip toggle in the system yet; ToggleGroupItem is the closest home.', delta: 0 });
    // Full-width, left-aligned rows stacked in a list are a nav/list, not a segmented control.
    if (!pressedAttr && !groupRole && x.has(/^w-full$/) && x.has(/^text-left$/)) {
      if (panelSwitch) return role('tab', 'button.dialog-tabs', 0.8, [{ text: `Full-width rows (${setWhy}) inside a dialog, one marked current, that switch the panel: vertical tabs.`, delta: 0 }]);
      return role('nav-item', 'button.list-nav', 0.78, [{ text: `Full-width, left-aligned rows (${setWhy}), one marked current: a nav list (or a selectable list row).`, delta: 0 }]);
    }
    return role(chip ? 'chip-toggle' : 'segmented', chip ? 'button.chip-toggle' : 'button.segmented', 0.84, r);
  }
  // A flag alone (`active`, `on`) can mean "enabled"; it's a latch when the handler flips it too.
  if (pressedAttr || (switching && x.kind === 'pressed' && (f.handlerIntent === 'toggle' || ctx.inMap || groupRole))) {
    const r: Candidate['reasons'] = [{ text: pressedAttr ? 'aria-pressed: a pressed/unpressed latch.' : 'Classes switch on a pressed/selected/on flag that the handler flips: a latch.', delta: 0 }];
    if (inSet) r.push({ text: `Part of a set (${setWhy}) with independent states: several Toggles, or a ToggleGroup type="multiple".`, delta: 0 });
    return role('toggle', 'button.toggle', pressedAttr ? 0.88 : 0.8, r);
  }
  return null;
}

/** Icon-only is presentation: it sets the winner's size/flavour instead of creating a role. */
export function applyIconOnly(sem: Candidate, map: RoleMap, sizeKey: string | undefined, reasons: Candidate['reasons'], sidebar: boolean, bordered = false) {
  if (sem.role === 'disclosure') {
    const to = sidebar ? 'sidebar-toggle' : 'disclosure-icon';
    const def = map.roles[to];
    Object.assign(sem, { role: to, ruleId: sidebar ? 'button.sidebar-toggle' : 'button.disclosure-icon', use: def?.use || undefined, from: def?.from, gap: def?.gap, props: { ...(def?.props ?? {}) } });
    if (!sidebar && sizeKey && sizeKey !== 'default') sem.props!.size = iconSize(def?.use, sizeKey, map);
    // Same look rule as an icon action: no box at rest is ghost, a border is outline.
    if (!sidebar) sem.props!.variant ??= bordered ? 'outline' : (map.roles['icon-button']?.props?.variant ?? 'ghost');
    const named = def?.use === 'IconButton' ? 'IconButton with label (from aria-label / sr-only text) and expanded' : `${def?.use || 'Button'} with an aria-label (from aria-label / sr-only text) and aria-expanded`;
    sem.reasons.push(...reasons, { text: sidebar ? 'Collapses the sidebar: SidebarTrigger.' : `Icon-only disclosure: ${named}.`, delta: 0 });
    return;
  }
  sem.reasons.push(...reasons, { text: 'Icon-only: keep an aria-label (or sr-only text) as the accessible name.', delta: 0 });
  // Toggle/ToggleGroupItem sizes are sm|default|lg (+xs on the item); there is no icon-* size.
  const s = sizeKey === 'xs' ? (sem.use === 'ToggleGroupItem' ? 'xs' : 'sm') : sizeKey;
  if (s && s !== 'default' && (sem.use === 'Toggle' || sem.use === 'ToggleGroupItem')) sem.props = { ...(sem.props ?? {}), size: s };
}

/** A Button needs the icon-* sizes; IconButton (if a host map still names it) takes the plain sizes (sm). */
export function iconSize(use: string | undefined, key: string | undefined, map: RoleMap): string {
  if (use === 'IconButton') return key ?? 'default';
  return map.iconSizes[key ?? 'default'] ?? 'icon';
}

/**
 * An icon-only disclosure that collapses the sidebar itself (SidebarTrigger: icon + sr-only "Toggle Sidebar").
 * Being inside a sidebar isn't enough: a section expander there opens its group, not the rail. The label,
 * the handler, or the state has to name the sidebar, the navigation, or the rail.
 */
export function sidebarHint(f: ElementFeatures): boolean {
  const label = [f.attrs['aria-label'], ...(f.attrLiterals?.['aria-label'] ?? []), f.attrs.title, ...(f.attrLiterals?.title ?? []), f.children.srLabel].filter(x => x && x !== DYNAMIC).join(' ');
  if (/\bsidebar\b/i.test(label) || /\b(navigation|nav|rail|side ?panel|side ?bar|menu panel)\b/i.test(label) && /\b(collapse|expand|toggle|hide|show|open|close|minimi[sz]e)\b/i.test(label)) return true;
  if (/toggle(Sidebar|Rail|Nav)|onToggle(Sidebar|Rail|Nav)|set(Sidebar|Rail|Nav)(Open|Collapsed|Expanded)/.test(f.openTag)) return true;
  // The rail's own edge handle: in the sidebar, pinned to its edge, flipping a collapsed flag.
  return Boolean(f.context.inSidebar) && f.classes.tokens.some(t => /^-?(right|left)-/.test(t)) && f.classes.tokens.includes('absolute') && (/collapsed/i.test(f.openTag) || discloseWords(f) !== null);
}

/** Opens a menu, popover, listbox, or dialog: aria-haspopup, or a raw button inside a *Trigger asChild. */
export function isPopupTrigger(f: ElementFeatures): boolean {
  const hp = f.attrs['aria-haspopup'];
  if (hp !== undefined && hp !== 'false' && hp !== DYNAMIC) return true;
  return f.context.ancestors.slice(0, 2).some(n => /(Menu|Popover|Select|Combobox|HoverCard|Dialog|Sheet)Trigger$/.test(n));
}

/** Opens the image larger (a lightbox or viewer): "Expand image", a zoom-in cursor. */
export function zooms(f: ElementFeatures): boolean {
  const names = [f.attrs['aria-label'], f.attrs.title, f.children.srLabel, f.children.text].filter(x => x && x !== DYNAMIC).join(' ');
  return f.classes.tokens.includes('cursor-zoom-in') || /\b(expand|enlarge|zoom|view( full)?)( the)? (image|photo|picture|preview|thumbnail)\b/i.test(names);
}

/**
 * Repeated buttons that are not options of a set: pins placed on a canvas by coordinates, and stat
 * tiles that stack a label over a count. Looking alike and sitting together isn't enough.
 */
function notAnOption(f: ElementFeatures, x: Ctx): boolean {
  if (x.has(/^absolute$/) && /\bstyle=\{\{[^}]*\b(left|top|right|bottom)\s*:/.test(f.openTag)) return true;
  const c = f.children;
  return x.has(/^flex-col$/) && (c.text ? 1 : 0) + c.dynamicText + c.elements.length >= 2;
}

/** Disclosure words in the element's names (static or any computed literal): "Collapse navigation", "Show more". */
export function discloseWords(f: ElementFeatures): string | null {
  const names = [f.attrs['aria-label'], ...(f.attrLiterals?.['aria-label'] ?? []), f.attrs.title, ...(f.attrLiterals?.title ?? []), f.children.srLabel, f.children.text].filter(x => x && x !== DYNAMIC) as string[];
  const hit = names.find(n => /\b(collapse|expand|show (more|less|all|details)|see (more|less|all)|hide (details|all)|more details|fewer details|minimi[sz]e|maximi[sz]e)\b/i.test(n));
  return hit ? hit.slice(0, 40) : null;
}
