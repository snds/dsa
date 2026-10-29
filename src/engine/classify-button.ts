import { system } from './system.js';
import type { Recommendation } from './classify.js';
import type { RoleMap } from './roles.js';
import { DYNAMIC, type ElementFeatures, type SwitchKind } from './scanners/features.js';
import { applyIconOnly, iconSize, semanticCandidate, sidebarHint } from './classify-semantics.js';
import { regionCandidates, regionOf } from './classify-region.js';
import { borderOf, boxOf, CELL_ICON_BUTTON, lookOf, resting, sizeKeyOfPx, SMALLEST_ICON_BUTTON, type Look } from './classify-look.js';

/**
 * Rules for native <button>s. Semantics first, presentation second:
 *   1. explicit role attributes
 *   2. disclosure (aria-expanded / aria-controls / data-state / a handler that opens / an expanded switch / a turning chevron)
 *   3. nav item (aria-current, or a current/selected switch in a nav or sidebar row)
 *   4. pressed toggle (single) vs segmented (one of a set)
 *   5. region: a list row or card, a cell value, a tile, a drop area, a colour part (classify-region.ts)
 *   6. icon-only: a property of the semantic winner; it becomes the icon-button action role only when there is none
 *   7. link / record-link / breadcrumb-back / breadcrumb-link / ghost / menu item / styled, as before
 * Four ARIA contracts (expanded, pressed, selected-in-set, current) look alike in class names;
 * collapsing them into "toggle" sent hosts to ToggleGroup for sidebars and row expanders.
 */

export interface Candidate extends Recommendation { ruleId: string; prior: number; reasons: { text: string; delta: number }[] }
export type RoleFn = (r: string, ruleId: string, prior: number, reasons: Candidate['reasons'], props?: Record<string, string>) => Candidate;

const hasVariantPrefix = (t: string) => /^[a-z-]+:/.test(t);
/** Old rows (before switchKind) only had the boolean. */
export const switchKindOf = (f: ElementFeatures): SwitchKind => f.classes.switchKind ?? (f.classes.selectedSwitch ? 'equality' : 'none');

/** Below this, a presentation candidate can't make a semantic call look close. */
const SEMANTIC_LEAD = 0.15;

