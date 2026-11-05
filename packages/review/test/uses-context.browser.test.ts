import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// For a person reviewing a proposal: a wider photo of the page around each element (its context), and photos
// of places the app already uses the design system's components (examples to compare with). The app uses the
// system's Button, which passes its props on, so the tagger's use mark reaches the page.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn, .ds-button { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `import { fileURLToPath } from 'node:url';\nexport default { cacheDir: '../../.vite', resolve: { alias: { '@acme/ds-react': fileURLToPath(new URL('../../packages/ds-react/src/Button.tsx', import.meta.url)) } } };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { App } from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n`,
  'src/App.jsx': `import { Button } from '@acme/ds-react';\nexport function App() {\n  return <main><h1>Orders</h1>\n    <Button>Export orders</Button>\n    <button className="btn">Archive orders</button>\n  </main>;\n}\n`,
};

test('each live photo has its page context, and the app\'s own uses of system components are photographed', { timeout: 300_000 }, async ({ skip }) => {
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
  const target = evals.find(e => e.file.endsWith('App.jsx') && e.match.text === 'Archive orders');
  assert.ok(target, evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 1, waitMs: 200, draw: false };
  await takeShots({ root, dataDir: data, config, target: 'orders', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const all = logs.join('\n');
  const shot = idx.shots[target!.id];
  assert.ok(shot && !shot.drawn, all);
  // Its context: a wider photo, with where the element sits in it.
  assert.ok(shot.context && fs.existsSync(path.join(data, 'shots', shot.context.file)), JSON.stringify(shot));
  assert.ok(shot.context.box.cw >= shot.box.cw && shot.context.box.w === shot.box.w, JSON.stringify(shot.context));
  // The app's own Button, photographed as an example, keyed by its file and line.
  const use = idx.uses?.['apps/orders/src/App.jsx:4'];
  assert.ok(use && use.component === 'Button' && fs.existsSync(path.join(data, 'shots', use.file)) && use.run === idx.run.id, `${JSON.stringify(idx.uses)}\n${all}`);
});
