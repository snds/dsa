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

test('inner content with bare words at its top level is compared, not thrown out', { timeout: 60_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const page = await browser!.newPage();
  try {
    await page.setContent('<button data-slot="b" style="font:14px sans-serif">Blue <span>swatch</span></button>');
    const seen = await r.run<any>(page, r.SHOWN, { sel: '[data-slot=b]', words: 'Blue swatch', inner: 'Blue <span>swatch</span>' });
    assert.deepEqual(seen, { shows: true });
  } finally { await page.close(); }
});

test("a field's words are what's typed in it, or its placeholder; a password's value is never kept", { timeout: 60_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const page = await browser!.newPage();
  try {
    await page.setContent(`<input data-dsa-shot="filled" value="Walnut"><input data-dsa-shot="hint" placeholder="Enter value"><input data-dsa-shot="secret" type="password" value="hunter2" placeholder="Password"><input data-dsa-shot="tick" type="checkbox" value="on"><textarea data-dsa-shot="area">Long note</textarea><select data-dsa-shot="pick"><option>One</option><option selected>Two</option></select><button data-dsa-shot="plain">Save</button>`);
    const get = (id: string) => page.evaluate(`(${__ownContent})(${JSON.stringify(id)})`) as Promise<any>;
    assert.deepEqual([(await get('filled')).value, (await get('filled')).placeholder, (await get('filled')).v], ['Walnut', null, 2]);
    assert.deepEqual([(await get('hint')).value, (await get('hint')).placeholder], [null, 'Enter value']);
    const secret = await get('secret');
    assert.deepEqual([secret.value, secret.placeholder], [null, 'Password']);
    assert.ok(!JSON.stringify(secret).includes('hunter2'), "a password's value isn't in the record");
    assert.equal((await get('tick')).value, null);
    assert.equal((await get('area')).value, 'Long note');
    assert.deepEqual([(await get('pick')).value, (await get('pick')).text], ['Two', null], 'a select says what is selected, not every option');
    assert.equal('value' in (await get('plain')), false);
  } finally { await page.close(); }
});

test("a drawn field holds the element's words, and the check reads them from the box", { timeout: 60_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const page = await browser!.newPage();
  try {
    const sel = '[data-slot=b]';
    await page.setContent('<div data-slot="b" style="width:200px;height:30px"><input placeholder="Sample"></div>');
    assert.deepEqual(await r.run<any>(page, r.INJECT_OWN, { sel, own: { value: 'Walnut' } }), { own: true });
    assert.equal(await page.inputValue('input'), 'Walnut');
    assert.deepEqual(await r.run<any>(page, r.SHOWN, { sel, words: 'Walnut', inner: null, field: { value: 'Walnut', placeholder: null } }), { shows: true });
    await page.fill('input', 'Other');
    assert.match((await r.run<any>(page, r.SHOWN, { sel, words: 'Walnut', inner: null, field: { value: 'Walnut', placeholder: null } })).notOwn, /not its own/);
    // A placeholder of its own replaces the sample's.
    await page.setContent('<input data-slot="b" placeholder="Sample">');
    await r.run(page, r.INJECT_OWN, { sel, own: { placeholder: 'Enter value' } });
    assert.equal(await page.getAttribute(sel, 'placeholder'), 'Enter value');
    // With no box in the drawing (a trigger, say), they're its label.
    await page.setContent('<button data-slot="b"><span>Sample</span></button>');
    assert.deepEqual(await r.run<any>(page, r.INJECT_OWN, { sel, own: { value: 'Walnut' } }), { own: true });
    assert.equal(await page.textContent(sel), 'Walnut');
  } finally { await page.close(); }
});

test("a whole structure keeps its parts: one line of joined words, or one icon, doesn't go in it", { timeout: 60_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const page = await browser!.newPage();
  try {
    const sel = '[data-slot=b]';
    const table = '<div data-slot="b"><table><tr><th>Sample</th></tr><tr><td>Row</td></tr></table></div>';
    for (const [html, own] of [
      [table, { text: 'AisleShelfPrice' }],
      ['<aside data-slot="b" style="height:400px"><ul><li>Sample</li></ul></aside>', { ariaLabel: 'Search', inner: { html: '<div data-dsa-mark="16">search</div>', marks: 1, blocks: 0, lost: 0 } }],
      ['<div data-slot="b"><div role="tablist"><button role="tab">Sample</button></div></div>', { text: 'Overview' }],
    ] as const) {
      await page.setContent(html);
      const before = await page.innerHTML('body');
      const res = await r.run<any>(page, r.INJECT_OWN, { sel, own });
      assert.deepEqual([res.own, res.example], [false, true], html);
      assert.match(res.why, /example of the component/);
      assert.equal(await page.innerHTML('body'), before, 'left as its story wrote it');
    }
    // Something itself made of several blocks, copied whole, does go in: the copy keeps its structure.
    await page.setContent('<ul data-slot="b"><li>Sample</li></ul>');
    const whole = await r.run<any>(page, r.INJECT_OWN, { sel, own: { inner: { html: '<div>One</div><div>Two</div>', marks: 0, blocks: 2, lost: 0 } } });
    assert.equal(whole.own, true);
    // A button with nothing like that inside still takes its own words.
    await page.setContent('<button data-slot="b"><span>Sample</span></button>');
    assert.equal((await r.run<any>(page, r.INJECT_OWN, { sel, own: { text: 'Export' } })).own, true);
  } finally { await page.close(); }
});

