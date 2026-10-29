import { DYNAMIC, type ElementFeatures } from './scanners/features.js';
import { isPopupTrigger } from './classify-semantics.js';
import { variantsOf } from './classify-look.js';

/**
 * Accessibility issues seen on the element, independent of the recommendation (audit item 12).
 *
 * - A name counts nested text and the alt / aria-label / title of nested elements, not only direct text:
 *   a list row's title in a <p> names the button.
 * - Fields include textareas and colour pickers.
 * - Missed problems are flagged: a chosen state shown only by colour or a ring, and a button with no handler.
 */
export function a11yNotes(f: ElementFeatures): string[] {
  const out: string[] = [];
  const attrName = f.attrs['aria-label'] || f.attrs['aria-labelledby'] || f.attrs.title;
  const c = f.children;
  if (f.element === 'button') {
    const named = attrName || c.text || c.dynamicText || c.srLabel || (c.nameText ?? '').trim();
    if (!named) out.push('No accessible name (no text, aria-label, or title).');
    if (c.interactive) out.push('Interactive elements nested inside a button (invalid HTML).');
    if (!('type' in f.attrs) && f.context.inForm) out.push('No type inside a form: defaults to submit.');
    if (colourOnlySelection(f)) out.push('The chosen state shows only by colour or a ring, so screen readers can\'t tell which one is chosen. Add aria-pressed (or aria-selected / aria-current).');
    if (noHandler(f)) out.push('No click handler: the button does nothing (a dead control). Wire it up or remove it.');
  }
  if (/^(input|textarea|select)$/.test(f.element) && !/^(hidden|submit|button|reset)$/.test(f.attrs.type ?? '')) {
    const labelled = attrName || f.attrs.id || f.context.ancestors.some(a => /^(label|Label|FormLabel|FieldLabel)$/.test(a));
    if (!labelled) out.push(f.attrs.type === 'color'
      ? 'A colour picker with no name: screen readers can\'t say which colour it sets. Add aria-label.'
      : `${f.element === 'textarea' ? 'Text area' : f.element === 'select' ? 'Select' : 'Input'} with no label, aria-label, or id for a <label>.`);
  }
  return out;
}

const COLOURISH = /^(bg|text|border|ring|outline|shadow|fill|stroke|decoration|from|to|via)-|^(ring|underline|shadow|border)$|^font-(medium|semibold|bold)$|^opacity-/;
const STATE_ATTRS = ['aria-pressed', 'aria-selected', 'aria-current', 'aria-checked', 'aria-expanded'];

/** A set member whose chosen look is only a colour or ring change, with no ARIA state saying it's chosen. */
function colourOnlySelection(f: ElementFeatures): boolean {
  const kind = f.classes.switchKind ?? 'none';
  if (!/^(equality|pressed|current)$/.test(kind)) return false;
  if (STATE_ATTRS.some(a => f.attrs[a] !== undefined)) return false;
  if (/^(tab|radio|option|checkbox|switch|menuitemradio|menuitemcheckbox)$/.test(f.attrs.role ?? '') || f.attrs.role === DYNAMIC) return false;
  const switched = f.classes.conditional.map(variantsOf).filter(v => !v.prefixes.length).map(v => v.base);
  return switched.length > 0 && switched.every(t => COLOURISH.test(t));
}

/** A <button> that nothing wires up: no handler, no spread, not a submit, not inside a trigger that owns it. */
export function noHandler(f: ElementFeatures): boolean {
  if (f.handlers.length || f.hasSpread || f.framework !== 'react') return false;
  if (/^(submit|reset)$/.test(f.attrs.type ?? '') || (!('type' in f.attrs) && f.context.inForm) || f.attrs.form !== undefined) return false;
  if (isPopupTrigger(f) || f.context.ancestors.slice(0, 2).some(a => /(Trigger|Close|Cancel|Action)$/.test(a))) return false;
  return true;
}
