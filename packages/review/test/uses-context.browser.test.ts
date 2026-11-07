import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshShots, latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots, usesPlaceWorth } from '../src/shots.js';

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

test("uses through a local re-export are photographed, a hidden one says so, and a second run retakes nothing", { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'orders');
  const files = { ...APP,
    'src/ui/button.jsx': `export * from '@acme/ds-react';\n`,
    'src/App.jsx': `import { Button } from './ui/button.jsx';\nexport function App() {\n  return <main><h1>Orders</h1>\n    <Button>Export orders</Button>\n    <div style={{ display: 'none' }}>\n      <Button>Hidden orders</Button>\n    </div>\n    <button className="btn">Archive orders</button>\n  </main>;\n}\n`,
  };
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'orders', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 1, waitMs: 200, draw: false };
  const logs: string[] = [];
  await takeShots({ root, dataDir: data, config, target: 'orders', perGroup: 20, log: m => logs.push(m) });
  const read = () => JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const idx = read();
  const seen = logs.join('\n');
  const use = idx.uses?.['apps/orders/src/App.jsx:4'];
  assert.ok(use && use.component === 'Button' && use.fileHash && fs.existsSync(path.join(data, 'shots', use.file)), `${JSON.stringify(idx.uses)}\n${seen}`);
  assert.equal(idx.useMisses?.['apps/orders/src/App.jsx:6']?.why, 'hidden', JSON.stringify(idx.useMisses));
  assert.match(seen, /the app's own uses: 1 photographed as examples .*1 hidden/);
  // Nothing has changed: the app isn't even started.
  const again: string[] = [];
  await takeShots({ root, dataDir: data, config, target: 'orders', perGroup: 20, log: m => again.push(m) });
  assert.ok(again.some(l => /not starting the app/.test(l)), again.join('\n'));
  // And the queue stays: a photo this run checked and kept counts as this run's, with its own age.
  const kept = freshShots(read());
  assert.ok(Object.keys(idx.shots).length > 0);
  assert.deepEqual(Object.keys(kept.stale).filter(id => !read().shots[id].drawn), [], 'no photo is called old');
  for (const id of Object.keys(idx.shots)) { assert.ok(kept.shots[id], `${id} still counts`); assert.equal(read().shots[id].at, idx.shots[id].at, 'its age is its own'); }
  assert.equal(read().uses['apps/orders/src/App.jsx:4'].file, use.file);
  // A changed file: looked for again.
  fs.appendFileSync(path.join(dir, 'src/App.jsx'), '// changed\n');
  const third: string[] = [];
  await takeShots({ root, dataDir: data, config, target: 'orders', perGroup: 20, log: m => third.push(m) });
  assert.match(third.join('\n'), /uses to look for/);
  assert.ok(read().uses['apps/orders/src/App.jsx:4'].at >= use.at);
});

test('a page is worth opening for the cards it can help: each look once, a look with a photo less, one not found less each time', () => {
  const want = (key: string, look: string, need: number, file = 'a.tsx') => ({ key, component: 'Button', look, file, fileHash: '', need });
  const have = (looks: Record<string, number> = {}, pages: Record<string, string[]> = {}) => ({ looks, components: {}, total: 0, pages });
  const place = (u: string, ...files: string[]) => ({ u, files: new Set(files) });
  const worth = usesPlaceWorth;
  // Many files of a look nobody asks for lose to one file with a look many cards ask for. List order, or how many files a page has, was the old rule.
  const left = [want('1', 'asked', 12, 'one.tsx'), ...['p', 'q', 'r', 's'].map(f => want(f, `other-${f}`, 0, `${f}.tsx`))];
  assert.ok(worth(place('/one', 'one.tsx'), left, have(), new Map()) > worth(place('/many', 'p.tsx', 'q.tsx', 'r.tsx', 's.tsx'), left, have(), new Map()));
  assert.ok(worth(place('/many', 'p.tsx', 'q.tsx', 'r.tsx', 's.tsx'), left, have(), new Map()) < 0.01, 'looks no card asks for wait their turn');
  // Three uses of one look count once.
  assert.equal(worth(place('/a', 'a.tsx'), [want('1', 'l', 5), want('2', 'l', 5), want('3', 'l', 5)], have(), new Map()), 5);
  // A first photo beats a second, and a second must come from another page.
  const second = [want('1', 'l', 5)];
  assert.equal(worth(place('/b', 'a.tsx'), second, have({ l: 1 }, { l: ['/a'] }), new Map()), 1);
  assert.equal(worth(place('/a', 'a.tsx'), second, have({ l: 1 }, { l: ['/a'] }), new Map()), 0);
  // Its file renders on this page, but that doesn't mean its line does: less each time it isn't found.
  assert.equal(worth(place('/a', 'a.tsx'), second, have(), new Map([['l', 4]])), 1);
});

test('the same look on one page is photographed once; the rest stand aside, without bringing the app back up next run', { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'orders');
  // `disabled` set from the code says nothing about its look: all three are one look.
  const files = { ...APP, 'src/App.jsx': `import { Button } from '@acme/ds-react';\nconst busy = false;\nexport function App() {\n  return <main><h1>Orders</h1>\n    <Button>Export orders</Button>\n    <Button>Print orders</Button>\n    <Button disabled={busy}>Send orders</Button>\n    <button className="btn">Archive orders</button>\n  </main>;\n}\n` };
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'orders', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 1, waitMs: 200, draw: false };
  const logs: string[] = [];
  await takeShots({ root, dataDir: data, config, target: 'orders', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const seen = logs.join('\n');
  assert.equal(Object.keys(idx.uses ?? {}).length, 1, `${JSON.stringify(idx.uses)}\n${seen}`);
  assert.match(seen, /the app's own uses: 1 photographed as examples/);
  const again: string[] = [];
  await takeShots({ root, dataDir: data, config, target: 'orders', perGroup: 20, log: m => again.push(m) });
  assert.ok(again.some(l => /not starting the app/.test(l)), again.join('\n'));
});
