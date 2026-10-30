import { test } from 'vitest';
import assert from 'node:assert/strict';
import { closestRendered, compareRendered } from '../../src/engine/rendered.js';

// Rendered evidence: an element as the app draws it vs a system variant as Storybook draws it.

test('rendered comparison: px tolerance, color distance, oklch, invisible borders', async () => {
    const base = { height: 32, paddingLeft: '12px', borderRadius: '12px', backgroundColor: 'rgba(0, 0, 0, 0)', color: 'oklch(0.55 0.2 260)', borderWidth: '1px', borderColor: 'rgba(0, 0, 0, 0)', fontSize: '14px', fontWeight: '500', textDecoration: 'none' };
  const same = compareRendered({ ...base, height: 33 }, base);
  assert.equal(same.score, 1, JSON.stringify(same.diffs));
  const d = compareRendered({ ...base, borderRadius: '0px', backgroundColor: 'rgb(240, 240, 240)', borderWidth: '0px' }, base);
  assert.deepEqual(d.diffs.map(x => x.label).sort(), ['background', 'radius']);
  const c = closestRendered({ ...base, height: 28 }, { 'ghost/default': { styles: base }, 'ghost/sm': { styles: { ...base, height: 28 } } });
  assert.equal(c?.key, 'ghost/sm');
});
