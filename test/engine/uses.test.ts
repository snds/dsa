import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findUses } from '../../src/engine/uses.js';

// Where an app already uses the system's components: props across lines; through a local file that
// re-exports a package; through a vendored copy of the package; and how much of the app was read.

function app(files: Record<string, string>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-uses-')));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return dir;
}

test('a multi-line use, through a local re-export of the package, is found with its props', () => {
  const dir = app({
    'src/ui/button.tsx': 'export * from "@acme/kit/button";\n',
    'src/ui/index.ts': 'export { Button as Btn } from "./button";\n',
    'src/A.tsx': `import { Button } from "./ui/button";
export const A = () => (
  <Button
    variant="outline"
    size="xs"
    type="button"
    onClick={() => {}}
  >Save</Button>
);
`,
    'src/B.tsx': 'import { Btn } from "./ui";\nexport const B = (p: any) => <Btn size={p.s} variant="ghost" {...p} />;\n',
  });
  const r = findUses({ dir, packages: ['@acme/kit'] });
  assert.equal(r.files, 3);
  assert.equal(r.unread, 0);
  const a = r.uses.find(u => u.file.endsWith('A.tsx'))!;
  assert.deepEqual([a.component, a.line, a.props], ['Button', 3, { variant: 'outline', size: 'xs', type: 'button' }]);
  const b = r.uses.find(u => u.file.endsWith('B.tsx'))!;
  assert.deepEqual([b.component, b.props, b.dynamic], ['Button', { variant: 'ghost' }, ['size', '...']]);
});

test('a vendored copy of the package counts; a local component of the same name does not; parts lose their dot', () => {
  const dir = app({
    'vendor/kit/package.json': '{"name":"@acme/kit"}',
    'vendor/kit/src/menu.tsx': 'export const Menu = {} as any;\nexport const MenuItem = (p: any) => null;\n',
    'src/Local.tsx': 'export const MenuItem = (p: any) => null;\n',
    'src/A.tsx': 'import { MenuItem } from "../vendor/kit/src/menu";\nexport const A = () => <MenuItem inset />;\n',
    'src/B.tsx': 'import { MenuItem } from "./Local";\nexport const B = () => <MenuItem />;\n',
    'src/C.tsx': 'import * as Kit from "@acme/kit/menu";\nexport const C = () => <Kit.MenuItem />;\n',
  });
  const r = findUses({ dir, packages: ['@acme/kit'], exclude: [path.join(dir, 'vendor')], wanted: new Set(['MenuItem']) });
  assert.deepEqual(r.uses.map(u => [path.basename(u.file), u.component, u.props]).sort(), [['A.tsx', 'MenuItem', { inset: 'true' }], ['C.tsx', 'MenuItem', {}]]);
});

test('a file it cannot parse is counted, so the search does not claim to have read the app', () => {
  const dir = app({ 'src/Bad.tsx': 'export const = <<<;\n', 'src/Ok.tsx': 'export const X = () => <div />;\n' });
  const r = findUses({ dir, packages: ['@acme/kit'] });
  assert.deepEqual([r.files, r.unread], [2, 1]);
});

test('a thin local wrapper of the same name counts as the system component', () => {
  const dir = app({
    'src/ui/input.tsx': 'import { Input as KitInput } from "@acme/kit/input";\nconst Input = (p: any) => <KitInput {...p} />;\nexport { Input };\n',
    'src/A.tsx': 'import { Input } from "./ui/input";\nexport const A = () => <Input size="sm" />;\n',
  });
  const r = findUses({ dir, packages: ['@acme/kit'], wanted: new Set(['Input']) });
  assert.ok(r.uses.some(u => u.file.endsWith('A.tsx') && u.props.size === 'sm'));
});
