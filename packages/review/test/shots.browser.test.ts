import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';

// The crawler's in-page scripts, run in a real headless browser through inPage (fixed function source,
// data as an argument). Skipped where no browser is installed (`dsa setup` installs one) or DSA_NO_BROWSER is set.

// DSA_NO_BROWSER=1 skips them on purpose.
const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();

test('shots: in-page scripts find, place, and offer interactions; data never becomes code', async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const { __test: t } = await import('../src/shots.js');
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.setContent(`<aside style="position:fixed;left:0;top:0;width:240px;height:900px"><nav><button class="nav-row" aria-current="page">Materials</button><button class="nav-row">Partners</button></nav></aside>
      <main style="margin-left:260px"><button aria-haspopup="menu" aria-expanded="false">Sort</button><div role="tablist"><button role="tab" aria-selected="false">Media</button></div><button>Delete all</button></main>`);
    const found = await t.inPage(page, t.FIND_IN_PAGE, [{ id: 'E-000000000001', m: { tag: 'button', classes: ['nav-row'], text: 'Partners' } }]);
    assert.equal(found[0]?.id, 'E-000000000001');
    const place = await t.inPage(page, `(id) => { const el = document.querySelector('[data-dsa-shot="' + CSS.escape(id) + '"]'); return el ? (${t.PLACE_IN_PAGE})(el) : null; }`, 'E-000000000001');
    assert.ok(place.regions.includes('nav') && place.regions.includes('aside'), JSON.stringify(place));
    await t.inPage(page, t.MARK_SEEN, 0);
    const acts = await t.inPage(page, t.CANDIDATES, { traced: [], hints: ['media'], level: 0, max: 10 });
    const labels = acts.map((a: any) => a.label);
    assert.ok(labels.includes('Media') && labels.includes('Sort'), JSON.stringify(labels));
    assert.equal(acts[0].label, 'Media', 'a hinted tab goes first');
    assert.ok(!labels.includes('Delete all'), 'destructive controls are never offered');
    // A hostile string crosses as a value: it is never parsed as code.
    assert.equal(await t.inPage(page, '(s) => typeof s', "'); throw new Error('x'); ('"), 'string');
  } finally { await page.close(); }
});

afterAll(async () => { await browser?.close(); });