export function buttonCandidates(f: ElementFeatures, map: RoleMap, role: RoleFn): Candidate[] {
  const all = [...f.classes.tokens, ...f.classes.conditional];
  const baseTokens = f.classes.tokens.filter(t => !hasVariantPrefix(t));
  const has = (re: RegExp, list = all) => list.some(t => re.test(t));
  const hasBase = (re: RegExp) => baseTokens.some(t => re.test(t));
  const c = f.children;
  const text = Boolean(c.text) || c.dynamicText > 0;
  const iconOnly = c.icons > 0 && !text && c.elements.length === 0;
  const roleAttr = f.attrs.role;
  const constNames = f.classes.viaConst.join(' ');
  const out: Candidate[] = [];
  const size = sizeOf(all, map);
  const kind = switchKindOf(f);

  // 1. Explicit ARIA roles say what the element is.
  if (roleAttr === 'tab') {
    const rich = c.elements.length >= 2;
    out.push(role('tab', 'button.role-tab', rich ? 0.76 : 0.92, [{ text: 'role="tab".', delta: 0 }, ...(rich ? [{ text: 'Tab contains several elements (card-style tab); standard Tabs look different.', delta: 0 }] : [])]));
    if (rich) out.push(role('selector-card', 'button.role-tab-card', 0.7, []));
  }
  if (roleAttr === 'switch') out.push(role('switch', 'button.role-switch', 0.93, [{ text: 'role="switch".', delta: 0 }]));
  if (roleAttr === 'checkbox') out.push(role('checkbox-role', 'button.role-checkbox', 0.88, [{ text: 'role="checkbox".', delta: 0 }]));
  if (roleAttr === 'radio') {
    const rich = c.elements.length >= 1 || c.images > 0;
    out.push(role(rich ? 'selector-card' : 'radio-role', rich ? 'button.role-radio-card' : 'button.role-radio', rich ? 0.8 : 0.86, [{ text: `role="radio"${rich ? ' with rich content (selectable card)' : ''}.`, delta: 0 }]));
  }
  if (roleAttr === 'menuitem') out.push(role('menu-item', 'button.role-menuitem', 0.86, [{ text: 'role="menuitem": a row in a menu.', delta: 0 }]));
  // An option is picked from a list of values (a picker), not run like a menu command.
  if (roleAttr === 'option') out.push(role('combobox-item', 'button.role-option', 0.86, [{ text: 'role="option": a value picked from a list. ComboboxItem is the system\'s picker option.', delta: 0 }]));
  // role={mode === 'single' ? 'radio' : 'option'} with aria-checked/aria-selected: a selectable option, whichever role wins at runtime.
  if (roleAttr === DYNAMIC && (f.attrs['aria-checked'] !== undefined || f.attrs['aria-selected'] !== undefined)) {
    const roles = f.attrLiterals?.role ?? [];
    const rich = c.elements.length >= 1 || c.images > 0;
    const r = [{ text: `Computed role${roles.length ? ` (${roles.join(' / ')})` : ''} with aria-checked/aria-selected: a selectable option.`, delta: 0 }];
    out.push(rich ? role('selector-card', 'button.role-dynamic-card', 0.78, r) : role(roles.includes('radio') ? 'radio-role' : roles.includes('option') ? 'combobox-item' : 'menu-item', 'button.role-dynamic', 0.78, r));
  }
  if (out.length) return out;

  // 2–4. What state the button carries decides what it is.
  const sem = semanticCandidate(f, map, role, { text, iconOnly, kind, has, constNames });

  // 5. Region: a button wrapping more than a label. Each pattern has its own home (classify-region.ts).
  // Link-style text that opens a record is a record name (7, record-link), not an inline cell trigger.
  const linky = hasBase(/^(text-primary|text-link|underline)$/) || /LINK|CRUMB/.test(constNames);
  const hoverLink = !linky && has(/^hover:(text-primary|underline|text-link)$/);
  const recordish = text && !c.text && c.dynamicText > 0 && f.handlerIntent === 'open' && (linky || hoverLink);
  const region = regionOf(f, { text, recordish, has, hasBase });
  if (region) out.push(...regionCandidates(f, region, role, variantOf(f, map).key));
  const regionSignals = region ? region.reasons : [];

  // A class switch with no set around it and a handler that doesn't flip it: maybe a toggle, not enough to outrank the look.
  if (!sem && (kind === 'equality' || kind === 'pressed') && (text || iconOnly) && !regionSignals.length) {
    out.push(role('toggle', 'button.toggle-weak', 0.72, [{ text: kind === 'equality' ? 'Classes switch on an equality, but no set (map, group, sibling buttons) and no pressed state: maybe a toggle.' : 'Classes switch on a flag the handler doesn\'t flip (enabled? selected?): maybe a toggle.', delta: 0 }]));
  }

  // 6. Icon-only control: a presentation of the semantic winner, or an action of its own.
  // Size comes from the real box (a size token, or the glyph plus its padding), never the glyph's size prop.
  const look = lookOf(f);
  const sq = sizeOf(all, map, true);
  const box = iconOnly ? boxOf(f) : undefined;
  const sizeKey = sq.key ?? (box && 'px' in box ? sizeKeyOfPx(box.px) : undefined);
  const iconReasons = (): Candidate['reasons'] => {
    const name = c.srLabel || f.attrs['aria-label'] || f.attrs.title;
    // No name means someone has to write the label before it can migrate.
    const r: Candidate['reasons'] = [{ text: name && name !== DYNAMIC ? `Shows only an icon, labelled "${name}"${c.badges ? ', with a count badge' : ''}.` : name ? 'Shows only an icon; its label is computed.' : 'Shows only an icon. It needs a written label for the tooltip and screen readers.', delta: name ? 0 : -0.04 }];
    if (c.badges) r.push({ text: 'Has a count badge; keep it as a child of the Button.', delta: -0.02 });
    r.push(...boxReasons(sq, box, look));
    return r;
  };
  if (sem) {
    if (iconOnly) {
      applyIconOnly(sem, map, sizeKey, iconReasons(), sidebarHint(f), look.border === 'box');
      if (look.toolbar && sem.role === 'disclosure-icon') Object.assign(sem.props!, toolbarProps(sem.use));
    }
    // The look still matters for props, but it can't outvote the state the element announces.
    for (const o of out) o.prior = Math.min(o.prior, sem.prior - SEMANTIC_LEAD);
    out.unshift(sem);
    if (iconOnly) return out;
  } else if (iconOnly) {
    const cellish = /CELL_ICON|CellIcon/i.test(constNames) || f.context.inTableCell || /Cell|Column|RowAction/.test(f.context.within);
    if (cellish) {
      const strong = /CELL_ICON|CellIcon/i.test(constNames);
      out.push(role('cell-icon-button', 'button.icon-cell', strong ? 0.94 : 0.84, [
        { text: strong ? `Uses the cell icon button classes (${constNames}).` : 'Icon-only button in a table cell or row-actions context.', delta: 0 },
      ]));
    }
    const r = iconReasons();
    if (has(/^(w|h)-3(\.5)?$/) && has(/^absolute$/)) r.push({ text: 'A tiny control placed over another element, like a chip\'s ✕: check what it belongs to.', delta: -0.12 });
    const def = map.roles['icon-button'];
    // Toolbar chrome (bordered, raised, control height) is Button variant="toolbar"; a full border is outline; a
    // one-side border is a divider from the group around it, not an outline.
    const props = look.toolbar ? toolbarProps(def?.use) : { variant: look.border === 'box' ? 'outline' : (def?.props?.variant ?? 'ghost'), size: iconSize(def?.use, sizeKey, map) };
    if (look.toolbar) r.push({ text: `Toolbar chrome (a border, a raised shadow, control height): variant "toolbar".`, delta: 0 });
    else if (look.border === 'side') r.push({ text: 'Its border is on one side only: a divider from the group around it, not an outline.', delta: 0 });
    out.push(role('icon-button', 'button.icon', cellish ? 0.82 : 0.9, r, props));
    return out;
  }

  // 7. Text link: colored/underlined text, no box.
  // Link at rest (colored or underlined without hover); hover-only link styling is a different, weaker pattern.
  // A box at rest: a fill, a full border (a one-side border is a divider), or a padded rounded shape.
  const boxy = hasBase(/^bg-(?!transparent)/) || borderOf(resting(f.classes.tokens)) === 'box' || hasBase(/^(h-|py-[2-9]|px-[3-9])/) && hasBase(/^rounded/);
  // Back or trail is decided by what it does and shows, never by a class constant's name (CRUMB_LINK also styles "Advanced Search ›").
  const { back, trail } = crumbOf(f);
  if (!sem && text && (linky || hoverLink || has(/^text-muted-foreground$/)) && !boxy && !regionSignals.length) {
    if (recordish) out.push(role('record-link', 'button.record-link', 0.88, [{ text: 'Shows a record\'s name and opens it: ObjectName is the system\'s record name.', delta: 0 }]));
    if (back) out.push(role('breadcrumb-back', 'button.breadcrumb-back', 0.9, [{ text: `Goes back to the list (${back}): BreadcrumbBack is the system's back control.`, delta: 0 }]));
    else if (trail && (linky || hoverLink)) out.push(role('breadcrumb-link', 'button.breadcrumb', 0.88, [{ text: `A crumb in a "/" trail (${trail}): BreadcrumbLink inside a Breadcrumb.`, delta: 0 }]));
  }
  if (text && linky && !boxy && !regionSignals.length) {
    const r: Candidate['reasons'] = [{ text: 'Link-coloured text with no box: a text action.', delta: 0 }];
    if (back) r.push({ text: 'It goes back to the list: BreadcrumbBack is the system\'s back control.', delta: -0.06 });
    else if (trail) r.push({ text: 'It is a crumb in a "/" trail: a Breadcrumb may fit better.', delta: -0.06 });
    else if (f.context.inNav) r.push({ text: 'Sits in navigation: a link with aria-current may fit better.', delta: -0.04 });
    if (recordish) r.push({ text: 'Opens a record by its name; ObjectName is the system home for record names.', delta: -0.06 });
    if (c.elements.length) r.push({ text: `Also renders ${c.elements.join(', ')} inside.`, delta: -0.05 });
    out.push(role('link-button', 'button.link', 0.91, r));
  }

  // 7b. Quiet text action: muted text, no box, no link color.
  const hoverFill = has(/^hover:bg-/);
  const textSize = has(/^text-(xs|\[1[01]px\])$/) ? 'xs' : has(/^text-sm$/) ? 'sm' : undefined;
  // Ghost text button: no box at rest, fills on hover.
  if (text && !linky && !boxy && hoverFill && !f.classes.selectedSwitch && !regionSignals.length && !has(/^w-full$/)) {
    const sz = size.key ?? (textSize === 'xs' ? 'xs' : 'sm');
    out.push(role('button', 'button.ghost', size.key ? 0.92 : 0.89, [
      { text: 'Quiet button: no fill until hover (ghost).', delta: 0 },
      { text: size.key ? `Size ${sz} from ${size.token}.` : `Size ${sz} inferred from ${textSize ? `text-${textSize === 'xs' ? 'xs' : 'sm'}` : 'padding'}.`, delta: 0 },
    ], { variant: 'ghost', size: sz }));
  }
  // Quiet text action: muted text, no box, no hover fill.
  const quiet = text && !linky && !boxy && !hoverFill && has(/^text-muted-foreground$/) && !regionSignals.length;
  if (quiet) {
    out.push(role('link-button', 'button.quiet-text', 0.64, [{ text: 'Grey text action with no box. Link turns it blue; ghost adds a hover fill. Pick the emphasis.', delta: 0 }]));
    out.push(role('button', 'button.quiet-ghost', 0.6, [{ text: 'Ghost button would add a hover box the original lacks.', delta: 0 }], { variant: 'ghost', size: 'xs' }));
  }
  // Link on hover only: plain text at rest that turns primary/underlined on hover (record names).
  if (text && hoverLink && !boxy && !hoverFill && !regionSignals.length) {
    out.push(role('link-button', 'button.hover-link', 0.7, [{ text: 'Plain text that turns into a link on hover. Button link is link-coloured all the time.', delta: 0 }]));
    out.push(role('button', 'button.hover-link-ghost', 0.55, [], { variant: 'ghost' }));
  }
  // Destructive text action: red at rest, or grey text that turns red on hover (a quiet remove).
  if (text && !boxy && (has(/^text-destructive$/) || look.danger === 'hover') && !hoverFill) {
    const quietRed = !has(/^text-destructive$/);
    out.push(role('button', 'button.destructive-text', 0.66, [{ text: quietRed ? 'Grey text that turns red on hover: a quiet remove or delete. Button destructive is red at rest and draws a tinted box.' : `Destructive text action with no box. ${system().label} destructive variant draws a box; the link variant is not red.`, delta: 0 }], { variant: 'destructive', size: 'xs' }));
    out.push(role('link-button', 'button.destructive-link', 0.6, []));
  }

  // 7c. Menu item: full-width row with icon + label in a list/float.
  if (text && has(/^w-full$/) && has(/^text-left$/) && has(/^hover:bg-/) && c.elements.length === 0 && !f.classes.selectedSwitch) {
    const listy = f.context.inList || f.context.inMap || /Menu|Popover|Float|Dropdown/.test(f.context.ancestors.join(' ') + f.context.within);
    out.push(role('menu-item', 'button.menu-item', listy ? 0.84 : 0.72, [{ text: 'A full-width row in a list. Check which list: a dropdown menu, a right-click menu, a page index or a step list.', delta: 0 }, ...(listy ? [] : [{ text: 'No menu around it in the code.', delta: 0 }])]));
  }

  // 7d. Styled like a button: box + padding/height.
  if (text && boxy && !regionSignals.length) {
    const v = variantOf(f, map);
    const r: Candidate['reasons'] = [{ text: 'A text button with its own box (a fill or border, and padding).', delta: 0 }];
    r.push(v.token ? { text: `Variant ${v.key} from ${v.token}.`, delta: 0 } : { text: 'Couldn\'t read its emphasis from the classes; variant left at default.', delta: -0.08 });
    r.push(size.key ? { text: `Size ${size.key} from ${size.token}.`, delta: 0 } : { text: 'Its height isn\'t on the button size scale; size left at default.', delta: -0.04 });
    if (f.classes.selectedSwitch) r.push({ text: 'Its look switches on a condition: it may be a toggle.', delta: -0.08 });
    out.push(role('button', 'button.styled', 0.92, r, { variant: v.key, ...(size.key && size.key !== 'default' ? { size: size.key } : {}) }));
  }

  if (sem) for (const o of out) if (o !== sem) o.prior = Math.min(o.prior, sem.prior - SEMANTIC_LEAD);

  // 8. Nothing matched strongly.
  if (!out.length) {
    if (!text && !c.icons && c.elements.length === 0) out.push(role('button', 'button.opaque', 0.42, [{ text: 'Its content comes from elsewhere, so its label and look can\'t be read from the code.', delta: 0 }]));
    else if (text && !f.classes.present) out.push(role('button', 'button.unstyled', 0.6, [{ text: 'Unstyled text button: a Button fits, but the original has no visual treatment to match.', delta: 0 }], { variant: 'ghost' }));
    else out.push(role('button', 'button.fallback', 0.5, [{ text: 'We couldn\'t tell what this is. Choose the component.', delta: 0 }], { variant: variantOf(f, map).key }));
  }
  return out;
}

