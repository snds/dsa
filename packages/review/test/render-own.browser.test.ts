import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from '@snds/dsa';
import { cardPicks, latestEvals, proposalKey, readProposals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { renderProposals, wantedProposals } from '../src/rendered.js';
import { takeShots } from '../src/shots.js';

// The review demo (test/fixtures/review-demo): photographed from its built pages, rendered from its built
// Storybook. A proposal is drawn with the element's own words and icon; what a card proposes (its
// auto-picked props included) is what gets drawn; what can't be drawn says why in plain words; and a miss
// is tried again once the app's setup changes. Skipped without a headless browser (`dsa setup`).

const hasBrowser = process.env.DSA_NO_BROWSER ? false : await (async () => {
  try { const { chromium } = await import('playwright'); const b = await chromium.launch(); await b.close(); return true; } catch { return false; }
})();
const DEMO = path.resolve(import.meta.dirname, '../../../test/fixtures/review-demo');

function demo() {
  const root = fixtureCopy();
  fs.cpSync(DEMO, root, { recursive: true });
  const live = { apps: { billing: { dir: 'apps/billing/site' }, checkout: { dir: 'apps/checkout/site' } }, storybook: { dir: 'storybook-static' } };
  return { root, data: path.join(root, '.dsa'), config: () => ({ ...loadConfig(root).config, live: parseConfig({ live }).live }) as any };
}

test('proposals are drawn with each element\'s own content, for what the cards propose', { timeout: 180_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const { root, data, config } = demo();
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  await takeShots({ root, dataDir: data, config: config(), perGroup: 3 });
  // Every card's pick is wanted, and each element's own content beside it.
  const want = await wantedProposals(data);
  const { evals } = await latestEvals(data);
  for (const c of cardPicks(data, evals)) if (c.auto?.verdict === 'replace' && c.auto.use) assert.ok(want.has(proposalKey(c.auto.use, c.auto.props)), `card pick ${proposalKey(c.auto.use, c.auto.props)} is drawn`);
  assert.ok([...want.values()].some(w => w.own?.text === 'Save invoice'), 'a text button brings its words');
  assert.ok([...want.values()].some(w => w.own?.icon && w.own.ariaLabel === 'Refresh'), 'an icon button brings its icon and name');

  await renderProposals({ root, config: config(), dataDir: data });
  const p = readProposals(data);
  const own = Object.entries(p).filter(([k, v]) => k.includes('#') && v.own);
  assert.ok(own.length >= 4, `${own.length} drawn with their own content`);
  for (const [, v] of own) { assert.equal(v.content, undefined, 'no sample label or stand-in icon'); assert.ok(v.shot && fs.existsSync(path.join(data, 'rendered', v.shot))); }
  // No story to draw from: said plainly, no code words.
  const none = Object.values(p).filter(v => v.check === 'none');
  assert.ok(none.length > 0);
  for (const v of none) assert.doesNotMatch(v.note ?? '', /data-slot|signature/, v.note);
});

test('a miss is tried again once the app\'s setup changes, without --retry-missing', { timeout: 180_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const { root, data, config } = demo();
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const first = await takeShots({ root, dataDir: data, config: config(), target: 'billing', perGroup: 3 });
  assert.ok((first.missing ?? 0) > 0, 'some elements are not on the built page (the selects have nothing to match on)');
  // Same setup: the misses are remembered, so the app isn't opened again.
  const same = await takeShots({ root, dataDir: data, config: config(), target: 'billing', perGroup: 3 });
  assert.ok(!same.apps.find(a => a.target === 'billing')!.url, 'nothing new to try: not opened');
  // A changed setup (another route to visit): its misses get another try.
  const cfg = config(); cfg.apps = { ...(cfg.apps ?? {}), billing: { ...(cfg.apps?.billing ?? {}), extraRoutes: ['/?view=all'] } };
  const again = await takeShots({ root, dataDir: data, config: cfg, target: 'billing', perGroup: 3 });
  assert.ok(again.apps.find(a => a.target === 'billing')!.url, 'the changed setup opens the app again');
});

test('a sign-in wall is said plainly, and nothing behind it is remembered as "not found"', { timeout: 180_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const { root, data, config } = demo();
  // The same app, signed out: every page sends you to a sign-in form.
  const locked = path.join(root, 'apps/billing/locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'index.html'), '<meta http-equiv="refresh" content="0; url=/login.html"><p>Redirecting…</p>');
  fs.writeFileSync(path.join(locked, 'login.html'), '<h1>Sign in</h1><form><input name="user"><input type="password" name="pass"><button>Sign in</button></form>');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const cfg = config(); cfg.live.apps.billing = { dir: 'apps/billing/locked' };
  const logs: string[] = [];
  const r = await takeShots({ root, dataDir: data, config: cfg, target: 'billing', perGroup: 3, log: m => logs.push(m) });
  const a = r.apps.find(x => x.target === 'billing')!;
  assert.match(a.signIn ?? '', /login/, JSON.stringify({ a, logs }));
  assert.equal(a.captured, 0);
  assert.ok(logs.some(l => /Every page asked for sign-in\. Run `dsa login .+` and set live\.apps\["billing"\]\.auth/.test(l)), logs.join('\n'));
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(idx.misses ?? {}), [], 'no misses remembered behind the wall');
  assert.equal(r.missing, 0);
  // Signed in (here: the open site), the same elements are looked for at once, no flag needed.
  const open = await takeShots({ root, dataDir: data, config: config(), target: 'billing', perGroup: 3 });
  assert.ok((open.apps.find(x => x.target === 'billing')!.captured ?? 0) > 0);
});

test('a redirect to another host to sign in (an identity provider) is a sign-in wall too', { timeout: 120_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const http = await import('node:http');
  const idp = http.createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end('<form><input type="password"></form>'); });
  await new Promise<void>(r => idp.listen(0, '127.0.0.1', r));
  const idpUrl = `http://localhost:${(idp.address() as any).port}/realms/acme/protocol/openid-connect/auth`;
  const app = http.createServer((_q, s) => { s.writeHead(302, { location: `${idpUrl}?client_id=billing` }); s.end(); });
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  try {
    const { root, data, config } = demo();
    await runPipeline({ root, dataDir: data, git: false, now: NOW });
    const r = await takeShots({ root, dataDir: data, config: config(), url: `http://127.0.0.1:${(app.address() as any).port}/`, target: 'billing', routes: ['/', '/invoices', '/settings'], perGroup: 3 });
    assert.match(r.apps[0]!.signIn ?? '', /realms\/acme\/protocol/);
    assert.equal(r.missing, 0);
  } finally { app.close(); idp.close(); }
});
