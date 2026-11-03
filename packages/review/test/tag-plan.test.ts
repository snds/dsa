import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureCopy } from '../../../test/engine/fixture.js';
import { tagPlan } from '../src/apps.js';

// Source tags for an app dsa starts, with no change to its files: a Vite app is started through Vite's API
// with the tagger added inline; anything else is started as configured with DSA_TAG=1.

const DEMO = path.resolve(import.meta.dirname, '../../../test/fixtures/review-demo');
function demo() {
  const root = fixtureCopy();
  fs.cpSync(DEMO, root, { recursive: true });
  return root;
}

test('an app dsa starts: Vite gets the tagger through its API; anything else gets DSA_TAG=1', () => {
  const root = demo();
  const dir = path.join(root, 'apps/billing');
  fs.mkdirSync(path.join(dir, 'node_modules/vite'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/vite/package.json'), JSON.stringify({ name: 'vite', exports: { '.': { import: './index.js' } } }));
  fs.writeFileSync(path.join(dir, 'node_modules/vite/index.js'), '');
  const vite = { target: 'billing', cwd: dir, command: 'npx', args: ['vite', '--port', '{port}'], url: (p: number) => `http://127.0.0.1:${p}/`, how: 'vite' };
  const p = tagPlan(vite, { root, dir });
  assert.equal(p.tag, 'injected');
  assert.equal(p.command, process.execPath);
  assert.deepEqual(p.args.slice(1), ['{port}']);
  assert.equal(p.env!.DSA_TAG, '1');
  assert.equal(p.env!.DSA_TAG_ROOT, root);
  assert.match(p.env!.DSA_TAG_MODULE!, /^file:.*\/tag\/index\.js$/);
  // The app's own files are untouched: the runner lives outside it.
  assert.ok(!p.args[0]!.startsWith(root));
  const next = tagPlan({ ...vite, command: 'npx', args: ['next', 'dev'], how: 'next dev' }, { root, dir });
  assert.deepEqual([next.tag, next.command, next.env!.DSA_TAG], ['env', 'npx', '1']);
  assert.equal(tagPlan(vite, { root, dir, off: true }), vite);
});
