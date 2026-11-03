import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A photo is evidence only if it shows the element: the capture checks the box has painted pixels and
// that the element is the top layer at its centre, trying hover and focus, then hiding a covering layer,
// before it gives up; it keeps
// the element's own content for its proposal; and identical controls claimed by two source lines are a
// guess, not a certainty. Skipped where no browser is installed (`dsa setup`) or DSA_NO_BROWSER is set.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const PAGE = `<style>
  body { font: 14px system-ui; margin: 40px; }
  button { width: 40px; height: 40px; border: 1px solid #999; background: #fff; margin: 8px; }
  svg { width: 16px; height: 16px; }
  .hover svg { opacity: 0; } .hover:hover svg { opacity: 1; }
  .never svg { opacity: 0; }
  .bar { position: fixed; left: 0; right: 0; bottom: 0; height: 120px; background: #222; }
</style>
<button class="plain" aria-label="Add"><svg viewBox="0 0 16 16" onload="window.bad = 1"><path d="M8 2v12M2 8h12" stroke="#000" stroke-width="2"/></svg></button>
<button class="hover" aria-label="Archive"><svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="#000"/></svg></button>
<button class="never" aria-label="Ghost"><svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="#000"/></svg></button>
<div style="height: 2000px"></div>
<button class="covered" aria-label="Under">Save</button>
<div class="bar"></div>`;

test('capture: painted, shown on hover, blank, uncovered; and the element\'s own content', async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const { __test: t } = await import('../src/shots.js');
  const page = await browser!.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-capture-'));
  try {
    await page.setContent(PAGE);
    const shoot = async (cls: string) => {
      await page.evaluate(`document.querySelector('.${cls}').setAttribute('data-dsa-shot', '${cls}')`);
      const content = cls === 'plain' ? await t.inPage(page, t.OWN_CONTENT, cls) : null;
      const r = await t.capture(page, cls, path.join(dir, `${cls}.png`));
      return { r, content };
    };
    const plain = await shoot('plain');
    assert.ok(plain.r && !plain.r.blank && !plain.r.covered && !plain.r.via, JSON.stringify(plain.r));
    assert.ok(fs.statSync(path.join(dir, 'plain.png')).size > 200);
    // Its own content: no words, its name, and its icon with handlers stripped and the system's colour.
    assert.equal(plain.content.text, null);
    assert.equal(plain.content.ariaLabel, 'Add');
    assert.match(plain.content.icon, /^<svg/);
    assert.doesNotMatch(plain.content.icon, /onload/);
    assert.match(plain.content.icon, /stroke="currentColor"|fill="currentColor"/);

    const hover = await shoot('hover');
    assert.equal(hover.r!.via, 'hover', 'an icon that shows on hover is photographed hovered');
    assert.ok(!hover.r!.blank);

    const never = await shoot('never');
    assert.equal(never.r!.blank, true, 'a box with nothing drawn inside is blank, after hover and focus');

    // A fixed bar over its centre: hidden for the photo (it's still the app's page), then put back.
    const covered = await shoot('covered');
    assert.deepEqual([covered.r!.covered, covered.r!.uncovered], [undefined, 1]);
    assert.equal((await page.locator('.bar').getAttribute('style')) ?? '', '', 'the bar is back as it was');
    assert.equal(await page.locator('.bar').evaluate((el) => getComputedStyle(el).visibility), 'visible');
  } finally { await page.close(); }
});

test('two source lines that want the same identical controls are told apart only as a guess', async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const { __test: t } = await import('../src/shots.js');
  const page = await browser!.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.setContent('<button class="btn out">Export</button><button class="btn out">Export</button><nav><a class="row">A</a><a class="row">B</a><a class="row">C</a></nav>');
    const m = { tag: 'button', classes: ['btn', 'out'], text: 'Export' };
    const found = await t.inPage(page, t.FIND_IN_PAGE, [{ id: 'E-1', m }, { id: 'E-2', m }, { id: 'E-3', m: { tag: 'a', classes: ['row'], text: '' } }]);
    const by = Object.fromEntries(found.map((f: any) => [f.id, f]));
    // Each line gets its own control, and each knows the other wants the same ones.
    assert.equal(by['E-1'].ties, 2);
    assert.equal(by['E-2'].ties, 2, 'a control the first line took still counts as a tie for the second');
    assert.deepEqual([by['E-1'].with, by['E-2'].with], [['E-2'], ['E-1']]);
    // Three rows built from one list: alike, and no other line wants them.
    assert.deepEqual([by['E-3'].ties, by['E-3'].alike, by['E-3'].with], [3, 3, []]);
    const marked = await page.evaluate(`Array.from(document.querySelectorAll('[data-dsa-shot]')).map(e => e.getAttribute('data-dsa-shot'))`);
    assert.deepEqual(marked, ['E-1', 'E-2', 'E-3']);
  } finally { await page.close(); }
});
