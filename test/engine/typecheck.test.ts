import { test } from 'vitest';
import './setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { reactFeatures, visitWithAncestors, resetFeatureCaches } from '../../src/engine/scanners/features.js';
import { classify } from '../../src/engine/classify.js';
import { openChecker, refineWithTypes } from '../../src/engine/typecheck.js';
import type { Lookalike } from '../../src/engine/types.js';

// Review item 17: the TypeScript checker with the app's own tsconfig. A made-up app; no real names.

function app(files: Record<string, string>, tsconfig = true): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-ts-')));
  if (tsconfig) fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'preserve', strict: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022' } }));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return dir;
}

/** Look-alike rows for every native element of a kind in one file, as the scanner records them. */
function rows(dir: string, file: string, tag: string): Lookalike[] {
  resetFeatureCaches();
  const abs = path.join(dir, file);
  const code = fs.readFileSync(abs, 'utf8');
  const out: Lookalike[] = [];
  visitWithAncestors(parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }).program, (n: any, anc: any[]) => {
    if (n.type === 'JSXElement' && n.openingElement.name.name === tag) {
      const f = reactFeatures(n, [...anc], code, abs, []);
      out.push({ target: 'app', element: tag, component: tag === 'input' ? 'Input' : 'Button', file, line: n.openingElement.loc.start.line, col: f.col, features: f });
    }
  });
  return out;
}
const refine = (dir: string, rs: Lookalike[]) => refineWithTypes(rs, r => path.join(dir, r.file), dir, dir, ['hidden', 'submit', 'file', 'image', 'reset'], { text: 'Input', search: 'Input' });

test('typecheck: a spread that carries type "file" is a file input, not an Input look-alike', () => {
  const dir = app({
    'src/drop.ts': `export function getInputProps() { return { type: 'file' as const, multiple: true, onChange: (_e: unknown) => {} }; }\n`,
    'src/Upload.tsx': `import { getInputProps } from './drop';\nexport const Upload = () => <input {...getInputProps()} className="hidden" />;\n`,
  });
  const rs = rows(dir, 'src/Upload.tsx', 'input');
  assert.equal(rs.length, 1);
  const ref = refine(dir, rs);
  assert.equal(ref.note, undefined, 'the checker ran');
  assert.equal(rs[0]!.features!.attrs.type, 'file');
  assert.equal(rs[0]!.features!.typed?.spread, 'resolved');
  assert.deepEqual(ref.dropped, rs, 'an allowed type: dropped from the look-alikes');
});

test('typecheck: a spread that leaves type open makes the classifier abstain instead of a 5% penalty', () => {
  const dir = app({
    'src/Field.tsx': `type FieldProps = { type?: string; placeholder?: string };\nexport function Field(props: FieldProps) { return <input {...props} className="border px-2 h-8" />; }\n`,
  });
  const rs = rows(dir, 'src/Field.tsx', 'input');
  refine(dir, rs);
  const f = rs[0]!.features!;
  assert.equal(f.typed?.spread, 'unresolved');
  assert.deepEqual(f.typed?.open, ['type']);
  const e = classify(f);
  assert.equal(e.verdict, 'unclear');
  assert.ok(e.unclear?.some(w => /spread \(\{\.\.\.props\}\) can set type/.test(w)), JSON.stringify(e.unclear));
});

test('typecheck: a spread with nothing that decides the element is resolved, with no penalty', () => {
  const dir = app({
    'src/Save.tsx': `const handlers = { onClick: () => {}, title: 'Save' };\nexport const Save = () => <button {...handlers} className="h-8 px-3 rounded bg-primary text-primary-foreground">Save</button>;\n`,
  });
  const rs = rows(dir, 'src/Save.tsx', 'button');
  refine(dir, rs);
  const e = classify(rs[0]!.features!);
  assert.equal(rs[0]!.features!.typed?.spread, 'resolved');
  assert.equal(e.use, 'Button');
  assert.ok(!e.reasons.some(r => r.delta < 0 && /extra settings/.test(r.text)), JSON.stringify(e.reasons));
});

test('typecheck: class constants resolve to their literal classes; one that does not is unresolved', () => {
  const dir = app({
    'src/styles.ts': `declare function make(): string;\nexport const BTN = ['h-8', 'px-3', 'bg-primary', 'text-primary-foreground'].join(' ') as 'h-8 px-3 bg-primary text-primary-foreground';\nexport const ODD: string = make();\n`,
    'src/Bar.tsx': `import { BTN, ODD } from './styles';\nexport const A = () => <button onClick={go} className={BTN}>Go</button>;\nexport const B = () => <button onClick={go} className={ODD}>Odd</button>;\ndeclare const go: () => void;\n`,
  });
  const rs = rows(dir, 'src/Bar.tsx', 'button');
  refine(dir, rs);
  const [a, b] = rs.map(r => r.features!);
  assert.ok(a!.classes.tokens.includes('bg-primary'), JSON.stringify(a!.classes));
  assert.equal(classify(a!).use, 'Button');
  assert.deepEqual(b!.typed?.classes, ['ODD']);
  assert.equal(classify(b!).verdict, 'unclear');
});

test('typecheck: the system prop unions come from a use of the component', () => {
  const dir = app({
    'src/kit.tsx': `export function Button(_p: { variant?: 'default' | 'ghost' | 'link'; size?: 'sm' | 'lg'; children?: unknown }) { return null; }\n`,
    'src/Use.tsx': `import { Button } from './kit';\nexport const U = () => <Button variant="ghost">Hi</Button>;\n`,
  });
  const c = openChecker(dir, [path.join(dir, 'src/Use.tsx')]);
  assert.ok(c.ok);
  if (!c.ok) return;
  const u = c.propUnions(path.join(dir, 'src/Use.tsx'), 2, 'Button')!;
  assert.deepEqual(Object.fromEntries(Object.entries(u).map(([k, v]) => [k, [...v].sort()])), { variant: ['default', 'ghost', 'link'], size: ['lg', 'sm'] });
});

test('typecheck: without a tsconfig it skips with a note, and spreads keep the old penalty', () => {
  const dir = app({ 'src/Field.tsx': `export function Field(props: { type?: string }) { return <input {...props} className="border px-2 h-8" />; }\n` }, false);
  const rs = rows(dir, 'src/Field.tsx', 'input');
  const ref = refine(dir, rs);
  assert.equal(ref.note, 'no tsconfig.json for the app');
  const e = classify(rs[0]!.features!);
  assert.notEqual(e.verdict, 'unclear');
  assert.ok(e.reasons.some(r => r.delta === -0.05 && /No type checker ran/.test(r.text)));
});