/**
 * Back control or trail crumb, from what the element does and shows. back: a handler that returns to the
 * list (onBack, setOpenId(null)), a leading back-arrow icon, or ← / ‹ text. trail: "/" path text, or
 * inside a Breadcrumb. Each answer says why, for the reason text.
 */
export function crumbOf(f: ElementFeatures): { back?: string | undefined; trail?: string | undefined } {
  const c = f.children;
  const back = f.handlerIntent === 'back' ? 'its handler returns to the list'
    : c.backIcon ? 'it starts with a back arrow'
    : /^\s*(←|‹|«)/.test(c.text) ? 'its text starts with a back arrow'
    : undefined;
  const trail = /\s\/\s/.test(c.text) ? '"/" path text'
    : f.context.ancestors.some(a => /Breadcrumb/.test(a)) ? 'inside a Breadcrumb'
    : undefined;
  return { back, trail };
}

/** Button's toolbar look: variant toolbar at toolbar-icon size (an IconButton takes its own default size). */
function toolbarProps(use: string | undefined): Record<string, string> {
  return { variant: 'toolbar', size: use === 'IconButton' ? 'default' : 'toolbar-icon' };
}

/**
 * How big the icon button is today and what it becomes. Growth is a design decision, so it's stated as
 * one ("It is 16px today; the smallest icon button is 24px"), not as the scanner's doubt.
 */
