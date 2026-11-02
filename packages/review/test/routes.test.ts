import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverRoutes, routeConfig } from '../src/apps.js';

// React Router's route config (app/routes.ts) declares an app's routes in code, not as `path:` strings:
// the crawler reads route(), index(), layout() and prefix() so it visits all of them, and lists the ones
// that need a value (a :param, a splat) instead of guessing one.

test("React Router's route config: every route it declares, params and splats listed as needing a value", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-rr-'));
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app', 'routes.ts'), `import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("about", "routes/about.tsx"),
  // route("retired", "routes/retired.tsx"),
  layout("routes/auth/layout.tsx", [
    route("login", "routes/auth/login.tsx"),
    route('register', 'routes/auth/register.tsx'),
  ]),
  ...prefix("orders", [
    index("routes/orders/list.tsx"),
    route(":orderId", "routes/orders/order.tsx", [
      route("edit", "routes/orders/edit.tsx"),
    ]),
    route("archived", "routes/orders/archived.tsx", { id: "archived" }),
  ]),
  route("files/*", "routes/files.tsx"),
  route(":lang?/help", "routes/help.tsx"),
  route("settings/profile?", "routes/settings.tsx"),
] satisfies RouteConfig;
`);
  const r = routeConfig(dir);
  assert.equal(path.basename(r.file!), 'routes.ts');
  assert.deepEqual(r.routes, ['/', '/about', '/help', '/login', '/orders', '/orders/archived', '/register', '/settings', '/settings/profile']);
  assert.deepEqual(r.needsValue, ['/files/*', '/orders/:orderId', '/orders/:orderId/edit']);
  // The crawler visits them; the ones that need a value aren't guessed.
  const all = discoverRoutes(dir);
  for (const x of r.routes) assert.ok(all.includes(x), x);
  assert.ok(!all.some(x => x.includes(':') || x.includes('*')));
  assert.ok(!all.includes('/retired'), 'a commented-out route stays out');
});
