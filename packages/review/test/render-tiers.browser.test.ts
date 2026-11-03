import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectApp, startApp, tagPlan } from '../src/apps.js';

// Four ways to show an element, best first. 1: a photo of the live app. 2: the same, with a layer that covers
// it hidden. 3: its component mounted in the app's own Vite build. 4: its JSX drawn as markup with the app's
// styles. 1–2 are "Live app screenshot"; 3 is "Drawn from the app's code" and counts when found by its exact
// tag and not blank; 4 is "Markup only" and doesn't count.
// Skipped without a headless browser (`dsa setup`).

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

test('2: a layer over the element is hidden for the photo, then put back', async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const { __test: t } = await import('../src/shots.js');
  // At the crawler's pixel density, which the blank check reads the photo at.
  const page = await browser!.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-tier2-'));
  try {
    await page.setContent(`<style>button { margin: 200px 40px; width: 120px; height: 40px; font: 500 16px system-ui; background: #1d4ed8; color: #fff; border: 0; border-radius: 6px; } .toast { position: fixed; left: 0; right: 0; top: 180px; height: 80px; background: #222; }</style>
      <button data-dsa-shot="E-1">Save</button><div class="toast" style="color: #fff"><span>Saved</span></div>`);
    const cap = await t.capture(page, 'E-1', path.join(dir, 'a.png'));
    assert.deepEqual([cap!.covered, cap!.uncovered, cap!.blank], [undefined, 1, undefined]);
    assert.equal(await page.getAttribute('.toast', 'style'), 'color: #fff', 'the layer is put back as it was');
    assert.equal(await page.locator('[data-dsa-hid]').count(), 0);
  } finally { await page.close(); }
});

test('3 and 4: what the crawler can\'t reach is drawn from the code, in the app\'s own build', { timeout: 120_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-tiers-')));
  const dir = path.join(root, 'apps', 'ledger');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dsa.config.json'), '{}');
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ledger', private: true, type: 'module', scripts: { dev: 'vite' } }));
  fs.writeFileSync(path.join(dir, 'vite.config.js'), `export default { cacheDir: '../../.vite' };\n`);
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>');
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public/app.css'), '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; border-radius: 6px; }');
  fs.writeFileSync(path.join(dir, 'src/main.jsx'), `import { createRoot } from 'react-dom/client';\nimport { Filters } from './Filters.jsx';\ncreateRoot(document.getElementById('root')).render(<main><h1>Ledger</h1><Filters open={false} /></main>);\n`);
  // Shown only when open: the crawler never sees it. Exported, so it can be mounted. Hidden isn't exported
  // (the tagger keeps it for the mount). Broken throws without data nothing can fill in: its markup is drawn.
  const filters = `export function Filters({ open }) {\n  if (!open) return null;\n  return <div><button className="btn">Apply filters</button></div>;\n}\nfunction Hidden() {\n  return <button className="btn">Never used</button>;\n}\nexport function Broken({ user }) {\n  const name = user.profile.name;\n  return <button className="btn">Rename {name}</button>;\n}\n`;
  fs.writeFileSync(path.join(dir, 'src/Filters.jsx'), filters);
  const col = (l: number, s: string) => filters.split('\n')[l - 1]!.indexOf(s) + 1;
  const ev = (id: string, line: number, within: string, text: string, gates: any[] = []) => ({
    id, target: 'ledger', file: 'apps/ledger/src/Filters.jsx', line, col: col(line, '<button'), element: 'button', within,
    match: { tag: 'button', classes: ['btn'], text }, classTokens: ['btn'], reach: { status: 'gated', gates, steps: [], why: '' },
  }) as any;
  const examples = [
    ev('E-mount', 3, 'Filters', 'Apply filters', [{ kind: 'early-return', test: '!open', negated: true, ids: ['open'], component: 'Filters', file: 'apps/ledger/src/Filters.jsx' }]),
    ev('E-local', 6, 'Hidden', 'Never used'),
    ev('E-markup', 10, 'Broken', 'Rename'),
  ];
  const app = await startApp(tagPlan(detectApp({ name: 'ledger', dir } as any, { apps: {} } as any) as any, { root, dir }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-tiers-shots-'));
  const logs: string[] = [];
  try {
    const { captureSession } = await import('../src/shots.js');
    const pw = await import('playwright');
    const r: any = await captureSession(pw, { url: app.url, routes: [''], crawl: false, examples, dir: out, maxPages: 3, waitMs: 300, log: (m: string) => logs.push(m), reveal: false, maxMinutes: 1, draw: { root, dir, mount: true } });
    // 3: its component, mounted with the props its gate needs, and found by its source tag.
    assert.equal(r.shots['E-mount']?.drawn, 'mount', logs.join('\n'));
    assert.equal(r.shots['E-mount']?.exact, true, 'found by its exact source tag, so it counts');
    // 3, for a component its file doesn't export.
    assert.deepEqual([r.shots['E-local']?.drawn, r.shots['E-local']?.exact], ['mount', true], logs.join('\n'));
    // 4: it fails to render: its own markup, with the app's style sheet, and the line says why.
    assert.equal(r.shots['E-markup']?.drawn, 'markup', logs.join('\n'));
    assert.equal(r.shots['E-markup']?.exact, undefined);
    assert.ok(logs.some(l => /E-markup \(apps\/ledger\/src\/Filters\.jsx:10\) drawn as markup only; not mounted: Broken: its component failed to render: .*profile/.test(l)), logs.join('\n'));
    for (const id of ['E-mount', 'E-local', 'E-markup']) {
      assert.ok(fs.statSync(path.join(out, r.shots[id].file)).size > 500, id);
      assert.ok(!r.shots[id].blank, `${id} isn't blank: the app's styles drew it`);
    }
    // Both are still "not found" in the app: a drawing isn't a photo.
    assert.deepEqual([...r.missing].sort(), ['E-local', 'E-markup', 'E-mount']);
    assert.equal(r.drawn, 3);
    assert.ok(logs.some(l => /E-mount \(apps\/ledger\/src\/Filters\.jsx:3\) drawn from the app's code \(its component, in the app's build\)/.test(l)), logs.join('\n'));
    // The app's files are untouched.
    assert.equal(fs.readFileSync(path.join(dir, 'src/Filters.jsx'), 'utf8'), filters);
  } finally { app.stop(); }
});
