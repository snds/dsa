import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// Two pages, each with its own "Edit Image" button that the scan can't trace (a toggle from a custom hook).
// The first page's opens something else (and the page mentions the element's words, so it's explored first); the second's reveals the element. Exploring tries the second one
// too: the same words on another page are another control when its source line differs.
// A real Vite + React app, started by dsa with source tags. Skipped without a headless browser or Vite.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { routes } from './routes.jsx';\nconst R = routes.find(r => r.path === location.pathname) ?? routes[0];\ncreateRoot(document.getElementById('root')).render(<R.Component />);\n`,
  'src/routes.jsx': `import { Gallery } from './Gallery.jsx';\nimport { Samples } from './Samples.jsx';\nexport const routes = [\n  { path: '/gallery', Component: Gallery },\n  { path: '/samples', Component: Samples },\n];\n`,
  'src/toggle.js': `import { useReducer } from 'react';\nexport const useToggle = () => useReducer(v => !v, false);\n`,
  'src/Gallery.jsx': `import { useToggle } from './toggle.js';\nexport function Gallery() {\n  const [on, flip] = useToggle();\n  return <section><h1>Gallery</h1><p>Samples: rotate left, rotate right, edit samples</p><button className="btn" onClick={flip}>Edit Image</button>\n    {on && <p>Pick a photo first</p>}</section>;\n}\n`,
  'src/Samples.jsx': `import { useToggle } from './toggle.js';\nexport function Samples() {\n  const [on, flip] = useToggle();\n  return <section><h1>Samples</h1><button className="btn" onClick={flip}>Edit Image</button>\n    {on && <div role="dialog">\n      <button className="btn">Rotate left</button>\n    </div>}</section>;\n}\n`,
};

test('the same words on another page are another control: "Edit Image" is tried on both pages', { timeout: 300_000 }, async ({ skip }) => {
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
  const target = evals.find(e => e.file.endsWith('Samples.jsx') && e.match.text === 'Rotate left');
  assert.ok(target, evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200 };
  config.apps = { ...(config.apps ?? {}), studio: { routes: ['/gallery', '/samples'] } };
  await takeShots({ root, dataDir: data, config, target: 'studio', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  assert.ok(idx.shots[target!.id] && !idx.shots[target!.id].drawn, logs.join('\n'));
  assert.match(idx.shots[target!.id].page, /\/samples$/);
});
