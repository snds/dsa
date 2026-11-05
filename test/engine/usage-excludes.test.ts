import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals } from '../../src/engine/index.js';
import { usageExcludes } from '../../src/engine/paths.js';
import { NOW, fixtureCopy, runPipeline } from './fixture.js';

// What an app's folder holds that isn't its usage stays out of element discovery: a vendor folder (a
// synced copy of the design system's own tooling) and what git ignores. An app git ignores as a whole
// is still scanned.

const button = (words: string) => `export function X() {\n  return <button className="btn">${words}</button>;\n}\n`;

test("an app's vendor folder and git-ignored files aren't its usage", async () => {
  const root = fixtureCopy();
  const dir = path.join(root, 'apps', 'ledger');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ledger', private: true, dependencies: { '@acme/ds-react': '^4.9.0', react: '^18.3.0' } }),
    '.gitignore': 'generated/\n*.local.tsx\n',
    'src/Pay.tsx': button('Pay invoice'),
    'vendor/ds-tools/Preview.tsx': button('Preview token'),
    'src/vendor/Copied.tsx': button('Copied control'),
    'generated/Stub.tsx': button('Generated stub'),
    'src/Scratch.local.tsx': button('Scratch control'),
  };
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  execFileSync('git', ['init', '-q'], { cwd: root });
  const ex = usageExcludes(dir).map(f => path.relative(dir, f)).sort();
  assert.deepEqual(ex, ['generated', 'src/Scratch.local.tsx', 'src/vendor', 'vendor']);
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const words = (await latestEvals(data)).evals.filter(e => e.file.startsWith('apps/ledger/')).map(e => e.match.text);
  assert.deepEqual(words, ['Pay invoice']);
});

test('an app folder git ignores as a whole is still scanned', () => {
  const root = fixtureCopy();
  const dir = path.join(root, 'clones', 'shop');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'A.tsx'), button('Buy'));
  fs.writeFileSync(path.join(root, '.gitignore'), 'clones/\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  assert.deepEqual(usageExcludes(dir), []);
});
