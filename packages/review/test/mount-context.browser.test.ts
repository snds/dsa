import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectApp, startApp, tagPlan } from '../src/apps.js';

// Drawing from the app's code for components that can't render alone: ones that read the app's providers
// (a store and a theme its entry file wraps it in), ones that need props (typed, untyped, and ones a call
// site passes as literals), and ones the file doesn't export. Every element ends drawn, or with a line
// saying why not. Skipped without a headless browser (`dsa setup`) or without Vite installed.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const FILES: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn, .badge { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; } .dark .btn { background: rgb(15, 23, 42); }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/store.jsx': `import { createContext, useContext } from 'react';\nexport const StoreCtx = createContext(null);\nexport const ThemeCtx = createContext('light');\nexport function StoreProvider({ store, children }) { return <StoreCtx.Provider value={store}>{children}</StoreCtx.Provider>; }\nexport const useStore = () => { const s = useContext(StoreCtx); if (!s) throw new Error('useStore needs a StoreProvider'); return s; };\n`,
  // The entry file wraps the app in its providers.
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { StoreProvider, ThemeCtx } from './store.jsx';\nimport { Home } from './Home.jsx';\nconst store = { shop: 'Northwind', orders: [] };\ncreateRoot(document.getElementById('root')).render(<StoreProvider store={store}><ThemeCtx.Provider value="dark"><Home /></ThemeCtx.Provider></StoreProvider>);\n`,
  'src/Home.jsx': `import { useContext } from 'react';\nimport { useStore, ThemeCtx } from './store.jsx';\nexport function Home() {\n  const s = useStore();\n  const theme = useContext(ThemeCtx);\n  return <main className={theme}><h1>{s.shop}</h1><p>No orders yet</p></main>;\n}\n`,
  // Needs the store, isn't exported, and shows its button only when open.
  'src/Panel.jsx': `import { useContext } from 'react';\nimport { useStore, ThemeCtx } from './store.jsx';\nfunction ExportPanel({ open }) {\n  const s = useStore();\n  const theme = useContext(ThemeCtx);\n  if (!open) return null;\n  return <div className={theme}><button className="btn">Export {s.shop} orders</button></div>;\n}\nexport const panels = [ExportPanel];\n`,
  // Typed props it needs to render: an object, a list and a handler.
  'src/InvoiceRow.tsx': `interface Invoice { id: string; total: number }\ninterface Props { invoice: Invoice; tags: string[]; onOpen: () => void; note?: string }\nexport function InvoiceRow({ invoice, tags, onOpen }: Props) {\n  return <div>{tags.map(t => <i key={t}>{t}</i>)}<button className="btn" onClick={onOpen}>Open {invoice.id.toUpperCase()} {invoice.total.toFixed(2)}</button></div>;\n}\n`,
  // Untyped: a count a call site passes as a literal.
  'src/Badge.jsx': `export function Badge({ count, items }) {\n  return <button className="badge">{count.toFixed(0)} new of {items.length}</button>;\n}\n`,
  'src/Admin.jsx': `import { Badge } from './Badge.jsx';\nexport function Admin() { return <Badge count={3} items={[]} />; }\n`,
};

test('components that need providers, props, or aren\'t exported are drawn from the app\'s code; the rest say why', { timeout: 180_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-mount-ctx-')));
  const dir = path.join(root, 'apps', 'shop');
  for (const [f, c] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(root, 'dsa.config.json'), '{}');
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop', private: true, type: 'module', scripts: { dev: 'vite' } }));
  const at = (f: string, s: string) => { const lines = FILES[f]!.split('\n'); const l = lines.findIndex(x => x.includes(s)); return { line: l + 1, col: lines[l]!.indexOf(s) + 1 }; };
  const ev = (id: string, f: string, within: string, text: string, gates: any[] = [], pos = at(f, '<button')) => ({
    id, target: 'shop', file: `apps/shop/${f}`, ...pos, element: 'button', within,
    match: { tag: 'button', classes: ['btn'], text }, classTokens: ['btn'], reach: { status: 'gated', gates, steps: [], why: '' },
  }) as any;
  const examples = [
    ev('E-panel', 'src/Panel.jsx', 'ExportPanel', 'Export Northwind orders', [{ kind: 'early-return', test: '!open', negated: true, ids: ['open'], component: 'ExportPanel', file: 'apps/shop/src/Panel.jsx' }]),
    ev('E-row', 'src/InvoiceRow.tsx', 'InvoiceRow', 'Open'),
    ev('E-badge', 'src/Badge.jsx', 'Badge', 'new of 0'),
    // Its line has moved since the scan: nothing to draw, and it says so.
    ev('E-gone', 'src/Badge.jsx', 'Badge', 'Gone', [], { line: 40, col: 3 }),
  ];
  const app = await startApp(tagPlan(detectApp({ name: 'shop', dir } as any, { apps: {} } as any) as any, { root, dir }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-mount-ctx-shots-'));
  const logs: string[] = [];
  try {
    const { captureSession } = await import('../src/shots.js');
    const pw = await import('playwright');
    const r: any = await captureSession(pw, { url: app.url, routes: [''], crawl: false, examples, dir: out, maxPages: 3, waitMs: 300, log: (m: string) => logs.push(m), reveal: false, maxMinutes: 1, draw: { root, dir, mount: true } });
    const all = logs.join('\n');
    // The live app's providers: the store and the dark theme from the entry file, read off the page.
    assert.deepEqual([r.shots['E-panel']?.drawn, r.shots['E-panel']?.exact], ['mount', true], all);
    assert.match(all, /E-panel \(apps\/shop\/src\/Panel\.jsx:7\) drawn from the app's code \(its component, in the app's build, with 2 of its providers\)/);
    // Typed props filled in from its types; untyped ones from a call site's literals.
    assert.deepEqual([r.shots['E-row']?.drawn, r.shots['E-row']?.exact], ['mount', true], all);
    assert.deepEqual([r.shots['E-badge']?.drawn, r.shots['E-badge']?.exact], ['mount', true], all);
    for (const id of ['E-panel', 'E-row', 'E-badge']) assert.ok(!r.shots[id].blank, `${id} drawn with the app's styles`);
    // What the mount drew is the real component with those values.
    assert.match(String(r.shots['E-panel'].content?.text ?? ''), /Export Northwind orders/, JSON.stringify(r.shots['E-panel'].content));
    // Every element has a line, the one not drawn included, with its reason.
    for (const id of ['E-panel', 'E-row', 'E-badge', 'E-gone']) assert.ok(logs.some(l => l.startsWith(`  ${id} (`)), `${id} has a line\n${all}`);
    assert.equal(r.shots['E-gone'], undefined);
    assert.match(all, /E-gone \(apps\/shop\/src\/Badge\.jsx:40\) not drawn: no element at 40:3 in its file as it is now; not mounted: Badge mounted with 2 of the app's providers, but the element wasn't in what it drew/);
    assert.ok(r.tried['E-gone']?.some((t: string) => /not drawn: no element/.test(t)), JSON.stringify(r.tried));
    assert.match(all, /drawings: 3 drawn from the app's code; 1 not drawn \(no element at its line in its file as it is now\)$/m);
  } finally { app.stop(); }
});

