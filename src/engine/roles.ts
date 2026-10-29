import type { Verdict } from './classify.js';
import { system, type EngineSystem } from './system.js';

/** What the design system offers for each role. The profile supplies it; the element map's roles section overrides it. */
export interface RoleMap {
  /** how: one line on how the component takes over, when it isn't a one-for-one swap (a DataTable column option). */
  roles: Record<string, { use: string; from?: string | undefined; props?: Record<string, string>; gap?: string | undefined; verdict?: Verdict | undefined; how?: string | undefined }>;
  /** Token evidence for each Button variant, strongest first. */
  variants: [string, RegExp][];
  /** Token evidence for each size key. */
  sizes: [string, RegExp][];
  /** Size key -> icon size prop value. */
  iconSizes: Record<string, string>;
}

/**
 * Neutral offers when the profile names none: the component names most React systems use (shadcn,
 * Radix), with no import paths. A system's profile re-points each role at its own component. Role
 * names are API: re-point, never remove. Item granularity on purpose: a set member is
 * ToggleGroupItem/TabsTrigger/RadioGroupItem, not the root.
 */
export const NEUTRAL_ROLES: RoleMap['roles'] = {
  button: { use: 'Button' },
  'icon-button': { use: 'Button', props: { variant: 'ghost' }, how: 'An icon-only Button: an icon size, an aria-label, and the icon as its only child.' },
  'cell-icon-button': { use: 'Button', props: { variant: 'ghost' } },
  'link-button': { use: 'Button', props: { variant: 'link' } },
  toggle: { use: 'Toggle' },
  segmented: { use: 'ToggleGroupItem' },
  'chip-toggle': { use: 'ToggleGroupItem', gap: 'No chip-shaped toggle: ToggleGroupItem is the closest home.' },
  disclosure: { use: 'CollapsibleTrigger' },
  'disclosure-icon': { use: 'Button', how: 'An icon-only Button with an aria-label and aria-expanded; the chevron icon turns when open.' },
  'sidebar-toggle': { use: 'SidebarTrigger' },
  'nav-item': { use: 'SidebarMenuButton' },
  'record-link': { use: 'Button', props: { variant: 'link' } },
  // A crumb in a real "/" trail. Back controls ("← List") are breadcrumb-back.
  'breadcrumb-link': { use: 'BreadcrumbLink' },
  'breadcrumb-back': { use: 'BreadcrumbLink', how: 'A back control at the start of the trail; it keeps the handler and draws the chevron.' },
  tab: { use: 'TabsTrigger' },
  'menu-item': { use: 'DropdownMenuItem' },
  // role="option": a value picked from a list (a picker), not a menu command.
  'combobox-item': { use: 'ComboboxItem', how: 'Each option is a ComboboxItem in a list; the field around it is a Combobox.' },
  switch: { use: 'Switch' },
  'checkbox-role': { use: 'Checkbox' },
  'radio-role': { use: 'RadioGroupItem' },
  // A list row or card that opens or picks something.
  'clickable-region': { use: 'Item', props: { render: '<button type="button" />' }, how: 'Item renders as the button; any actions inside it go in its actions slot.' },
  'editable-cell': { use: 'DataTable', how: 'Make the column editable; the table draws the click-to-edit cell.' },
  'choice-tile': { use: 'ToggleGroupItem', how: 'Wrap the set in ToggleGroup (single); each tile is a ToggleGroupItem with an aria-label.' },
  'drop-target': { use: '', verdict: 'gap', gap: 'The system has no file dropzone (drop files here, or click to browse). Propose one, starting from the app\'s version.' },
  'selector-card': { use: '', verdict: 'gap', gap: 'The system has no choice card (a card picked as one option of a set). Until then: RadioGroup with each RadioGroupItem inside a Label card.' },
  'text-input': { use: 'Input' },
  'search-input': { use: 'Input' },
  checkbox: { use: 'Checkbox' },
  radio: { use: 'RadioGroupItem' },
  range: { use: 'Slider' },
  date: { use: 'DatePicker' },
  'number-input': { use: 'Input', props: { type: 'number' } },
  'color-input': { use: '', verdict: 'gap', gap: 'The system has no colour field (swatch, picker and value entry). Propose one, starting from the app\'s version.' },
  'hidden-proxy': { use: '', verdict: 'keep' },
  'data-table': { use: 'DataTable' },
  'static-table': { use: 'Table' },
  select: { use: 'Select' },
  combobox: { use: 'Combobox' },
  'multi-select': { use: 'Combobox', props: { multiple: 'true' } },
  textarea: { use: 'Textarea' },
  dialog: { use: 'Dialog' },
  'native-dialog': { use: 'Dialog' },
  // Parts by kind (classify-parts.ts): each only works inside its container, which the review names with it.
  'context-menu-item': { use: 'ContextMenuItem' },
  'menu-checkbox-item': { use: 'DropdownMenuCheckboxItem' },
  'menu-radio-item': { use: 'DropdownMenuRadioItem' },
  'menu-sub-trigger': { use: 'DropdownMenuSubTrigger' },
  'row-expander': { use: 'Button', props: { variant: 'ghost' }, how: 'A ghost Button with aria-expanded; inside a data table, the table\'s own grouped rows.' },
};

