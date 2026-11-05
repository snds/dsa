import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// The ledger records only what renders, so an element behind a condition the crawler never meets has no
// record of its own. Its component's does: Shelf rendered its heading with the props the app passed it.
// The drawing mounts Shelf with those props and forces the element's condition (items.length > 0: one
// item), and says so. A Vite + React app with source tags.

const browser = process.env.DSA_NO_BROWSER ? null : await (async () => {
  try { const { chromium } = await import('playwright'); return await chromium.launch(); } catch { return null; }
})();
afterAll(async () => { await browser?.close(); });

const APP: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  'public/app.css': '.btn { background: rgb(29, 78, 216); color: #fff; padding: 8px 16px; border: 0; margin: 4px; }',
  'vite.config.js': `export default { cacheDir: '../../.vite' };\n`,
  'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport { Library } from './Library.jsx';\ncreateRoot(document.getElementById('root')).render(<Library />);\n`,
  'src/Shelf.jsx': `import { useState } from 'react';\nexport function Shelf({ title, items }) {\n  const [picked, setPicked] = useState([]);\n  const [tip, setTip] = useState(false);\n  return <section><h2>{title}</h2>\n    {items.length > 0 && <button className="btn">Open {items.length} in {title}</button>}\n    {picked.length > 0 && <button className="btn">Clear {picked[0].name}</button>}\n    {tip && <button className="btn">Hide tip</button>}\n    {Date.now() < 0 && <button className="btn">Never</button>}\n  </section>;\n}\n`,
  // A tray drawn in a portal, as a dialog's content is: its state is set where the portal put it.
  'src/Tray.jsx': `import { useState } from 'react';\nimport { createPortal } from 'react-dom';\nexport function Tray({ label }) {\n  const [open, setOpen] = useState(false);\n  return createPortal(<aside><span>{label}</span>{open && <button className="btn">Close tray</button>}</aside>, document.body);\n}\n`,
  // Never rendered by anything here: a drawer behind a state that stays off (with a test beside it, not run), a
  // card that throws without its store, and, in Shelf, a button behind a condition no drawing can meet.
  'src/Drawer.jsx': `export function Drawer() {\n  return <nav><button className="btn">Close drawer</button></nav>;\n}\n`,
  'src/Drawer.test.jsx': `import { Drawer } from './Drawer.jsx';\n`,
  'src/Card.jsx': `export function Card() {\n  throw new Error('Card needs its store');\n  return <button className="btn">Card action</button>;\n}\n`,
  // A hook whose JSX only its caller (Grid, never shown) draws; uploads whose retry shows for a failed one; a
  // panel that uses useState without importing it (the app's own bug).
  'src/useRowTools.jsx': `export function useRowTools() {\n  return { menu: <button className="btn">Row menu</button> };\n}\n`,
  'src/Grid.jsx': `import { useRowTools } from './useRowTools.jsx';\nexport function Grid() {\n  const tools = useRowTools();\n  return <section>{tools.menu}</section>;\n}\n`,
  'src/Uploads.jsx': `export function Uploads({ uploads }) {\n  return <ul>{uploads.map((up) => <li key={up.name}>{up.name}{up.failed && <button className="btn">Retry {up.name}</button>}</li>)}</ul>;\n}\n`,
  'src/Stale.jsx': `export function Stale() {\n  const [n] = useState(0);\n  return <button className="btn">Stale {n}</button>;\n}\n`,
  // Another caller of the hook, which throws: found first, tried, passed over for Grid.
  'src/Board.jsx': `import { useRowTools } from './useRowTools.jsx';\nexport function Board() {\n  const tools = useRowTools();\n  throw new Error('Board needs its store');\n  return <section>{tools.menu}</section>;\n}\n`,
  // A picker that closes itself whenever it's opened; an owner read from a context only the app provides.
  'src/Picker.jsx': `import { useEffect, useState } from 'react';\nexport function Picker() {\n  const [open, setOpen] = useState(false);\n  useEffect(() => { if (open) setOpen(false); }, [open]);\n  return <div className="picker">{open && <button className="btn">Pick one</button>}</div>;\n}\n`,
  // A comparison whose data helper throws on an empty list (reduce, no start): the component hands it its prop.
  'src/data/quotes.ts': `export type Quote = { id: string; price: { n: number } };\nexport function cheapest(qs: Quote[]): Quote {\n  return qs.reduce((a, b) => (a.price.n <= b.price.n ? a : b));\n}\n`,
  'src/Compare.tsx': `import { cheapest, type Quote } from './data/quotes';\nexport function Compare({ quotes }: { quotes: Quote[] }) {\n  const best = cheapest(quotes);\n  return <button className="btn">Cheapest {best.price.n}</button>;\n}\n`,
  'src/Store.jsx': `import { createContext } from 'react';\nexport const StoreCtx = createContext(null);\n`,
  'src/Owner.jsx': `import { useContext } from 'react';\nimport { StoreCtx } from './Store.jsx';\nexport function Owner() {\n  const store = useContext(StoreCtx);\n  return <button className="btn">Owner {store.owner.n}</button>;\n}\n`,
  'src/Library.jsx': `import { useState } from 'react';\nimport { Shelf } from './Shelf.jsx';\nimport { Tray } from './Tray.jsx';\nimport { Drawer } from './Drawer.jsx';\nimport { Card } from './Card.jsx';\nimport { Grid } from './Grid.jsx';\nimport { Board } from './Board.jsx';\nimport { Uploads } from './Uploads.jsx';\nimport { Stale } from './Stale.jsx';\nimport { Picker } from './Picker.jsx';\nimport { Owner } from './Owner.jsx';\nimport { StoreCtx } from './Store.jsx';\nimport { Compare } from './Compare.tsx';\nexport function Library() {\n  const [more] = useState(false);\n  return <StoreCtx.Provider value={null}><main><h1>Library</h1><Shelf title="Ferns" items={[]} /><Tray label="Tools" /><Picker /><Uploads uploads={[{ name: 'a.png', failed: false }]} />{more && <Drawer />}{more && <Card />}{more && <Grid />}{more && <Board />}{more && <Stale />}{more && <Owner />}{more && <Compare quotes={[]} />}</main></StoreCtx.Provider>;\n}\n`,
};

