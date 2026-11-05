import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// A route table the scan can't tie to files (components looked up by name), and a modal two files below
// the page that only an untraced "Edit image" opens. The page shows a file that imports the modal's file,
// so it counts as one that renders what's missing: explored first, with every control tried. A real Vite +
// React app, started by dsa with source tags. Skipped without a headless browser or Vite.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport * as pages from './pages.jsx';\nconst table = [['/gallery', 'Gallery'], ['/samples', 'Samples']];\nconst hit = table.find(([p]) => p === location.pathname) ?? table[0];\nconst P = pages[hit[1]];\ncreateRoot(document.getElementById('root')).render(<P />);\n`,
  'src/pages.jsx': `export { Gallery } from './Gallery.jsx';\nexport { Samples } from './Samples.jsx';\n`,
  'src/toggle.js': `import { useReducer } from 'react';\nexport const useToggle = () => useReducer(v => !v, false);\n`,
  // Mentions the element's words, so the explore pass would try it first by words alone.
  'src/Gallery.jsx': `import { useToggle } from './toggle.js';\nexport function Gallery() {\n  const [on, flip] = useToggle();\n  return <section><h1>Gallery</h1><p>Edit image, rotate left, image editor</p><button className="btn" onClick={flip}>Edit image</button>\n    {on && <p>Pick a photo first</p>}</section>;\n}\n`,
  'src/Samples.jsx': `import { SampleGrid } from './samples/SampleGrid.jsx';\nexport function Samples() {\n  return <section><h1>Samples</h1><SampleGrid /></section>;\n}\n`,
  'src/samples/SampleGrid.jsx': `import { useToggle } from '../toggle.js';\nimport { ImageEditor } from './ImageEditor.jsx';\nexport function SampleGrid() {\n  const [on, flip] = useToggle();\n  return <div><button className="btn" onClick={flip}>Edit image</button>\n    {on && <ImageEditor />}</div>;\n}\n`,
  'src/samples/ImageEditor.jsx': `export function ImageEditor() {\n  return <div role="dialog">\n    <button className="btn">Rotate left</button>\n  </div>;\n}\n`,
};

test('a page that shows a file importing a missing element is explored first, every control tried', { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'studio');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'studio', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const target = evals.find(e => e.file.endsWith('ImageEditor.jsx') && e.match.text === 'Rotate left');
  assert.ok(target, evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200 };
  config.apps = { ...(config.apps ?? {}), studio: { routes: ['/gallery', '/samples'] } };
  await takeShots({ root, dataDir: data, config, target: 'studio', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const all = logs.join('\n');
  assert.ok(idx.shots[target!.id] && !idx.shots[target!.id].drawn, all);
  assert.match(idx.shots[target!.id].page, /\/samples$/);
  assert.match(all, /explored \/samples: \d+ interactions?, [1-9]\d* found(, .*?)? \(a page that renders what is missing: every control tried\)/);
});
