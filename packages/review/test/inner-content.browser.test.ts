import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { __ownContent } from '../src/shots.js';
import { __test as r } from '../src/rendered.js';

// What an element holds besides its words is captured from the page and carried into its proposal's
// drawing, checked there. Skipped without a headless browser (`dsa setup`).

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const PAGE = `<!doctype html><style>.sys{display:inline-flex;padding:4px;font:14px sans-serif}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>
<button data-dsa-shot="swatch" style="display:flex;flex-direction:column;gap:4px" onclick="x()"><span class="tri" style="display:block;width:0;height:0;border-width:0 16px 16px 0;border-style:solid;border-color:transparent rgb(0,0,255) transparent transparent"></span><span style="font-size:10px">Blue</span></button>
<button data-dsa-shot="words"><span>Save</span><span class="sr">hidden</span></button>
<button data-dsa-shot="icon"><svg width="16" height="16"><path d="M0 0h16v16z"/></svg>Add</button>
<button data-dsa-shot="two"><span style="display:block">Requests</span><span style="display:block">Issued work</span></button>
<button data-dsa-shot="pic"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=" width="20" height="20">Photo</button>
<button data-dsa-shot="glyph"><span style="font-family:'Material Symbols Outlined';display:inline-block;width:20px;overflow:hidden">add</span>Add</button>
<input data-dsa-shot="field" value="x">
<div id="out"></div>`;

test('marks and text blocks are captured with what paints them, and drawn inside the proposal', { timeout: 60_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const page = await browser!.newPage();
  try {
    await page.setContent(PAGE);
    const own = (id: string) => r.run<any>(page, __ownContent, id);
    assert.equal((await own('words')).inner, null, 'its words alone, a hidden label left out');
    assert.equal((await own('icon')).inner, null, 'words and one inline icon go the existing way');
    assert.equal((await own('field')).inner, null);
    assert.equal((await own('glyph')).inner.marks, 1, 'an icon-font glyph is a mark');
    assert.equal((await own('pic')).inner.marks, 1);
    const two = await own('two');
    assert.deepEqual([two.inner.marks, two.inner.blocks], [0, 2]);
    const swatch = await own('swatch');
    assert.equal(swatch.text, 'Blue');
    assert.deepEqual([swatch.inner.marks, swatch.inner.blocks, swatch.inner.lost], [1, 1, 0]);
    assert.doesNotMatch(swatch.inner.html, /onclick|class=/);

    const draw = async (o: any) => {
      await page.evaluate(`document.getElementById('out').innerHTML = '<button id="p" class="sys">sample</button>'`);
      return r.run<any>(page, r.INJECT_OWN, { sel: '#p', own: o });
    };
    assert.deepEqual(await draw(swatch), { own: true, inner: true });
    const tri = await page.evaluate(`(() => { const m = document.querySelector('#p [data-dsa-mark]'); const b = m.getBoundingClientRect(); const c = getComputedStyle(m); return { w: b.width, h: b.height, col: c.borderRightColor, words: document.querySelector('#p').textContent }; })()`) as any;
    assert.deepEqual(tri, { w: 16, h: 16, col: 'rgb(0, 0, 255)', words: 'Blue' });
    // A mark that spells itself out in the drawing (its icon font isn't there) isn't shown.
    assert.equal((await draw({ text: 'Add', inner: { html: '<span data-dsa-mark="20" style="white-space:nowrap">arrow_forward_long_name</span>Add', marks: 1, blocks: 1, lost: 0 } })).inner, false);
    // A picture that couldn't be copied: the rest is drawn, but it doesn't count as carried.
    assert.equal((await draw({ text: 'x', inner: { ...swatch.inner, lost: 1 } })).inner, false);
  } finally { await page.close(); }
});

// The picture must say what the data says. Each page below draws a component that a data field would call fine.
const looked = async (page: any, html: string, words: string | null, inner: string | null = null) => {
  await page.setContent(`<!doctype html><body style="margin:0;background:#fff;font:14px sans-serif">${html}</body>`);
  return r.run<any>(page, r.SHOWN, { sel: '[data-slot=b]', words, inner });
};