test('the ledger: an element its component rendered without is drawn with the component\'s recorded props, its condition forced', { timeout: 300_000 }, async ({ skip }) => {
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
  const target = evals.find(e => e.file.endsWith('Shelf.jsx') && /Open/.test(e.match.text ?? ''));
  assert.ok(target, evals.map(e => `${e.file}:${e.line} ${e.match.text}`).join('\n'));

  // One run: the crawler's own visit records Shelf's heading (and Shelf's props); the button never renders.
  const logs: string[] = [];
  const config = loadConfig(root).config as any;
  // A person's record (dsa record), with the value StoreCtx's provider gave where they were.
  const lines = path.join(root, 'person.jsonl');
  fs.writeFileSync(lines, JSON.stringify({ src: 'apps/library/src/Library.jsx:1:1', url: 'http://localhost/', at: 1, w: 10, h: 10, owner: null, ancestors: [], contexts: [{ name: 'apps/library/src/Store.jsx#StoreCtx', value: { owner: { n: 'Ada' } }, cut: false }] }) + '\n');
  config.shots = { ...(config.shots ?? {}), maxMinutes: 2, waitMs: 200, reveal: false, ledger: path.relative(root, lines) };
  await takeShots({ root, dataDir: data, config, target: 'library', perGroup: 20, log: m => logs.push(m) });
  const all = logs.join('\n');
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));

  assert.match(all, /ledger coverage: of \d+ not reached live, 0 recorded themselves, [1-9]\d* whose component is recorded/);
  assert.ok(idx.ledgerCoverage?.library?.component >= 1, JSON.stringify(idx.ledgerCoverage));
  const shot = idx.shots[target!.id];
  assert.deepEqual([shot?.drawn, shot?.exact, shot?.source], ['mount', true, 'isolated'], all);
  assert.ok(shot.forced?.some((f: string) => f.startsWith('items = [')), JSON.stringify(shot.forced));
  // Shelf's recorded title, with the one item forced in.
  assert.match(String(shot.content?.text ?? ''), /Open 1 in Ferns/);
  assert.match(all, /an isolated render \(recorded props, condition forced: items = \[/);

  // What nothing ever rendered, by file, with the test near it; and why drawings failed, grouped.
  assert.match(all, /ledger gaps: [1-9]\d* never rendered by the crawl, a person or a test, in [1-9]\d* files?/);
  assert.match(all, /\n    apps\/library\/src\/Drawer\.jsx · 1 element · test: src\/Drawer\.test\.jsx \(rendered none of them\) · story: none · first condition: “more”/);
  assert.ok(idx.ledgerGaps?.library?.some((g: any) => g.file.endsWith('Card.jsx') && g.test === null), JSON.stringify(idx.ledgerGaps));
  assert.match(all, /drawings, its component failed to render \(top \d+ of \d+ causes\): 1 × Card needs its store/);
  assert.match(all, /drawings, mounted but the element wasn't in what it drew \(top \d+ of \d+ conditions\): .*1 × “Date\.now\(\) < 0” in Shelf/);
  assert.ok(idx.drawCauses?.library?.threw?.length, JSON.stringify(idx.drawCauses));

  // A hook's JSX, drawn by the component that calls it; a failed upload's retry, its item's field forced on;
  // and the app's own missing import, said as such.
  const of = (re: RegExp) => evals.find(e => /\.[jt]sx$/.test(e.file) && re.test(e.match.text ?? ''));
  const menu = idx.shots[of(/Row menu/)!.id];
  assert.deepEqual([menu?.drawn, menu?.exact], ['mount', true], all);
  const retry = idx.shots[of(/Retry/)!.id];
  assert.deepEqual([retry?.drawn, retry?.exact, retry?.source], ['mount', true, 'isolated'], all);
  assert.match(String(retry.content?.text ?? ''), /Retry a\.png/);
  assert.match(all, /Stale: its component failed to render: useState is not defined \(apps\/library\/src\/Stale\.jsx uses useState but never declares or imports it: a bug in the app's code/);

  // The hook's first caller throws: it's passed over, and Grid draws it.
  assert.match(all, new RegExp(`${of(/Row menu/)!.id} .*drawn from the app's code.*Grid`));
  // Where a cause was thrown: the first frame in the app's own code.
  assert.match(all, /1 × Card needs its store \(thrown at \/src\/Card\.jsx:\d+\)/);
  // A state the component sets back: said so.
  assert.match(all, /open was set, then set back by the component: it opens and closes itself/);
  assert.match(all, /“open” in Picker \(set, then set back: it opens and closes itself\)/);
  // A context the page provides empty, which a person's record holds filled: drawn with the recorded value.
  const owner = idx.shots[of(/Owner/)!.id];
  assert.deepEqual([owner?.drawn, owner?.exact], ['mount', true], all);
  assert.match(String(owner.content?.text ?? ''), /Owner Ada/);
  assert.match(all, /with the recorded value of StoreCtx/);

  // A data helper that threw on what the component handed it: that prop filled from its type, one more try.
  const cheap = idx.shots[of(/Cheapest/)!.id];
  assert.deepEqual([cheap?.drawn, cheap?.exact], ['mount', true], all);
  assert.match(all, /after filling quotes, which it passes to cheapest/);
  // What changed since the last run (none before this one): every drawing is new.
  assert.match(all, /drawings changed since the last run: \+[1-9]\d* now drawn from the app's code/);
  assert.ok(idx.drawChanges?.library?.gained?.includes(of(/Cheapest/)!.id), JSON.stringify(idx.drawChanges));

  // State inside the drawing, the drawing's own: a list one item, a flag true; and inside its portal.
  const by = (text: RegExp) => evals.find(e => e.file.endsWith('.jsx') && text.test(e.match.text ?? ''));
  for (const [re, set] of [[/Clear/, /setting picked = \[/], [/Hide tip/, /setting tip = true/], [/Close tray/, /setting open = true/]] as const) {
    const e = by(re);
    assert.ok(e, String(re));
    const sh = idx.shots[e!.id];
    assert.deepEqual([sh?.drawn, sh?.exact, sh?.source], ['mount', true, 'isolated'], `${re}\n${all}`);
    assert.match(all, new RegExp(`${e!.id} .*after ${set.source}`));
  }
});
