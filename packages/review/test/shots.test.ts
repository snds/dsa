import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { discoverRoutes } from '../src/apps.js';
import { takeShots } from '../src/shots.js';

// Screenshots for the element review: the crawler starts each app itself (here, a tiny dev server),
// visits routes it finds in the source, captures examples, stops the app, and caches by source.

test('screenshots start the app themselves, find routes in the source, and stop it after', async () => {
  const root = fixtureCopy();
  const app = path.join(root, 'apps/checkout');
  fs.writeFileSync(path.join(app, 'src/Links.tsx'), `export const L = () => <nav><a href="/orders">Orders</a><button className="text-primary hover:underline">Open order</button></nav>;\nconst routes = ['#/orders', '#/order/1'];\n`);
  // A tiny "dev server": serves a page with the same button, on whatever --port it's given.
  fs.writeFileSync(path.join(app, 'serve.mjs'), `import http from 'node:http';\nconst port = Number(process.argv[process.argv.indexOf('--port') + 1]);\nhttp.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end('<html><body><h1>Orders</h1><button class="text-primary hover:underline">Open order</button></body></html>'); }).listen(port, '127.0.0.1');\n`);
  const pj = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  pj.scripts = { dev: 'node serve.mjs' };
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(pj));
  fs.mkdirSync(path.join(app, 'node_modules'), { recursive: true });
  assert.ok(discoverRoutes(app).includes('#/orders') && discoverRoutes(app).includes('/orders'));
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { config } = loadConfig(root);
  const r = await takeShots({ root, dataDir: data, config, target: 'checkout', perGroup: 2 });
  const a = r.apps.find(x => x.target === 'checkout')!;
  assert.equal(a.how, 'npm run dev');
  assert.ok((a.captured ?? 0) >= 1, JSON.stringify(r));
  const idx = JSON.parse(fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8'));
  const shotId = Object.keys(idx.shots)[0];
  assert.ok(fs.statSync(path.join(data, 'shots', idx.shots[shotId].file)).size > 500);
  // The dev server is gone afterwards.
  const port = new URL(a.url!).port;
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }));
  // Second run: sources unchanged, so nothing is captured and the app isn't started.
  const r2 = await takeShots({ root, dataDir: data, config, target: 'checkout', perGroup: 2 });
  const a2 = r2.apps.find(x => x.target === 'checkout')!;
  assert.ok(!a2.url && (a2.cached ?? 0) >= 1, JSON.stringify(r2));
  // Touch the element's file: it gets re-captured.
  fs.appendFileSync(path.join(app, 'src/Links.tsx'), '\n// edit\n');
  const r3 = await takeShots({ root, dataDir: data, config, target: 'checkout', perGroup: 2 });
  assert.ok(r3.apps.find(x => x.target === 'checkout')!.url, 'changed source restarts the app');
});
