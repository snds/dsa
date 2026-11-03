import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { latestEvals } from '../src/engine/index.js';
import dsaTagBabel from '../src/tag/babel.js';
import { dsaTag, tagPath, tagSource } from '../src/tag/index.js';
import { NOW, fixtureCopy, runPipeline } from './engine/fixture.js';

// Source tags: every host element gets data-dsa-src="<file>:<line>:<col>", the place the scanner records
// for it, so the crawler can match exactly. Off unless asked for; paths relative to the scan root, never
// absolute, nothing outside the repo.

const DEMO = path.resolve(import.meta.dirname, 'fixtures/review-demo');
const babel = createRequire(import.meta.url)('@babel/core');

function demo() {
  const root = fixtureCopy();
  fs.cpSync(DEMO, root, { recursive: true });
  return root;
}
const tagsIn = (code: string) => [...code.matchAll(/data-dsa-src=(?:\{)?"([^"]+)"/g)].map(m => m[1]!);

test('off unless asked for: no DSA_TAG, no tags (Vite and Babel alike)', () => {
  const root = demo();
  const file = path.join(root, 'apps/billing/src/Toolbar.tsx');
  const code = fs.readFileSync(file, 'utf8');
  const was = process.env.DSA_TAG;
  delete process.env.DSA_TAG;
  try {
    assert.equal(tagSource(code, file, { root }), null);
    assert.equal(dsaTag({ root }).transform(code, file), null);
    const out = babel.transformSync(code, { filename: file, babelrc: false, configFile: false, parserOpts: { plugins: ['jsx', 'typescript'] }, plugins: [[dsaTagBabel, { root }]] }).code;
    assert.deepEqual(tagsIn(out), []);
    // when: false wins over DSA_TAG=1.
    process.env.DSA_TAG = '1';
    assert.equal(tagSource(code, file, { root, when: false }), null);
  } finally { if (was === undefined) delete process.env.DSA_TAG; else process.env.DSA_TAG = was; }
});

test('every element the scanner records carries its exact file:line:col', async () => {
  const root = demo();
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { evals } = await latestEvals(data);
  const files = [...new Set(evals.filter(e => /^apps\/(billing|checkout)\/src\//.test(e.file)).map(e => e.file))];
  assert.ok(files.length >= 3, files.join(', '));
  for (const f of files) {
    const abs = path.join(root, f);
    const r = tagSource(fs.readFileSync(abs, 'utf8'), abs, { when: true, root })!;
    const values = new Set(r.tags.map(t => t.value));
    for (const e of evals.filter(x => x.file === f)) assert.ok(values.has(`${e.file}:${e.line}:${e.col}`), `${e.file}:${e.line}:${e.col} in ${[...values].join(' ')}`);
    // Lines are kept: each tag sits on its element's own line.
    assert.equal(r.code.split('\n').length, fs.readFileSync(abs, 'utf8').split('\n').length);
    for (const t of r.tags) assert.ok(r.code.split('\n')[t.line - 1]!.includes(`data-dsa-src="${t.value}"`), t.value);
  }
});

test('paths are relative to the scan root: no absolute path, no user folder, nothing outside the repo', () => {
  const root = demo();
  const file = path.join(root, 'apps/billing/src/Toolbar.tsx');
  const code = fs.readFileSync(file, 'utf8');
  const v = dsaTag({ when: true, root }).transform(code, file)!;
  const b = babel.transformSync(code, { filename: file, babelrc: false, configFile: false, parserOpts: { plugins: ['jsx', 'typescript'] }, plugins: [[dsaTagBabel, { when: true, root }]] }).code;
  for (const out of [v.code, b]) {
    const tags = tagsIn(out);
    assert.ok(tags.length >= 8, `${tags.length} tags`);
    for (const t of tags) {
      assert.match(t, /^apps\/billing\/src\/Toolbar\.tsx:\d+:\d+$/);
      assert.ok(!t.includes(os.homedir()) && !t.includes(os.userInfo().username + '/') && !path.isAbsolute(t), t);
    }
  }
  // Vite and Babel write the same tags.
  assert.deepEqual(tagsIn(b).sort(), tagsIn(v.code).sort());
  // Found from the file itself, with no root given: the folder with dsa.config.json.
  const found = tagSource(code, file, { when: true })!;
  assert.deepEqual(found.tags.map(t => t.value), tagSource(code, file, { when: true, root })!.tags.map(t => t.value));
  // Outside the root, and dependencies, are never tagged.
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-out-')), 'Other.tsx');
  assert.equal(tagSource('<button>x</button>', outside, { when: true, root }), null);
  assert.equal(tagPath(path.join(root, 'node_modules/kit/Button.jsx'), root), null);
  // An app folder outside the root reads "<folder>/<path>", as the scanner shows it.
  assert.equal(tagPath(path.join(path.dirname(outside), 'src/A.tsx'), root, path.dirname(outside)), `${path.basename(path.dirname(outside))}/src/A.tsx`);
});

test('components are left alone unless asked for; then never a Fragment', () => {
  const root = demo();
  const file = path.join(root, 'apps/billing/src/Page.tsx');
  const code = `import { Fragment } from 'react';\nexport const P = () => <Fragment><Card title="a"><button>Go</button></Card><Kit.Row /></Fragment>;\n`;
  assert.deepEqual(tagSource(code, file, { when: true, root })!.tags.map(t => t.element), ['button']);
  assert.deepEqual(tagSource(code, file, { when: true, root, components: true })!.tags.map(t => t.element).sort(), ['Card', 'Kit.Row', 'button']);
  assert.deepEqual(tagSource(code, file, { when: true, root, components: ['Card'] })!.tags.map(t => t.element).sort(), ['Card', 'button']);
  // Already tagged (the app's own dsaTag ran first): left as it is.
  assert.equal(tagSource('<button data-dsa-src="x">Go</button>', file, { when: true, root }), null);
});
