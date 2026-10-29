import { test } from 'vitest';
import { ACME_UI } from './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { reactFeatures, visitWithAncestors, resetFeatureCaches, type ElementFeatures } from '../../src/engine/scanners/features.js';
import { classify, systemRoleMap, type Evaluation } from '../../src/engine/classify.js';
import { borderOf, boxOf, lookOf, resting } from '../../src/engine/classify-look.js';
import { variantOf } from '../../src/engine/classify-button.js';
import { buildSignatures } from '../../src/engine/signatures.js';
import { APP_DIR } from '../../src/engine/paths.js';

// How the scanner reads an element (audit items 8, 10, 12; docs/element-review-audit/). Snippets are trimmed
// from a host app at the lines the audit names.

const pkgs = ACME_UI;
const sigs = buildSignatures([{ dir: path.join(pkgs, 'ui'), name: '@acme/ui' }, { dir: path.join(pkgs, 'tokens'), name: '@acme/tokens' }]);

function features(code: string, tag = /^(button|input|table|textarea)$/): ElementFeatures {
  resetFeatureCaches();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-reads-')), 'x.tsx');
  fs.writeFileSync(file, code);
  let hit: ElementFeatures | null = null;
  visitWithAncestors(parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }).program, (n: any, anc: any[]) => {
    if (!hit && n.type === 'JSXElement' && tag.test(n.openingElement.name.name)) hit = reactFeatures(n, [...anc], code, file, []);
  });
  assert.ok(hit, 'snippet has a native element');
  return hit!;
}
const evalOf = (code: string, withSigs = true): Evaluation => classify(features(code), systemRoleMap(), 0.9, withSigs ? sigs : undefined);
const said = (e: Evaluation, re: RegExp) => e.reasons.some(r => re.test(r.text));

// ---------- item 8: the look ----------

test('look: hover and pressed fills are not a resting fill, so a quiet Cancel stays ghost', () => {
  const code = `export const A = ({ onCancel }) => <button onClick={onCancel} className="px-2 py-1 text-xs text-muted-foreground hover:bg-accent active:bg-accent rounded">Cancel</button>;`;
  const look = lookOf(features(code));
  assert.equal(look.fill, false);
  assert.equal(look.hoverFill, true);
  const e = evalOf(code);
  assert.equal(e.use, 'Button');
  assert.equal(e.props?.variant, 'ghost', JSON.stringify(e.props));
});

test('look: a bordered button with a hover wash is outline, not a primary', () => {
  const e = evalOf(`export const A = ({ onSave }) => <button onClick={onSave} className="h-(--acme-control-h) px-2.5 border border-neutral-700 hover:bg-white/10 text-neutral-100 rounded-sm text-sm font-medium transition-colors">Save &amp; Replace</button>;`);
  assert.equal(e.props?.variant, 'outline', JSON.stringify(e.props));
});

test('look: the "on" branch of a clsx condition is the resting look of a plain button', () => {
  const code = `export const A = ({ n, confirmSelect }) => <button onClick={confirmSelect} disabled={!n} className={clsx('h-(--acme-control-h) px-(--acme-control-px) rounded-sm text-sm font-semibold transition-colors', n ? 'bg-foreground text-background hover:bg-foreground/85' : 'bg-muted text-muted-foreground cursor-not-allowed')}>Select Image</button>;`;
  const f = features(code);
  assert.deepEqual(f.classes.onBranch?.slice(0, 2), ['bg-foreground', 'text-background']);
  assert.equal(lookOf(f).fromBranch, true);
  const e = evalOf(code);
  assert.equal(e.props?.variant, 'dark', JSON.stringify(e.props));
  assert.equal(e.look?.fromBranch, true, 'recorded so a screenshot of the other state does not switch it');
});

test('look: a set member\'s "on" branch is its chosen look, not its rest', () => {
  const f = features(`export const A = () => <div>{OPTS.map(o => <button key={o} onClick={() => setV(o)} className={v === o ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}>{o}</button>)}</div>;`);
  assert.equal(lookOf(f, { branch: false }).fill, false);
});

