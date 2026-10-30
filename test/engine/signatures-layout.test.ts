import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSignatures, componentFiles } from '../../src/engine/signatures.js';

const comp = (name: string, cls: string) => `import { cva } from 'class-variance-authority';
const v = cva('${cls}', { variants: { variant: { default: 'bg-primary', ghost: 'bg-transparent' } }, defaultVariants: { variant: 'default' } });
export function ${name}({ variant, ...props }: { variant?: 'default' | 'ghost' }) {
  return <button data-slot="${name.toLowerCase()}" className={v({ variant })} {...props} />;
}
`;

function pkg(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-sig-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@acme/ui' }));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}
const rel = (dir: string) => (f: string) => path.relative(path.join(dir, 'src'), f);

describe('signatures read components wherever the package keeps its public ones', () => {
  it('finds re-exported components in subfolders of src', () => {
    const dir = pkg({
      'src/index.ts': 'export * from "./components/ui/button"\n',
      'src/components/ui/button.tsx': comp('Button', 'inline-flex h-9'),
    });
    const sigs = buildSignatures([{ dir, name: '@acme/ui' }]);
    expect([...sigs.components.keys()]).toEqual(['Button']);
    expect(sigs.components.get('Button')!.axes.variant).toEqual(['default', 'ghost']);
  });

  it('follows barrels, and skips internals, vendor, tests and stories', () => {
    const dir = pkg({
      'src/index.ts': 'export * from "./ui"\nexport { Card } from "./cards/card"\n',
      'src/ui/index.ts': 'export * from "./badge"\n',
      'src/ui/badge.tsx': comp('Badge', 'b'),
      'src/cards/card.tsx': comp('Card', 'c'),
      'src/features/grid/cell.tsx': comp('Cell', 'internal'),
      'src/top.tsx': comp('Top', 't'),
      'src/vendor/shadcn/button.tsx': comp('Button', 'stock'),
      'src/button.test.tsx': comp('T', 't'),
      'src/__tests__/x.tsx': comp('X', 'x'),
      'src/x.stories.tsx': comp('S', 's'),
    });
    expect(componentFiles(path.join(dir, 'src')).map(rel(dir))).toEqual(['top.tsx', path.join('cards', 'card.tsx'), path.join('ui', 'badge.tsx')]);
  });

  it('a component deeper in src never replaces one at the top', () => {
    const dir = pkg({
      'src/index.ts': 'export * from "./tips/tip"\n',
      'src/tip.tsx': comp('Tip', 'top-level'),
      'src/tips/tip.tsx': comp('Tip', 'nested'),
    });
    const sig = buildSignatures([{ dir, name: '@acme/ui' }]).components.get('Tip')!;
    expect(rel(dir)(sig.file)).toBe('tip.tsx');
  });
});
