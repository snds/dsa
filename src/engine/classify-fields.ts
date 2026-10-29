import type { RoleMap } from './roles.js';
import { system } from './system.js';
import type { Candidate, RoleFn } from './classify-button.js';
import { DYNAMIC, type ElementFeatures } from './scanners/features.js';
import { borderOf, resting } from './classify-look.js';

/**
 * Rules for form fields and tables (audit item 10).
 *
 * - AmountInput is for money and quantities, and it doesn't pass onBlur or onKeyDown: any other number
 *   field is Input type="number", and a number field inside a colour picker is part of a colour field.
 * - A field with no visible box at rest (border-transparent, bg-transparent) will gain one as an Input.
 * - Tables score from evidence: sorting, row selection, row clicks, expanders and editors push towards
 *   DataTable; hand-written rows, a checkbox in every cell (a form grid) or nothing interactive push towards
 *   Table. A static table sits below the review threshold, and a close call is shown as one.
 */

/** Money or quantity, read from the field's own tag and where it sits. */
const AMOUNT = /price|cost|amount|qty|quantit|moq|budget|total|fee|freight|fob|currenc|money|\bunits?\b|pcs|pieces|stock|minimum|lead ?time|\$|€|£/i;
/** A colour channel or code: R/G/B 0–255, a hex, a CMYK segment. */
const COLOUR_TAG = /\b(rgb|hex|cmyk|hsl|hsv)\w*|channel|rgbTo|toHex|\bhue\b|\balpha\b/i;
const COLOUR_HOST = /(Hex|Rgb|Cmyk|Hsl|Hsv|Swatch)\w*(Input|Field|Picker)|Colou?r(Picker|Field|Input)/;

/** Inside a colour picker: its number and text fields are parts of a colour field (a gap in the system). */
export function inColourPicker(f: ElementFeatures): boolean {
  return COLOUR_HOST.test(f.context.within) || f.context.ancestors.some(a => COLOUR_HOST.test(a)) || COLOUR_TAG.test(f.openTag);
}

export function inputCandidates(f: ElementFeatures, role: RoleFn, map: RoleMap): Candidate[] {
  const type = f.attrs.type;
  if (type === DYNAMIC) return [role('text-input', 'input.dynamic-type', 0.4, [{ text: 'type is computed at runtime.', delta: 0 }])];
  const t = (type ?? 'text').toLowerCase();
  const tokens = f.classes.tokens;
  const hidden = tokens.some(x => /^(sr-only|hidden|opacity-0)$/.test(x)) || f.attrs['aria-hidden'] === 'true';
  // A native colour picker laid invisibly over a swatch is the colour field itself, not a proxy for another control.
  if (hidden && t === 'color') return [role('color-input', 'input.color-overlay', 0.86, [{ text: 'A native colour picker laid invisibly over a swatch: this is a colour field.', delta: 0 }])];
  if (hidden && t !== 'checkbox' && t !== 'radio') return [role('hidden-proxy', 'input.hidden-proxy', 0.86, [{ text: 'Visually hidden input driven by another control.', delta: 0 }])];
  switch (t) {
    case 'checkbox': {
      const custom = tokens.some(x => /^(sr-only|peer|appearance-none)$/.test(x));
      return [role('checkbox', custom ? 'input.checkbox-custom' : 'input.checkbox', custom ? 0.84 : 0.94, [{ text: custom ? 'Visually hidden checkbox with custom visuals (peer pattern): Checkbox or Switch.' : 'Native checkbox.', delta: 0 }]), ...(custom ? [role('switch', 'input.checkbox-switch', 0.7, [])] : [])];
    }
    case 'radio': return [role('radio', 'input.radio', 0.86, [{ text: 'Native radio; RadioGroup needs the set wrapped in a group.', delta: 0 }])];
    case 'range': return [role('range', 'input.range', 0.92, [{ text: 'Native range input.', delta: 0 }])];
    case 'date': case 'datetime-local': return [role('date', 'input.date', 0.88, [{ text: `Native ${t} input.`, delta: 0 }])];
    case 'number': return numberCandidates(f, role, map);
    case 'color': return [role('color-input', 'input.color', 0.9, [{ text: 'A native colour picker.', delta: 0 }])];
    case 'search': return [role('search-input', 'input.search', 0.88, [{ text: 'Search field.', delta: 0 }], { type: 'search' })];
    default: {
      if (inColourPicker(f)) return [role('color-input', 'input.colour-part', 0.84, [{ text: 'A text field inside a colour picker (a hex or CMYK value): part of a colour field.', delta: 0 }]), role('text-input', 'input.text', 0.6, [])];
      const r: Candidate['reasons'] = [{ text: `Text-like input (type="${t}").`, delta: 0 }];
      if (noBoxAtRest(f)) r.push({ text: `This field shows no box at rest. ${system().label} Input always shows one, so the look will change.`, delta: -0.08 });
      if (f.context.ancestors.slice(0, 2).some(a => /div|label/.test(a)) && f.classes.tokens.some(x => /^p[lr]-\d/.test(x))) r.push({ text: 'Padded for an adornment; InputGroup may fit better.', delta: -0.05 });
      return [role('text-input', 'input.text', 0.93, r)];
    }
  }
}

/** No border and no fill at rest. `border border-transparent` draws no box; the box appears only on hover. */
function noBoxAtRest(f: ElementFeatures): boolean {
  const rest = resting(f.classes.tokens);
  const explicit = rest.some(x => /^(bg-transparent|border-0|border-none|border-transparent|outline-none)$/.test(x));
  return explicit && borderOf(rest) !== 'box' && !rest.some(x => /^bg-(?!transparent$)/.test(x));
}

