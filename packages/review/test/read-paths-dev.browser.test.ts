import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from '@snds/dsa';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// An app dsa starts itself, with a live entry that has only settings (readPaths): those settings apply to
// the started app, which isn't skipped as a live surface without a url. Its button shows only once a read of
// /api/setup/status comes back, which the network guard lets through because readPaths names it.
// A real Vite + React app. Skipped without a headless browser or Vite.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite', plugins: [{ name: 'api', configureServer(s) { s.middlewares.use('/api/setup/status', (q, r) => { r.setHeader('content-type', 'application/json'); r.end('{"done":true}'); }); } }] };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { Home } from './Home.jsx';\ncreateRoot(document.getElementById('root')).render(<Home />);\n`,
  'src/Home.jsx': `import { useEffect, useState } from 'react';\nexport function Home() {\n  const [done, setDone] = useState(null);\n  useEffect(() => { fetch('/api/setup/status').then(r => r.json()).then(j => setDone(j.done)).catch(() => setDone(false)); }, []);\n  return <main><h1>Workspace</h1>{done === null ? <p>Loading</p> : done ? <p>Ready</p> : <p>Finish setting up</p>}\n    {done && <button className="btn">Open board</button>}</main>;\n}\n`,
};

test('a live entry with only readPaths adds them to the app dsa starts, not a live surface needing a url', { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'boards');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'boards', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const target = evals.find(e => e.file.endsWith('Home.jsx') && e.match.text === 'Open board');
  assert.ok(target, evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));
  const logs: string[] = [];
  const config = { ...loadConfig(root).config, live: parseConfig({ live: { apps: { boards: { readPaths: ['/api/setup/**'] } } } }).live } as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 1, waitMs: 200 };
  const r = await takeShots({ root, dataDir: data, config, target: 'boards', perGroup: 20, log: m => logs.push(m) });
  const all = logs.join('\n');
  assert.ok(!r.apps.find(a => a.target === 'boards')?.skipped, all);
  assert.match(all, /reads allowed besides its pages: \/api\/setup\/\*\*/);
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  assert.ok(idx.shots[target!.id] && !idx.shots[target!.id].drawn, all);
});