test('look: a one-side border is a divider, and border-transparent draws no box', () => {
  assert.equal(borderOf(['border-l', 'border-border']), 'side');
  assert.equal(borderOf(['border', 'border-transparent']), 'none');
  assert.equal(borderOf(['border-border']), 'none', 'a colour without a width draws nothing');
  assert.equal(borderOf(['border', 'border-border']), 'box');
  assert.deepEqual(resting(['hover:bg-accent', 'md:px-2', 'aria-expanded:bg-selected', 'bg-card']), ['px-2', 'bg-card']);
  const code = `export const A = () => <button type="button" aria-label="Decrease" onClick={() => bump(-1)} className="flex-1 flex items-center justify-center border-t border-border text-muted-foreground hover:bg-accent"><Icon name="expand_more" size="xs" /></button>;`;
  assert.notEqual(variantOf(features(code), systemRoleMap()).key, 'outline');
  const e = evalOf(code, false);
  assert.equal(e.props?.variant, 'ghost');
  assert.ok(said(e, /one side only: a divider/), JSON.stringify(e.reasons));
  assert.ok(said(e, /layout around it \(flex-1\)/), 'its size comes from the control around it');
});

test('look: red on hover is a tone the component must keep, flagged as a quiet-danger gap', () => {
  const e = evalOf(`export const A = ({ f, onRemove }) => <button type="button" aria-label="Remove Facility" onClick={() => onRemove(f)} className="p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded"><Icon name="delete" size="sm" /></button>;`, false);
  assert.equal(e.props?.variant, 'ghost');
  assert.ok(said(e, /Red on hover: a danger action.*tone gap/), JSON.stringify(e.reasons));
  assert.ok(e.visualDiffs.some(d => /red on hover/.test(d)), 'never counted as reproduced');
  assert.ok(e.confidence < 0.9, 'a designer decides the tone');
});

test('look: grey text that turns red on hover offers Button destructive, not a blue link', () => {
  const e = evalOf(`export const A = () => <button type="button" onClick={() => setValue('image', '')} className="text-sm text-muted-foreground hover:text-destructive transition-colors">Remove</button>;`);
  assert.equal(e.use, 'Button');
  assert.equal(e.props?.variant, 'destructive', JSON.stringify(e.props));
  assert.ok(e.confidence < 0.9);
});

test('look: toolbar chrome is variant toolbar at toolbar-icon size, read through a helper', () => {
  const code = `function toolbarIconBtn(active) { return clsx('h-(--acme-control-h) w-(--acme-control-h) border rounded-sm grid place-items-center transition-colors shadow-sm', active ? ON : IDLE); }
export const A = ({ fullscreen, expandLabel, onToggleFullscreen }) => <button type="button" onClick={onToggleFullscreen} aria-label={expandLabel} className={toolbarIconBtn(fullscreen)}><Icon name="open_in_full" /></button>;`;
  assert.equal(lookOf(features(code)).toolbar, true);
  const asButton = { ...systemRoleMap(), roles: { ...systemRoleMap().roles, 'icon-button': { use: 'Button', props: { variant: 'ghost' } } } };
  const e = classify(features(code), asButton);
  assert.deepEqual(e.props, { variant: 'toolbar', size: 'toolbar-icon' });
});

test('look: a bordered card-surface text button is the toolbar look', () => {
  const e = evalOf(`export const A = ({ onOpen }) => <button type="button" onClick={onOpen} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm border border-border bg-card text-xs text-muted-foreground hover:bg-accent active:bg-accent transition-colors">Columns</button>;`);
  assert.equal(e.props?.variant, 'toolbar', JSON.stringify(e.props));
});