test("a wordless tile whose picture couldn't be copied says so, and doesn't claim the story's words", { timeout: 60_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const page = await browser!.newPage();
  try {
    await page.setContent('<button data-slot="b">Left</button>');
    const res = await r.run<any>(page, r.INJECT_OWN, { sel: '[data-slot=b]', own: { ariaLabel: 'Picture 2', inner: { html: null, marks: 1, blocks: 0, lost: 0 } } });
    assert.equal(res.own, false);
    assert.match(res.why, /couldn't be copied/);
  } finally { await page.close(); }
});

test('what sits on top of something stays on top of it in the copy', { timeout: 60_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const page = await browser!.newPage();
  try {
    await page.setContent(`<button data-dsa-shot="s" style="position:relative;width:32px;height:32px;padding:0;border:0"><span style="display:block;width:32px;height:32px;background:rgb(1,2,3)"></span><span style="position:absolute;right:2px;bottom:2px;width:10px;height:10px;background:rgb(9,9,9)"></span></button><button data-slot="b" style="display:inline-flex;width:32px;height:32px;padding:0;border:0"></button>`);
    const c: any = await page.evaluate(`(${__ownContent})("s")`);
    assert.ok(c.inner?.html.includes('position: absolute'), c.inner?.html);
    await r.run(page, r.INJECT_OWN, { sel: '[data-slot=b]', own: { inner: c.inner } });
    const at = await page.evaluate(`(() => { const b = document.querySelector('[data-slot=b]'), a = b.querySelector('[style*="position: absolute"]'); const x = b.getBoundingClientRect(), y = a.getBoundingClientRect(); return [y.left >= x.left, y.right <= x.right, y.top >= x.top, y.bottom <= x.bottom]; })()`);
    assert.deepEqual(at, [true, true, true, true], 'inside the element, not beside it');
  } finally { await page.close(); }
});

test("a drawing's width: only what follows its container fills it, and it can be asked for a width", { timeout: 60_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<!doctype html><body style="margin:0;padding:24px"><div id="root">
      <input id="full" style="width:100%;box-sizing:border-box">
      <div style="padding:0 10px"><label id="inset" style="display:block">Alder</label></div>
      <div id="half" style="width:50%;height:8px"></div>
      <div id="fixed" style="width:256px;height:40px"></div>
      <button id="wordless"></button><button id="worded">Alder</button><span id="dot" role="checkbox"></span>
    </div><div id="popup" style="position:fixed;width:50%;height:9px"></div>`);
    const fills = (id: string) => r.run<any>(page, r.FILLS, { sel: `#${id}` });
    const room = (f: any, w: number) => Math.max(1, (w - f.rest) / f.rate);
    const set = (id: string, f: any, w: number) => r.run<any>(page, r.SET_WIDTH, { sel: `#${id}`, room: room(f, w) });
    assert.equal(await fills('fixed'), null, 'a fixed width is its own');
    assert.equal(await fills('popup'), null, 'outside the drawing, the room has no say');
    const full = await fills('full');
    assert.equal((await set('full', full, 161)).w, 161);
    await r.run(page, r.SET_WIDTH, { sel: '#full', room: null });
    assert.equal(await page.evaluate(`document.getElementById('root').style.width`), '', 'back as it was');
    const inset = await fills('inset');
    assert.equal((await set('inset', inset, 96)).w, 96, 'room taken up around it is allowed for');
    const half = await fills('half');
    assert.equal((await set('half', half, 300)).w, 300, 'a share of the room is allowed for');
    await r.run(page, r.SET_WIDTH, { sel: '#half', room: null });
    const bare = (id: string) => r.run<boolean>(page, r.BARE, { sel: `#${id}` });
    assert.deepEqual([await bare('wordless'), await bare('worded'), await bare('dot')], [true, false, false]);
  } finally { await page.close(); }
});
