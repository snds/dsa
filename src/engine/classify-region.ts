import type { ElementFeatures } from './scanners/features.js';
import type { Candidate, RoleFn } from './classify-button.js';
import { isPopupTrigger } from './classify-semantics.js';
import { system } from './system.js';

/**
 * A <button> that wraps more than a label: a list row, a card, a tile, a cell value, a drop area.
 * Each is a different design pattern with its own home in the system, or its own gap. One catch-all role
 * used to send all of them to "the system has no clickable row, card, or region", which was false: Item
 * renders as a button.
 *
 *   list row or card         → Item render={<button />}        role clickable-region
 *   click-to-edit cell value → DataTable column meta.editable   role editable-cell
 *   tile in a pick-one set   → ToggleGroupItem                  role choice-tile
 *   drag-and-drop target     → gap: a file dropzone             role drop-target
 *   part of a colour field   → gap: a colour field              role color-input
 *   menu trigger on an image → Button ghost icon, as the trigger role button
 *   one label and icons      → Button: a single action, laid out wide
 *
 * Every pattern also offers the other plausible homes, so a reviewer can always pick the right one.
 */
export type RegionPattern = 'row' | 'card' | 'cell' | 'tile' | 'drop' | 'colour' | 'trigger' | 'action';

export interface RegionRead { pattern: RegionPattern; reasons: string[] }

interface Ctx { text: boolean; recordish: boolean; has: (re: RegExp) => boolean; hasBase: (re: RegExp) => boolean }

const INLINE = /^(span|strong|em|b|i|small)$/;
const label = (f: ElementFeatures) => [f.attrs['aria-label'], f.attrs.title, f.children.srLabel].filter(Boolean).join(' ');
/** Block-level lines inside the button, at any depth (a title and a detail line), read from the source. */
const lines = (f: ElementFeatures) => {
  const inner = f.source.slice(f.openTag.length);
  return (inner.match(/<(div|p|h[1-6])\b/g)?.length ?? 0) + (inner.match(/className="[^"]*\bblock\b/g)?.length ?? 0);
};
/** System parts it shows (Avatar, ObjectThumb): the content is the system already. */
const systemParts = (f: ElementFeatures) => f.children.systemParts ?? [];
/** Shows a picture: a raw image, or a system Avatar / ObjectThumb. */
const pictures = (f: ElementFeatures) => f.children.images > 0 || systemParts(f).length > 0;
/** Shows a colour: a thumbnail or a filled swatch, not an icon. */
const showsColour = (f: ElementFeatures) => !f.children.icons && (pictures(f) || /backgroundColor|ObjectThumbFill|\bhex=/.test(f.source));
/** "an Acme Avatar", "Acme ObjectThumb and Avatar". */
const systemWords = (f: ElementFeatures) => `${system().label} ${[...new Set(systemParts(f))].join(' and ')}`;

