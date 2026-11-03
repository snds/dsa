import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseConfig } from '@snds/dsa';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { takeShots } from '../src/shots.js';

// An app that doesn't render (it throws on load, or its dev server fails its modules: a package that
// isn't installed) hides every element. That is said plainly, not counted as "not found", and nothing
// behind it is remembered; installing the app's dependencies then retries on its own.
// The review demo (test/fixtures/review-demo) photographed from its built pages. Skipped without a
// headless browser (`dsa setup`).

const hasBrowser = process.env.DSA_NO_BROWSER ? false : await (async () => {
  try { const { chromium } = await import('playwright'); const b = await chromium.launch(); await b.close(); return true; } catch { return false; }
})();
const DEMO = path.resolve(import.meta.dirname, '../../../test/fixtures/review-demo');

function demo(billing = 'apps/billing/site') {
  const root = fixtureCopy();
  fs.cpSync(DEMO, root, { recursive: true });
  const live = { apps: { billing: { dir: billing }, checkout: { dir: 'apps/checkout/site' } }, storybook: { dir: 'storybook-static' } };
  return { root, data: path.join(root, '.dsa'), config: () => ({ ...loadConfig(root).config, live: parseConfig({ live }).live }) as any };
}
const misses = (data: string) => Object.keys(JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8')).misses ?? {});

test('an app that throws on load: said plainly, with its error, and nothing remembered as "not found"', { timeout: 120_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const { root, data, config } = demo('apps/billing/broken');
  fs.mkdirSync(path.join(root, 'apps/billing/broken'));
  fs.writeFileSync(path.join(root, 'apps/billing/broken/index.html'), `<div id="root"></div><script>throw new Error("Cannot find package 'ledger-charts' imported from /src/main.tsx")</script>`);
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const logs: string[] = [];
  const r = await takeShots({ root, dataDir: data, config: config(), target: 'billing', perGroup: 3, log: m => logs.push(m) });
  const a = r.apps.find(x => x.target === 'billing')!;
  assert.match(a.broken ?? '', /Cannot find package 'ledger-charts'/);
  assert.equal(a.captured, 0);
  assert.ok(logs.some(l => /The app didn't render: .*ledger-charts.*\. Fix the app's install, then run again\./.test(l)), logs.join('\n'));
  assert.deepEqual(misses(data), [], 'no misses remembered');
  assert.equal(r.missing, 0);
});

test("a dev server that fails the app's own modules (500) is a broken app too", { timeout: 120_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const app = http.createServer((q, s) => {
    if (q.url?.startsWith('/src/')) { s.writeHead(500, { 'content-type': 'text/plain' }); s.end('[vite] Internal server error: Failed to resolve import "ledger-charts"'); return; }
    s.setHeader('content-type', 'text/html'); s.end('<div id="root"></div><script type="module" src="/src/main.tsx"></script>');
  });
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  try {
    const { root, data, config } = demo();
    await runPipeline({ root, dataDir: data, git: false, now: NOW });
    const r = await takeShots({ root, dataDir: data, config: config(), url: `http://127.0.0.1:${(app.address() as any).port}/`, target: 'billing', routes: ['/', '/invoices', '/settings', '/customers'], perGroup: 3 });
    assert.match(r.apps[0]!.broken ?? '', /\/src\/main\.tsx answered 500/);
    assert.equal(r.missing, 0);
  } finally { app.close(); }
});

test('a page that renders but logs an error is not a broken app', { timeout: 120_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const { root, data, config } = demo();
  const page = path.join(root, 'apps/billing/site/index.html');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('</body>', '<script>throw new Error("analytics blocked")</script></body>'));
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const r = await takeShots({ root, dataDir: data, config: config(), target: 'billing', perGroup: 3 });
  const a = r.apps.find(x => x.target === 'billing')!;
  assert.equal(a.broken, undefined);
  assert.ok((a.captured ?? 0) > 0);
});

test("installing the app's dependencies retries its misses, no flag needed", { timeout: 180_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const { root, data, config } = demo();
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  await takeShots({ root, dataDir: data, config: config(), target: 'billing', perGroup: 3 });
  assert.ok(misses(data).length > 0, 'some elements are not on the page (the selects have nothing to match on)');
  const same = await takeShots({ root, dataDir: data, config: config(), target: 'billing', perGroup: 3 });
  assert.ok(!same.apps.find(a => a.target === 'billing')!.url, 'same setup: not opened again');
  // A package added: the lockfile changes, and so does node_modules' install marker.
  fs.writeFileSync(path.join(root, 'apps/billing/package-lock.json'), JSON.stringify({ name: 'billing', lockfileVersion: 3, packages: { 'node_modules/ledger-charts': { version: '1.0.0' } } }));
  const after = await takeShots({ root, dataDir: data, config: config(), target: 'billing', perGroup: 3 });
  assert.ok(after.apps.find(a => a.target === 'billing')!.url, 'the new lockfile opens the app again');
  fs.mkdirSync(path.join(root, 'apps/billing/node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps/billing/node_modules/.package-lock.json'), '{}');
  const reinstalled = await takeShots({ root, dataDir: data, config: config(), target: 'billing', perGroup: 3 });
  assert.ok(reinstalled.apps.find(a => a.target === 'billing')!.url, 'a fresh install opens it again too');
});
