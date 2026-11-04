import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// A live pass on an app that never goes quiet: it polls every 200 ms, its blocked API calls throw, and one
// page is read-only (text, no controls). Every page that shows something is swept and explored: a menu
// opened, a tab switched, a traced control replayed and the page reloaded between tries. A real Vite +
// React app with a pushState router, started by dsa with source tags. Skipped without a headless browser
// (`dsa setup`) or without Vite installed.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'public/poll.json': '{"jobs": 3}',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  // Polls forever (the network is never idle), and its API reads are blocked, so each one throws.
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { App } from './App.jsx';\nsetInterval(() => { fetch('/poll.json?t=' + Date.now()); fetch('/api/jobs').then(r => r.json()); }, 200);\ncreateRoot(document.getElementById('root')).render(<App />);\n`,
  'src/App.jsx': `import { useEffect, useState } from 'react';\nimport { Reports } from './Reports.jsx';\nimport { Team } from './Team.jsx';\nimport { Settings } from './Settings.jsx';\nconst pages = { '/reports': Reports, '/team': Team, '/settings': Settings };\nexport function App() {\n  const [at, setAt] = useState(location.pathname);\n  useEffect(() => { const on = () => setAt(location.pathname); addEventListener('popstate', on); return () => removeEventListener('popstate', on); }, []);\n  const P = pages[at];\n  if (P) return <P />;\n  const go = (to) => (e) => { e.preventDefault(); history.pushState(null, '', to); setAt(to); };\n  return <main><h1>Jobs</h1><nav><a href="/reports" onClick={go('/reports')}>Reports</a> <a href="/team" onClick={go('/team')}>Team</a> <a href="/settings" onClick={go('/settings')}>Settings</a></nav></main>;\n}\n`,
  // Read-only: text and a figure, nothing to click.
  'src/Reports.jsx': `export function Reports() {\n  return <article><h1>Quarterly report</h1><p>Three jobs ran this quarter.</p><img className="chart" alt="Jobs by week" width="120" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" /></article>;\n}\n`,
  // A menu: "Remove member" shows once "Actions" is clicked.
  'src/Team.jsx': `import { useState } from 'react';\nexport function Team() {\n  const [open, setOpen] = useState(false);\n  return <section><h1>Team</h1><button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>Actions</button>{open && <div role="menu"><button className="btn" role="menuitem">Remove member</button></div>}</section>;\n}\n`,
  // Tabs: "Delete workspace" is on the second one.
  'src/Settings.jsx': `import { useState } from 'react';\nexport function Settings() {\n  const [tab, setTab] = useState('general');\n  return <section><h1>Settings</h1><div role="tablist"><button role="tab" aria-selected={tab === 'general'} onClick={() => setTab('general')}>General</button><button role="tab" aria-selected={tab === 'danger'} onClick={() => setTab('danger')}>Danger zone</button></div>{tab === 'general' ? <p>Name and logo</p> : <button className="btn">Delete workspace</button>}</section>;\n}\n`,
};

test('an app that polls and throws: every page that shows something is swept and explored', { timeout: 300_000 }, async ({ skip }) => {
  if (!browser) skip('no headless browser (run dsa setup)');
  const kit = path.resolve(import.meta.dirname, '../../dashboard/ui/node_modules');
  if (!fs.existsSync(path.join(kit, 'vite')) || !fs.existsSync(path.join(kit, 'react'))) skip('no Vite installed');
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'jobs');
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'jobs', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }));
  fs.symlinkSync(kit, path.join(dir, 'node_modules'), 'dir');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const mine = evals.filter(e => e.file.startsWith('apps/jobs/src/'));
  const listed = mine.map(e => `${e.file}:${e.line} ${e.element} ${e.match.text || e.match.ariaLabel || ''}`).join('\n');
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  config.shots = { ...(config.shots ?? {}), maxMinutes: 3, waitMs: 300 };
  config.apps = { ...(config.apps ?? {}), jobs: { routes: ['/', '/reports', '/team', '/settings'] } };
  await takeShots({ root, dataDir: data, config, target: 'jobs', perGroup: 20, log: m => logs.push(m) });
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const live = mine.filter(e => idx.shots[e.id] && !idx.shots[e.id].drawn).map(e => `${e.file.replace('apps/jobs/src/', '')}:${e.line}`);
  const all = `${listed}\n--- live: ${live.join(', ')}\n${logs.join('\n')}`;
  const isLive = (file: string, text: string) => mine.some(e => e.file.endsWith(file) && (e.match.text === text || e.match.ariaLabel === text) && idx.shots[e.id] && !idx.shots[e.id].drawn);
  // Every element reached live, and the read-only page (text, nothing to click) swept, though it throws.
  assert.deepEqual(mine.filter(e => !idx.shots[e.id] || idx.shots[e.id].drawn).map(e => e.id), [], all);
  assert.ok(idx.pages.some((u: string) => u.endsWith('/reports')), `the read-only page was swept\n${all}`);
  // Explored while the network never goes quiet: a menu opened, a tab switched.
  assert.ok(isLive('Team.jsx', 'Remove member'), `a menu item\n${all}`);
  assert.ok(isLive('Settings.jsx', 'Delete workspace'), `a tab's content\n${all}`);
  assert.ok(!logs.some(l => /didn't render/.test(l)), all);
});
