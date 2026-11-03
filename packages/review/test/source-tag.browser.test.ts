import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { parseConfig } from '@snds/dsa';
import { latestEvals } from '@snds/dsa/engine';
import { tagSource } from '@snds/dsa/tag';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { detectApp, startApp, tagPlan } from '../src/apps.js';
import { takeShots } from '../src/shots.js';
// @ts-expect-error a plain script, shared with scripts/review-demo.mjs
import { tagDemoSites } from '../../../scripts/review-demo-tag.mjs';

// Source tags: on a page whose elements carry data-dsa-src="file:line:col", each element is the node its own
// line made. Two identical buttons from two files each match their own line at 100%; a line that renders a
// list is any one of its nodes; a tagged page without the line hasn't got the element (no guess from a
// look-alike). Untagged pages keep the crawler's guess. Skipped without a headless browser (`dsa setup`).

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });
const DEMO = path.resolve(import.meta.dirname, '../../../test/fixtures/review-demo');
const req = createRequire(import.meta.url);

test('a tagged page: exact by line, one of N for a list, and no guess for a line that isn\'t there', async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const { __test: t } = await import('../src/shots.js');
  const page = await browser!.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.setContent(`
      <button class="btn out" data-dsa-src="apps/a/src/Bar.tsx:3:7">Export</button>
      <button class="btn out" data-dsa-src="apps/a/src/Foot.tsx:5:9">Export</button>
      <nav><a class="row" data-dsa-src="apps/a/src/List.tsx:4:30">A</a><a class="row" data-dsa-src="apps/a/src/List.tsx:4:30">B</a><a class="row" data-dsa-src="apps/a/src/List.tsx:4:30">C</a></nav>
      <p><span data-dsa-src="apps/a/src/Pair.tsx:2:5">x</span><span data-dsa-src="apps/a/src/Pair.tsx:2:22">y</span></p>
      <button class="btn out">Export</button>`);
    const m = { tag: 'button', classes: ['btn', 'out'], text: 'Export' };
    const found = await t.inPage(page, t.FIND_IN_PAGE, [
      { id: 'E-bar', m, src: 'apps/a/src/Bar.tsx:3:7' },
      { id: 'E-foot', m, src: 'apps/a/src/Foot.tsx:5:9' },
      { id: 'E-list', m: { tag: 'a', classes: ['row'], text: '' }, src: 'apps/a/src/List.tsx:4:30' },
      { id: 'E-y', m: { tag: 'span', classes: [], text: '' }, src: 'apps/a/src/Pair.tsx:2:22' },
      // Looks exactly like the Export buttons, but its line isn't on this page.
      { id: 'E-gone', m, src: 'apps/a/src/Other.tsx:9:3' },
    ]);
    const by = Object.fromEntries(found.map((f: any) => [f.id, f]));
    for (const id of ['E-bar', 'E-foot']) assert.deepEqual([by[id].score, by[id].ties, by[id].with, by[id].tagged], [1, 1, [], true], id);
    assert.deepEqual([by['E-list'].score, by['E-list'].ties], [1, 3], 'any of the three rows stands for the line');
    assert.equal(by['E-gone'], undefined, 'a tagged page without the line: not on this page');
    const marked = await page.evaluate(`Object.fromEntries(Array.from(document.querySelectorAll('[data-dsa-shot]')).map(e => [e.getAttribute('data-dsa-shot'), e.getAttribute('data-dsa-src')]))`);
    assert.deepEqual(marked, { 'E-bar': 'apps/a/src/Bar.tsx:3:7', 'E-foot': 'apps/a/src/Foot.tsx:5:9', 'E-list': 'apps/a/src/List.tsx:4:30', 'E-y': 'apps/a/src/Pair.tsx:2:22' }, 'the column tells apart two elements on one line');
    // The same page untagged: the crawler's guess, two lines wanting the same buttons.
    await page.setContent('<button class="btn out">Export</button><button class="btn out">Export</button>');
    const guess = await t.inPage(page, t.FIND_IN_PAGE, [{ id: 'E-bar', m, src: 'apps/a/src/Bar.tsx:3:7' }, { id: 'E-foot', m, src: 'apps/a/src/Foot.tsx:5:9' }]);
    assert.deepEqual(guess.map((g: any) => [g.tagged, g.with.length]), [[undefined, 1], [undefined, 1]]);
  } finally { await page.close(); }
});

