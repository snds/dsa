import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// The ledger records only what renders, so an element behind a condition the crawler never meets has no
// record of its own. Its component's does: Shelf rendered its heading with the props the app passed it.
// The drawing mounts Shelf with those props and forces the element's condition (items.length > 0: one
// item), and says so. A Vite + React app with source tags.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { Library } from './Library.jsx';\ncreateRoot(document.getElementById('root')).render(<Library />);\n`,
  'src/Shelf.jsx': `import { useState } from 'react';\nexport function Shelf({ title, items }) {\n  const [picked, setPicked] = useState([]);\n  const [tip, setTip] = useState(false);\n  return <section><h2>{title}</h2>\n    {items.length > 0 && <button className="btn">Open {items.length} in {title}</button>}\n    {picked.length > 0 && <button className="btn">Clear {picked[0].name}</button>}\n    {tip && <button className="btn">Hide tip</button>}\n  </section>;\n}\n`,
  // A tray drawn in a portal, as a dialog's content is: its state is set where the portal put it.
  'src/Tray.jsx': `import { useState } from 'react';\nimport { createPortal } from 'react-dom';\nexport function Tray({ label }) {\n  const [open, setOpen] = useState(false);\n  return createPortal(<aside><span>{label}</span>{open && <button className="btn">Close tray</button>}</aside>, document.body);\n}\n`,
  'src/Library.jsx': `import { Shelf } from './Shelf.jsx';\nimport { Tray } from './Tray.jsx';\nexport function Library() {\n  return <main><h1>Library</h1><Shelf title="Ferns" items={[]} /><Tray label="Tools" /></main>;\n}\n`,
};

test('the ledger: an element its component rendered without is drawn with the component\'s recorded props, its condition forced', { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'library');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'library', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const target = evals.find(e => e.file.endsWith('Shelf.jsx') && /Open/.test(e.match.text ?? ''));
  assert.ok(target, evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));

  // One run: the crawler's own visit records Shelf's heading (and Shelf's props); the button never renders.
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200, reveal: false };
  await takeShots({ root, dataDir: data, config, target: 'library', perGroup: 20, log: m => logs.push(m) });
  const all = logs.join('\n');
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));

  assert.match(all, /ledger coverage: of \d+ not reached live, 0 recorded themselves, [1-9]\d* whose component is recorded/);
  assert.ok(idx.ledgerCoverage?.library?.component >= 1, JSON.stringify(idx.ledgerCoverage));
  const shot = idx.shots[target!.id];
  assert.deepEqual([shot?.drawn, shot?.exact, shot?.source], ['mount', true, 'isolated'], all);
  assert.ok(shot.forced?.some((f: string) => f.startsWith('items = [')), JSON.stringify(shot.forced));
  // Shelf's recorded title, with the one item forced in.
  assert.match(String(shot.content?.text ?? ''), /Open 1 in Ferns/);
  assert.match(all, /an isolated render \(recorded props, condition forced: items = \[/);

  // State inside the drawing, the drawing's own: a list one item, a flag true; and inside its portal.
  const by = (text: RegExp) => evals.find(e => e.file.endsWith('.jsx') && text.test(e.match.text ?? ''));
  for (const [re, set] of [[/Clear/, /setting picked = \[/], [/Hide tip/, /setting tip = true/], [/Close tray/, /setting open = true/]] as const) {
    const e = by(re);
    assert.ok(e, String(re));
    const sh = idx.shots[e!.id];
    assert.deepEqual([sh?.drawn, sh?.exact, sh?.source], ['mount', true, 'isolated'], `${re}\n${all}`);
    assert.match(all, new RegExp(`${e!.id} .*after ${set.source}`));
  }
});
