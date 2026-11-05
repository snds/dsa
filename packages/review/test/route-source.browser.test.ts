import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// Routes the source never spells out: built by the app's own route function from its registries, written by
// the app itself (replaceState), or a view a stored flag picks. The app's route list (apps.routeSource), the
// URLs it writes, and a profile (a route opened with storage seeded) reach each. A Vite + React app, hash routed.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  // Kinds and tabs as data; the route is put together from them, so no '#/…' literal names a detail tab.
  'src/routes.js': `const KINDS = ['print', 'swatch'];\nconst TABS = ['summary', 'history'];\nexport const SEP = '/';\nexport function allRoutes() { return KINDS.flatMap(k => TABS.map(t => '#' + SEP + k + SEP + '1' + SEP + t)); }\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { useEffect, useState } from 'react';\nimport { Detail } from './Detail.jsx';\nimport { Settings } from './Settings.jsx';\nimport { Wizard } from './Wizard.jsx';\nfunction App() {\n  const [h, setH] = useState(location.hash);\n  useEffect(() => { const f = () => setH(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);\n  const parts = h.replace(/^#\\//, '').split('/');\n  if (parts[0] === 'settings') return <Settings sub={parts[1]} />;\n  if (parts[0] === 'wizard') return <Wizard />;\n  if (parts.length === 3) return <Detail kind={parts[0]} tab={parts[2]} />;\n  return <main><h1>Home</h1><a href="#/settings">Settings</a> <a href="#/wizard">Wizard</a></main>;\n}\ncreateRoot(document.getElementById('root')).render(<App />);\n`,
  'src/Detail.jsx': `export function Detail({ kind, tab }) {\n  return <section><h1>{kind}</h1>\n    {tab === 'history' && <div>\n      <button className="btn">Restore version</button>\n    </div>}</section>;\n}\n`,
  // The app writes the URL of its advanced page itself; loaded fresh there, it shows more.
  'src/Settings.jsx': `import { useEffect } from 'react';\nconst MORE = 'advanced';\nexport function Settings({ sub }) {\n  useEffect(() => { if (!sub) history.replaceState(null, '', location.hash + '/' + MORE); }, [sub]);\n  return <section><h1>Settings</h1>\n    {sub === MORE && <div>\n      <button className="btn">Reset workspace</button>\n    </div>}</section>;\n}\n`,
  'src/Wizard.jsx': `export function Wizard() {\n  const step = localStorage.getItem('wizardStep');\n  return <section><h1>Wizard</h1>\n    {step === '3' && <div>\n      <button className="btn">Finish setup</button>\n    </div>}</section>;\n}\n`,
};

test("routes from the app's own route function, URLs it writes, and a profile with storage seeded", { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'vault');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'vault', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const id = (t: string) => evals.find(e => e.file.includes('apps/vault/') && e.match.text === t)?.id;
  for (const t of ['Restore version', 'Reset workspace', 'Finish setup']) assert.ok(id(t), `${t}\n${evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n')}`);
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200, reveal: false };
  config.apps = { vault: { routeSource: { module: 'src/routes.js', export: 'allRoutes' }, profiles: [{ name: 'wizard step 3', route: '#/wizard', storage: { wizardStep: '3' } }] } };
  await takeShots({ root, dataDir: data, config, target: 'vault', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const all = logs.join('\n');
  for (const t of ['Restore version', 'Reset workspace', 'Finish setup']) assert.ok(idx.shots[id(t)!] && !idx.shots[id(t)!].drawn, `${t} live\n${all}`);
  assert.match(all, /4 routes from src\/routes\.js \(allRoutes\)/);
  assert.match(all, /on \/#\/print\/1\/history/);
  assert.match(all, /on \/#\/settings\/advanced/);
  assert.match(all, /profile “wizard step 3” on \/wizard: 1 found/);
});

test('an apps key that names no app stops the run', { timeout: 60_000 }, async () => {
  const root = fixtureCopy();
  const config = loadConfig(root).config as any;
  config.apps = { 'no-such-app': { screenshots: false } };
  await assert.rejects(takeShots({ root, dataDir: path.join(root, '.dsa'), config, log: () => {} }), /apps "no-such-app" in the config names no app here/);
});
