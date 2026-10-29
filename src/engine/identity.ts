import { describe, type Recommendation } from './classify.js';
import { system } from './system.js';
import type { ElementEval } from './elements.js';

/**
 * Design identity: how a design-system designer would group the review. Not by the scanner's rule
 * id, and never by a utility class (HOVER_WASH pairs a menu row with a filter chip). In order:
 *
 *   1. the control it belongs to: a hand-built copy of a system component (its insides), or one menu,
 *      toggle set, toolbar or button pair. A control's parts stay in one card, even when some are
 *      already sure, with one decision row per kind of part;
 *   2. the design role (text action, list row, record name, icon button…);
 *   3. tone (red, grey, blue) and the recommended component with its size.
 *
 * Every card names the pattern in designer words and states the decision needed.
 */

export type Tone = 'danger' | 'muted' | 'primary';

const REST = (t: string) => !/:/.test(t);
export function toneOf(e: Pick<ElementEval, 'classTokens'>): Tone | undefined {
  const t = e.classTokens ?? [];
  if (t.some(x => /(^|:)(text|bg|border)-destructive\b/.test(x))) return 'danger';
  if (t.some(x => REST(x) && /^text-(primary|link)$/.test(x))) return 'primary';
  if (t.some(x => REST(x) && /^text-muted-foreground$/.test(x))) return 'muted';
  return undefined;
}

export const effectiveRec = (e: ElementEval): Recommendation => e.decided?.decision ?? e;

/** Where a decision lands, for grouping the page: the system's component, or no home yet, or keep native. */
export function homeOf(r: Recommendation): string {
  if (r.verdict === 'replace' && r.use) return r.use;
  if (r.verdict === 'gap') return `No ${system().label} home yet`;
  if (r.verdict === 'keep') return 'Keep native';
  if (r.verdict === 'ignore') return 'Ignored';
  return 'Unclear';
}

/** The control an element is part of, when it shares one with others: a copy of a system component, or a wrapper. */
export function controlOf(e: ElementEval): string | undefined {
  if (e.recipe) return `recipe:${e.file}#${e.recipe}`;
  if (e.container) return `in:${e.file}#${e.container.line}`;
  return undefined;
}

/** What an icon-only button does, from its label or its glyph: designers group close, remove and edit apart. */
export type Meaning = 'close' | 'remove' | 'edit' | 'more' | 'pager' | 'expand' | 'add' | 'search';
const MEANINGS: [Meaning, RegExp][] = [
  ['close', /\b(close|dismiss)\b|^x(icon)?$/i],
  ['remove', /\b(remove|delete|trash|clear|unlink)\b/i],
  ['edit', /\b(edit|pencil|rename)\b/i],
  ['more', /more_(horiz|vert)|\b(more|ellipsis|dots|overflow)\b/i],
  ['pager', /chevron_(left|right)|arrow_(back|forward)|caret(left|right)|\b(previous|next|prev)\b/i],
  ['expand', /\b(expand|collapse|unfold)\b|chevron_(up|down)|expand_(more|less)|caret(up|down)/i],
  ['add', /^(add|plus)$|\badd\b/i],
  ['search', /\bsearch\b|magnif/i],
];
export function meaningOf(e: Pick<ElementEval, 'role' | 'match' | 'source'>): Meaning | undefined {
  if (!/icon/.test(e.role)) return undefined;
  // A chevron on an expander turns; it doesn't page.
  if (e.role === 'disclosure-icon') return 'expand';
  const glyph = /<Icon\b[^>]*\bname="([\w-]+)"/.exec(e.source ?? '')?.[1] ?? /<([A-Z]\w*?)(Icon)?\s*\/>/.exec(e.source ?? '')?.[1] ?? '';
  const words = [e.match?.ariaLabel, e.match?.title, glyph.replace(/_/g, ' ')].filter(Boolean).join(' ');
  return MEANINGS.find(([, re]) => re.test(words) || re.test(glyph))?.[0];
}

/** Buttons the scanner reads as a specific pattern, or couldn't read at all, don't share a card with ordinary buttons. */
const subFamily = (e: ElementEval) => /region-(trigger|action)$/.exec(e.ruleId)?.[1] ?? (/\.(fallback|opaque|unknown)$/.test(e.ruleId) ? 'unread' : '');

/**
 * The design identity of an element on its own (steps 2 and 3): role, what it does, tone, and for plain
 * buttons the emphasis (variant). Size is not part of it: the same pencil at four sizes is one design
 * question ("make these consistent"), with one decision per version.
 */
