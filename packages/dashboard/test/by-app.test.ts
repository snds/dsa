import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ACME_PROFILE, NOW, contextFor, fixtureCopy, loadConfig, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { renderReport } from '../src/report.js';

// The dashboard's app selector filters on the page, so the report carries each measure per app: a
// component's uses and look-alikes, each run's measures (Overview's cards, Trends' lines), and the
// model's app uses. Each app's numbers add up to the all-apps number.

const payloadOf = (html: string) => JSON.parse(html.match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)![1]!);

test('per-app counts add up to the totals, and match the Apps table', async () => {
  const root = fixtureCopy();
  const data = tmp();
  const dsaConfig = contextFor(root, data).loaded.config;
  await runPipeline({ root, dataDir: data, git: false, now: NOW, dsaConfig });
  await runPipeline({ root, dataDir: data, git: false, now: new Date(NOW.getTime() + 86400000), dsaConfig });
  const p = payloadOf(await renderReport(root, loadConfig(root).config, data, ACME_PROFILE, { site: true }));
  const apps = p.targets.map((t: any) => t.name);
  assert.ok(apps.length > 1, 'the fixture has several apps');

  for (const c of p.components) {
    const parts = Object.values(c.byTarget) as any[];
    assert.equal(parts.reduce((a, b) => a + b.instances, 0), Number(c.instances), `${c.component} instances`);
    assert.equal(parts.reduce((a, b) => a + b.lookalikes, 0), Number(c.lookalikes), `${c.component} look-alikes`);
    for (const t of Object.keys(c.byTarget)) assert.ok(apps.includes(t), `${t} is an app`);
  }

  const last = p.runs.at(-1);
  assert.equal(p.runs.length, 2);
  for (const t of p.targets) {
    const m = last.byTarget[t.name];
    assert.ok(m, `${t.name} has measures in the last run`);
    assert.equal(m.instances, t.instances, `${t.name} instances`);
    assert.equal(m.lookalikes, t.lookalikes, `${t.name} look-alikes`);
    assert.equal(m.correct_use, t.correctUse, `${t.name} used as intended`);
    assert.equal(m.majors, t.worstMajors, `${t.name} majors behind`);
    assert.equal(typeof m.instances, 'number');
  }
  assert.equal(Object.values(last.byTarget).reduce((a: number, m: any) => a + m.lookalikes, 0), last.lookalikes);
  assert.ok(p.runs[0].byTarget[apps[0]], 'earlier runs carry per-app measures too');

  const used = p.model.components.filter((c: any) => c.uses.consumer > 0);
  assert.ok(used.length, 'the model counts app uses');
  for (const c of used) {
    const parts = Object.entries(c.uses.byTarget) as [string, any][];
    assert.ok(parts.length, `${c.name} has uses by app`);
    assert.ok(parts.reduce((a, [, u]) => a + u.consumer, 0) <= c.uses.consumer, `${c.name}: by-app uses never exceed the total`);
    for (const [t, u] of parts) { assert.ok(apps.includes(t), `${t} is an app`); assert.ok(u.files > 0 && u.files <= c.uses.files); }
  }
});
