import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// State set by name, not by place. A hook made by a factory runs before the component's own state, and its
// own hooks can't be counted from the source, so `open` has no known place among the component's hooks. The
// tagger names each state hook by its setter as the app runs, and the crawler sets `open` by that name.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { Panel } from './Panel.jsx';\ncreateRoot(document.getElementById('root')).render(<Panel />);\n`,
  // A hook a factory makes, with two state hooks of its own the source can't count.
  'src/store.js': `import { useState } from 'react';\nexport const makeStore = (n) => function useStore() { const [a] = useState(n); const [b] = useState(n + 1); return a + b; };\n`,
  'src/Panel.jsx': `import { useEffect, useState } from 'react';\nimport { makeStore } from './store.js';\nconst useStore = makeStore(1);\nexport function Panel() {\n  const total = useStore();\n  const [open, setOpen] = useState(false);\n  useEffect(() => { window.__socket?.on('open', () => setOpen(true)); }, []);\n  return <main><h1>Views {total}</h1>\n    {open && <div>\n      <button className="btn">Save view</button>\n    </div>}</main>;\n}\n`,
};

test("state past a hook that can't be counted is set by the name the tagger gave its setter", { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'views');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'views', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const target = evals.find(e => e.file.endsWith('Panel.jsx') && e.match.text === 'Save view');
  assert.ok(target, evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200 };
  await takeShots({ root, dataDir: data, config, target: 'views', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const all = logs.join('\n');
  assert.ok(idx.shots[target!.id] && !idx.shots[target!.id].drawn, `${JSON.stringify(target!.reach?.gates)}\n${all}`);
  assert.match(all, /after setting open = true/);
});
