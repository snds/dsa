import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// An app whose "/" sends itself elsewhere as it loads (here, location.replace to /start): the navigation that
// brought the crawler there is aborted, but the app loaded. Its home still counts as a page, and drawings go
// to where it landed, not back to "/", where every one would fail.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><script>if (location.pathname === "/") location.replace("/start" + location.hash);</script><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { Inbox } from './Inbox.jsx';\ncreateRoot(document.getElementById('root')).render(<Inbox />);\n`,
  'src/Inbox.jsx': `import { useEffect, useState } from 'react';\nexport function Inbox() {\n  const [msg, setMsg] = useState(null);\n  useEffect(() => { window.__socket?.on('msg', setMsg); }, []);\n  return <main><h1>Inbox</h1>\n    {msg && <div>\n      <button className="btn">Reply</button>\n    </div>}</main>;\n}\n`,
};

test('a home that redirects as it loads: pages still count, and drawings go where it landed', { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'inbox');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'inbox', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const target = evals.find(e => e.file.endsWith('Inbox.jsx') && e.match.text === 'Reply');
  assert.ok(target);
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  // Looking around off, so it's left to the drawing.
  config.shots = { ...(config.shots ?? {}), maxMinutes: 1, waitMs: 200, reveal: false };
  await takeShots({ root, dataDir: data, config, target: 'inbox', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const all = logs.join('\n');
  assert.doesNotMatch(all, /the page failed while drawing|skip http/, all);
  assert.equal(idx.shots[target!.id]?.drawn, 'mount', all);
  assert.match(idx.shots[target!.id].page, /\/start/);
});
