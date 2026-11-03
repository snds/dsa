import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capByEvidence, cardPicks, latestEvals, ownKey, ownOf, readProposals } from '@snds/dsa/engine';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { settleProposals, wantedProposals } from '../src/rendered.js';

// A card must show its proposal drawn with its own element's content. What a card proposes depends on the
// confidence cap (a held element joins a question, and a question's pick depends on who's in it), and the
// cap depends on what's drawn. Drawing once and capping afterwards left cards pointing at proposals never
// drawn with their element's content, so they showed the story's sample. Drawing until it settles doesn't.

/** A stand-in for the Storybook render: draws whatever is wanted, exactly, with the element's own content. */
async function drawWanted(o: { dataDir: string; config: any }) {
  const want = await wantedProposals(o.dataDir, o.config.review?.threshold);
  const items: Record<string, any> = { ...readProposals(o.dataDir) };
  fs.mkdirSync(path.join(o.dataDir, 'rendered'), { recursive: true });
  for (const [k, p] of want) if (!items[k]) { fs.writeFileSync(path.join(o.dataDir, 'rendered', `${items.length ?? 0}-${Object.keys(items).length}.png`), ''); items[k] = { use: p.use, props: p.props, check: 'exact', shot: `${Object.keys(items).length}.png`, ...(p.own ? { own: true } : {}), hash: 'x' }; }
  fs.writeFileSync(path.join(o.dataDir, 'rendered', 'proposals.json'), JSON.stringify({ items }));
  return { rendered: 0, reused: 0, exact: 0 };
}

/** Cards whose element's own-content proposal isn't drawn: they'd show the story's sample. */
async function sampleShown(dataDir: string) {
  const { evals } = await latestEvals(dataDir);
  let shots: Record<string, any> = {};
  try { shots = JSON.parse(fs.readFileSync(path.join(dataDir, 'shots', 'index.json'), 'utf8')).shots ?? {}; } catch { /* none */ }
  const have = readProposals(dataDir);
  const out: string[] = [];
  for (const c of cardPicks(dataDir, evals, 0.9)) for (const id of c.ids) {
    const e = evals.find(x => x.id === id)!;
    const own = ownOf(e, shots[id]);
    if (c.auto?.verdict === 'replace' && c.auto.use && own && !have[ownKey(c.auto.use, c.auto.props, own)]) out.push(id);
  }
  return out;
}

async function setup() {
  const root = fixtureCopy();
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  // Photos of every element: once their proposals are drawn, the cap lifts and cards change.
  const { evals } = await latestEvals(data);
  fs.mkdirSync(path.join(data, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(data, 'shots', 'index.json'), JSON.stringify({ shots: Object.fromEntries(evals.map(e => [e.id, { file: 'a.png', matchScore: 1 }])) }));
  return { root, data, config: loadConfig(root).config as any };
}

test('the loop: a cap after the last draw changes what cards propose; settling draws that too', async () => {
  // Modelled on the run: each draw lifts the cap on what it drew, and a lifted cap moves the cards that are
  // left to a new pick (a question's size is picked from whoever is still in it).
  const dataDir = fs.mkdtempSync(path.join(fixtureCopy(), '.settle-'));
  let state = 0;
  const wants = [['Button|size=sm#a'], ['Button|size=sm#a', 'Button|size=default#b'], ['Button|size=sm#a', 'Button|size=default#b']];
  const want = async () => new Map(wants[Math.min(state, 2)]!.map(k => [k, { use: 'Button', props: {} }]));
  const draw = async () => {
    const items = { ...readProposals(dataDir) } as Record<string, any>;
    for (const k of (await want()).keys()) items[k] ??= { use: 'Button', props: {}, check: 'exact', shot: 'p.png', own: true };
    fs.mkdirSync(path.join(dataDir, 'rendered'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'rendered', 'proposals.json'), JSON.stringify({ items }));
  };
  const cap = async () => { if (Object.keys(readProposals(dataDir)).length) state++; return 0; };
  const missing = async () => [...(await want()).keys()].filter(k => !readProposals(dataDir)[k]);
  // The old order: draw once, then cap. A card is left proposing what was never drawn.
  await draw();
  await cap();
  assert.deepEqual(await missing(), ['Button|size=default#b']);
  // Settling: cap, draw what's newly wanted, until nothing is.
  const config = { review: { threshold: 0.9 } } as any;
  await settleProposals({ root: '', config, dataDir }, { render: draw, cap, want: want as any });
  assert.deepEqual(await missing(), []);
});

test('settling draws until the cards and the drawings agree', async () => {
  const { root, data, config } = await setup();
  const rounds = await settleProposals({ root, config, dataDir: data }, { render: drawWanted });
  assert.ok(rounds >= 1);
  assert.deepEqual(await sampleShown(data), []);
  // Settled: another pass draws nothing.
  assert.equal(await settleProposals({ root, config, dataDir: data }, { render: drawWanted }), 0);
});
