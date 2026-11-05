import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// Traced openers are replayed on every page that has them, however many pages came before: an app with
// more openers than one run-wide budget would allow, whose last page is the one that matters. And an
// opener matched only by its words ("Add") on one page is tried again on the next page that has it.
// A real Vite + React app with a hand-rolled route table, started by dsa with source tags. Skipped without
// a headless browser (`dsa setup`) or without Vite installed.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const N = 45;
const page = (i: number) => `import { useState } from 'react';\nexport function Page${i}() {\n  const [open, setOpen] = useState(false);\n  return <section><h1>Page ${i}</h1><button className="btn" onClick={() => setOpen(true)}>Open panel ${i}</button>{open && <button className="btn">Inside panel ${i}</button>}</section>;\n}\n`;
const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { routes } from './routes.jsx';\nconst R = routes.find(r => r.path === location.pathname) ?? routes[0];\ncreateRoot(document.getElementById('root')).render(<R.Component />);\n`,
  'src/routes.jsx': `${Array.from({ length: N }, (_, i) => `import { Page${i} } from './pages/Page${i}.jsx';`).join('\n')}\nexport const routes = [\n${Array.from({ length: N }, (_, i) => `  { path: '/p${i}', Component: Page${i} },`).join('\n')}\n];\n`,
  ...Object.fromEntries(Array.from({ length: N }, (_, i) => [`src/pages/Page${i}.jsx`, page(i)])),
};

test('every page with a traced opener gets it replayed, past any run-wide budget', { timeout: 600_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'panels');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'panels', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const inside = evals.filter(e => e.file.startsWith('apps/panels/src/') && /^Inside panel/.test(e.match.text ?? ''));
  assert.equal(inside.length, N, evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));
  assert.ok(inside.every(e => e.reach?.steps?.length), 'each has its opener traced');
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 9, waitMs: 100, maxPages: 120 };
  config.apps = { ...(config.apps ?? {}), panels: { routes: Array.from({ length: N }, (_, i) => `/p${i}`) } };
  await takeShots({ root, dataDir: data, config, target: 'panels', perGroup: 100, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const missed = inside.filter(e => !idx.shots[e.id] || idx.shots[e.id].drawn).map(e => e.match.text);
  assert.deepEqual(missed, [], logs.join('\n'));
  assert.ok(logs.some(l => /after opening “Open panel 44”/.test(l)), logs.join('\n'));
});
