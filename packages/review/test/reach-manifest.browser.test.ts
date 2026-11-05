import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// The reach manifest (docs/reach-manifest.md). The dev build declares window.__DSA__ with a named state only
// its own go() puts on (a dialog nothing on the page opens), and dsa.reach.json beside the app names a route
// the source never spells out and a state that's a route with storage seeded. Each is reached by lookup.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { App } from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n`,
  'src/App.jsx': `import { useEffect, useState } from 'react';\nconst PART = 'ar' + 'chive';\nexport function App() {\n  const [h, setH] = useState(location.hash);\n  const [danger, setDanger] = useState(false);\n  useEffect(() => { const f = () => setH(location.hash); addEventListener('hashchange', f);\n    window.__DSA__ = { routes: () => [], states: () => [{ name: 'danger-zone', reveals: ['src/App.jsx'] }], go: async (n) => { if (n === 'danger-zone') setDanger(true); } };\n    return () => removeEventListener('hashchange', f); }, []);\n  const step = localStorage.getItem('step');\n  return <main><h1>Home</h1>\n    {danger && <div role="dialog">\n      <button className="btn">Delete workspace</button>\n    </div>}\n    {h === '#/' + PART && <div>\n      <button className="btn">Restore all</button>\n    </div>}\n    {step === '2' && <div>\n      <button className="btn">Next step</button>\n    </div>}</main>;\n}\n`,
  'dsa.reach.json': JSON.stringify({ routes: ['#/archive'], states: [{ name: 'step two', route: '#/', storage: { step: '2' } }] }),
};

test('the reach manifest: window.__DSA__ states and dsa.reach.json routes and seeded states', { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'atlas');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'atlas', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const id = (t: string) => evals.find(e => e.file.includes('apps/atlas/') && e.match.text === t)?.id;
  for (const t of ['Delete workspace', 'Restore all', 'Next step']) assert.ok(id(t), t);
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200, reveal: true };
  await takeShots({ root, dataDir: data, config, target: 'atlas', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const all = logs.join('\n');
  for (const t of ['Delete workspace', 'Restore all', 'Next step']) assert.ok(idx.shots[id(t)!] && !idx.shots[id(t)!].drawn, `${t}\n${all}`);
  assert.match(all, /after the app's manifest state “danger-zone”/);
  assert.match(all, /manifest: 0 routes \(0 new\), 1 of 1 state put on, 1 found/);
  assert.match(all, /profile “step two” on \/: 1 found/);
});
