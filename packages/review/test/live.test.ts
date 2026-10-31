import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from '@snds/dsa';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { routeUrl } from '../src/flows.js';
import { startStorybook } from '../src/rendered.js';
import { takeShots } from '../src/shots.js';

// Screenshots and Storybook renderings from what is live: a deployed URL or the built folder that
// ships, instead of a dev server started from the checkout.

test('routes found in the source resolve under the path the app is mounted at', () => {
  assert.equal(routeUrl('/orders', new URL('https://site.test/app/')), 'https://site.test/app/orders');
  assert.equal(routeUrl('/app/orders', new URL('https://site.test/app/')), 'https://site.test/app/orders');
  assert.equal(routeUrl('#/order/1', new URL('https://site.test/app/')), 'https://site.test/app/#/order/1');
  assert.equal(routeUrl('/orders', new URL('http://127.0.0.1:5173/')), 'http://127.0.0.1:5173/orders');
  assert.equal(routeUrl('', new URL('https://site.test/app/')), 'https://site.test/app/');
});

test('the live Storybook can be a built folder (or a URL) instead of one started from the repo', async () => {
  const root = fixtureCopy();
  fs.mkdirSync(path.join(root, 'sb-dist'));
  fs.writeFileSync(path.join(root, 'sb-dist', 'index.json'), JSON.stringify({ v: 5, entries: { 'button--default': { id: 'button--default', type: 'story', importPath: './Button.stories.tsx' } } }));
  const config = { ...loadConfig(root).config, ...parseConfig({ live: { storybook: { dir: 'sb-dist' } } }) };
  const sb = await startStorybook(root, config as never, () => {});
  try {
    assert.equal(sb.source, 'built folder sb-dist');
    const idx = await (await fetch(new URL('index.json', sb.url))).json();
    assert.ok(idx.entries['button--default']);
  } finally { sb.stop(); }
  const remote = await startStorybook(root, { ...config, ...parseConfig({ live: { storybook: { url: 'https://storybook.site.test' } } }) } as never, () => {});
  assert.equal(remote.url, 'https://storybook.site.test/');
  assert.equal(remote.source, 'live https://storybook.site.test');
});

test('screenshots come from the built folder that ships, without starting the app', async () => {
  const root = fixtureCopy();
  const app = path.join(root, 'apps/checkout');
  fs.writeFileSync(path.join(app, 'src/Links.tsx'), `export const L = () => <nav><button className="text-primary hover:underline">Open order</button></nav>;\n`);
  // No dev script: the only way to see the app is its build.
  const pj = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  delete pj.scripts;
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(pj));
  fs.mkdirSync(path.join(app, 'dist'));
  fs.writeFileSync(path.join(app, 'dist', 'index.html'), '<html><body><h1>Orders</h1><button class="text-primary hover:underline">Open order</button></body></html>');
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const config = { ...loadConfig(root).config, ...parseConfig({ live: { apps: { checkout: { dir: 'apps/checkout/dist', base: '/checkout/' } } } }) };
  const r = await takeShots({ root, dataDir: data, config: config as never, target: 'checkout', perGroup: 2 });
  const a = r.apps.find(x => x.target === 'checkout')!;
  assert.equal(a.how, 'built folder apps/checkout/dist');
  assert.match(a.url!, /\/checkout\/$/);
  assert.ok((a.captured ?? 0) >= 1, JSON.stringify(r));
});
