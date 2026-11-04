import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectApp, startApp, tagPlan } from '../src/apps.js';

// Drawing from the app's code when the component alone doesn't show the element: it's behind the
// component's own state (a tab), it's made by a render helper the build doesn't keep (cellFor), or the
// component throws because nothing provides what its hook reads. The first two are drawn; the third says
// which component threw and what it needed. Skipped without a headless browser (`dsa setup`) or Vite.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const FILES: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\ncreateRoot(document.getElementById('root')).render(<main><h1>Desk</h1><a href="#help">Help</a></main>);\n`,
  // "Reopen order" shows on the "Done" tab only: state inside the component, no prop opens it.
  'src/Orders.jsx': `import { useState } from 'react';\nexport function Orders() {\n  const [tab, setTab] = useState('open');\n  return <div><div role="tablist"><button role="tab" onClick={() => setTab('open')}>Open</button><button role="tab" onClick={() => setTab('done')}>Done</button></div>\n    {tab === 'done' ? <button className="btn">Reopen order</button> : <p>Nothing done yet</p>}</div>;\n}\n`,
  // A render helper: not a component, not kept by the build. Grid, around it, draws it.
  'src/Grid.jsx': `function cellFor(row) {\n  return <button className="btn" key={row}>Open {row}</button>;\n}\nexport function Grid() {\n  return <div>{['A1', 'B2'].map(cellFor)}</div>;\n}\n`,
  // Reads a session nothing on the page provides.
  'src/session.js': `import { createContext, useContext } from 'react';\nexport const SessionCtx = createContext(undefined);\nexport const useSession = () => useContext(SessionCtx);\n`,
  'src/Account.jsx': `import { useSession } from './session.js';\nexport function Account() {\n  const s = useSession();\n  return <button className="btn">{s.user.name}</button>;\n}\n`,
};

test("an element behind its component's state, one made by a render helper, and a component that throws", { timeout: 180_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-mount-reveal-')));
  const dir = path.join(root, 'apps', 'desk');
  for (const [f, c] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(root, 'dsa.config.json'), '{}');
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'desk', private: true, type: 'module', scripts: { dev: 'vite' } }));
  const at = (f: string, s: string) => { const lines = FILES[f]!.split('\n'); const l = lines.findIndex(x => x.includes(s)); return { line: l + 1, col: lines[l]!.indexOf(s) + 1 }; };
  const ev = (id: string, f: string, within: string, text: string, find = '<button className="btn"') => ({
    id, target: 'desk', file: `apps/desk/${f}`, ...at(f, find), element: 'button', within,
    match: { tag: 'button', classes: ['btn'], text }, classTokens: ['btn'], reach: { status: 'gated', gates: [], steps: [], why: '' },
  }) as any;
  const examples = [
    ev('E-reopen', 'src/Orders.jsx', 'Orders', 'Reopen order'),
    ev('E-cell', 'src/Grid.jsx', 'cellFor', 'Open A1'),
    ev('E-account', 'src/Account.jsx', 'Account', ''),
  ];
  const app = await startApp(tagPlan(detectApp({ name: 'desk', dir } as any, { apps: {} } as any) as any, { root, dir }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-mount-reveal-shots-'));
  const logs: string[] = [];
  try {
    const { captureSession } = await import('../src/shots.js');
    const pw = await import('playwright');
    const r: any = await captureSession(pw, { url: app.url, routes: [''], crawl: false, examples, dir: out, maxPages: 3, waitMs: 300, log: (m: string) => logs.push(m), reveal: false, maxMinutes: 1, draw: { root, dir, mount: true } });
    const all = logs.join('\n');
    // The drawing's own tab, clicked: the element it hid is drawn from the app's code.
    assert.deepEqual([r.shots['E-reopen']?.drawn, r.shots['E-reopen']?.exact], ['mount', true], all);
    assert.match(all, /E-reopen \(apps\/desk\/src\/Orders\.jsx:5\) drawn from the app's code \(its component, in the app's build, after clicking “Done” in it\)/);
    // A render helper: the component around it draws it.
    assert.deepEqual([r.shots['E-cell']?.drawn, r.shots['E-cell']?.exact], ['mount', true], all);
    assert.match(all, /E-cell \(apps\/desk\/src\/Grid\.jsx:2\) drawn from the app's code \(Grid, the component around it, in the app's build\)/);
    // Thrown: its first line, and what it needed, from its source.
    assert.match(all, /E-account \(apps\/desk\/src\/Account\.jsx:4\) .*not mounted: Account: its component failed to render: Cannot read properties of undefined \(reading 'user'\); it needed what useSession reads \(a provider above it\)/);
  } finally { app.stop(); }
});
