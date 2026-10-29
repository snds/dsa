import type { ElementFeatures } from './scanners/features.js';
import { system } from './system.js';

/**
 * How an element looks at rest, read from its classes (audit item 8).
 *
 * - State classes (hover:, active:, focus:, aria-expanded:, data-*:, group-hover:) are not the resting look:
 *   a ghost button fills only on hover. Responsive (md:) and theme (dark:) prefixes still apply at rest.
 * - When nothing at rest draws a fill or border, the "on" branch of a class condition is the resting look
 *   to compare (a primary "Select Image" that is filled once something is picked).
 * - A border on one side (border-l, border-b) is a divider, not an outline; `border border-transparent`
 *   draws no box.
 * - Red text is a tone the component has to keep, at rest or on hover.
 * - Toolbar chrome is a bordered, raised square at control height (a Button variant="toolbar").
 */
export interface Look {
  /** Resting tokens, with responsive/theme prefixes stripped. */
  rest: string[];
  /** The fill or border was read from the "on" branch of a class condition, not the resting classes. */
  fromBranch: boolean;
  fill: boolean;
  border: 'box' | 'side' | 'none';
  /** Fills on hover or press (ghost). */
  hoverFill: boolean;
  /** Red: a red fill, red text at rest, red only on hover (a quiet danger action), or red when it's on (armed). */
  danger?: 'fill' | 'rest' | 'hover' | 'on' | undefined;
  /** Bordered, raised, control-height chrome: Button variant="toolbar". */
  toolbar: boolean;
}

/** Variants that still describe the resting look. Everything else (hover, aria-*, data-*, [&_svg]) is a state. */
const RESTING_PREFIX = /^(sm|md|lg|xl|2xl|dark|print|motion-safe|motion-reduce|max-[\w-]+|min-[\w-]+|@[\w-]+)$/;

/** "hover:bg-accent" → ['hover', 'bg-accent']; colons inside [] or () are part of the value. */
export function variantsOf(token: string): { prefixes: string[]; base: string } {
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of token) {
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ':' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  return { prefixes: parts, base: cur };
}

/** Tokens that apply at rest (no state prefix), prefixes stripped. */
export function resting(tokens: string[]): string[] {
  return tokens.map(variantsOf).filter(v => v.prefixes.every(p => RESTING_PREFIX.test(p.replace(/^!/, '')))).map(v => v.base.replace(/^!|!$/g, ''));
}
const stateful = (tokens: string[]) => tokens.map(variantsOf).filter(v => v.prefixes.length && !v.prefixes.every(p => RESTING_PREFIX.test(p)));

const FILL = /^bg-(?!transparent$|none$|inherit$|current$|clip-|origin-|repeat|no-repeat|cover$|contain$|center$|fixed$|local$|scroll$|gradient-|linear-|radial-|conic-|blend-)/;
const BOX_WIDTH = /^border(-[0-9]+|-\[\d+(\.\d+)?px\])?$/;
const SIDE_WIDTH = /^border-[lrtbxyse](-[0-9]+|-\[\d+(\.\d+)?px\])?$/;
const NO_BORDER = /^border-(0|none|transparent)$/;

export function borderOf(rest: string[]): Look['border'] {
  if (rest.some(t => NO_BORDER.test(t))) return 'none';
  if (rest.some(t => BOX_WIDTH.test(t))) return 'box';
  if (rest.some(t => SIDE_WIDTH.test(t))) return 'side';
  return 'none';
}