export function familyKey(e: ElementEval): string {
  // The recommendation, not a recorded answer: answering a card doesn't move its members elsewhere.
  const sub = subFamily(e);
  return [e.role, sub, meaningOf(e) ?? '', toneKey(e), e.role === 'button' && !sub ? e.props?.variant ?? '' : '', e.verdict].join('|');
}
/**
 * Colour separates text actions (blue, grey, red, or plain until hover). For anything else only red
 * counts: a record name, a menu row or a quiet button is the same pattern in grey or blue.
 */
function toneKey(e: ElementEval): string {
  const tone = toneOf(e);
  if (e.role === 'link-button') return tone ?? (hoverLink(e) ? 'hover' : '');
  // Red is expected on a remove button; on anything else it's a design call of its own.
  return tone === 'danger' && meaningOf(e) !== 'remove' ? 'danger' : '';
}
const hoverLink = (e: ElementEval) => (e.classTokens ?? []).some(t => /^hover:(text-(primary|link)|underline)$/.test(t));

/** @deprecated familyKey plus the exact recommendation; kept for callers that need one answer per key. */
export const roleKey = (e: ElementEval) => `${familyKey(e)}|${describe(e)}`;

// ---- words

const ROLE_TITLE: Record<string, string> = {
  button: 'Buttons',
  'icon-button': 'Icon-only buttons',
  'cell-icon-button': 'Icon buttons in table cells',
  'link-button': 'Text actions',
  'record-link': 'Record names that open the record',
  'breadcrumb-link': 'Crumbs in a "/" trail',
  'breadcrumb-back': 'Back to the list',
  'clickable-region': 'List rows that open or pick something',
  'editable-cell': 'Cell values you click to edit',
  'choice-tile': 'Image tiles you pick one of',
  'drop-target': 'File drop areas',
  'color-input': 'Colour field parts',
  'selector-card': 'Choice cards',
  segmented: 'Segmented controls: pick one of a few',
  'chip-toggle': 'Filter chips you switch on and off',
  toggle: 'On/off toggle buttons',
  disclosure: 'Show and hide buttons',
  'disclosure-icon': 'Expand and collapse icon buttons',
  'sidebar-toggle': 'Sidebar collapse buttons',
  'nav-item': 'Navigation items',
  tab: 'Tabs',
  'menu-item': 'Rows in a menu or list',
  'combobox-item': 'Options in a picker',
  switch: 'On/off switches',
  checkbox: 'Checkboxes',
  'checkbox-role': 'Checkboxes built from buttons',
  radio: 'Radio buttons',
  'radio-role': 'Radio buttons built from buttons',
  'text-input': 'Text fields',
  'search-input': 'Search fields',
  'number-input': 'Number fields',
  textarea: 'Multi-line text fields',
  date: 'Date fields',
  range: 'Sliders',
  select: 'Dropdown selects',
  combobox: 'Searchable selects',
  'multi-select': 'Multi-selects',
  'data-table': 'Tables people sort, filter or select in',
  'static-table': 'Simple tables',
  dialog: 'Dialogs',
  'native-dialog': 'Dialogs opened from code',
  'hidden-proxy': 'Hidden inputs behind another control',
  'context-menu-item': 'Rows in a right-click menu',
  'menu-checkbox-item': 'Menu rows that switch a setting on and off',
  'menu-radio-item': 'Menu rows that pick one of a few',
  'menu-sub-trigger': 'Menu rows that open another menu',
  'row-expander': 'Expanders on table group rows',
  get 'host-copy'() { return `Host copies of ${system().label} components`; },
};

const VARIANT_WORDS: Record<string, string> = {
  ghost: 'Quiet buttons (a fill on hover only)', outline: 'Outlined buttons', secondary: 'Grey filled buttons',
  default: 'Primary buttons', dark: 'Dark filled buttons', toolbar: 'Toolbar buttons', destructive: 'Red buttons for destructive actions', link: 'Buttons styled as links',
};

/** "Grey text actions", "Red icon-only buttons", "List rows that open or pick something". */
const MEANING_TITLE: Record<Meaning, string> = {
  close: 'Close buttons (✕)', remove: 'Remove buttons', edit: 'Edit buttons (pencil)', more: 'More-actions buttons (⋯)',
  pager: 'Previous and next buttons', expand: 'Expand and collapse buttons', add: 'Add buttons (+)', search: 'Search buttons',
};
const SUB_TITLE: Record<string, string> = {
  trigger: 'Image buttons that open a menu (avatar, thumbnail)', action: 'Wide single actions (one label with icons)', unread: 'Buttons we couldn’t read: choose the component',
};