test('look: icon-button size comes from the real box, and growth is stated as the design decision', () => {
  // a 12px glyph with 2px padding is a 16px box, not the 28px the glyph's size prop suggested.
  const pencil = evalOf(`export const A = () => <button title="Edit Your Note" onClick={edit} className="ml-1 p-0.5 rounded hover:bg-selected text-muted-foreground hover:text-primary"><Icon name="edit" size="xs" /></button>;`, false);
  assert.deepEqual(boxOf(features(`export const A = () => <button title="Edit" onClick={edit} className="p-0.5"><Icon name="edit" size="xs" /></button>;`)), { px: 16, how: '12px icon + 2px padding on each side' });
  // icon-button is Button on main, so the size key xs is Button's icon-xs.
  assert.equal(pencil.props?.size, 'icon-xs');
  assert.ok(said(pencil, /It is 16px today .*; the smallest icon button is 24px\. Approve the growth, or use the 20px cell icon button\./), JSON.stringify(pencil.reasons));
  // size-5 is a 20px box.
  const box = boxOf(features(`export const A = () => <button type="button" onClick={t} aria-expanded={open} className="flex size-5 items-center justify-center"><Icon name="chevron_right" /></button>;`));
  assert.deepEqual(box, { px: 20, how: 'size-5' });
  // A density token still names the size exactly.
  const exact = evalOf(`export const A = () => <button aria-label="Close" onClick={close} className="size-(--acme-control-h-sm) hover:bg-accent"><Icon name="close" /></button>;`, false);
  assert.equal(exact.props?.size, 'icon-sm');
});

// ---------- item 10: tables and inputs ----------

test('tables: inline editors and a button in every row make a close call between Table and DataTable', () => {
  const e = evalOf(`export const A = () => <table className="w-full text-sm"><thead><tr><th>Context</th><th>Code</th><th>Name</th><th /></tr></thead>
    <tbody>{aliases.map((a) => (<tr key={a.id}>
      <td><InlineEditSelect value={a.context} onSave={s} /></td><td><InlineEditText value={a.code} onSave={s} /></td><td><InlineEditText value={a.name} onSave={s} /></td>
      <td><CellIconButton name="delete" label="Remove Alias" onClick={() => removeAlias(a.id)} /></td></tr>))}</tbody></table>;`);
  assert.equal(e.use, 'Table');
  assert.ok(said(e, /Close call with DataTable/), JSON.stringify(e.reasons));
  assert.ok(e.alternatives.some(a => a.use === 'DataTable'));
  assert.ok(e.confidence < 0.9);
});

test('tables: a checkbox in every cell is a form grid, a checkbox in the first column is row selection', () => {
  const grid = features(`export const A = () => <table><thead><tr><th>Colour</th>{ids.map(pid => <th key={pid}>{pid}</th>)}</tr></thead>
    <tbody>{links.map(link => (<tr key={link.id}><td>{link.name}</td>{ids.map(pid => (<td key={pid}><label><Checkbox checked={c} onCheckedChange={t} />Sample</label></td>))}</tr>))}</tbody></table>;`);
  assert.equal(grid.table?.checkboxes, 'grid');
  assert.equal(grid.table?.headersMapped, true);
  const g = classify(grid);
  assert.equal(g.use, 'Table');
  assert.ok(said(g, /form grid, not row selection/));
  const sel = classify(features(`export const A = () => <table><tbody>{rows.map(r => (<tr key={r.id}><td><Checkbox checked={r.on} onCheckedChange={t} /></td><td>{r.name}</td><td>{r.code}</td></tr>))}</tbody></table>;`));
  assert.equal(sel.use, 'DataTable');
  assert.ok(said(sel, /first column: row selection/));
});

test('tables: rows from a row component in a loop and looped headers count as from data', () => {
  const f = features(`export const A = () => <table><thead><tr>{['Token', 'Value', 'Status'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{tokens.map(t => <PackageTokenRow key={t.name} token={t} />)}</tbody></table>;`);
  assert.equal(f.table?.rowsMapped, true);
  assert.equal(f.table?.headersMapped, true);
  assert.ok(said(classify(f), /Rows come from data; columns come from data\./));
});

