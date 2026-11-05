import { test } from 'vitest';
import './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from '@babel/parser';
import { reactFeatures, visitWithAncestors, resetFeatureCaches, type ElementFeatures } from '../../src/engine/scanners/features.js';
import { classify } from '../../src/engine/classify.js';
import { styleKeyOf, styleSigOf, type ElementEval } from '../../src/engine/elements.js';
import { applyPrecedent, gitMigrations, indexUses } from '../../src/engine/precedent.js';
import type { Instance } from '../../src/engine/types.js';

// Review item 18: learn from the app's own migrations. A made-up app; no real names.

function app(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-prec-')));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return dir;
}

function rawEval(dir: string, file: string, at = 0): { e: ElementEval; f: ElementFeatures } {
  resetFeatureCaches();
  const abs = path.join(dir, file);
  const code = fs.readFileSync(abs, 'utf8');
  const hits: { f: ElementFeatures; line: number }[] = [];
  visitWithAncestors(parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }).program, (n: any, anc: any[]) => {
    if (n.type === 'JSXElement' && n.openingElement.name.name === 'button') hits.push({ f: reactFeatures(n, [...anc], code, abs, []), line: n.openingElement.loc.start.line });
  });
  const { f, line } = hits[at]!;
  const c = classify(f);
  const e = { ...c, id: 'E-1', target: 'app', file, line, col: f.col, element: 'button', fingerprint: 'x', needsHuman: c.confidence < 0.9, snippet: f.openTag, source: f.source, styleKey: styleKeyOf(f.classes.viaConst), styleSig: styleSigOf(f.classes.tokens), classTokens: f.classes.tokens, match: { tag: 'button', classes: [], text: '' } } as ElementEval;
  return { e, f };
}
const inst = (file: string, line: number, component = 'Button'): Instance => ({ target: 'app', library: 'acme', pkg: '@acme/ui', component, file, line, framework: 'react', overrides: [] } as Instance);

test('precedent: a raw element styled by a constant the app already migrated follows that migration', () => {
  const dir = app({
    'src/styles.ts': `export const QUIET_LINK = "text-primary underline text-xs";\n`,
    'src/Done.tsx': `import { Button } from '@acme/ui';\nimport { QUIET_LINK } from './styles';\nexport const D = () => (\n  <Button variant="link" size="xs" className={QUIET_LINK}>Open</Button>\n);\n`,
    'src/Todo.tsx': `import { QUIET_LINK } from './styles';\nexport const T = () => <button onClick={open} className={QUIET_LINK}>Details</button>;\n`,
  });
  const uses = indexUses([inst('src/Done.tsx', 4)], f => path.join(dir, f));
  assert.equal(uses.length, 1);
  assert.equal(uses[0]!.styleKey, 'QUIET_LINK');
  assert.deepEqual(uses[0]!.props, { variant: 'link', size: 'xs' });
  const { e } = rawEval(dir, 'src/Todo.tsx');
  assert.equal(applyPrecedent(e, { uses, migrations: [] }, 0.9), 'migrated');
  assert.equal(e.use, 'Button');
  assert.equal(e.props?.variant, 'link');
  assert.equal(e.props?.size, 'xs');
  assert.ok(e.confidence >= 0.92);
  assert.ok(e.reasons.some(r => /Near-truth: the app already migrated the shared style QUIET_LINK/.test(r.text)));
});

test('precedent: git history pairs a removed raw element with the system component that replaced it', () => {
  const dir = app({ 'src/Bar.tsx': `export const B = () => (\n  <div>\n    <button onClick={a} className="px-2 py-1 rounded border">A</button>\n  </div>\n);\n` });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'ignore' });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'raw');
  fs.writeFileSync(path.join(dir, 'src/Bar.tsx'), `export const B = () => (\n  <div>\n    <Button variant="outline" size="sm" onClick={a}>A</Button>\n  </div>\n);\n`);
  git('commit', '-q', '-am', 'migrate');
  const ms = gitMigrations(dir, new Set(['Button']));
  assert.equal(ms.length, 1);
  assert.equal(ms[0]!.styleSig, styleSigOf(['px-2', 'py-1', 'rounded', 'border']));
  assert.deepEqual(ms[0]!.props, { variant: 'outline', size: 'sm' });
  fs.writeFileSync(path.join(dir, 'src/Other.tsx'), `export const O = () => <button onClick={b} className="px-2 py-1 rounded border">B</button>;\n`);
  const { e } = rawEval(dir, 'src/Other.tsx');
  assert.equal(applyPrecedent(e, { uses: [], migrations: ms }, 0.9), 'history');
  assert.equal(e.use, 'Button');
  assert.deepEqual({ variant: e.props?.variant, size: e.props?.size }, { variant: 'outline', size: 'sm' });
});

test('precedent: a system Button two lines away in the same row lends its size', () => {
  const dir = app({ 'src/Row.tsx': `import { Button } from '@acme/ui';\nexport const R = () => (\n  <div className="flex gap-2">\n    <Button variant="outline" size="sm">Cancel</Button>\n    <button onClick={save} className="h-8 px-3 rounded bg-primary text-primary-foreground">Save</button>\n  </div>\n);\n` });
  const uses = indexUses([inst('src/Row.tsx', 4)], f => path.join(dir, f));
  const { e, f } = rawEval(dir, 'src/Row.tsx');
  assert.equal(e.use, 'Button');
  assert.equal(applyPrecedent(e, { uses, migrations: [] }, 0.9, f.context.ancestors), 'adjacent');
  assert.equal(e.props?.size, 'sm');
  assert.ok(e.reasons.some(r => /Next to it \(line 4\) the app already uses <Button variant="outline" size="sm">; take its size \(sm\)/.test(r.text)), JSON.stringify(e.reasons));
});
