import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { CODE_TERMS, decodePng, isBlank, plainText, withPlain } from '../../src/engine/index.js';

// The review card's words and pictures: reasons in plain words (the code terms kept for Technical
// details), and a screenshot read back to tell a painted box from an empty one.

test('reasons lose their code terms, or stay technical-only', () => {
  assert.equal(plainText('aria-pressed: a pressed/unpressed latch.'), 'It works as a pressed/unpressed latch.');
  assert.equal(plainText('An icon-only Button: an icon size, an aria-label, and the icon as its only child.'), 'An icon-only Button: an icon size, an accessible name, and the icon as its only child.');
  assert.equal(plainText("Styling Toggle won't keep: btn, btn-ghost."), "Some of its own styling won't carry over to Toggle.");
  assert.equal(plainText('Red text: a destructive row (variant="destructive").'), 'Red text: a destructive row.');
  assert.equal(plainText('Rows come from a .map() over invoices.'), 'Rows come from a list built from data.');
  assert.equal(plainText('Inside role="tablist", so it is a tab.'), 'Inside the tablist role, so it is a tab.');
  assert.equal(plainText('It opens a menu (aria-haspopup="menu").'), 'It opens a menu.');
  // Nothing plain to say: left to Technical details, never guessed.
  assert.equal(plainText('Matched {cn(base, active && "on")}'), null);
  assert.equal(plainText('aria-flowto points elsewhere.'), null);
  // Plain lines pass through.
  assert.equal(plainText('No click handler: the button does nothing yet.'), 'No click handler: the button does nothing yet.');
  for (const t of ['It works as a pressed/unpressed latch.', 'Rendered: looks like Button outline (70%).']) assert.ok(!CODE_TERMS.test(t), t);
  for (const t of ['aria-label', 'role="tab"', 'rows.map(', '{x}', 'className', 'data-slot', 'variant="ghost"', '<button>']) assert.ok(CODE_TERMS.test(t), t);
  assert.deepEqual(withPlain([{ text: 'aria-pressed: a latch.', delta: 0 }]), [{ text: 'aria-pressed: a latch.', delta: 0, plain: 'It works as a latch.' }]);
});

/** A PNG the way Chromium writes them: 8-bit RGBA, each row with a filter byte. */
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number], filter = 0) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = filter;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y), o = y * (1 + w * 4) + 1 + x * 4;
      // Filter 1 (Sub) stores each byte minus the one to its left.
      const left = x ? px(x - 1, y) : [0, 0, 0];
      const v = filter === 1 ? [r - left[0]!, g - left[1]!, b - left[2]!, x ? 0 : 255] : [r, g, b, 255];
      for (let i = 0; i < 4; i++) raw[o + i] = (v[i]! + 256) & 255;
    }
  }
  const chunk = (kind: string, body: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); return Buffer.concat([len, Buffer.from(kind, 'latin1'), body, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('a screenshot is read back; an unpainted box is blank, a drawn one is not', () => {
  const white = decodePng(png(40, 20, () => [255, 255, 255]));
  assert.equal(white.width, 40);
  assert.equal(white.height, 20);
  assert.equal(isBlank(white), true);
  // A dark label in the middle of a white button (CSS box 4,2 · 12×6 at 2x).
  const label = (x: number, y: number): [number, number, number] => (x >= 12 && x < 28 && y >= 8 && y < 12 ? [20 + x, 20, 40] : [255, 255, 255]);
  for (const filter of [0, 1]) {
    const p = decodePng(png(40, 20, label, filter));
    assert.deepEqual([...p.data.slice((9 * 40 + 13) * 4, (9 * 40 + 13) * 4 + 4)], [33, 20, 40, 255], `filter ${filter}`);
    assert.equal(isBlank(p, { x: 4, y: 2, w: 12, h: 6 }), false);
    // The same image, but only its empty corner.
    assert.equal(isBlank(p, { x: 0, y: 0, w: 4, h: 3 }), true);
  }
  // Two flat colours (a border and a fill) are still nothing to see.
  assert.equal(isBlank(decodePng(png(10, 10, (x) => (x === 0 ? [200, 200, 200] : [255, 255, 255])))), true);
});