test('tables: a hand-written table sits below the review threshold; expandable rows and sorting are read', () => {
  const s = evalOf(`export const A = () => <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>;`, false);
  assert.equal(s.use, 'Table');
  assert.ok(s.confidence < 0.9, String(s.confidence));
  assert.ok(said(s, /written by hand in the code \(2 rows\)/));
  const x = features(`export const A = () => <table><tbody>{rows.map(r => (<Fragment key={r.id}><tr><td><button aria-expanded={open} onClick={() => toggleRow(r.id)}>{r.name}</button></td></tr>{open && <tr><td>{r.detail}</td></tr>}</Fragment>))}</tbody></table>;`);
  assert.equal(x.table?.expandableRows, true);
  const sorted = features(`export const A = () => <table><thead><tr><th aria-sort="ascending"><button onClick={() => setSort('name')}>Name</button></th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{r.n}</td></tr>)}</tbody></table>;`);
  assert.equal(sorted.table?.sortable, true);
});

test('inputs: AmountInput only for amounts without blur/key handlers; other numbers are Input type=number', () => {
  // saves on blur and cancels on Escape; AmountInput would drop both.
  const inline = evalOf(`export const A = () => <input autoFocus type="number" step="0.01" min="0" value={local} onChange={e => setLocal(e.target.value)} onBlur={commit} onKeyDown={k} className="w-24 border border-primary rounded px-2 py-1" />;`, false);
  assert.equal(inline.use, 'Input');
  assert.equal(inline.props?.type, 'number');
  const cost = evalOf(`export const A = () => <input type="number" value={draft.cost} onChange={setCost} className="w-24 border rounded px-2" />;`, false);
  assert.equal(cost.use, 'AmountInput');
  const plain = evalOf(`export const A = () => <input type="number" value={pct} onChange={setPct} className="w-24 border rounded px-2" />;`, false);
  assert.equal(plain.use, 'Input');
  assert.ok(said(plain, /AmountInput is for money and quantities/));
});

test('inputs: number and text fields inside a colour picker belong to the colour-field gap', () => {
  const rgb = evalOf(`function HexSwatchInput() { return <input type="number" min={0} max={255} value={valid ? rgb.r : ''} onChange={(e) => setHex(rgbToHex(+e.target.value || 0, rgb.g, rgb.b))} className="w-full h-7 border border-border rounded-sm px-2" />; }`, false);
  assert.equal(rgb.verdict, 'gap');
  assert.equal(rgb.role, 'color-input');
  const cmyk = evalOf(`function CmykInput() { return <input value={parts[i]} onChange={(e) => setChannel(i, e.target.value)} inputMode="numeric" maxLength={3} />; }`, false);
  assert.equal(cmyk.role, 'color-input');
});

test('inputs: border border-transparent shows no box, so the field goes to a person', () => {
  const e = evalOf(`export const A = () => <input value={m.n} onChange={x} placeholder="Colour name" className="w-full h-6 px-1 text-sm bg-transparent border border-transparent rounded-sm hover:border-border focus:border-primary" />;`, false);
  assert.equal(e.use, 'Input');
  assert.ok(said(e, /shows no box at rest/), JSON.stringify(e.reasons));
  assert.ok(e.confidence < 0.9);
});

test('a11y: textareas with no label are flagged', () => {
  const e = evalOf(`export const A = () => <textarea ref={ref} defaultValue={v} className="w-full text-xs" />;`, false);
  assert.ok(e.a11y.some(a => /Text area with no label/.test(a)), JSON.stringify(e.a11y));
});

// ---------- item 12: detection ----------

test('detection: onOpen?.() and a bare or member onOpen open a record', () => {
  const shared = features(`export const A = ({ opts, row, label }) => <button type="button" className="min-w-0 text-left hover:underline text-primary" onClick={(e) => { e.stopPropagation(); opts.onOpen(row.original); }}><TruncatingLabel>{empty ? '—' : label}</TruncatingLabel></button>;`);
  assert.equal(shared.handlerIntent, 'open');
  assert.equal(classify(shared).use, 'ObjectName');
  assert.equal(features(`export const A = () => <button onClick={() => onOpen?.(row)} className="text-primary hover:underline">{name}</button>;`).handlerIntent, 'open');
  assert.equal(features(`export const A = () => <button onClick={onOpen} className="text-primary hover:underline">{name}</button>;`).handlerIntent, 'open');
  assert.equal(features(`export const A = () => <button onClick={() => args.onOpen(r)} className="text-primary">{r.label || <span className="text-destructive">Missing label</span>}</button>;`).children.text, '', 'a fallback branch is computed text, not the label');
  assert.notEqual(features(`export const A = () => <button onClick={() => onOpenChange(true)}>{label}</button>;`).handlerIntent, 'open');
});

