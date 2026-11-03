import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// Reach without config: the crawler opens the routes whose component renders each missing element, finds
// values for routes like /orders/:id in the links it sees, clicks the control the source says opens a state
// (found by its source tag), and picks form options that reveal fields. What it still can't reach is said
// with a reason. A real Vite + React app with a hand-rolled route table, started by dsa with source tags.
// Skipped without a headless browser (`dsa setup`) or without Vite installed.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; } .field { border: 1px solid #888; padding: 6px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { routes } from './routes.jsx';\nimport './admin/index.jsx';\nconst match = (p) => routes.find(r => new RegExp('^' + r.path.replace(/:[^/]+/g, '[^/]+') + '$').test(p));\nconst R = match(location.pathname) ?? routes[0];\ncreateRoot(document.getElementById('root')).render(<R.Component />);\n`,
  'src/routes.jsx': `import { Home } from './Home.jsx';\nimport { Order } from './orders/Order.jsx';\nexport const routes = [\n  { path: '/', Component: Home },\n  { path: '/orders/:id', Component: Order },\n];\n`,
  // Orders open from a row click: no link to follow.
  'src/Home.jsx': `export function Home() {\n  return <main><h1>Orders</h1><table><tbody>{['1042', '1043'].map(n => <tr key={n} onClick={() => location.assign('/orders/' + n)}><td>Order {n}</td></tr>)}</tbody></table></main>;\n}\n`,
  // Only on an order's page, and only once "Edit" is clicked, or "Card" chosen.
  'src/orders/Order.jsx': `import { useState } from 'react';\nexport function Order() {\n  const [editing, setEditing] = useState(false);\n  const [pay, setPay] = useState('invoice');\n  const [notes, setNotes] = useState(false);\n  return (\n    <section>\n      <button className="btn" onClick={() => setNotes(!notes)}>Edit</button>\n      <button className="btn" onClick={() => setEditing(true)}>Edit</button>\n      {editing && <button className="btn">Keep draft</button>}\n      <select aria-label="Payment" value={pay} onChange={e => setPay(e.target.value)}><option value="invoice">Invoice</option><option value="card">Card</option></select>\n      {pay === 'card' && <input className="field" aria-label="Card number" />}\n    </section>\n  );\n}\n`,
  // Imported, but no route renders it.
  'src/admin/index.jsx': `import { Panel } from './Panel.jsx';\nexport const admin = { Panel };\n`,
  'src/admin/Panel.jsx': `export function Panel() {\n  return <div><button className="btn">Rebuild index</button></div>;\n}\n`,
};

test('every element reached without routes or flows written down, and the rest said why', { timeout: 240_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'orders');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'orders', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const mine = evals.filter(e => e.file.startsWith('apps/orders/src/'));
  const id = (text: string) => mine.find(e => e.match.text === text || e.match.ariaLabel === text)?.id;
  assert.ok(id('Keep draft') && id('Card number') && id('Rebuild index'), mine.map(e => `${e.file}:${e.line} ${e.match.text || e.match.ariaLabel}`).join('\n'));
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 300 };
  const r = await takeShots({ root, dataDir: data, config, target: 'orders', perGroup: 10, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const live = (t: string) => idx.shots[id(t)!] && !idx.shots[id(t)!].drawn;
  // /orders/:id: a value from Home's links. "Edit" clicked (found by its line). "Card" chosen.
  assert.ok(live('Edit'), logs.join('\n'));
  assert.ok(live('Keep draft'), `the state a traced control sets\n${logs.join('\n')}`);
  assert.ok(live('Card number'), `a form option that reveals a field\n${logs.join('\n')}`);
  assert.match(idx.shots[id('Edit')!].page, /\/orders\/104[23]$/);
  // No route renders the admin panel: said so, and drawn from the code instead.
  assert.equal(idx.misses[id('Rebuild index')!]?.why, 'no route reaches its file', JSON.stringify(idx.misses));
  assert.equal(idx.shots[id('Rebuild index')!]?.drawn, 'mount');
  const app = r.apps.find(a => a.target === 'orders')!;
  assert.ok(app.reach && app.reach.live >= 3 && app.reach.mounted >= 1 && app.reach.why['no route reaches its file'] === 1, JSON.stringify(app.reach));
  assert.ok(logs.some(l => /orders: \d+ reached live, \d+ drawn from the app's code/.test(l)), logs.join('\n'));
});
