import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectApp, startApp, tagPlan } from '../src/apps.js';

// An app whose Vite root is a folder below the scan root, with its own vite.config: a base path, an "@"
// alias to its src folder, and TypeScript. Its components still mount from the app's code (the tagger
// says where its server serves each file), and one that draws with no size is shown outlined, with why.
// Skipped without a headless browser (`dsa setup`) or without Vite installed.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const FILES: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.tsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.ts': `import { fileURLToPath } from 'node:url';\nexport default { base: '/portal/', cacheDir: '../../.vite', resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } } };\n`,
  'src/main.tsx': `import { createRoot } from 'react-dom/client';\nimport { App } from '@/app/App';\ncreateRoot(document.getElementById('root')!).render(<App />);\n`,
  'src/lib/text.ts': `export const label = (s: string): string => s.toUpperCase();\n`,
  'src/app/App.tsx': `import { Toolbar } from '@/app/components/Toolbar';\nimport { SettingsPanel } from '@/app/components/SettingsPanel';\nexport function App() {\n  return <main><Toolbar /><SettingsPanel open={false} /></main>;\n}\n`,
  'src/app/components/Toolbar.tsx': `export function Toolbar() {\n  return <nav><a href="#help">Help</a></nav>;\n}\n`,
  // Nothing opens it: only drawing from the app's code shows it.
  'src/app/components/SettingsPanel.tsx': `import { label } from '@/lib/text';\ninterface Props { open: boolean }\nexport function SettingsPanel({ open }: Props) {\n  if (!open) return null;\n  return <div><button className="btn">{label('Save settings')}</button></div>;\n}\n`,
  // Imports a file that isn't there: it can't load, and its line says what the app's server answered.
  'src/app/components/Broken.tsx': `import { gone } from '@/lib/gone';\nexport function Broken() {\n  return <button className="btn">{gone}</button>;\n}\n`,
  // An icon slot with nothing in it until the app fills it: its markup draws at 0×0.
  'src/app/components/Slot.tsx': `export const slot = (name: string) => <i className="slot" data-name={name} />;\n`,
};

test("an app in a subfolder with its own base and aliases mounts from its code; a 0×0 drawing is shown outlined with why", { timeout: 180_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-mount-sub-')));
  const dir = path.join(root, 'web', 'portal');
  for (const [f, c] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(root, 'dsa.config.json'), '{}');
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'portal', private: true, type: 'module', scripts: { dev: 'vite' } }));
  const at = (f: string, s: string) => { const lines = FILES[f]!.split('\n'); const l = lines.findIndex(x => x.includes(s)); return { line: l + 1, col: lines[l]!.indexOf(s) + 1 }; };
  const ev = (id: string, f: string, tag: string, within: string | undefined, text: string, gates: any[] = []) => ({
    id, target: 'portal', file: `web/portal/${f}`, ...at(f, `<${tag}`), element: tag, within,
    match: { tag, classes: [], text }, classTokens: [], reach: { status: 'gated', gates, steps: [], why: '' },
  }) as any;
  const examples = [
    ev('E-save', 'src/app/components/SettingsPanel.tsx', 'button', 'SettingsPanel', 'SAVE SETTINGS', [{ kind: 'early-return', test: '!open', negated: true, ids: ['open'], component: 'SettingsPanel', file: 'web/portal/src/app/components/SettingsPanel.tsx' }]),
    ev('E-slot', 'src/app/components/Slot.tsx', 'i', undefined, ''),
    ev('E-broken', 'src/app/components/Broken.tsx', 'button', 'Broken', ''),
  ];
  const plan = detectApp({ name: 'portal', dir } as any, { apps: {} } as any);
  assert.ok(!('reason' in plan), JSON.stringify(plan));
  const app = await startApp(tagPlan(plan as any, { root, dir }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-mount-sub-shots-'));
  const logs: string[] = [];
  try {
    const { captureSession } = await import('../src/shots.js');
    const pw = await import('playwright');
    const r: any = await captureSession(pw, { url: app.url, routes: [''], crawl: false, examples, dir: out, maxPages: 3, waitMs: 300, log: (m: string) => logs.push(m), reveal: false, maxMinutes: 1, draw: { root, dir, mount: true } });
    const all = logs.join('\n');
    // Imported the way the app imports it: under its base, from its own root, its "@" imports resolved.
    assert.deepEqual([r.shots['E-save']?.drawn, r.shots['E-save']?.exact], ['mount', true], all);
    assert.match(String(r.shots['E-save'].content?.text ?? ''), /SAVE SETTINGS/, JSON.stringify(r.shots['E-save'].content));
    assert.match(all, /E-save \(web\/portal\/src\/app\/components\/SettingsPanel\.tsx:5\) drawn from the app's code/);
    // Empty in its markup: shown outlined, with a reason a person can act on, and it doesn't count.
    assert.equal(r.shots['E-slot']?.drawn, 'markup', all);
    assert.match(String(r.shots['E-slot']?.placeholder), /empty in its markup/);
    assert.match(all, /E-slot \(web\/portal\/src\/app\/components\/Slot\.tsx:1\) drawn as markup only; not mounted: the scan found no component around it · shown outlined, it had no size: it is empty in its markup/);
    assert.ok(fs.statSync(path.join(out, 'E-slot.png')).size > 0);
    // A file that can't load: what the server answered for it, under the app's base.
    assert.match(all, /E-broken \(web\/portal\/src\/app\/components\/Broken\.tsx:3\) .*not mounted: Broken: its file did not load: \/portal\/src\/app\/components\/Broken\.tsx answered 500 \(.*gone/);
  } finally { app.stop(); }
});