const RED_TEXT = /^text-(destructive|red-\d+)(\/\d+)?$/;
const RED_FILL = /^bg-(destructive|red-[5-9]00)$/;
/** A control's height: h-8, h-9, the profile's control-height properties of 28px or more, or --button-height. */
const controlHeightRe = new WeakMap<object, RegExp>();
function controlHeight(): RegExp {
  const s = system();
  let re = controlHeightRe.get(s);
  if (!re) {
    const vars = Object.entries(s.controlHeights).filter(([, px]) => px >= 28).map(([k]) => `\\(--${escapeRe(k)}\\)`);
    re = new RegExp(`^(h|size)-(8|9|${[...vars, '\\(--button-height\\)'].join('|')})$`);
    controlHeightRe.set(s, re);
  }
  return re;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** branch: false reads the resting classes only (a set member's "on" side is its chosen look, not its rest). */
export function lookOf(f: ElementFeatures, opts: { branch?: boolean | undefined } = {}): Look {
  const c = f.classes;
  let rest = resting(c.tokens);
  const restFill = rest.some(t => FILL.test(t)), restBorder = borderOf(rest);
  let fromBranch = false;
  // Nothing drawn at rest, but the "on" branch draws a box: that branch is how the control normally reads.
  if (opts.branch !== false && !restFill && restBorder === 'none' && c.onBranch?.length) {
    const on = resting(c.onBranch);
    if (on.some(t => FILL.test(t)) || borderOf(on) !== 'none') { rest = [...rest, ...on]; fromBranch = true; }
  }
  const states = stateful([...c.tokens, ...c.conditional]);
  const all = resting([...c.tokens, ...c.conditional]);
  const danger = rest.some(t => RED_FILL.test(t)) ? 'fill' as const
    : rest.some(t => RED_TEXT.test(t)) ? 'rest' as const
    : states.some(v => RED_TEXT.test(v.base) && v.prefixes.some(p => /^(hover|group-hover|focus-visible|active)$/.test(p))) ? 'hover' as const
    : resting(c.onBranch ?? []).some(t => RED_TEXT.test(t) || /^border-destructive$/.test(t)) ? 'on' as const
    : undefined;
  const border = borderOf(rest);
  // A helper's classes (toolbarIconBtn()) arrive as conditional: chrome is chrome whichever branch is on.
  const toolbar = (border === 'box' || borderOf(all) === 'box') && all.includes('shadow-sm') && all.some(t => controlHeight().test(t))
    || /toolbar/i.test(c.viaConst.join(' ')) && all.includes('shadow-sm');
  return {
    rest, fromBranch, border, toolbar, ...(danger ? { danger } : {}),
    fill: rest.some(t => FILL.test(t)),
    hoverFill: states.some(v => /^bg-/.test(v.base) && !/^bg-transparent$/.test(v.base) && v.prefixes.some(p => /^(hover|active|group-hover)$/.test(p))),
  };
}

/** px per Icon size name (a system Icon and the host's copy). */
const ICON_PX: Record<string, number> = { micro: 10, xs: 12, sm: 14, md: 16, lg: 20, xl: 24, '2xl': 32 };
/** The system's control-height properties (the profile's controlHeights), e.g. xs 24, sm 28, default 32, lg 36. */
export const SMALLEST_ICON_BUTTON = 24;
export const CELL_ICON_BUTTON = 20;

/**
 * The real box of an icon-only button: its own size/height token, or the glyph plus padding on both sides.
 * `layout` when the box comes from the layout around it (flex-1, h-full): the parent decides, not the button.
 */
export function boxOf(f: ElementFeatures): { px: number; how: string } | { layout: string } | undefined {
  const all = resting([...f.classes.tokens, ...f.classes.conditional]);
  const px = (v: string): number | undefined => {
    const n = /^(\d+(\.\d+)?)$/.exec(v); if (n) return Number(n[1]) * 4;
    const b = /^\[(\d+(\.\d+)?)px\]$/.exec(v); if (b) return Number(b[1]);
    const d = /^\(--([\w-]+)\)$/.exec(v); if (d && d[1]! in system().controlHeights) return system().controlHeights[d[1]!];
    return undefined;
  };
  for (const pre of ['size', 'h', 'w']) {
    const t = all.find(x => x.startsWith(`${pre}-`) && px(x.slice(pre.length + 1)) !== undefined);
    if (t) return { px: px(t.slice(pre.length + 1))!, how: t };
  }
  const stretch = all.find(t => /^(flex-1|h-full|self-stretch|grow)$/.test(t));
  if (stretch) return { layout: stretch };
  const sizeName = f.children.iconSizes[0];
  const glyph = sizeName === undefined ? ICON_PX.md : ICON_PX[sizeName] ?? (Number(sizeName) || undefined);
  if (!glyph) return undefined;
  const padOf = (re: RegExp) => { const t = all.find(x => re.test(x)); return t ? px(t.replace(re, '$2')) : undefined; };
  const pad = padOf(/^(p)-(.+)$/) ?? padOf(/^(py)-(.+)$/) ?? 0;
  return { px: glyph + 2 * pad, how: `${glyph}px icon${pad ? ` + ${pad}px padding on each side` : ', no padding'}` };
}

/** The button size key for a box: the compact scale (xs 24, sm 28, default 32, lg 36). */
export function sizeKeyOfPx(px: number): string {
  return px <= 26 ? 'xs' : px <= 30 ? 'sm' : px <= 34 ? 'default' : 'lg';
}

/** "on hover", "text", "fill", "when it's on": how the red shows, for reasons. */
export const dangerWords = (d: NonNullable<Look['danger']>) => d === 'hover' ? 'on hover' : d === 'fill' ? 'fill' : d === 'on' ? 'when it\'s on' : 'text';