// A deep page adds a context the app's entry doesn't (an open panel's "hidden" flag): borrowed into a drawing,
// it hides the element. The app's own providers are tried first; every context on the page only if that fails.
const DEEP: Record<string, string> = {
  'index.html': FILES['index.html']!,
  'public/app.css': FILES['public/app.css']!,
  'vite.config.js': FILES['vite.config.js']!,
  'src/hide.js': `import { createContext } from 'react';\nexport const HideCtx = createContext(false);\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { useEffect, useState } from 'react';\nimport { HideCtx } from './hide.js';\nfunction App() {\n  const [h, setH] = useState(location.hash);\n  useEffect(() => { const f = () => setH(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);\n  const deep = h === '#/deep';\n  return <main className="app">\n    {deep ? <HideCtx.Provider value={true}><section><h1>Deep</h1></section></HideCtx.Provider> : <p>Home</p>}\n  </main>;\n}\ncreateRoot(document.getElementById('root')).render(<App />);\n`,
  'src/Tile.jsx': `import { useContext } from 'react';\nimport { HideCtx } from './hide.js';\nexport function Tile() {\n  const hidden = useContext(HideCtx);\n  if (hidden) return null;\n  return <button className="btn">Tile action</button>;\n}\n`,
};

test("a drawing on a deep page gets the app's own providers first, not a context that hides it", { timeout: 180_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-mount-deep-')));
  const dir = path.join(root, 'apps', 'deep');
  for (const [f, c] of Object.entries(DEEP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(root, 'dsa.config.json'), '{}');
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'deep', private: true, type: 'module', scripts: { dev: 'vite' } }));
  const lines = DEEP['src/Tile.jsx']!.split('\n');
  const l = lines.findIndex(x => x.includes('<button'));
  const examples = [{ id: 'E-tile', target: 'deep', file: 'apps/deep/src/Tile.jsx', line: l + 1, col: lines[l]!.indexOf('<button') + 1, element: 'button', within: 'Tile', match: { tag: 'button', classes: ['btn'], text: 'Tile action' }, classTokens: ['btn'], reach: { status: 'gated', gates: [], steps: [], why: '' } }] as any;
  const app = await startApp(tagPlan(detectApp({ name: 'deep', dir } as any, { apps: {} } as any) as any, { root, dir }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-mount-deep-shots-'));
  const logs: string[] = [];
  try {
    const { captureSession } = await import('../src/shots.js');
    const pw = await import('playwright');
    // The scan says the deep page renders it, so it's drawn there.
    const r: any = await captureSession(pw, { url: app.url, routes: ['', '#/deep'], crawl: false, examples, dir: out, maxPages: 3, waitMs: 300, log: (m: string) => logs.push(m), reveal: false, maxMinutes: 1, draw: { root, dir, mount: true }, reach: { byId: { 'E-tile': ['/deep'] }, near: {}, patterns: [] } });
    const all = logs.join('\n');
    assert.deepEqual([r.shots['E-tile']?.drawn, r.shots['E-tile']?.exact], ['mount', true], all);
  } finally { app.stop(); }
});
