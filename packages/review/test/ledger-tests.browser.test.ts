import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// The app's own component tests as a render tier. The app shows its Swatches panel only once picking (never,
// here); its test does,
// with colours. Run before the crawl with source tags and the ledger on, that test records the panel's button
// with the props it was given, and the button is drawn with them: an isolated render, known only from a test.
// A Vite + React app with a Vitest test (happy-dom).

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite', esbuild: { jsx: 'automatic' }, test: { environment: 'happy-dom' } };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { Library } from './Library.jsx';\ncreateRoot(document.getElementById('root')).render(<Library />);\n`,
  'src/Library.jsx': `import { useState } from 'react';\nimport { Swatches } from './Swatches.jsx';\nexport function Library() {\n  const [picking] = useState(false);\n  return <main><h1>Library</h1>{picking && <Swatches colours={[]} />}</main>;\n}\n`,
  'src/Swatches.jsx': `export function Swatches({ colours }) {\n  return <div>{colours.length > 0 && <button className="btn">Use {colours[0]}</button>}</div>;\n}\n`,
  'src/Swatches.test.jsx': `import { test, expect } from 'vitest';\nimport { act } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { Swatches } from './Swatches.jsx';\nglobalThis.IS_REACT_ACT_ENVIRONMENT = true;\ntest('shows its colours', async () => {\n  const el = document.createElement('div');\n  document.body.appendChild(el);\n  const root = createRoot(el);\n  await act(() => root.render(<Swatches colours={['#2f6f4f', '#aa3300']} />));\n  expect(el.textContent).toContain('Use #2f6f4f');\n  act(() => root.unmount());\n});\n`,
};

test("the app's own tests: what they render is recorded with its props and drawn from that", { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  const top = path.resolve(import.meta.dirname, '../../../node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  if (!fs.existsSync(path.join(top, 'vitest')) || !fs.existsSync(path.join(top, 'happy-dom'))) skip('no Vitest or happy-dom installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'library');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'library', private: true, type: 'module', scripts: { dev: 'vite', test: 'vitest run' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  // The kit's packages, and Vitest with happy-dom from the repo's own.
  const nm = path.join(dir, 'node_modules');
  fs.mkdirSync(nm);
  for (const n of fs.readdirSync(kit)) fs.symlinkSync(path.join(kit, n), path.join(nm, n));
  for (const n of ['vitest', 'happy-dom']) fs.symlinkSync(path.join(top, n), path.join(nm, n));
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const target = evals.find(e => e.file.endsWith('Swatches.jsx') && /Use/.test(e.match.text ?? ''));
  assert.ok(target, evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));

  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200, reveal: false, renderTests: { maxMinutes: 3 } };
  await takeShots({ root, dataDir: data, config, target: 'library', perGroup: 20, log: m => logs.push(m) });
  const all = logs.join('\n');
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));

  assert.match(all, /tests: the app's own tests rendered \d+ tagged elements? in \d+ files?/, all);
  // The app itself never rendered it: known only from the test.
  assert.match(all, /ledger coverage: of \d+ not reached live, [1-9]\d* recorded themselves.*; [1-9]\d* of these known only from the app's tests/, all);
  assert.ok(idx.ledgerCoverage?.library?.tests >= 1, JSON.stringify(idx.ledgerCoverage));
  const shot = idx.shots[target!.id];
  assert.deepEqual([shot?.drawn, shot?.exact, shot?.source], ['mount', true, 'isolated'], all);
  assert.match(String(shot.content?.text ?? ''), /Use #2f6f4f/);
  // The test's address is never opened as a page.
  assert.doesNotMatch(all, /opened test:/);
});