test('the review demo built with source tags: every match exact, and the app said to be tagged', { timeout: 180_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const root = fixtureCopy();
  fs.cpSync(DEMO, root, { recursive: true });
  const data = path.join(root, '.dsa');
  await tagDemoSites(root, { tagSource, ts, React: req('react'), renderToStaticMarkup: req('react-dom/server').renderToStaticMarkup });
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const live = { apps: { billing: { dir: 'apps/billing/site' } } };
  const config = { ...loadConfig(root).config, live: parseConfig({ live }).live } as any;
  const logs: string[] = [];
  const r = await takeShots({ root, dataDir: data, config, target: 'billing', perGroup: 3, log: m => logs.push(m) });
  assert.equal(r.apps[0]!.tagged, 1, logs.join('\n'));
  assert.ok(logs.some(l => /billing: 100% of pages tagged/.test(l)), logs.join('\n'));
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const { evals } = await latestEvals(data);
  const mine = evals.filter(e => e.file.startsWith('apps/billing/src/'));
  const shot = mine.filter(e => idx.shots[e.id]);
  assert.ok(shot.length >= 5, `${shot.length} photographed`);
  for (const e of shot) assert.deepEqual([idx.shots[e.id].tagged, idx.shots[e.id].matchScore, idx.shots[e.id].shared], [true, 1, undefined], e.id);
  // The rows from the .map(): one of three, said so.
  const row = mine.find(e => e.match.classes.includes('row-link'))!;
  assert.equal(idx.shots[row.id]?.ties, 3);
  assert.ok(logs.some(l => l.includes(`${row.id} on`) && l.includes('one of 3 rendered by this line')), logs.join('\n'));
  // The Export button here is this file's own line, not a guess shared with the checkout app's.
  const exp = mine.find(e => e.match.text === 'Export')!;
  assert.match(logs.find(l => l.includes(`${exp.id} on`)) ?? '', /matched by source tag\)/);
});

test('an app dsa starts with Vite: its own config file, the tagger added inline, its files untouched', { timeout: 120_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  // A real Vite and React from the dashboard's own install; skipped where they aren't installed.
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-tag-vite-')));
  const dir = path.join(root, 'apps', 'ledger');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dsa.config.json'), '{}');
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ledger', private: true, type: 'module', scripts: { dev: 'vite' }, devDependencies: { vite: '*' } }));
  // The app's own config: its define shows up on the page, so the config file was loaded.
  // (Its cache outside the shared install.)
  fs.writeFileSync(path.join(dir, 'vite.config.js'), `export default { cacheDir: '../../.vite', define: { __APP_NAME__: JSON.stringify('Ledger') } };\n`);
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/src/main.jsx"></script>');
  const main = `import { createRoot } from 'react-dom/client';\nimport { Row } from './Row.jsx';\nfunction App() {\n  return <main><h1>{__APP_NAME__}</h1><button className="btn">Pay</button>{['a', 'b'].map(k => <Row key={k} name={k} />)}</main>;\n}\ncreateRoot(document.getElementById('root')).render(<App />);\n`;
  fs.writeFileSync(path.join(dir, 'src/main.jsx'), main);
  fs.writeFileSync(path.join(dir, 'src/Row.jsx'), `export function Row({ name }) {\n  return <button className="btn">{name}</button>;\n}\n`);
  const before = fs.readdirSync(dir).sort();
  const found = detectApp({ name: 'ledger', dir } as any, { apps: {} } as any);
  assert.ok(!('reason' in found) && found.how === 'vite');
  const plan = tagPlan(found as any, { root, dir });
  assert.equal(plan.tag, 'injected');
  const app = await startApp(plan);
  const page = await browser!.newPage();
  try {
    await page.goto(app.url);
    await page.waitForSelector('h1', { timeout: 30_000 });
    assert.equal(await page.textContent('h1'), 'Ledger', 'the app\'s own vite.config.js was used');
    const tags: string[] = await page.evaluate(`Array.from(document.querySelectorAll('[data-dsa-src]')).map(e => e.getAttribute('data-dsa-src'))`);
    assert.ok(tags.includes(`apps/ledger/src/main.jsx:4:${main.split('\n')[3]!.indexOf('<button') + 1}`), tags.join(' '));
    assert.deepEqual(tags.filter(t => t.startsWith('apps/ledger/src/Row.jsx:2:')), ['apps/ledger/src/Row.jsx:2:10', 'apps/ledger/src/Row.jsx:2:10']);
    for (const t of tags) assert.ok(!t.startsWith('/') && !t.includes(root), t);
  } finally { await page.close(); app.stop(); }
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'nothing written into the app');
  assert.equal(fs.readFileSync(path.join(dir, 'src/main.jsx'), 'utf8'), main);
});
