import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { stateOrder } from '../src/drawn.js';
import { takeShots } from '../src/shots.js';

// Elements behind a component's own state that no control the scan can trace sets (here, only a message
// from a socket would): the crawler sets that state through React on the live page, photographs what
// shows, and reloads. A real Vite + React app, started by dsa with source tags. Skipped without a headless
// browser or Vite.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const COLOURS = `import { useEffect, useMemo, useState } from 'react';\nexport function Colours() {\n  const [openColour, setOpenColour] = useState(null);\n  const names = useMemo(() => ['Teal', 'Rust'], []);\n  const [mode, setMode] = useState('list');\n  useEffect(() => { window.__socket?.on('open', (c) => setOpenColour(c)); window.__socket?.on('mode', setMode); }, []);\n  return <section><h1>Colours</h1><ul>{names.map(n => <li key={n}>{n}</li>)}</ul>\n    {mode === 'grid' && <div>\n      <button className="btn">Grid tile</button>\n    </div>}\n    {openColour && <div role="dialog">\n      <button className="btn">Rename {openColour.name.trim()}</button>\n    </div>}</section>;\n}\n`;

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { routes } from './routes.jsx';\nconst R = routes.find(r => r.path === location.pathname) ?? routes[0];\ncreateRoot(document.getElementById('root')).render(<R.Component />);\n`,
  'src/routes.jsx': `import { Colours } from './Colours.jsx';\nexport const routes = [\n  { path: '/colours', Component: Colours },\n];\n`,
  'src/Colours.jsx': COLOURS,
};

test("the order of a component's state hooks, as React keeps them", () => {
  assert.deepEqual(stateOrder(COLOURS, 'Colours'), ['openColour', 'mode']);
  // A custom hook's own hooks can't be counted: the order stops there.
  assert.deepEqual(stateOrder(`export function A() { const [a] = useState(0); const x = useThing(); const [b] = useState(1); return null; }`, 'A'), ['a']);
});

test("elements behind a component's own state are shown live by setting it", { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'swatches');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'swatches', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const id = (t: string) => evals.find(e => e.file.endsWith('Colours.jsx') && (e.match.text ?? '').startsWith(t))?.id;
  assert.ok(id('Grid tile') && id('Rename'), evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200 };
  await takeShots({ root, dataDir: data, config, target: 'swatches', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const all = logs.join('\n');
  for (const t of ['Grid tile', 'Rename']) assert.ok(idx.shots[id(t)!] && !idx.shots[id(t)!].drawn, `${t} live\n${all}`);
  assert.match(all, /on \/colours after setting mode = "grid"/);
  assert.match(all, /on \/colours after setting openColour = \{"name":""\}/);
  assert.match(all, /state on \/colours: .*found 1/);
});
