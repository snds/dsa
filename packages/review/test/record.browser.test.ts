import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { recordApp } from '../src/record.js';
import { takeShots } from '../src/shots.js';

// `dsa record`: the app started from a temp copy with tags and the ledger on, for a person to click through.
// What they open (a modal only a socket message opens) is recorded under the app's own file names, nothing
// lands in the app, and the next `dsa shots` reads the records without being told where they are.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default {};\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { Library } from './Library.jsx';\ncreateRoot(document.getElementById('root')).render(<Library />);\n`,
  'src/ImageModal.jsx': `export function ImageModal({ image }) {\n  return <div role="dialog"><h2>{image.name}</h2>\n    <button className="btn">Apply crop</button>\n  </div>;\n}\n`,
  'src/Library.jsx': `import { useEffect, useState } from 'react';\nimport { ImageModal } from './ImageModal.jsx';\nexport function Library() {\n  const [editing, setEditing] = useState(null);\n  useEffect(() => { window.__socket = { open: (img) => setEditing(img) }; }, []);\n  return <main><h1>Library</h1>\n    {editing ? <ImageModal image={editing} /> : null}</main>;\n}\n`,
};

test('dsa record: a person\'s click-through is recorded from a copy of the app, and shots reads it next', { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'library');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'library', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  const nm = path.join(dir, 'node_modules');
  fs.mkdirSync(nm);
  for (const n of fs.readdirSync(kit)) fs.symlinkSync(path.join(kit, n), path.join(nm, n));
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const target = evals.find(e => e.file.endsWith('ImageModal.jsx') && e.match.text === 'Apply crop');
  assert.ok(target);
  const snapshot = () => {
    const out: Record<string, number> = {};
    const walk = (d: string) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, x.name); out[path.relative(dir, p)] = fs.lstatSync(p).mtimeMs; if (x.isDirectory() && !x.isSymbolicLink()) walk(p); } };
    walk(dir);
    return out;
  };
  const before = snapshot();

  const config = loadConfig(root).config as any;
  const rec = await recordApp({ root, dataDir: data, config, target: 'library', log: () => {} });
  try {
    const page = await browser!.newPage();
    await page.goto(rec.url);
    await page.waitForSelector('h1');
    await page.evaluate(`window.__socket.open({ id: 'img-7', name: 'Coastline' })`);
    await page.waitForSelector('[role=dialog]');
    await page.waitForTimeout(800);
    await page.close();
  } finally { rec.stop(); }
  assert.equal(rec.out, path.join(data, 'shots', 'ledger-lines.jsonl'));
  const recs = fs.readFileSync(rec.out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  // Named as the app's own file, not the copy's.
  const mine = recs.find((r: any) => r.src.startsWith(`${target!.file}:${target!.line}:`));
  assert.ok(mine, recs.map((r: any) => r.src).join('\n'));
  assert.deepEqual(mine.owner.props, { image: { id: 'img-7', name: 'Coastline' } });
  assert.deepEqual(snapshot(), before);

  // The next shots run reads the file by itself, and reaches the modal with Library's recorded state.
  const logs: string[] = [];
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200 };
  await takeShots({ root, dataDir: data, config, target: 'library', perGroup: 20, log: m => logs.push(m) });
  const all = logs.join('\n');
  assert.match(all, /ledger: \d+ records? added from .*ledger-lines\.jsonl/);
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  assert.ok(idx.shots[target!.id] && !idx.shots[target!.id].drawn, all);
  assert.deepEqual(snapshot(), before);
});
