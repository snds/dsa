import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '@snds/dsa';
import { decodePng, latestEvals, readProposals } from '@snds/dsa/engine';
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

// A page that never returns: Playwright's evaluate has no timeout, so one component looping forever used to hold a whole run.
function demoWithBrowser() {
  const root = fixtureCopy();
  fs.cpSync(path.resolve(import.meta.dirname, '../../../test/fixtures/review-demo'), root, { recursive: true });
  fs.symlinkSync(KIT, path.join(root, 'node_modules'), 'dir');
  return { root, data: path.join(root, '.dsa') };
}

test('a component that never returns: the run finishes, reports it as not drawn and names it, and the rest is saved and reused', { timeout: 240_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  if (!hasKit) skip('no Vite and React installed');
  const { root, data } = demoWithBrowser();
  fs.rmSync(path.join(root, 'storybook-static'), { recursive: true });
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  // Toggle now hangs its page whenever it's drawn.
  fs.writeFileSync(path.join(root, 'packages/ds-react/src/Toggle.tsx'), 'export function Toggle() { while (true) {} }\n');
  const config = { ...loadConfig(root).config, live: parseConfig({ live: {} }).live, rendered: { drawSeconds: 5 } } as any;
  const logs: string[] = [];
  let savedBy10 = -1;
  await renderProposals({ root, config, dataDir: data, log: m => { logs.push(m); if (/rendered 10\//.test(m)) savedBy10 = Object.keys(readProposals(data)).length; } });
  const p = readProposals(data);
  const toggles = Object.entries(p).filter(([, v]) => v.use === 'Toggle');
  assert.ok(toggles.length > 0, 'the demo proposes Toggle');
  for (const [k, v] of toggles) {
    assert.deepEqual([v.check, v.shot], ['none', undefined], `${k} is not drawn`);
    assert.match(v.note ?? '', /took longer than \d+ seconds .* stuck in a loop/);
    assert.ok(logs.some(l => l.includes(k) && l.includes('Toggle') && /from the system's source/.test(l)), `the log names ${k}:\n${logs.join('\n')}`);
  }
  assert.ok(logs.some(l => new RegExp(`Stopped for taking too long: ${toggles.length} drawing`).test(l)), logs.join('\n'));
  // The clean page carried on: everything else is still drawn from source.
  const others = Object.values(p).filter(v => v.use !== 'Toggle');
  assert.ok(others.filter(v => v.shot && v.via === 'source').length >= 4, JSON.stringify(others));
  for (const v of others) assert.doesNotMatch(v.note ?? '', /took longer/, 'only the one that hangs is stopped');
  // Saved along the way, so a run killed here would have kept them.
  if (Object.keys(p).length > 10) assert.ok(savedBy10 >= 9, `${savedBy10} on disk by the tenth drawing`);
  // A rerun picks up from what was saved: only the failed ones are tried again.
  fs.writeFileSync(path.join(root, 'packages/ds-react/src/Toggle.tsx'), fs.readFileSync(path.resolve(import.meta.dirname, '../../../test/fixtures/review-demo/packages/ds-react/src/Toggle.tsx')));
  const looked = Object.values(p).filter(v => v.checked).length;
  const again = await renderProposals({ root, config, dataDir: data });
  assert.ok(looked >= 4 && again.reused >= looked, `${again.reused} reused of ${looked} that were drawn and checked`);
  const after = readProposals(data);
  for (const [k] of toggles) assert.doesNotMatch(after[k]!.note ?? '', /took longer/, `${k} isn't stopped once its loop is gone`);
  assert.ok(toggles.some(([k]) => after[k]!.shot), 'and with its own words, it is drawn');
});

test('a story that never returns: the drawing keeps what it had, and the rest of the run carries on', { timeout: 180_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const { root, data } = demoWithBrowser();
  const frame = path.join(root, 'storybook-static/iframe.html');
  fs.writeFileSync(frame, fs.readFileSync(frame, 'utf8').replace('<head>', `<head><script>if (new URLSearchParams(location.search).get('id') === 'button--icon') while (true) {}</script>`));
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const config = { ...loadConfig(root).config, live: parseConfig({ live: { storybook: { dir: 'storybook-static' } } }).live, rendered: { harness: false, drawSeconds: 4 } } as any;
  const logs: string[] = [];
  await renderProposals({ root, config, dataDir: data, log: m => logs.push(m) });
  const stopped = logs.filter(l => /Stopped after \d+ seconds: .*story button--icon/.test(l));
  assert.ok(stopped.length > 0, logs.join('\n'));
  const p = readProposals(data);
  const buttons = Object.values(p).filter(v => v.use === 'Button');
  assert.ok(buttons.some(v => v.check === 'exact' && v.shot), 'the other stories are still drawn, on a clean page');
  assert.ok(buttons.some(v => v.props.size === 'icon' && v.shot && v.check === 'closest'), 'one that hung on its last story keeps the picture it had');
});

test('a trigger is drawn beside what it opens, closed: inside its own open popup, it never returned', { timeout: 120_000 }, async ({ skip }) => {
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
export function PickTrigger({ children }) { return h(Menu.Trigger, { 'data-slot': 'pick-trigger', style: { height: 30, width: 120 } }, children); }
`);
  const h = await startHarness(root, {} as any, [file], () => {});
  const page = await browser!.newPage({ viewport: { width: 800, height: 600 } });
  try {
    assert.equal(await openHarness(page, h!), true);
    const res = await Promise.race([page.evaluate((a) => (window as any).__dsaDraw(a), { file: '/@fs' + file, name: 'PickTrigger', props: {}, text: 'Open', slot: 'pick-trigger' } as any), new Promise(r => setTimeout(() => r('never returned'), 20_000))]);
    assert.deepEqual(res, { ok: true });
    assert.equal(await page.textContent('[data-slot=pick-trigger]'), 'Open');
  } finally { await page.close(); await h!.stop(); }
});

test("a component that fills its container is drawn at its elements' widths; one with its own width isn't", { timeout: 180_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  if (!hasKit) skip('no Vite and React installed');
  const { root, data } = demoWithBrowser();
  fs.rmSync(path.join(root, 'storybook-static'), { recursive: true });
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  // Select fills whatever holds it.
  const select = path.join(root, 'packages/ds-react/src/Select.tsx');
  fs.writeFileSync(select, fs.readFileSync(select, 'utf8').replace('<select', "<select style={{ width: '100%', boxSizing: 'border-box' }}"));
  // Photos say how wide the elements are; a photo that shows nothing doesn't count.
  const { evals } = await latestEvals(data);
  const widths = [161, 96];
  const shots = Object.fromEntries(evals.map((e: any, i: number) => [e.id, { box: { x: 1, y: 1, w: widths[i % 2], h: 26, cw: 400, ch: 200 } }]));
  const blank = { box: { x: 1, y: 1, w: 777, h: 4, cw: 900, ch: 200 }, blank: true };
  fs.mkdirSync(path.join(data, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(data, 'shots', 'index.json'), JSON.stringify({ shots: { ...shots, [evals[0].id]: blank } }));
  const config = { ...loadConfig(root).config, live: parseConfig({ live: {} }).live } as any;
  await renderProposals({ root, config, dataDir: data });
  const p = readProposals(data);
  const s = p.Select!;
  assert.equal(s.fills, true, JSON.stringify(s));
  assert.ok(s.sizes!.length >= 1 && s.sizes!.every(z => [161, 96].includes(z.for)), JSON.stringify(s.sizes));
  assert.equal(s.sizes![0]!.shot, s.shot, 'its main picture is its first size');
  for (const z of s.sizes!) {
    assert.ok(z.wider ? z.w > z.for : z.w === z.for, JSON.stringify(z));
    // At 2x, with 6 px of room each side.
    assert.ok(Math.abs(decodePng(fs.readFileSync(path.join(data, 'rendered', z.shot))).width - (z.w + 12) * 2) <= 2, JSON.stringify(z));
  }
  const fixed = Object.values(p).filter(v => v.use === 'Toggle' && v.shot);
  assert.ok(fixed.length > 0);
  for (const v of fixed) assert.deepEqual([v.fills, v.sizes], [undefined, undefined], JSON.stringify(v));
  // Nothing wanted changed: drawn once, reused after.
  const again = await renderProposals({ root, config, dataDir: data });
  assert.ok(again.reused >= Object.values(p).filter(v => v.shot && v.checked).length, `${again.reused} reused`);
});
