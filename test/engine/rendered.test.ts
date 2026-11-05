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

// Review item 19: screenshots confirm a pick, never invent one.
import fs from 'node:fs';
import path from 'node:path';
import { applyRenderedEvidence } from '../../src/engine/rendered.js';
import { latestEvals } from '../../src/engine/index.js';
import { openStore } from '../../src/engine/store.js';
import { NOW, fixtureCopy, runPipeline } from './fixture.js';

const STYLE = { height: 32, paddingLeft: '12px', borderRadius: '6px', color: 'rgb(20, 20, 20)', borderWidth: '0px', borderColor: 'rgba(0, 0, 0, 0)', fontSize: '14px', fontWeight: '500', textDecoration: 'none' };
const FILLED = { ...STYLE, backgroundColor: 'rgb(30, 60, 200)', color: 'rgb(255, 255, 255)' };
const CLEAR = { ...STYLE, backgroundColor: 'rgba(0, 0, 0, 0)' };

async function measured(styles: Record<string, string | number>, variants: (pick: string) => Record<string, any>) {
  const root = fixtureCopy();
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const e = (await latestEvals(data)).evals.find(x => x.verdict === 'replace' && x.use)!;
  assert.ok(e, 'the fixture has a replacement');
  // Give it the signature match and resting look the scanner records (no box at rest, a ghost pick).
  e.props = { ...(e.props ?? {}), variant: 'ghost' };
  e.signature = { component: e.use!, variant: 'ghost', size: 'default', score: 0.8, matched: [], mismatched: [], structure: [] };
  e.look = { fill: false, border: 'none', fromBranch: false, toolbar: false };
  const store = await openStore(data);
  try { await store.exec('update element_evals set data=$2 where id=$1', [e.id, JSON.stringify(e)]); } finally { store.close(); }
  fs.mkdirSync(path.join(data, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(data, 'shots', 'index.json'), JSON.stringify({ shots: { [e.id]: { file: 'a.png', matchScore: 1, styles } } }));
  const sig = e.signature!;
  const components = { [sig.component]: Object.fromEntries(Object.entries(variants(sig.variant)).map(([v, st]) => [`${v}/${sig.size}`, { styles: st, story: 's' }])) };
  fs.mkdirSync(path.join(data, 'rendered'), { recursive: true });
  fs.writeFileSync(path.join(data, 'rendered', 'index.json'), JSON.stringify({ takenAt: NOW.toISOString(), source: 'test', components, notes: [] }));
  const res = await applyRenderedEvidence(data, 0.9);
  const after = (await latestEvals(data)).evals.find(x => x.id === e.id)!;
  return { before: e, after, res };
}

test('rendered evidence never switches the pick; disagreement lowers confidence and ranks the other variant below it', async () => {
  const { before, after, res } = await measured(FILLED, pick => ({ [pick]: CLEAR, other: FILLED }));
  assert.equal(res.switched, 0);
  assert.equal(res.disagreed, 1);
  assert.equal(after.props?.variant, before.props?.variant, 'the variant the classes picked stays');
  assert.equal(after.signature?.variant, before.signature?.variant);
  assert.ok(after.confidence <= 0.85, `under the review threshold (${after.confidence})`);
  assert.equal(after.alternatives[0]?.props?.variant, 'other', 'the rendered variant is offered');
  for (const a of after.alternatives) assert.ok(a.confidence <= after.confidence, `alternative ${a.confidence} above the pick ${after.confidence}`);
  assert.ok(after.reasons.some(r => /^Rendered: .*kept/.test(r.text)), JSON.stringify(after.reasons));
});

test('rendered evidence: a weak lead (under the minimum margin) changes nothing', async () => {
  const near = { ...CLEAR, fontWeight: '600' };
  const { before, after, res } = await measured(CLEAR, pick => ({ [pick]: near, other: CLEAR }));
  assert.equal(res.disagreed, 0);
  assert.equal(after.props?.variant, before.props?.variant);
  assert.equal(after.verdict, 'replace');
});

test('rendered evidence: a pick the rendering clearly contradicts, with nothing in the classes against it, becomes unclear', async () => {
  const far = { ...STYLE, height: 24, paddingLeft: '4px', borderRadius: '0px', backgroundColor: 'rgb(200, 30, 30)', color: 'rgb(255, 255, 255)' };
  const { after, res } = await measured(CLEAR, pick => ({ [pick]: far, link: CLEAR }));
  assert.equal(res.unclear, 1);
  assert.equal(after.verdict, 'unclear');
  assert.ok(after.alternatives.some(a => a.props?.variant === 'ghost') && after.alternatives.some(a => a.props?.variant === 'link'), 'both readings are offered');
  assert.ok(after.confidence < 0.85);
});
