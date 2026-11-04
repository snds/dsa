import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { stateOrder } from '../src/drawn.js';
import { takeShots } from '../src/shots.js';

// Elements behind a component's own state that no control the scan can trace sets (here, only a message
// from a socket would): the crawler sets that state through React on the live page, photographs what
// shows, and reloads. A real Vite + React app, started by dsa with source tags. Skipped without a headless
// browser or Vite.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const COLOURS = `import { useEffect, useMemo, useState } from 'react';\nexport function Colours() {\n  const [openColour, setOpenColour] = useState(null);\n  const names = useMemo(() => ['Teal', 'Rust'], []);\n  const [mode, setMode] = useState('list');\n  useEffect(() => { window.__socket?.on('open', (c) => setOpenColour(c)); window.__socket?.on('mode', setMode); }, []);\n  return <section><h1>Colours</h1><ul>{names.map(n => <li key={n}>{n}</li>)}</ul>\n    {mode === 'grid' && <div>\n      <button className="btn">Grid tile</button>\n    </div>}\n    {openColour && <div role="dialog">\n      <button className="btn">Rename {openColour.name.trim()}</button>\n    </div>}</section>;\n}\n`;

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { routes } from './routes.jsx';\nconst R = routes.find(r => r.path === location.pathname) ?? routes[0];\ncreateRoot(document.getElementById('root')).render(<R.Component />);\n`,
  'src/routes.jsx': `import { Colours } from './Colours.jsx';\nexport const routes = [\n  { path: '/colours', Component: Colours },\n];\n`,
  'src/Colours.jsx': COLOURS,
};

test("the order of a component's state hooks, as React keeps them", () => {
  assert.deepEqual(stateOrder(COLOURS, 'Colours'), ['openColour', 'mode']);
  // A custom hook's own hooks can't be counted: the order stops there.
  assert.deepEqual(stateOrder(`export function A() { const [a] = useState(0); const x = useThing(); const [b] = useState(1); return null; }`, 'A'), ['a']);
});

test("elements behind a component's own state are shown live by setting it", { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'swatches');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'swatches', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const id = (t: string) => evals.find(e => e.file.endsWith('Colours.jsx') && (e.match.text ?? '').startsWith(t))?.id;
  assert.ok(id('Grid tile') && id('Rename'), evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200 };
  await takeShots({ root, dataDir: data, config, target: 'swatches', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const all = logs.join('\n');
  for (const t of ['Grid tile', 'Rename']) assert.ok(idx.shots[id(t)!] && !idx.shots[id(t)!].drawn, `${t} live\n${all}`);
  assert.match(all, /on \/colours after setting mode = "grid"/);
  assert.match(all, /on \/colours after setting openColour = \{"name":""\}/);
  assert.match(all, /state on \/colours: .*found 1/);
});

// An app that navigates by its root's state, not routes: a custom hook first (its own hooks counted from
// its source), then setupTakeover and activeNav; under it PartnersView's own open. Set outermost first.
const NAV: Record<string, string> = {
  'index.html': APP['index.html']!,
  'public/app.css': APP['public/app.css']!,
  'vite.config.js': APP['vite.config.js']!,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { App } from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n`,
  'src/useSession.js': `import { useEffect, useState } from 'react';\nexport function useSession() {\n  const [user, setUser] = useState(null);\n  useEffect(() => { setUser({ name: 'Ada' }); }, []);\n  return user;\n}\n`,
  'src/App.jsx': `import { useState } from 'react';\nimport { useSession } from './useSession.js';\nimport { PartnersView } from './PartnersView.jsx';\nexport function App() {\n  const user = useSession();\n  const [setupTakeover, setSetupTakeover] = useState(true);\n  const [activeNav, setActiveNav] = useState('Home');\n  if (setupTakeover) return <main><h1>Finish setting up</h1><p>{user?.name}</p></main>;\n  return <main><nav>{activeNav}</nav>\n    {activeNav === 'Partners' && <PartnersView />}</main>;\n}\n`,
  'src/PartnersView.jsx': `import { useState } from 'react';\nexport function PartnersView() {\n  const [open, setOpen] = useState(false);\n  return <section><h1>Partners</h1>\n    {open && <div>\n      <button className="btn">Add facility</button>\n    </div>}</section>;\n}\n`,
};

test("an app that navigates by its root's state: each level set, outermost first, and photographed live", { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  // The custom hook's own state counts: App's setupTakeover is its second state hook, not its first.
  assert.deepEqual(stateOrder(NAV['src/App.jsx']!, 'App', (n) => (n === 'useSession' ? NAV['src/useSession.js']! : null)), [null, 'setupTakeover', 'activeNav']);
  assert.deepEqual(stateOrder(NAV['src/App.jsx']!, 'App'), []);
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'partners');
  for (const [f, c] of Object.entries(NAV)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'partners', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const target = evals.find(e => e.file.endsWith('PartnersView.jsx') && e.match.text === 'Add facility');
  assert.ok(target, evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200 };
  await takeShots({ root, dataDir: data, config, target: 'partners', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const all = logs.join('\n');
  assert.ok(idx.shots[target!.id] && !idx.shots[target!.id].drawn, `${JSON.stringify(target!.reach?.gates)}\n${all}`);
  assert.match(all, /after setting setupTakeover = false, activeNav = "Partners", open = true/);
});

// A modal a custom hook renders (useDetailImages returns JSX), shown once the hook's own state is set; the
// hook keeps that state in the component that calls it (ColoursView), after its own openColour.
const HOOKED: Record<string, string> = {
  'index.html': APP['index.html']!,
  'public/app.css': APP['public/app.css']!,
  'vite.config.js': APP['vite.config.js']!,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { ColoursView } from './ColoursView.jsx';\ncreateRoot(document.getElementById('root')).render(<ColoursView />);\n`,
  'src/ImageEditorModal.jsx': `export function ImageEditorModal({ open }) {\n  if (!open) return null;\n  return <div role="dialog">\n    <button className="btn">Apply palette</button>\n  </div>;\n}\n`,
  'src/useDetailImages.jsx': `import { useEffect, useState } from 'react';\nimport { ImageEditorModal } from './ImageEditorModal.jsx';\nexport function useDetailImages() {\n  const [editor, setEditor] = useState(null);\n  useEffect(() => { window.__socket?.on('edit', setEditor); }, []);\n  return { modal: <ImageEditorModal open={!!editor} /> };\n}\n`,
  'src/ColoursView.jsx': `import { useEffect, useState } from 'react';\nimport { useDetailImages } from './useDetailImages.jsx';\nexport function ColoursView() {\n  const [openColour, setOpenColour] = useState(null);\n  const { modal } = useDetailImages();\n  useEffect(() => { window.__socket?.on('open', setOpenColour); }, []);\n  return <main><h1>Colours</h1>\n    {openColour && <section>{modal}</section>}</main>;\n}\n`,
};

test("a modal a custom hook renders: the hook's state is set in the component that calls it", { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'hooked');
  for (const [f, c] of Object.entries(HOOKED)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'hooked', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const target = evals.find(e => e.file.endsWith('ImageEditorModal.jsx') && e.match.text === 'Apply palette');
  assert.ok(target, evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200 };
  await takeShots({ root, dataDir: data, config, target: 'hooked', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const all = logs.join('\n');
  assert.ok(idx.shots[target!.id] && !idx.shots[target!.id].drawn, `${JSON.stringify(target!.reach?.gates)}\n${all}`);
  assert.match(all, /after setting openColour = true, editor = true/);
});
