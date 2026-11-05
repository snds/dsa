import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { detectApp, startApp, tagPlan } from '../src/apps.js';
import { takeShots } from '../src/shots.js';

// The evidence ledger. A person clicks through the app's dev server, started with DSA_LEDGER set, and opens
// a modal only a message from a socket opens, so no control the crawler can find does. The tagger's runtime
// records the modal's button as it renders: its URL, the state above it, its owner's props. A later crawl
// goes back there and sets that state (reached live), and, with looking around off, draws the modal with the
// props the app really passed it (an isolated render). A Vite + React app with source tags.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { Library } from './Library.jsx';\ncreateRoot(document.getElementById('root')).render(<Library />);\n`,
  // The modal's prop has a shape nothing in the source spells out (meta.tags), and only a socket opens it.
  'src/ImageModal.jsx': `export function ImageModal({ image }) {\n  return <div role="dialog"><h2>{image.name}</h2>\n    <p>{image.meta.tags.join(', ')}</p>\n    <button className="btn">Apply crop</button>\n  </div>;\n}\n`,
  'src/Library.jsx': `import { useEffect, useState } from 'react';\nimport { ImageModal } from './ImageModal.jsx';\nexport function Library() {\n  const [editing, setEditing] = useState(null);\n  useEffect(() => { window.__socket = { open: (img) => setEditing(img) }; }, []);\n  return <main><h1>Library</h1>\n    {editing ? <ImageModal image={editing} /> : null}</main>;\n}\n`,
};

test('the ledger: an element a person saw render is reached again by its recorded state, and drawn with its recorded props', { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'library');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'library', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const target = evals.find(e => e.file.endsWith('ImageModal.jsx') && e.match.text === 'Apply crop');
  assert.ok(target, evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));

  // A person, on a dev server that records (DSA_LEDGER): opens the app, and a socket message opens the modal.
  const lines = path.join(root, 'ledger-lines.jsonl');
  process.env.DSA_LEDGER = lines;
  const app = await startApp(tagPlan(detectApp({ name: 'library', dir } as any, { apps: {} } as any) as any, { root, dir }));
  delete process.env.DSA_LEDGER;
  try {
    const page = await browser!.newPage();
    await page.goto(app.url);
    await page.waitForSelector('h1');
    await page.evaluate(`window.__socket.open({ id: 'img-7', name: 'Coastline', meta: { tags: ['sea', 'dusk'] } })`);
    await page.waitForSelector('[role=dialog]');
    await page.waitForTimeout(800);
    await page.close();
  } finally { app.stop(); }
  const recs = fs.readFileSync(lines, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const mine = recs.find((r: any) => r.src.startsWith(`${target!.file}:${target!.line}:`));
  assert.ok(mine, recs.map((r: any) => r.src).join('\n'));
  assert.equal(mine.owner.name, 'ImageModal');
  assert.deepEqual(mine.owner.props, { image: { id: 'img-7', name: 'Coastline', meta: { tags: ['sea', 'dusk'] } } });
  assert.deepEqual(mine.ancestors.map((a: any) => a.name), ['Library', 'ImageModal']);

  const run = async (reveal: boolean) => {
    const logs: string[] = [];
    const dataN = `${data}-${reveal ? 'live' : 'drawn'}`;
    fs.cpSync(data, dataN, { recursive: true });
    const config = loadConfig(root).config as any;
    config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200, reveal, ledger: path.relative(root, lines) };
    await takeShots({ root, dataDir: dataN, config, target: 'library', perGroup: 20, log: m => logs.push(m) });
    return { idx: JSON.parse(fs.readFileSync(path.join(dataN, 'shots', 'index.json'), 'utf8')), all: logs.join('\n') };
  };

  // Looking around on: opened where it rendered, Library's recorded state set back, photographed live.
  const live = await run(true);
  assert.match(live.all, /ledger: \d+ records? added from ledger-lines\.jsonl/);
  assert.ok(live.idx.shots[target!.id] && !live.idx.shots[target!.id].drawn, live.all);
  assert.match(live.all, /after setting the state the ledger recorded in Library/);

  // Off: drawn from the app's code with the props the app passed it, labelled an isolated render.
  const drawn = await run(false);
  const shot = drawn.idx.shots[target!.id];
  assert.deepEqual([shot?.drawn, shot?.exact, shot?.source], ['mount', true, 'isolated'], drawn.all);
  assert.match(String(shot.content?.text ?? ''), /Apply crop/);
  assert.match(drawn.all, /drawn from the app's code with the props the app passed it \(recorded\): an isolated render/);
});
