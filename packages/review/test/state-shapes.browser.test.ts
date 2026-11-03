import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { detectApp, startApp } from '../src/apps.js';
import { takeShots } from '../src/shots.js';

// Elements behind a state, in the shapes real apps use, each reached live from what the scan traced:
//  (a) a useState flag set by an unlabelled control in the same component (a colour swatch);
//  (b) state held in a parent, the control in a sibling that gets the setter as a prop;
//  (c) a flag read from saved state that hides it after a first visit (a finished setup);
//  (d) a string mode set by onValueChange on a segmented control;
//  (e) a search field's text, and a URL search parameter.
// One more, behind a prop nothing sets, is drawn from the app's code. The app runs on its own Vite dev
// server with dsaTag in its own config, not on dsa's runner. Skipped without a browser or Vite.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });
const TAG = pathToFileURL(path.resolve(import.meta.dirname, '../../../dist/tag/index.js')).href;

const app = (root: string): Record<string, string> => ({
  // A first visit marks setup as done (as a returning user's saved state would).
  'index.html': `<!doctype html><link rel="stylesheet" href="/app.css"><script>if (!sessionStorage.getItem('seen')) { localStorage.setItem('setupDone', '1'); sessionStorage.setItem('seen', '1'); }</script><div id="root"></div><script type="module" src="/src/main.jsx"></script>`,
  'public/app.css': '.btn, .result { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; } .swatch, .icon { width: 28px; height: 28px; border: 1px solid #333; margin: 4px; } .seg { padding: 6px 12px; }',
  'vite.config.js': `import { dsaTag } from ${JSON.stringify(TAG)};\nexport default { cacheDir: '../../.vite', plugins: [dsaTag({ when: true, root: ${JSON.stringify(root)} })] };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { Studio } from './Studio.jsx';\ncreateRoot(document.getElementById('root')).render(<Studio />);\n`,
  'src/Studio.jsx': `import { useState } from 'react';
import { Toolbar } from './Toolbar.jsx';
import { AddPanel } from './AddPanel.jsx';
import { Segmented, Seg } from './Segmented.jsx';
import { Drawer } from './Drawer.jsx';
export function Studio() {
  const [openColour, setOpenColour] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [setupDone] = useState(() => localStorage.getItem('setupDone') === '1');
  const [viewMode, setViewMode] = useState('table');
  const [q, setQ] = useState('');
  const report = new URLSearchParams(location.search).get('report');
  return (
    <main>
      {['red', 'blue'].map(c => <button key={c} className="swatch" onClick={() => setOpenColour(c)} />)}
      {openColour && <div><button className="btn">Apply colour</button></div>}
      <Toolbar onAdd={() => setAddOpen(true)} />
      <AddPanel open={addOpen} />
      {!setupDone && <div><button className="btn">Start setup</button></div>}
      <Segmented value={viewMode} onValueChange={setViewMode}><Seg value="table">Table</Seg><Seg value="gallery">Gallery</Seg></Segmented>
      {viewMode === 'gallery' && <div><button className="btn">Open gallery item</button></div>}
      <input aria-label="Search" value={q} onChange={e => setQ(e.target.value)} />
      {q && <div><button className="result">First result</button></div>}
      {report && <div><button className="btn">Open report</button></div>}
      <Drawer open={false} />
    </main>
  );
}
`,
  'src/Toolbar.jsx': `export function Toolbar({ onAdd }) {\n  return <div><button className="icon" onClick={onAdd}><svg width="12" height="12"><path d="M6 1v10M1 6h10" stroke="#000" /></svg></button></div>;\n}\n`,
  'src/AddPanel.jsx': `export function AddPanel({ open }) {\n  if (!open) return null;\n  return <div><button className="btn">Create item</button></div>;\n}\n`,
  'src/Segmented.jsx': `import { Children, cloneElement } from 'react';\nexport function Segmented({ value, onValueChange, children }) {\n  return <div role="group">{Children.map(children, c => cloneElement(c, { on: value === c.props.value, pick: () => onValueChange(c.props.value) }))}</div>;\n}\nexport function Seg({ children, on, pick }) {\n  return <button className="seg" aria-pressed={on} onClick={pick}>{children}</button>;\n}\n`,
  // Nothing in the app opens it: only drawing from the app's code shows it.
  'src/Drawer.jsx': `export function Drawer({ open }) {\n  if (!open) return null;\n  return <aside><button className="btn">Archive later</button></aside>;\n}\n`,
});

test('state-gated elements in the shapes real apps use, reached live; the rest drawn from the app\'s code', { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react')) || !fs.existsSync(new URL(TAG))) skip('no Vite installed, or the core not built');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'studio');
  for (const [f, c] of Object.entries(app(root))) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'studio', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const mine = evals.filter(e => e.file.startsWith('apps/studio/src/'));
  const ev = (text: string) => mine.find(e => e.match.text === text)!;
  for (const t of ['Apply colour', 'Create item', 'Start setup', 'Open gallery item', 'First result', 'Open report', 'Archive later']) assert.ok(ev(t), `${t} scanned: ${mine.map(e => e.match.text).join(', ')}`);
  // The scan traces what sets each state, controls without words and controls in other components included.
  assert.match((ev('Apply colour').reach?.looked ?? []).join(' '), /setOpenColour .*clicking an unlabelled control at Studio\.jsx:\d+/);
  assert.match((ev('Create item').reach?.looked ?? []).join(' '), /setAddOpen .*Toolbar\.jsx/);
  assert.match((ev('Open gallery item').reach?.looked ?? []).join(' '), /setViewMode:gallery .*“Gallery”/);
  assert.match((ev('First result').reach?.looked ?? []).join(' '), /setQ .*typing in “Search”/);
  assert.deepEqual([ev('Start setup').reach?.storage, ev('Open report').reach?.params], [['setupDone'], ['report']]);

  // The app's own dev server (dsaTag in its config), not dsa's runner.
  const found = detectApp({ name: 'studio', dir } as any, { apps: {} } as any);
  assert.ok(!('reason' in found));
  const running = await startApp(found as any);
  const logs: string[] = [];
  try {
    const config = loadConfig(root).config as any;
    config.shots = { ...(config.shots ?? {}), maxMinutes: 3, waitMs: 300 };
    await takeShots({ root, dataDir: data, config, url: running.url, target: 'studio', perGroup: 12, log: m => logs.push(m) });
  } finally { running.stop(); }
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const shot = (t: string) => idx.shots[ev(t).id];
  for (const t of ['Apply colour', 'Create item', 'Start setup', 'Open gallery item', 'First result', 'Open report']) {
    assert.ok(shot(t) && !shot(t).drawn, `${t} reached live\n${JSON.stringify(idx.misses[ev(t).id] ?? null)}\n${logs.join('\n')}`);
  }
  // Behind a prop nothing sets: drawn from the app's code, found by its exact tag, so it counts.
  assert.deepEqual([shot('Archive later')?.drawn, shot('Archive later')?.exact], ['mount', true], logs.join('\n'));
  assert.ok(logs.some(l => /drawing \d+ not reached live: from the app's code/.test(l)), logs.join('\n'));
  // Its miss says what was looked for and tried.
  const miss = idx.misses[ev('Archive later').id];
  assert.ok(miss.tried?.some((t: string) => /no state setter|no control found/.test(t)), JSON.stringify(miss));
});
