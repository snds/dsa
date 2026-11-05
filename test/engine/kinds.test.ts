import { test } from 'vitest';
import './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCode } from '../../src/engine/scanners/code.js';
import { classify } from '../../src/engine/classify.js';
import { loadConfig } from './fixture.js';
import { ACME_ROOT } from './setup.js';

// Round 4: Skeleton and Label are found by their own markup, never by tag alone. A made-up app.

function scan(code: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-kinds-')));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'Screen.tsx'), code);
  const { config } = loadConfig(ACME_ROOT);
  const res = scanCode(dir, config, { name: 'app', dir, role: 'consumer', deps: {} }, []);
  return res.lookalikes.filter(l => /^(div|span|label)$/.test(l.element));
}

test('kinds: a pulsing, muted, empty div is a Skeleton; each signal alone is not', () => {
  const rows = scan(`export const S = () => <>
    <div className="animate-pulse rounded-md bg-muted h-4 w-48" />
    <div className="animate-pulse rounded-md bg-muted h-4">Loading</div>
    <div className="rounded-md bg-muted h-4 w-48" />
    <div className="animate-pulse rounded-full bg-primary size-2" />
  </>;`);
  assert.deepEqual(rows.map(r => [r.element, r.component, r.line]), [['div', 'Skeleton', 2]]);
  const e = classify(rows[0]!.features!);
  assert.equal(e.use, 'Skeleton');
  assert.ok(e.confidence >= 0.9);
});

test('kinds: a label with htmlFor or wrapping a text field is a Label; around a choice control or inside a Field it is not', () => {
  const rows = scan(`export const F = () => <>
    <label htmlFor="name" className="text-sm font-medium">Name</label>
    <label className="grid gap-1 text-sm">Notes <textarea name="notes" /></label>
    <label className="flex gap-2"><input type="checkbox" /> Remember me</label>
    <label htmlFor="agree" className="flex gap-2"><Checkbox id="agree" /> Agree</label>
    <Field><label htmlFor="city">City</label></Field>
    <label className="text-xs text-muted-foreground">Just text</label>
  </>;`);
  assert.deepEqual(rows.map(r => [r.component, r.line]), [['Label', 2], ['Label', 3]]);
  const [forLabel, wraps] = rows.map(r => classify(r.features!));
  assert.equal(forLabel!.use, 'Label');
  assert.equal(forLabel!.ruleId, 'label.for');
  assert.equal(wraps!.ruleId, 'label.wraps');
});