function boxReasons(sq: { key?: string | undefined; token?: string | undefined }, box: ReturnType<typeof boxOf>, look: Look): Candidate['reasons'] {
  if (look.toolbar) return [];
  if (sq.key) return [{ text: `Size from ${sq.token}.`, delta: 0 }];
  if (!box) return [{ text: 'Its size can\'t be read from the code; size left at default.', delta: -0.05 }];
  if ('layout' in box) return [{ text: `Its size comes from the layout around it (${box.layout}): it is part of a bigger control. Check what it belongs to.`, delta: -0.04 }];
  if (box.px < SMALLEST_ICON_BUTTON) {
    return [{ text: `It is ${box.px}px today (${box.how}); the smallest icon button is ${SMALLEST_ICON_BUTTON}px. Approve the growth, or use the ${CELL_ICON_BUTTON}px cell icon button.`, delta: -0.04 }];
  }
  const key = sizeKeyOfPx(box.px), on = { xs: 24, sm: 28, default: 32, lg: 36 }[key]!;
  return box.px === on
    ? [{ text: `It is ${box.px}px (${box.how}): size ${key}.`, delta: 0 }]
    : [{ text: `Its size (${box.px}px, ${box.how}) isn't on the button size scale; ${key} (${on}px) is closest.`, delta: -0.02 }];
}

export function variantOf(f: ElementFeatures, map: RoleMap): { key: string; token?: string | undefined } {
  const base = f.classes.tokens;
  // A border colour with no full border width (border-b border-border) is a divider, not an outline.
  const boxed = borderOf(resting([...base, ...f.classes.conditional])) === 'box';
  for (const [key, re] of map.variants) {
    if (key === 'outline' && !boxed) continue;
    const tok = base.find(t => re.test(t)) ?? f.classes.conditional.find(t => re.test(t) && key !== 'ghost');
    if (tok) return { key, token: tok };
  }
  return { key: 'default' };
}

export function sizeOf(tokens: string[], map: RoleMap, square = false): { key?: string | undefined; token?: string | undefined } {
  for (const [key, re] of map.sizes) {
    const tok = tokens.find(t => !hasVariantPrefix(t) && (re.test(t) || (square && re.test(t.replace(/^w-/, 'h-')))));
    if (tok) return { key, token: tok };
  }
  return {};
}