test('a drawing that can\'t be seen is not a drawing, and words that don\'t show are not its own', { timeout: 60_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const page = await browser!.newPage();
  try {
    assert.deepEqual(await looked(page, '<button data-slot="b">Open drawer</button>', 'Open drawer'), { shows: true });
    // An overlay part with size, but nothing opened it.
    assert.equal((await looked(page, '<div style="visibility:hidden"><div data-slot="b" style="height:30px">Open drawer</div></div>', 'Open drawer')).shows, false);
    assert.equal((await looked(page, '<div style="opacity:0"><div data-slot="b" style="height:30px">Open drawer</div></div>', 'Open drawer')).shows, false);
    assert.equal((await looked(page, '<div data-slot="b" style="position:fixed;top:-200px;height:30px">Open drawer</div>', 'Open drawer')).shows, false);
    assert.equal((await looked(page, '<div data-slot="b"></div>', 'Open drawer')).shows, false);
    // Equals, not includes: the sample's words beside its own are not its own.
    assert.match((await looked(page, '<button data-slot="b">Open drawer New shelf</button>', 'Open drawer')).notOwn, /not its own/);
    assert.match((await looked(page, '<button data-slot="b">New shelf</button>', '')).notOwn, /does not have/);
    // White on white, and on a dark fill, in any colour syntax.
    assert.match((await looked(page, '<button data-slot="b" style="color:#fff;background:#fff;border:0">Open drawer</button>', 'Open drawer')).notOwn, /same colour/);
    assert.match((await looked(page, '<div data-slot="b" style="color:oklch(1 0 0);height:30px">Open drawer</div>', 'Open drawer')).notOwn, /same colour/);
    assert.deepEqual(await looked(page, '<button data-slot="b" style="color:#fff;background:#123;border:0">Open drawer</button>', 'Open drawer'), { shows: true });
    // Icons aren't words: an icon-only button holds none, and that's right.
    assert.deepEqual(await looked(page, '<button data-slot="b"><svg width="16" height="16"><text>x</text><path d="M0 0h16v16z"/></svg><span class="material-symbols-outlined">add</span></button>', ''), { shows: true });
    // Inner content is compared with what was put in: its words, not a hidden label's.
    assert.deepEqual(await looked(page, '<button data-slot="b"><span data-dsa-mark="16">add</span><span>Blue</span></button>', 'Blue extra', '<span data-dsa-mark="16">add</span><span>Blue</span>'), { shows: true });
  } finally { await page.close(); }
});

test("a sample's bare words beside its icon-font glyph are replaced, and the glyph doesn't get the words", { timeout: 60_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const page = await browser!.newPage();
  try {
    const put = async (html: string) => {
      await page.setContent(`<!doctype html><body>${html}</body>`);
      const out = await r.run<any>(page, r.INJECT_OWN, { sel: '[data-slot=b]', own: { text: 'Open drawer' } });
      assert.equal(out.own, true);
      return { text: await page.textContent('[data-slot=b]'), seen: await r.run<any>(page, r.SHOWN, { sel: '[data-slot=b]', words: 'Open drawer', inner: null }) };
    };
    for (const sample of [
      '<button data-slot="b"><span class="material-symbols-outlined">add</span>New shelf</button>',
      '<button data-slot="b"><span style="font-family:\'Phosphor\'">plus</span>New shelf</button>',
      '<button data-slot="b"><span class="material-icons">add</span><span>New shelf</span></button>',
      '<button data-slot="b">New shelf</button>',
      '<button data-slot="b"><span>New shelf</span><span>Today</span></button>',
    ]) {
      const got = await put(sample);
      assert.equal(got.text, 'Open drawer', sample);
      assert.deepEqual(got.seen, { shows: true }, sample);
    }
    // A component's own inline icon stays beside the words.
    await put('<button data-slot="b"><svg data-slot="icon" width="16" height="16"><path d="M0 0h16v16z"/></svg>New shelf</button>');
    assert.equal(await page.locator('[data-slot=b] svg').count(), 1);
  } finally { await page.close(); }
});