test('detection: accessible names count nested text and nested alt/aria-label', () => {
  const e = evalOf(`export const A = () => <div>{RELATED.map(r => (<button type="button" key={r.name} onClick={() => setRelated(r)} className="w-full text-left group">
    <p className="text-sm font-medium">{r.name}</p><div className="flex text-xs"><span className="px-1.5 rounded bg-muted">{r.type}</span></div></button>))}</div>;`, false);
  assert.ok(!e.a11y.some(a => /No accessible name/.test(a)), JSON.stringify(e.a11y));
  const img = features(`export const A = () => <button onClick={pick}><img src={s} alt="Front view" /></button>;`);
  assert.match(img.children.nameText ?? '', /Front view/);
  const none = evalOf(`export const A = () => <button onClick={pick} className="w-14 h-14 rounded-lg bg-muted" />;`, false);
  assert.ok(none.a11y.some(a => /No accessible name/.test(a)));
});

test('detection: selection shown only by colour, a nameless colour input, and a button with no handler are flagged', () => {
  const colourOnly = evalOf(`export const A = () => <div>{OPTS.map(o => <button key={o} onClick={() => setV(o)} className={v === o ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}>{o}</button>)}</div>;`, false);
  assert.ok(colourOnly.a11y.some(a => /only by colour or a ring/.test(a)), JSON.stringify(colourOnly.a11y));
  const pressed = evalOf(`export const A = () => <div>{OPTS.map(o => <button key={o} aria-pressed={v === o} onClick={() => setV(o)} className={v === o ? 'bg-primary' : 'bg-muted'}>{o}</button>)}</div>;`, false);
  assert.ok(!pressed.a11y.some(a => /only by colour/.test(a)));
  const colour = evalOf(`export const A = () => <input type="color" value={hex} onChange={pick} />;`, false);
  assert.ok(colour.a11y.some(a => /colour picker with no name/.test(a)), JSON.stringify(colour.a11y));
  // a button nothing wires up.
  const dead = evalOf(`export const A = () => <button type="button" aria-label="Search" className="h-(--acme-control-h) w-(--acme-control-h) hover:bg-accent"><Icon name="search" /></button>;`, false);
  assert.ok(dead.a11y.some(a => /No click handler/.test(a)));
  assert.ok(dead.confidence < 0.9, 'a dead control goes to a person');
  const trigger = evalOf(`export const A = () => <PopoverTrigger><button type="button" className="px-2">Open</button></PopoverTrigger>;`, false);
  assert.ok(!trigger.a11y.some(a => /No click handler/.test(a)), 'a trigger owns its click');
});

test('detection: text in a conditional branch is text, and StepGlyph is not an icon', () => {
  const f = features(`export const A = () => <button type="button" onClick={() => canAdvance && onAdvance?.(stage)} aria-current={current ? 'step' : undefined} className="size-8 rounded-full">
    {canAdvance ? (isPrimaryNext ? '→' : i + 1) : (<StepGlyph state="current" index={i + 1} size="lg" />)}</button>;`);
  assert.equal(f.children.icons, 0);
  assert.ok(f.children.dynamicText > 0);
  const e = classify(f);
  assert.notEqual(e.role, 'icon-button');
  assert.ok(said(e, /A step in a stepper/));
  assert.ok(e.confidence < 0.9);
  // A chevron that swaps by state is still one icon.
  assert.equal(features(`export const A = () => <button aria-label="Toggle" onClick={t}>{open ? <ChevronUp /> : <ChevronDown />}</button>;`).children.icons, 1);
});
