import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGraph } from '@snds/dsa/engine';
import { needsValue, patternTest, routeFiles, routesReaching } from '../src/routes.js';

// Which route renders which file, from the source alone: JSX routes (nested), route objects with element,
// Component or lazy, React Router's route config, and Next's file routes. With the import graph, each
// element's file maps to the routes that render it.

function app(files: Record<string, string>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-routes-')));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  return dir;
}

test('JSX routes, nested, and route objects with element, Component and lazy', () => {
  const dir = app({
    'index.html': '<script type="module" src="/src/main.tsx"></script>',
    'src/main.tsx': `import { Routes, Route } from 'x';\nimport { Shell } from './Shell';\nimport { Orders } from './orders/Orders';\nimport { router } from './data';\nexport const App = () => (<Routes><Route path="/app" element={<Shell />}><Route path="orders" element={<Orders />} /></Route></Routes>);\n`,
    'src/Shell.tsx': `export const Shell = () => <div />;\n`,
    'src/orders/Orders.tsx': `import { Row } from './Row';\nexport const Orders = () => <Row />;\n`,
    'src/orders/Row.tsx': `export const Row = () => <button>Open</button>;\n`,
    'src/data.tsx': `import { lazy } from 'react';\nimport { Invoice } from './Invoice';\nconst Reports = lazy(() => import('./Reports'));\nexport const router = [{ path: '/invoices/:id', Component: Invoice, children: [{ path: 'notes', element: <Reports /> }] }, { path: '/settings', lazy: () => import('./Settings') }];\n`,
    'src/Invoice.tsx': `export const Invoice = () => <div />;\n`,
    'src/Reports.tsx': `export default function Reports() { return <div />; }\n`,
    'src/Settings.tsx': `export const Component = () => <div />;\n`,
  });
  const r = Object.fromEntries(routeFiles(dir).map(x => [x.path, path.relative(dir, x.file)]));
  assert.deepEqual(r, { '/app': 'src/Shell.tsx', '/app/orders': 'src/orders/Orders.tsx', '/invoices/:id': 'src/Invoice.tsx', '/invoices/:id/notes': 'src/Reports.tsx', '/settings': 'src/Settings.tsx' });
  // A file a route's component imports is reached by that route.
  const g = buildGraph(dir);
  assert.deepEqual(routesReaching(routeFiles(dir), g, path.join(dir, 'src/orders/Row.tsx')), ['/app/orders']);
});

test('React Router\'s route config and Next\'s file routes', () => {
  const rr = app({
    'app/root.tsx': 'export default () => null;',
    'app/routes.ts': `import { type RouteConfig, route, index } from '@react-router/dev/routes';\nexport default [index('routes/home.tsx'), route('orders/:id', 'routes/order.tsx')] satisfies RouteConfig;\n`,
    'app/routes/home.tsx': 'export default () => null;',
    'app/routes/order.tsx': 'export default () => null;',
  });
  assert.deepEqual(routeFiles(rr).map(x => [x.path, path.relative(rr, x.file)]).sort(), [['/', 'app/routes/home.tsx'], ['/orders/:id', 'app/routes/order.tsx']]);
  const next = app({ 'pages/index.tsx': '', 'pages/orders/[id].tsx': '', 'pages/_app.tsx': '', 'app/(shop)/cart/page.tsx': '' });
  assert.deepEqual(routeFiles(next).map(x => x.path).sort(), ['/', '/cart', '/orders/:id']);
});

test('patterns: which paths fill a route that needs a value', () => {
  assert.ok(needsValue('/orders/:id') && needsValue('/files/*') && !needsValue('/orders'));
  const t = patternTest('/orders/:id');
  assert.ok(t.test('/orders/1042') && !t.test('/orders') && !t.test('/orders/1042/edit'));
  assert.ok(patternTest('/docs/:lang?').test('/docs') && patternTest('/docs/:lang?').test('/docs/en'));
});
