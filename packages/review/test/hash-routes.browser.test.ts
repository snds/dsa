import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// A hash-routed app (#/colours, #/style/:id/samples): every page the crawler opens, replays an opener on,
// resets after a replay, or explores is the hash route, not the app's home page. A traced opener ("Add
// colour") and one only exploring can find ("Edit image", a toggle from a custom hook) both reveal their
// elements live. A real Vite + React app with a hand-rolled hash router, started by dsa with source tags.
// Skipped without a headless browser (`dsa setup`) or without Vite installed.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { App } from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n`,
  'src/routes.jsx': `import { Home } from './Home.jsx';\nimport { Colours } from './Colours.jsx';\nimport { Samples } from './Samples.jsx';\nexport const routes = [\n  { path: '/', Component: Home },\n  { path: '/colours', Component: Colours },\n  { path: '/style/:id/samples', Component: Samples },\n];\n`,
  'src/App.jsx': `import { useEffect, useState } from 'react';\nimport { routes } from './routes.jsx';\nconst at = () => location.hash.replace(/^#/, '') || '/';\nconst match = (p) => routes.find(r => new RegExp('^' + r.path.replace(/:[^/]+/g, '[^/]+') + '$').test(p)) ?? routes[0];\nexport function App() {\n  const [p, setP] = useState(at());\n  useEffect(() => { const on = () => setP(at()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);\n  const R = match(p);\n  return <R.Component />;\n}\n`,
  'src/Home.jsx': `export function Home() {\n  return <main><h1>Studio</h1><a href="#/colours">Colours</a> <a href="#/style/s1/samples">Style s1 samples</a></main>;\n}\n`,
  'src/Colours.jsx': `import { useState } from 'react';\nexport function Colours() {\n  const [adding, setAdding] = useState(false);\n  return <section><h1>Colours</h1><button className="btn" onClick={() => setAdding(true)}>Add colour</button>\n    {adding && <form>\n      <button type="button" className="btn">Pick swatch</button>\n    </form>}</section>;\n}\n`,
  'src/toggle.js': `import { useReducer } from 'react';\nexport const useToggle = () => useReducer(v => !v, false);\n`,
  'src/Samples.jsx': `import { useToggle } from './toggle.js';\nexport function Samples() {\n  const [on, flip] = useToggle();\n  return <section><h1>Samples</h1><button className="btn" aria-haspopup="dialog" onClick={flip}>Edit image</button>\n    {on && <div role="dialog">\n      <button className="btn">Rotate left</button>\n    </div>}</section>;\n}\n`,
};

test('a hash-routed app: openers replayed and pages explored on their own hash routes', { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'studio');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'studio', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const id = (text: string) => evals.find(e => e.file.startsWith('apps/studio/src/') && e.match.text === text)?.id;
  assert.ok(id('Pick swatch') && id('Rotate left'), evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200 };
  await takeShots({ root, dataDir: data, config, target: 'studio', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const all = logs.join('\n');
  for (const t of ['Pick swatch', 'Rotate left']) assert.ok(idx.shots[id(t)!] && !idx.shots[id(t)!].drawn, `${t} live\n${all}`);
  assert.match(idx.shots[id('Pick swatch')!].page, /#\/colours$/);
  assert.match(idx.shots[id('Rotate left')!].page, /#\/style\/s1\/samples$/);
  // Each page's line names its hash route.
  assert.ok(!/(openers|explored) on \/(colours|style)/.test(all), all);
});
