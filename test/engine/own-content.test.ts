import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { contentHash, iconInSource, ownOf } from '../../src/engine/index.js';
import { NOW, fixtureCopy, runPipeline } from './fixture.js';

// An element's own content, to draw its proposal with: from its photo when there is one, else from its
// source (its words, its accessible name, and the icon component inside it).

test('no photo: the icon component its JSX holds, so its proposal can draw that icon', () => {
  const snippet = '<Button variant="ghost" aria-label="Add row" onClick={() => add()}>';
  const e = { match: { tag: 'Button', classes: [], text: '', ariaLabel: 'Add row' }, snippet, source: `${snippet}<PlusIcon className="size-4" /></Button>` } as any;
  assert.equal(iconInSource(e), 'PlusIcon');
  assert.deepEqual(ownOf(e, null), { text: undefined, ariaLabel: 'Add row', icon: undefined, iconName: 'PlusIcon' });
  // A photo's icon wins: the markup, not the name.
  const shot = { content: { text: null, ariaLabel: 'Add row', icon: '<svg viewBox="0 0 16 16"></svg>' } } as any;
  assert.equal(ownOf(e, shot)!.iconName, undefined);
  // The arrow in its handler isn't the end of its opening tag.
  assert.equal(iconInSource({ snippet, source: `${snippet}Add</Button>` }), undefined);
});

test('no photo: an icon written inline in its JSX, as plain markup (no handlers, classes or expressions)', () => {
  const snippet = '<button className="icon-btn" aria-label="Refresh" onClick={refresh}>';
  const e = { match: { tag: 'button', classes: ['icon-btn'], text: '', ariaLabel: 'Refresh' }, snippet, source: `${snippet}<svg className="icon" viewBox="0 0 16 16" onLoad={x}><path d="M8 2a6 6 0 1 0 6 6" strokeWidth="2" /></svg></button>` } as any;
  // A handler that's an expression: not plain markup, left out.
  assert.equal(ownOf(e, null)!.icon, undefined);
  e.source = `${snippet}<svg className="icon" viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 0 6 6" strokeWidth="2" /></svg></button>`;
  assert.equal(ownOf(e, null)!.icon, '<svg data-slot="icon" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 0 6 6" stroke-width="2"/></svg>');
});

test('content without an icon name hashes as it did before (cached drawings stay valid)', () => {
  assert.equal(contentHash({ text: 'Save' }), contentHash({ text: 'Save', iconName: undefined }));
  assert.notEqual(contentHash({ ariaLabel: 'Add' }), contentHash({ ariaLabel: 'Add', iconName: 'PlusIcon' }));
  assert.equal(contentHash({}), null);
});

test('signatures keep the classes each prop value adds, to confirm props without data attributes', async () => {
  const root = fixtureCopy();
  fs.cpSync(path.resolve(import.meta.dirname, '../fixtures/review-demo'), root, { recursive: true });
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const sigs = JSON.parse(fs.readFileSync(path.join(data, 'signatures.json'), 'utf8'));
  const toggle = sigs.find((c: any) => c.component === 'Toggle');
  assert.deepEqual(toggle.axisClasses, { variant: { default: ['ds-toggle-plain'], outline: ['ds-toggle-outline'] }, size: { default: ['ds-toggle-md'], sm: ['ds-toggle-sm'] } });
  assert.deepEqual(sigs.find((c: any) => c.component === 'Button').axisClasses.size.sm, ['h-8', 'px-3']);
});
