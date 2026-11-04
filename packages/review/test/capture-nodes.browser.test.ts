import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// One line can render many nodes: when the one found first photographs blank (drawn in the page's own
// background), the photo is taken of the next one the same line drew.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; } .ghost { background: transparent; color: transparent; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nconst ITEMS = ['Hidden', 'Teal', 'Rust'];\nfunction App() {\n  return <main><h1>Swatches</h1>\n    <div>{ITEMS.map((n, i) => <button key={n} className={i === 0 ? 'btn ghost' : 'btn'}>Pick swatch</button>)}</div>\n</main>;\n}\ncreateRoot(document.getElementById('root')).render(<App />);\n`,
};

test("a node that photographs blank gives way to the next one its line drew", { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'nodes');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'nodes', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const id = (t: string) => evals.find(e => e.file.includes('apps/nodes/') && e.match.text === t)?.id;
  assert.ok(id('Pick swatch'), evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 1, waitMs: 200, draw: false };
  await takeShots({ root, dataDir: data, config, target: 'nodes', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const all = logs.join('\n');
  const pick = idx.shots[id('Pick swatch')!];
  assert.ok(pick && !pick.drawn && !pick.blank, all);
  assert.doesNotMatch(all, /captured but blank/);
});
