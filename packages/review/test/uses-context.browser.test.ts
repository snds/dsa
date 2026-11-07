import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshShots, latestEvals } from '@snds/dsa/engine';
import { ACME_PROFILE, fixtureCopy, loadConfig, NOW, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { publish } from '../../dashboard/src/publish.js';
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

test('a normal rerun gives what the fresh run gave: its photos and drawings count, an older photo stays old, and a page already looked at is not opened again', { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'orders');
  const files = { ...APP,
    'src/App.jsx': `import { Button } from '@acme/ds-react';\nconst never = false;\nexport function App() {\n  return <main><h1>Orders</h1>\n    <Button>Export orders</Button>\n    <button className="btn">Archive orders</button>\n    {never && <button className="btn">Undo archive</button>}\n    {never && <Button variant="outline">Undo export</Button>}\n  </main>;\n}\n`,
  };
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'orders', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 1, waitMs: 200 };
  const file = path.join(data, 'shots', 'index.json');
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const run = async () => { const logs: string[] = []; await takeShots({ root, dataDir: data, config, target: 'orders', perGroup: 20, log: m => logs.push(m) }); return logs.join('\n'); };
  const first = await run();
  const taken = read();
  const before = freshShots(taken);
  const drawings = Object.keys(before.shots).filter(id => before.shots[id].drawn);
  const live = Object.keys(before.shots).filter(id => !before.shots[id].drawn);
  assert.ok(drawings.length && live.length, `a drawing and a photo:\n${first}`);
  const missKey = 'apps/orders/src/App.jsx:8';
  assert.equal(taken.useMisses?.[missKey]?.why, 'not-seen', `${JSON.stringify(taken.useMisses)}\n${first}`);
  // An older photo: it wasn't this run's and no run checked it, so it didn't count. The use's pass was cut short before it could say the use isn't on any page.
  const old = drawings[0]!;
  const edited = read();
  const { [old]: drawing, ...others } = edited.shots;
  edited.shots = { ...others, [old]: { ...drawing, drawn: undefined, placement: null, tagged: true, run: 'older', at: new Date(Date.now() - 36e5).toISOString() } };
  edited.useMisses[missKey].why = 'out-of-time';
  fs.writeFileSync(file, JSON.stringify(edited));
  const counting = freshShots(edited);
  // What a person is shown: the same cards, each element with the same evidence.
  const shown = async () => {
    const out = path.join(tmp(), 'site');
    await publish(root, config, data, ACME_PROFILE, out, null, {});
    const { elements } = JSON.parse(fs.readFileSync(path.join(out, 'index.html'), 'utf8').match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)![1]);
    return {
      cards: elements.review.items.map((x: any) => x.id), photos: elements.review.photos, ready: elements.review.ready, setAside: elements.review.setAside,
      evals: elements.evals.map((e: any) => [e.id, e.confidence, e.needsHuman, e.shot?.url ?? null, e.staleShot?.why ?? null, e.review?.ready, (e.review?.missing ?? []).map((m: any) => m.kind)]),
    };
  };
  const fromFresh = await shown();
  assert.ok(fromFresh.evals.some((e: any[]) => e[3]), 'some have a photo');
  const second = await run();
  assert.deepEqual(await shown(), fromFresh);
  const after = freshShots(read());
  assert.deepEqual(Object.keys(after.shots).sort(), Object.keys(counting.shots).sort(), 'the same shots count');
  assert.deepEqual(Object.keys(after.stale), [old], 'the older photo stays old');
  for (const id of Object.keys(counting.shots)) assert.equal(read().shots[id].at, counting.shots[id].at, 'nothing was retaken');
  assert.match(second, /0 examples to capture/);
  // The use isn't on any page the first run saw, so nothing is opened for it, and the time limit isn't spent.
  assert.match(second, /already looked at not opened again/);
  assert.match(second, /the app's own uses: 0 photographed as examples \(\d+s, 0 extra pages\).*1 on no page opened/);
  assert.equal(read().useMisses[missKey].why, 'not-seen');
  // And now it's settled: nothing to look for, so the app isn't started. A third run still keeps everything.
  const third = await run();
  assert.match(third, /not starting the app/);
  assert.deepEqual(Object.keys(freshShots(read()).shots).sort(), Object.keys(counting.shots).sort());
  // A changed file could put the use on any page: every page is open again.
  fs.appendFileSync(path.join(dir, 'src/App.jsx'), '// changed\n');
  const fourth = await run();
  assert.doesNotMatch(fourth, /already looked at not opened again/);
});

test("a lab's use of a look no card asks for isn't photographed; a product's is", { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'orders');
  const files = { ...APP,
    'src/labs/Specimen.jsx': `import { Button } from '@acme/ds-react';\nexport const Specimen = () => <Button variant="outline">Specimen</Button>;\n`,
    'src/App.jsx': `import { Button } from '@acme/ds-react';\nimport { Specimen } from './labs/Specimen.jsx';\nexport function App() {\n  return <main><h1>Orders</h1>\n    <Button variant="ghost">Export orders</Button>\n    <Specimen />\n    <button className="btn">Archive orders</button>\n  </main>;\n}\n`,
  };
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'orders', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 1, waitMs: 200, draw: false };
  await takeShots({ root, dataDir: data, config, target: 'orders', perGroup: 20 });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  assert.ok(idx.uses?.['apps/orders/src/App.jsx:5'], JSON.stringify(Object.keys(idx.uses ?? {})));
  assert.equal(idx.uses?.['apps/orders/src/labs/Specimen.jsx:2'], undefined);
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
  // A lab page can't help a product look, and a lab's look waits behind any look a card asks for in the product.
  assert.equal(worth({ ...place('/lab', 'a.tsx'), lab: true }, [want('1', 'l', 5)], have(), new Map()), 0);
  const specimen = { ...want('s', 'l', 30, 'lab.tsx'), lab: true };
  assert.ok(worth({ ...place('/lab', 'lab.tsx'), lab: true }, [specimen], have(), new Map()) < 0.01, 'no first visit, however many cards ask');
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