/** Button evidence most Tailwind systems share (shadcn's class names). */
const NEUTRAL_VARIANTS: [string, RegExp][] = [
  ['destructive', /^(bg-destructive|text-destructive|border-destructive)/],
  ['default', /^bg-primary(\/|$)/],
  ['dark', /^bg-foreground(\/|$)/],
  ['secondary', /^bg-(secondary|muted)(\/|$)/],
  ['outline', /^border(-input|-border)?$/],
  ['ghost', /^hover:bg-/],
];
const NEUTRAL_ICON_SIZES: Record<string, string> = { xs: 'icon-xs', sm: 'icon-sm', default: 'icon', lg: 'icon-lg' };

/** Size evidence: the Tailwind height steps, plus the profile's control-height properties at the same px. */
function sizesFor(s: EngineSystem): [string, RegExp][] {
  const vars = (px: number[]) => Object.entries(s.controlHeights).filter(([, v]) => px.includes(v)).map(([k]) => `\\(--${k.replace(/[-]/g, '\\-')}\\)`);
  const alt = (steps: string[], px: number[]) => new RegExp(`^(h|size)-(${[...steps, ...vars(px)].join('|')})$`);
  return [
    ['xs', alt(['6'], [24])],
    ['sm', alt(['7'], [28])],
    ['lg', alt(['9', '10'], [36, 40])],
    ['default', alt(['8'], [32])],
  ];
}

const cache = new WeakMap<EngineSystem, RoleMap>();

/** The role map for the current system: the neutral offers, the profile's roles and button tokens over them. */
export function systemRoleMap(s: EngineSystem = system()): RoleMap {
  const hit = cache.get(s);
  if (hit) return hit;
  const p = s.profile;
  const bt = p.buttonTokens ?? {};
  const map: RoleMap = {
    roles: { ...NEUTRAL_ROLES, ...(p.roles as RoleMap['roles']) },
    variants: bt.variants ? Object.entries(bt.variants).map(([k, re]) => [k, new RegExp(re)]) : NEUTRAL_VARIANTS,
    sizes: bt.sizes ? Object.entries(bt.sizes).map(([k, re]) => [k, new RegExp(re)]) : sizesFor(s),
    iconSizes: bt.iconSizes ?? NEUTRAL_ICON_SIZES,
  };
  cache.set(s, map);
  return map;
}

/** The current system's roles (what classify falls back to for a role the map doesn't name). */
export const systemRoles = (): RoleMap['roles'] => systemRoleMap().roles;

/** Merge an element map's roles section over the system's role map. */
export function roleMapFrom(map: any): RoleMap {
  const base = systemRoleMap();
  const r = map?.roles;
  if (!r) return base;
  const out: RoleMap = { ...base, roles: { ...base.roles } };
  for (const [k, v] of Object.entries<any>(r.components ?? {})) out.roles[k] = v;
  if (r.variants) out.variants = Object.entries<string>(r.variants).map(([k, re]) => [k, new RegExp(re)]);
  if (r.sizes) out.sizes = Object.entries<string>(r.sizes).map(([k, re]) => [k, new RegExp(re)]);
  if (r.iconSizes) out.iconSizes = r.iconSizes;
  return out;
}