export function titleOf(e: ElementEval): string {
  const r: Recommendation = e, tone = toneOf(e);
  const sub = subFamily(e), meaning = meaningOf(e);
  if (sub && SUB_TITLE[sub]) return SUB_TITLE[sub];
  if (meaning) return MEANING_TITLE[meaning] + (tone === 'danger' && meaning !== 'remove' ? ', red' : '');
  if (e.role === 'clickable-region' && r.props?.variant === 'outline') return 'Cards that open or pick something';
  if (e.role === 'link-button') return tone === 'danger' ? 'Red text actions (remove, delete)' : tone === 'muted' ? 'Grey text actions' : tone === 'primary' ? 'Blue text actions' : hoverLink(e) ? 'Plain text that turns into a link on hover' : 'Text actions';
  if (e.role === 'button' && r.verdict === 'replace') return (tone === 'danger' && r.props?.variant !== 'destructive' ? 'Red ' + (VARIANT_WORDS[r.props?.variant ?? 'default'] ?? 'buttons').toLowerCase() : VARIANT_WORDS[r.props?.variant ?? 'default']) ?? 'Buttons';
  if (/icon-button/.test(e.role) && tone === 'danger') return 'Red icon-only buttons';
  return ROLE_TITLE[e.role] ?? `<${e.element}> elements`;
}

const propWords = (p?: Record<string, string>) => Object.entries(p ?? {}).filter(([k]) => k !== 'render').map(([k, v]) => `${k} ${v}`).join(', ');
const asButton = (r: Recommendation) => r.props?.render && /<button/.test(r.props.render) ? ' rendered as a button' : '';

/** The decision needed, as a question a designer can answer at a glance. */
export function askOf(r: Recommendation): string {
  if (r.verdict === 'gap') return `No ${system().label} component fits. Confirm the gap, or pick a component.`;
  if (r.verdict === 'keep') return 'Keep the native element?';
  if (r.verdict === 'ignore') return 'Set aside.';
  if (r.verdict === 'unclear' || !r.use) return 'We couldn’t tell what these are. Choose the component.';
  const p = propWords(r.props);
  if (r.role === 'host-copy') return `Import ${system().label} ${r.use} instead of the host's copy?`;
  const box = r.parent ? `, inside ${r.parent.use}${propWords(r.parent.props) ? ` (${propWords(r.parent.props)})` : ''}` : '';
  return `Replace with ${r.use}${asButton(r)}${p ? ` (${p})` : ''}${box}?`;
}

const labelOf = (e: ElementEval) => e.match?.text || e.match?.ariaLabel || e.match?.title || '';
const fileName = (f: string) => (f.split('/').pop() ?? f).replace(/\.[jt]sx?$/, '');

/** Title for a card holding one control's parts: what the control is, where, and what its parts say. */
export function controlTitle(items: ElementEval[]): string {
  const e = items[0]!, n = items.length;
  if (e.recipe) return `The insides of a hand-built ${e.recipe} (${n} parts)`;
  const box = e.container?.name ?? '';
  const where = ` in ${fileName(e.file)}`;
  const labels = [...new Set(items.map(labelOf).filter(Boolean))];
  const said = labels.length ? `: ${labels.slice(0, 4).map(l => `“${l.slice(0, 24)}”`).join(', ')}${labels.length > 4 ? '…' : ''}` : '';
  const allRoles = (re: RegExp) => items.every(i => re.test(i.role));
  if (/Menu|Dropdown|role=menu|role=listbox/.test(box) || allRoles(/^(menu-item|context-menu-item|menu-(checkbox|radio)-item|menu-sub-trigger)$/)) return `One menu${where}${said}`;
  if (/ToggleGroup|Segment|role=(group|radiogroup)/.test(box) || allRoles(/^(segmented|chip-toggle|toggle)$/)) return `One set of options${where}${said}`;
  if (/Toolbar|role=toolbar|ButtonGroup/.test(box)) return `One toolbar${where}${said}`;
  if (/Popover|Popup|Float/.test(box)) return `One pop-up panel${where}${said}`;
  return `${n} controls side by side${where}${said}`;
}

/** What a recipe card should say first: the real answer is often the system's component itself. */
export const recipeNote = (recipe: string) => `This file rebuilds ${system().label} ${recipe}. Importing ${recipe} from ${system().label} replaces all of these at once; migrate the parts only if that isn't possible yet.`;