function numberCandidates(f: ElementFeatures, role: RoleFn, map: RoleMap): Candidate[] {
  const amountUse = map.roles['number-input']?.use;
  if (inColourPicker(f)) {
    return [
      role('color-input', 'input.colour-channel', 0.84, [{ text: `A number field inside a colour picker (a colour channel): part of a colour field, which ${system().label} doesn't have yet.`, delta: 0 }]),
      role('text-input', 'input.number-as-text', 0.62, [{ text: 'Input type="number" until there is a colour field.', delta: 0 }], { type: 'number' }),
    ];
  }
  const word = AMOUNT.exec(`${f.openTag} ${f.context.within}`)?.[0];
  // AmountInput doesn't pass these on: blur-to-save and Escape-to-cancel would be lost.
  const lost = f.handlers.filter(h => /^on(Blur|KeyDown|KeyUp|Focus)$/.test(h));
  const asNumber = (prior: number, why: string) => role('text-input', 'input.number-as-text', prior, [{ text: why, delta: 0 }], { type: 'number' });
  if (!amountUse) return [asNumber(0.86, 'Number field; the system has no number input, so Input type="number".')];
  if (word && !lost.length) {
    return [
      role('number-input', 'input.number', 0.86, [{ text: `Number field for an amount or quantity ("${word.trim()}"): ${amountUse}.`, delta: 0 }]),
      asNumber(0.66, 'Input type="number" keeps it plain, without steppers or formatting.'),
    ];
  }
  if (word) {
    return [
      asNumber(0.8, `An amount ("${word.trim()}"), but it uses ${lost.join(', ')}; ${amountUse} doesn't pass ${lost.length > 1 ? 'those' : 'that'} on. Input type="number" keeps them (in an InputGroup with the unit).`),
      role('number-input', 'input.number', 0.72, [{ text: `${amountUse} would need ${lost.join(', ')} passed through.`, delta: 0 }]),
    ];
  }
  return [
    asNumber(0.86, `Number field. ${amountUse} is for money and quantities. Use Input type="number" for channels, codes and percentages.`),
    role('number-input', 'input.number', 0.62, [{ text: `${amountUse} only if this is an amount or a quantity.`, delta: 0 }]),
  ];
}

export function tableCandidates(f: ElementFeatures, role: RoleFn): Candidate[] {
  const t = f.table!;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const rows = t.rowsMapped ? 'Rows come from data' : `Rows are written by hand in the code (${plural(t.literalRows, 'row')})`;
  const cols = t.headersMapped || t.cellsMapped ? 'columns come from data' : `${plural(t.headerCells, 'column')}`;
  const fact = { text: `${rows}; ${cols}.`, delta: 0 };
  const dt: Candidate['reasons'] = [fact], table: Candidate['reasons'] = [fact];
  // What a DataTable does that a Table doesn't: these count for DataTable and against Table.
  const strong: [boolean | undefined, string, number][] = [
    [t.sortable, 'The header sorts.', 0.15],
    [t.checkboxes === 'selection', 'A checkbox in the first column: row selection.', 0.15],
    [t.rowClick, 'Rows open on click.', 0.08],
  ];
  for (const [on, text, d] of strong) if (on) { dt.push({ text, delta: d }); table.push({ text: `${text} Table leaves that to the page.`, delta: -d / 2 }); }
  // Interaction a Table can hold too: it leans towards DataTable, it doesn't rule Table out.
  if (t.expandableRows) dt.push({ text: 'Rows open and close (expanders): DataTable groups and expands rows.', delta: 0.06 });
  if (t.cellEditors) dt.push({ text: `Cells edit in place (${plural(t.cellEditors, 'editor')}). DataTable can make a column editable; a Table can keep the editors.`, delta: 0.06 });
  if (t.cellButtons) dt.push({ text: `${plural(t.cellButtons, 'button')} in the cells (row actions).`, delta: 0.03 });
  if (t.checkboxes === 'grid') {
    table.push({ text: 'Checkboxes in every cell: a form grid, not row selection. Table, with a Checkbox and a label in each cell.', delta: 0.1 });
    dt.push({ text: 'Checkboxes across the cells are answers, not row selection.', delta: -0.1 });
  }
  const interactive = t.sortable || t.checkboxes || t.rowClick || t.expandableRows || t.cellEditors || t.cellButtons || t.headerClick;
  if (t.rowsMapped) {
    dt.push({ text: 'Rows from data.', delta: 0.03 });
    if ((t.headerCells >= 6 || t.headersMapped) && interactive) dt.push({ text: 'Many columns: DataTable sizes and pins them.', delta: 0.04 });
    if (!interactive) table.push({ text: 'No sorting, selection or editing found.', delta: 0.04 });
  } else if (!t.cellsMapped && !interactive) {
    table.push({ text: 'A fixed table: Table fits; a person confirms the look.', delta: 0.12 });
  } else if (!interactive) {
    table.push({ text: 'Fixed rows across columns from data (a comparison): Table, with the row labels as row headers.', delta: 0.12 });
  }
  if (t.headerClick && !t.sortable) table.push({ text: 'Buttons in the header don\'t sort.', delta: 0 });
  const literal = !t.rowsMapped;
  return [
    role('static-table', t.checkboxes === 'grid' ? 'table.form-grid' : literal ? 'table.static' : 'table.mapped-simple', 0.7, table),
    role('data-table', t.sortable || t.checkboxes === 'selection' || t.rowClick ? 'table.interactive' : 'table.mapped', 0.55, dt),
  ];
}
