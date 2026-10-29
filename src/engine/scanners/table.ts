import { jsxName, visit, visitWithAncestors } from './ast.js';
import type { TableInfo } from './features.js';

const CELL_EDITOR = /^(input|select|textarea)$|^(InlineEdit|Editable)|Editor$|(Input|Select|Combobox|DatePicker|Textarea|Picker)$/;
const CELL_BUTTON = /^(button|a)$|Button$|^(Link|NavLink|ObjectName)$/;
const EXPAND_WORDS = /expand|collaps|^isOpen$|^open$|^toggleRow$/i;

/**
 * Table structure and interaction (audit item 10). Rows and columns rendered from loops count as "from data"
 * whether the loop returns a <tr> or a row component. Interaction is counted inside cells, not only on
 * <tr>/<th>: inline editors, buttons, expanders, and where the checkboxes sit.
 */
export function tableInfo(el: any): TableInfo {
  const t: TableInfo = { hasThead: false, headerCells: 0, rowsMapped: false, literalRows: 0, rowClick: false, headerClick: false, hasCheckbox: false, headersMapped: false, cellsMapped: false, cellEditors: 0, cellButtons: 0, expandableRows: false, sortable: false };
  const isMap = (n: any) => (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') && /^(map|flatMap)$/.test(n.callee?.property?.name ?? '');
  const attr = (o: any, name: string) => o.attributes.find((a: any) => a.name?.name === name);
  const isCheckbox = (o: any, nm: string) => (nm === 'input' && attr(o, 'type')?.value?.value === 'checkbox') || /Checkbox$/.test(nm);
  let gridCheckbox = false, selectionCheckbox = false;
  visitWithAncestors(el, (n: any, anc: any[]) => {
    if (n.type === 'JSXAttribute' && n.name?.name === 'aria-expanded') t.expandableRows = true;
    if (n.type === 'JSXAttribute' && n.name?.name === 'aria-sort') t.sortable = true;
    if (n.type !== 'JSXElement') return;
    const o = n.openingElement, nm = jsxName(o.name);
    const tags = anc.filter((a: any) => a.type === 'JSXElement').map((a: any) => jsxName(a.openingElement.name));
    const inHead = tags.includes('thead');
    const loopIdx = anc.map(isMap).lastIndexOf(true);
    const looped = loopIdx >= 0;
    // The loop sits inside this element's row: cells (or columns) from data, not rows.
    const rowIdx = anc.map((a: any) => a.type === 'JSXElement' && jsxName(a.openingElement.name) === 'tr').lastIndexOf(true);
    if (nm === 'thead') t.hasThead = true;
    if (nm === 'th') {
      if (looped && inHead) t.headersMapped = true; else if (!looped) t.headerCells++;
      if (attr(o, 'onClick')) { t.headerClick = true; if (mentions(attr(o, 'onClick').value, /sort/i)) t.sortable = true; }
    }
    if (nm === 'tr') {
      if (looped && !inHead) t.rowsMapped = true; else if (!looped && !inHead) t.literalRows++;
      if (attr(o, 'onClick') && !inHead) t.rowClick = true;
      // A row that renders only when its parent is open: {expanded && <tr>…}
      const gate = anc[anc.length - 1];
      if ((gate?.type === 'LogicalExpression' || gate?.type === 'ConditionalExpression') && mentions(gate.type === 'LogicalExpression' ? gate.left : gate.test, EXPAND_WORDS)) t.expandableRows = true;
    }
    if ((nm === 'td' || nm === 'th') && looped && rowIdx >= 0 && loopIdx > rowIdx && !inHead) t.cellsMapped = true;
    // A row component rendered from a loop in the body: rows from data, even though no <tr> is visible here.
    if (looped && !inHead && /^[A-Z]/.test(nm) && /Row$/.test(nm) && !tags.some(x => x === 'tr' || x === 'td')) t.rowsMapped = true;
    const cell = [...anc].reverse().find((a: any) => a.type === 'JSXElement' && /^(td|th)$/.test(jsxName(a.openingElement.name)));
    if (isCheckbox(o, nm)) {
      t.hasCheckbox = true;
      if (cell && !inHead) { if (firstCellOfRow(cell, anc)) selectionCheckbox = true; else gridCheckbox = true; }
      else if (!cell && !inHead) selectionCheckbox = true;
      return;
    }
    if (!cell || inHead) {
      if (inHead && cell && (CELL_BUTTON.test(nm) || attr(o, 'onClick'))) { t.headerClick = true; if (mentions(attr(o, 'onClick')?.value, /sort/i)) t.sortable = true; }
      return;
    }
    if (CELL_EDITOR.test(nm) || attr(o, 'contentEditable')) t.cellEditors!++;
    else if (CELL_BUTTON.test(nm)) {
      t.cellButtons!++;
      if (mentions(attr(o, 'onClick')?.value, EXPAND_WORDS)) t.expandableRows = true;
    }
  });
  if (gridCheckbox) t.checkboxes = 'grid'; else if (selectionCheckbox) t.checkboxes = 'selection';
  return t;
}

/** An identifier, member name, or string inside the node matches (a header handler that sorts, a row that expands). */
function mentions(node: any, re: RegExp): boolean {
  let hit = false;
  visit(node, (x: any) => {
    if (hit) return;
    if (x.type === 'Identifier' && re.test(x.name)) hit = true;
    else if (x.type === 'MemberExpression' && x.property?.type === 'Identifier' && re.test(x.property.name)) hit = true;
    else if (x.type === 'StringLiteral' && re.test(x.value)) hit = true;
  });
  return hit;
}

/** The cell is the first cell its row writes (a looped cell, or one after another cell, isn't). */
function firstCellOfRow(cell: any, anc: any[]): boolean {
  const i = anc.indexOf(cell);
  const row = [...anc.slice(0, i)].reverse().find((a: any) => a.type === 'JSXElement' && jsxName(a.openingElement.name) === 'tr');
  if (!row) return true;
  const kids = (row.children ?? []).filter((k: any) => !(k.type === 'JSXText' && !k.value.trim()));
  return kids[0] === cell;
}
