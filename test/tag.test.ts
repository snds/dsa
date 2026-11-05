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

test('the file\'s own components, exported or not, are kept for the mount, on its last line', () => {
  const src = `import { memo } from 'react';\nfunction Row() { return <li>a</li>; }\nexport const List = memo(() => <ul><Row /></ul>);\nconst helper = () => 1;\ntype Props = {};\nexport default function Page() { return <List />; }\n`;
  const r = tagSource(src, '/repo/apps/x/src/Page.tsx', { when: true, root: '/repo' })!;
  assert.equal(r.code.split('\n').length, src.split('\n').length);
  assert.ok(r.code.endsWith(';(globalThis.__dsaLocal ??= {})["apps/x/src/Page.tsx"] = { Row, List, Page };'), r.code);
});

test('a tag path maps back to its file, and to the URL a Vite server with a base serves it at', async () => {
  const { fileOfTag, viteUrlOf } = await import('../src/tag/index.js');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-tag-url-')));
  const app = path.join(root, 'web', 'portal');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.writeFileSync(path.join(app, 'src', 'Row.tsx'), '');
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-tag-out-')));
  fs.mkdirSync(path.join(outside, 'src'));
  fs.writeFileSync(path.join(outside, 'src', 'Card.tsx'), '');
  const file = fileOfTag('web/portal/src/Row.tsx', root)!;
  assert.equal(file, path.join(app, 'src', 'Row.tsx'));
  // Under the server's root: its path from there, after the base. Elsewhere: /@fs/, after the base.
  assert.equal(viteUrlOf(file, app, '/portal/'), '/portal/src/Row.tsx');
  assert.equal(viteUrlOf(file, app), '/src/Row.tsx');
  assert.equal(viteUrlOf(file, path.join(root, 'other'), '/'), `/@fs${file}`);
  // An app folder outside the root reads "<folder>/<path>".
  assert.equal(fileOfTag(`${path.basename(outside)}/src/Card.tsx`, root, outside), path.join(outside, 'src', 'Card.tsx'));
  assert.equal(fileOfTag('web/portal/src/Gone.tsx', root), null);
  assert.equal(fileOfTag('../etc/passwd', root), null);
});

test('state hooks are named by their setter, without moving a line or adding a hook; a plain .ts hook too', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-tag-names-'));
  const tsx = `import { useState } from 'react';\nexport function Panel() {\n  const [open, setOpen] = useState(false);\n  const [rows] = useState([]);\n  return <div>{open ? 'x' : ''}</div>;\n}\n`;
  const r = tagSource(tsx, path.join(root, 'src/Panel.tsx'), { when: true, root })!;
  assert.match(r.code, /const \[open, setOpen\] = useState\(false\);;globalThis\.__dsaStateName\?\.\(setOpen, "open", "src\/Panel\.tsx:3"\);/);
  // No setter, nothing to name; and no line moves.
  assert.doesNotMatch(r.code, /"rows"/);
  assert.equal(r.code.split('\n').length, tsx.split('\n').length);
  // A custom hook in a .ts file (generics, no JSX): parsed as TypeScript alone, its state named.
  const ts = `import { useReducer } from 'react';\nexport function useCount<T>(x: T) {\n  const [n, bump] = useReducer((a: number) => a + 1, 0);\n  return <T>(x as T) && n;\n}\n`;
  const t = tagSource(ts, path.join(root, 'src/useCount.ts'), { when: true, root })!;
  assert.match(t.code, /;globalThis\.__dsaStateName\?\.\(bump, "n", "src\/useCount\.ts:3"\);/);
  assert.equal(tagSource(`export const x = <T,>(a: T) => a;\n`, path.join(root, 'src/x.ts'), { when: true, root }), null);
});

test('a component with type arguments gets its marks after them (<Table<Row> …>), and the output parses', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-tag-generic-'));
  const code = `import { Table } from './Table';\nexport function List({ rows }: { rows: Row[] }) {\n  return <Table<Row> rows={rows} render={(r) => <span>{r.name}</span>} />;\n}\n`;
  const r = tagSource(code, path.join(root, 'src/List.tsx'), { when: true, root, uses: true })!;
  assert.match(r.code, /<Table<Row> data-dsa-use="src\/List\.tsx:3:10" rows=/);
});

test('fail safe: code tagging would break is served as written, with one line naming the file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-tag-safe-'));
  // Parses only with error recovery (a name declared twice): tagged, it wouldn't parse, so it's left alone.
  const code = `export function Box() {\n  let a = 1; let a = 2;\n  return <div>{a}</div>;\n}\n`;
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => { warns.push(m); };
  try { assert.equal(tagSource(code, path.join(root, 'src/Box.tsx'), { when: true, root }), null); } finally { console.warn = warn; }
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /src\/Box\.tsx: tagging it made code that does not parse, so it is served as written/);
});

// Every .ts/.tsx/.jsx file of the dashboard's own UI and the test fixtures, tagged with every mark on: each
// output parses, and none falls back. A smoke check that the transform holds on real-world code shapes.
test('the transform holds on a real code base: every file tagged, every output parses, no fallback', () => {
  const repo = path.resolve(import.meta.dirname, '..');
  const files: string[] = [];
  const walkDir = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walkDir(p); else if (/\.(tsx?|jsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(p); } };
  for (const d of ['packages/dashboard/ui/src', 'test/fixtures']) walkDir(path.join(repo, d));
  assert.ok(files.length > 100, `${files.length} files`);
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => { warns.push(m); };
  let tagged = 0;
  try { for (const f of files) if (tagSource(fs.readFileSync(f, 'utf8'), f, { when: true, root: repo, uses: true })) tagged++; } finally { console.warn = warn; }
  assert.deepEqual(warns, []);
  assert.ok(tagged > 50, `${tagged} tagged`);
});