export function regionOf(f: ElementFeatures, { text, recordish, has, hasBase }: Ctx): RegionRead | undefined {
  const c = f.children;
  if (f.handlers.some(h => /^onDrag(Over|Enter)$|^onDrop$/.test(h))) {
    return { pattern: 'drop', reasons: ['Takes dropped files and opens a file picker on click: a file dropzone.'] };
  }
  const colourWords = /colou?r|swatch|\bhex\b/i.test(label(f)) || /\bset(Hex|Colou?r|Swatch)\w*\(/.test(f.source);
  if (!text && colourWords && showsColour(f)) {
    return { pattern: 'colour', reasons: ['Part of a colour field: a swatch that shows, opens or sets a colour.', ...(systemParts(f).length ? [`The swatch is a ${systemWords(f)} already; only the button around it is hand-built.`] : [])] };
  }
  const inCell = 'data-cell-control' in f.attrs || f.context.inTableCell || has(/^group\/cell$/);
  if (text && !recordish && !c.icons && has(/^text-left$/) && !has(/^(px-[2-9]|py-[1-9]|h-)/) && inCell) {
    return { pattern: 'cell', reasons: ['A value in a table cell that turns into an editor when clicked.'] };
  }

  // Anything below needs a sign that this is more than a label.
  const signs: string[] = [];
  if (c.interactive) signs.push('interactive');
  const pictured = pictures(f) || /<img\b/.test(f.source.slice(f.openTag.length));
  if (pictured && !text) signs.push('image');
  const twoLines = c.elements.length >= 2 || lines(f) >= 2;
  if (twoLines) signs.push('structure');
  if (has(/^(w-full|block)$/) && has(/^text-left$/) && (c.elements.length >= 1 || has(/^border-b$/))) signs.push('row');
  if (!text && !c.icons && c.elements.length === 0 && has(/^(w|h|size)-\d{2}$/)) signs.push('tile');
  if (!text && f.classes.selectedSwitch && has(/^(w|size)-(1[0-9]|2[0-9])$/) && has(/^h-(1[0-9]|2[0-9])$|^size-/)) signs.push('tile');
  if (!signs.length) return;

  const inSet = f.context.inMap || (f.context.siblingButtons ?? 0) > 0;
  const lit = f.classes.selectedSwitch;
  if (!text && (pictured || signs.includes('tile')) && !c.interactive && inSet) {
    return { pattern: 'tile', reasons: [`One of a set of image tiles${lit ? '; the chosen one is highlighted' : ''}. That is a pick-one control.`] };
  }
  if (!text && pictured && !c.interactive && isPopupTrigger(f)) {
    return { pattern: 'trigger', reasons: [systemParts(f).length ? `Wraps a ${systemWords(f)} and opens a menu. Keep it as the trigger; only the button around it is hand-built.` : 'Opens a menu and shows an image or avatar. Keep it as the trigger; only the button around the image changes.'] };
  }
  if (!pictured && !c.interactive && !twoLines && c.elements.every(e => INLINE.test(e)) && (text || c.elements.length === 1)) {
    return { pattern: 'action', reasons: ['One label with icons: a single action, laid out full width.'] };
  }
  const card = (hasBase(/^border$/) && hasBase(/^rounded/)) || hasBase(/^bg-card$/) || hasBase(/^shadow/);
  const reasons = [card ? 'Drawn as a card: a border and rounded corners around its content.' : 'Looks like a row in a list.'];
  if (twoLines) reasons.push('Has a title line and a detail line, like a list item.');
  if (c.interactive) reasons.push('Holds other controls inside the button, which is invalid HTML. With Item, put them in ItemActions, outside the clickable part.');
  return { pattern: card ? 'card' : 'row', reasons };
}

/** The winner for the pattern, then the other plausible homes, so a reviewer can always pick one. */
export function regionCandidates(f: ElementFeatures, read: RegionRead, role: RoleFn, buttonVariant: string): Candidate[] {
  const why = read.reasons.map(text => ({ text, delta: 0 }));
  const lit = f.classes.selectedSwitch;
  const item = (prior: number, r: Candidate['reasons'] = []) => role('clickable-region', `button.region-${read.pattern === 'card' ? 'card' : 'row'}`, prior, r, read.pattern === 'card' ? { variant: 'outline' } : undefined);
  const button = (prior: number, r: Candidate['reasons'] = []) => role('button', 'button.region-action', prior, r, { variant: buttonVariant });
  const tile = (prior: number, r: Candidate['reasons'] = []) => role('choice-tile', 'button.region-tile', prior, r);
  switch (read.pattern) {
    case 'drop': return [role('drop-target', 'button.region-drop', 0.86, why), button(0.7)];
    case 'colour': return [role('color-input', 'button.region-colour', 0.84, why), ...(f.context.inMap ? [tile(0.72)] : []), button(0.7)];
    case 'cell': return [role('editable-cell', 'button.region-cell', 0.82, why), button(0.7), item(0.66)];
    case 'tile': return [tile(lit ? 0.84 : 0.8, why), item(0.7), button(0.68)];
    case 'trigger': return [role('button', 'button.region-trigger', 0.84, why, { variant: 'ghost', size: 'icon' }), item(0.66)];
    case 'action': return [button(0.84, why), item(0.72)];
    default: return [item(lines(f) >= 2 || f.children.elements.length >= 2 ? 0.84 : 0.8, why), button(0.7), ...(f.context.inMap && lit ? [tile(0.7)] : [])];
  }
}
