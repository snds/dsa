import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '@snds/dsa';
import { readProposals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { openHarness, startHarness } from '../src/harness.js';
import { READ_STYLE, __test as r, drawFresh, lookAt, renderProposals, unstyledLook } from '../src/rendered.js';

// Proposals drawn without stories: the system's component mounted from its own source with the proposal's
// props and the element's own words, inside what its Storybook preview adds (its CSS). Props confirmed from
// the drawn element: its data attributes, else the classes its cva adds. Skipped without a headless browser
// (`dsa setup`) or without Vite and React installed (the dashboard's own install stands in here).

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });
const KIT = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
const hasKit = fs.existsSync(path.join(KIT, 'vite')) && fs.existsSync(path.join(KIT, 'react')) && fs.existsSync(path.join(KIT, 'class-variance-authority'));

test('the review demo with no Storybook at all: drawn from source, exactly, with each element\'s own content', { timeout: 180_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  if (!hasKit) skip('no Vite and React installed');
  const root = fixtureCopy();
  fs.cpSync(path.resolve(import.meta.dirname, '../../../test/fixtures/review-demo'), root, { recursive: true });
  fs.rmSync(path.join(root, 'storybook-static'), { recursive: true });
  fs.symlinkSync(KIT, path.join(root, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const config = { ...loadConfig(root).config, live: parseConfig({ live: {} }).live } as any;
  const logs: string[] = [];
  await renderProposals({ root, config, dataDir: data, log: m => logs.push(m) });
  assert.ok(logs.some(l => /drawing from the system's own source with Vite and packages\/ds-react\/\.storybook\/preview\.ts/.test(l)), logs.join('\n'));
  const p = readProposals(data);
  const by = (use: string) => Object.entries(p).filter(([k]) => k.startsWith(use) && k.includes('#')).map(([, v]) => v);
  // Every element with words of its own (no photos here: its words come from its source) is drawn with them.
  const own = Object.entries(p).filter(([k]) => k.includes('#'));
  assert.ok(own.length >= 5, `${own.length} drawn with own content`);
  // (A candidate that isn't in the system's source can't be drawn, and says so.)
  for (const [k, v] of own.filter(([k, v]) => !k.startsWith('Table') && !v.noSource)) assert.deepEqual([v.check, v.via, v.own], ['exact', 'source', true], `${k} ${JSON.stringify(v)}`);
  // A select with no words of its own in the source (no story either): drawn from source as it is, with none.
  assert.deepEqual([p.Select!.check, p.Select!.via, p.Select!.content], ['exact', 'source', undefined]);
  // A toggle that shows no data-variant: its props confirmed from its classes.
  for (const v of by('Toggle')) assert.deepEqual([v.check, v.own], ['exact', true]);
  // A table: its rows are data, so it's drawn empty and says so.
  for (const v of by('Table')) assert.match(v.content ?? '', /rows come from data/);
  for (const [, v] of own) if (v.shot && v.own) assert.ok(fs.statSync(path.join(data, 'rendered', v.shot)).size > 300, v.shot);
});

test('a part that lives inside something closed is drawn inside its family, opened; a part that needs data gets empty lists', { timeout: 120_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  if (!hasKit) skip('no Vite and React installed');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-harness-')));
  const ds = path.join(root, 'kit');
  fs.mkdirSync(path.join(ds, 'src'), { recursive: true });
  fs.mkdirSync(path.join(ds, '.storybook'));
  fs.symlinkSync(KIT, path.join(root, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(ds, '.storybook/preview.js'), "import '../src/kit.css';\n");
  fs.writeFileSync(path.join(ds, 'src/kit.css'), '[data-slot=menu-item] { display: block; padding: 6px 12px; background: rgb(238, 242, 255); }');
  const file = path.join(ds, 'src/Menu.jsx');
  fs.writeFileSync(file, `import { createContext, createElement as h, useContext } from 'react';
const Open = createContext(false);
export function Menu({ open, children }) { return h(Open.Provider, { value: Boolean(open) }, children); }
export function MenuContent({ children }) { return useContext(Open) ? h('div', { role: 'menu' }, children) : null; }
export function MenuItem({ children }) { return h('div', { 'data-slot': 'menu-item', role: 'menuitem' }, children); }
export function Grid({ rows }) { return h('table', { 'data-slot': 'grid' }, h('tbody', null, rows.map((x, i) => h('tr', { key: i }, h('td', null, x))))); }
`);
  const h = await startHarness(root, {} as any, [file], () => {});
  assert.ok(h);
  const page = await browser!.newPage();
  try {
    assert.equal(await openHarness(page, h!), true);
    const draw = (a: object) => page.evaluate((x) => (window as any).__dsaDraw(x), a as any);
    const fs_ = '/@fs' + file;
    // Alone it draws nothing (its menu is closed): inside Menu open and MenuContent, it shows.
    assert.deepEqual(await draw({ file: fs_, name: 'MenuItem', props: {}, text: 'Rename', slot: 'menu-item' }), { ok: true });
    assert.equal(await page.textContent('[data-slot=menu-item]'), 'Rename');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('[data-slot=menu-item]')).backgroundColor`), 'rgb(238, 242, 255)', "the system's CSS came from its preview");
    // Without data it throws; with empty lists it draws.
    assert.deepEqual(await draw({ file: fs_, name: 'Grid', props: {}, text: null, slot: 'grid', empty: true }), { ok: true });
    const missing: any = await draw({ file: fs_, name: 'Nope', props: {}, text: null, slot: 'x' });
    assert.match(missing.why, /isn't exported/);
  } finally { await page.close(); await h!.stop(); }
});

test('props are confirmed from cva\'s classes when the element shows no data attributes', async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const page = await browser!.newPage();
  try {
    await page.setContent('<button data-slot="toggle" class="ds-toggle ds-toggle-outline ds-toggle-sm">A</button><button data-slot="toggle" class="ds-toggle ds-toggle-plain ds-toggle-md">B</button>');
    const classes = { variant: { default: ['ds-toggle-plain'], outline: ['ds-toggle-outline'] }, size: { default: ['ds-toggle-md'], sm: ['ds-toggle-sm'] } };
    const found: any[] = await r.run(page, r.SCAN, { slot: 'toggle', want: { variant: 'outline', size: 'sm' }, classes });
    assert.deepEqual(found.map(f => [f.confirmed, f.contradicted, f.unknown]), [[2, 0, 0], [0, 2, 0]]);
    assert.deepEqual(found[1].actual, { variant: 'default', size: 'default' });
    // Without the classes, nothing can be read: unverified, as before.
    const blind: any[] = await r.run(page, r.SCAN, { slot: 'toggle', want: { variant: 'outline' }, classes: null });
    assert.equal(blind[0].unknown, 1);
  } finally { await page.close(); }
});

test("Storybook beside the packages: its stylesheet, Tailwind and all, reaches the drawing, even when its decorators can't run outside it", { timeout: 120_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  if (!hasKit || !fs.existsSync(path.join(KIT, '@tailwindcss/vite'))) skip('no Vite, React and Tailwind installed');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-harness-')));
  fs.symlinkSync(KIT, path.join(root, 'node_modules'), 'dir');
  const sb = path.join(root, 'apps/storybook/.storybook'), ds = path.join(root, 'packages/kit/src');
  fs.mkdirSync(sb, { recursive: true });
  fs.mkdirSync(ds, { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/kit/package.json'), '{"name":"@acme/kit"}');
  fs.writeFileSync(path.join(sb, 'main.js'), "import tailwindcss from '@tailwindcss/vite';\nexport default { viteFinal(c) { c.plugins = [...(c.plugins ?? []), tailwindcss()]; return c; } };\n");
  fs.writeFileSync(path.join(sb, 'preview.css'), '@import "tailwindcss";\n@source "../../../packages";\nhtml { font-family: Verdana, sans-serif; }\n');
  // The preview's decorator works only inside Storybook: it throws here.
  fs.writeFileSync(path.join(sb, 'preview.js'), "import './preview.css';\nexport const decorators = [() => { throw new Error('only inside Storybook'); }];\n");
  const file = path.join(ds, 'Menu.jsx');
  fs.writeFileSync(file, `import { createElement as h } from 'react';
export function MenuItem({ children }) { return h('div', { 'data-slot': 'menu-item', className: 'px-3 py-1 rounded-md' }, children); }
`);
  const logs: string[] = [];
  const h = await startHarness(root, {} as any, [file], m => logs.push(m));
  assert.ok(h);
  assert.ok(logs.some(l => l.includes(path.join('apps', 'storybook', '.storybook', 'preview.js'))), logs.join('\n'));
  const page = await browser!.newPage();
  try {
    assert.equal(await openHarness(page, h!), true);
    const done = await page.evaluate((x) => (window as any).__dsaDraw(x), { file: `/@fs${file}`, name: 'MenuItem', props: {}, text: 'Comment', slot: 'menu-item' } as any);
    assert.deepEqual(done, { ok: true });
    await page.waitForTimeout(300);
    const look: any = await page.evaluate(`(${READ_STYLE})(document.querySelector('[data-slot="menu-item"]'))`);
    assert.equal(look.paddingLeft, '12px', 'the utility classes were generated');
    assert.match(look.fontFamily, /Verdana/);
    assert.equal(unstyledLook(look), false);
  } finally { await page.close(); await h!.stop(); }
});

/** A kit whose components use hooks, one of which brings a dependency that itself uses React. */
function hookKit() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-harness-')));
  const ds = path.join(root, 'kit');
  fs.mkdirSync(path.join(ds, 'src'), { recursive: true });
  fs.symlinkSync(KIT, path.join(root, 'node_modules'), 'dir');
  const comp = (n: string, more = '') => {
    const file = path.join(ds, `src/${n}.jsx`);
    fs.writeFileSync(file, `import { createElement as h, useRef } from 'react';\n${more}\nexport function ${n}({ children }) { useRef(null); return h('button', { 'data-slot': '${n}' }, children); }\n`);
    return file;
  };
  return { root, first: comp('First'), late: comp('Late', "import { ThemeProvider } from 'next-themes';\nimport { Toaster } from 'sonner';\nexport const parts = [ThemeProvider, Toaster];"), after: comp('After') };
}
const arg = (file: string, name: string) => ({ file: '/@fs' + file, name, props: {}, text: 'Save', slot: name });

test('a dependency found late puts a second React in the open page; a fresh page draws what that broke', { timeout: 120_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  if (!hasKit) skip('no Vite and React installed');
  const kit = hookKit();
  // Only the first file is known up front, so the others' dependencies are found during the run.
  const h = await startHarness(kit.root, {} as any, [kit.first], () => {});
  const page = await browser!.newPage();
  const reacts = new Set<string>();
  page.on('response', x => { if (/\/deps\/react\.js\?v=/.test(x.url())) reacts.add(x.url()); });
  try {
    assert.equal(await openHarness(page, h!), true);
    const raw = (a: object) => page.evaluate((x) => (window as any).__dsaDraw(x), a as any);
    assert.deepEqual(await raw(arg(kit.first, 'First')), { ok: true });
    assert.deepEqual(await raw(arg(kit.late, 'Late')), { ok: true });
    // The cause: a new bundle, a second React, and a component imported after it can't use hooks.
    const broken: any = await raw(arg(kit.after, 'After'));
    assert.match(broken.why, /Cannot read properties of null \(reading 'useRef'\)/);
    assert.equal(reacts.size, 2, [...reacts].join('\n'));
    // The fix: the failure reloads the page, and it draws. The module that failed is drawn fresh.
    const fresh = { reloads: 0, gaveUp: new Set<string>() };
    assert.deepEqual(await drawFresh(page, h!, fresh, arg(kit.after, 'After')), { ok: true });
    assert.equal(fresh.reloads, 1);
    assert.equal(await page.textContent('[data-slot=After]'), 'Save');
    // Others keep drawing, with no more reloads.
    assert.deepEqual(await drawFresh(page, h!, fresh, arg(kit.first, 'First')), { ok: true });
    assert.equal(fresh.reloads, 1);
  } finally { await page.close(); await h!.stop(); }
});

test('with every component known up front, the first bundle holds their dependencies, so React stays one copy', { timeout: 120_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  if (!hasKit) skip('no Vite and React installed');
  const kit = hookKit();
  const h = await startHarness(kit.root, {} as any, [kit.first, kit.late, kit.after], () => {});
  const page = await browser!.newPage();
  const reacts = new Set<string>();
  page.on('response', x => { if (/\/deps\/react\.js\?v=/.test(x.url())) reacts.add(x.url()); });
  try {
    assert.equal(await openHarness(page, h!), true);
    const fresh = { reloads: 0, gaveUp: new Set<string>() };
    for (const [f, n] of [[kit.first, 'First'], [kit.late, 'Late'], [kit.after, 'After']] as const) assert.deepEqual(await drawFresh(page, h!, fresh, arg(f, n)), { ok: true }, n);
    assert.equal(fresh.reloads, 0);
    assert.equal(reacts.size, 1, [...reacts].join('\n'));
  } finally { await page.close(); await h!.stop(); }
});

test('a menu part drawn with nothing to open it is sized but not painted: looked at, it is no drawing', { timeout: 120_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  if (!hasKit || !fs.existsSync(path.join(KIT, '@base-ui/react'))) skip('no menu library installed');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-harness-')));
  const ds = path.join(root, 'kit');
  fs.mkdirSync(path.join(ds, 'src'), { recursive: true });
  fs.symlinkSync(KIT, path.join(root, 'node_modules'), 'dir');
  const file = path.join(ds, 'src/Pick.jsx');
  fs.writeFileSync(file, `import { createElement as h } from 'react';
import { Menu } from '@base-ui/react/menu';
export function Pick(props) { return h(Menu.Root, props); }
export function PickContent({ children }) { return h(Menu.Portal, null, h(Menu.Positioner, null, h(Menu.Popup, null, children))); }
export function PickItem({ children }) { return h(Menu.Item, { 'data-slot': 'pick-item', style: { height: 30, width: 120 } }, children); }
`);
  const h = await startHarness(root, {} as any, [file], () => {});
  const page = await browser!.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
  try {
    assert.equal(await openHarness(page, h!), true);
    const fresh = { reloads: 0, gaveUp: new Set<string>() };
    const out = await drawFresh(page, h!, fresh, { file: '/@fs' + file, name: 'PickItem', props: {}, text: 'Open drawer', slot: 'pick-item' });
    // It drew, it has a size, and its words are in it, which is all the data ever said.
    assert.deepEqual(out, { ok: true });
    const item = page.locator('[data-slot=pick-item]').first();
    assert.equal((await item.boundingBox())!.width, 120);
    assert.equal(await item.textContent(), 'Open drawer');
    const shot = path.join(root, 'item.png');
    await item.screenshot({ path: shot });
    // Looked at, it's see-through: its positioner has nothing to sit against.
    const seen = await lookAt(page, '[data-slot=pick-item]', shot, { use: 'PickItem', props: {}, own: { text: 'Open drawer' } } as any, { own: true });
    assert.equal(seen.shows, false);
    assert.match(seen.why!, /see-through/);
  } finally { await page.close(); await h!.stop(); }
});
