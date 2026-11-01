import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { deployFor, parseConfig, workflowCrons } from '@snds/dsa';
import { ACME_PROFILE, ACME_ROOT, NOW, contextFor, loadConfig, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { nextRun, nextScheduled, parseCron } from '../ui/src/lib/cron.js';
import { publish } from '../src/publish.js';
import { startServer } from '../src/server.js';

// When the next scheduled scan runs: declared in the config, or read from the GitHub workflow, and
// shown on the page in the viewer's time.

const at = (iso: string) => new Date(iso);
const payloadOf = (html: string) => JSON.parse(html.match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)![1]!);

test('reads cron lines as CI does: UTC, lists, ranges, steps, names, either day field', () => {
  // Weekdays at 09:47 UTC. Friday 10:00 → Monday 09:47.
  assert.equal(nextRun('47 9 * * 1-5', at('2026-10-30T10:00:00Z'))!.toISOString(), '2026-11-02T09:47:00.000Z');
  assert.equal(nextRun('47 9 * * MON-FRI', at('2026-11-02T09:46:30Z'))!.toISOString(), '2026-11-02T09:47:00.000Z');
  assert.equal(nextRun('*/15 * * * *', at('2026-10-31T12:07:00Z'))!.toISOString(), '2026-10-31T12:15:00.000Z');
  assert.equal(nextRun('0 0 1 jan *', at('2026-10-31T00:00:00Z'))!.toISOString(), '2027-01-01T00:00:00.000Z');
  // Both day fields set: the 1st of the month or any Sunday, whichever comes first.
  assert.equal(nextRun('0 6 1 * 0', at('2026-10-27T00:00:00Z'))!.toISOString(), '2026-11-01T06:00:00.000Z');
  assert.equal(nextRun('0 6 * * 7', at('2026-10-27T00:00:00Z'))!.toISOString(), '2026-11-01T06:00:00.000Z', '7 is Sunday too');
  assert.equal(parseCron('61 * * * *'), null);
  assert.equal(parseCron('@daily'), null);
  assert.equal(nextRun('0 0 30 2 *'), null, 'never fires');
  // The soonest of two workflows' schedules.
  assert.equal(nextScheduled(['37 10 * * 1-5', '47 9 * * 1-5'], at('2026-11-02T09:50:00Z'))!.toISOString(), '2026-11-02T10:37:00.000Z');
  assert.equal(nextScheduled([], at('2026-11-02T09:50:00Z')), null);
});

test('the github adapter reads the schedule from its workflow file; config wins', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'pages.yml'), 'name: pages\non:\n  push: { branches: [main] }\n  schedule:\n    - cron: "47 9 * * 1-5"\n  workflow_dispatch:\n');
  assert.deepEqual(workflowCrons(root, 'pages.yml'), ['47 9 * * 1-5']);
  assert.deepEqual(workflowCrons(root, 'missing.yml'), []);
  const base = { designSystem: { core: { name: 'c', packages: [] } } };
  const gh = deployFor({ root, config: { ...base, ...parseConfig({ host: { adapter: 'github', github: { repo: 'a/b', workflow: 'pages.yml' } } }) } as never, env: {} });
  assert.deepEqual(gh.actions().schedule, ['47 9 * * 1-5']);
  const own = deployFor({ root, config: { ...base, ...parseConfig({ host: { adapter: 'github', github: { repo: 'a/b', workflow: 'pages.yml' }, schedule: ['0 3 * * *'] } }) } as never, env: {} });
  assert.deepEqual(own.schedule(), ['0 3 * * *']);
  assert.deepEqual(deployFor({ root, config: { ...base, ...parseConfig({ host: { schedule: ['0 3 * * *'] } }) } as never }).schedule(), ['0 3 * * *'], 'generic: from the config');
  assert.deepEqual(deployFor({ root, config: base as never }).schedule(), []);
});

const freePort = () => new Promise<number>(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });

test('the schedule reaches the page, published or served', async () => {
  const data = tmp();
  await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW });
  const config = { ...loadConfig(ACME_ROOT).config, ...parseConfig({ host: { schedule: ['47 9 * * 1-5'] } }) };
  const out = path.join(tmp(), 'site');
  await publish(ACME_ROOT, config as never, data, ACME_PROFILE, out, deployFor({ root: ACME_ROOT, config: config as never }).actions());
  assert.deepEqual(payloadOf(fs.readFileSync(path.join(out, 'index.html'), 'utf8')).schedule, ['47 9 * * 1-5']);
  const port = await freePort();
  const s = await startServer({ load: async () => contextFor(ACME_ROOT, data), port, addons: [], log: () => {}, deploy: async () => deployFor({ root: ACME_ROOT, config: config as never }) });
  try {
    assert.deepEqual(payloadOf(await (await fetch(`http://127.0.0.1:${port}/`)).text()).schedule, ['47 9 * * 1-5']);
  } finally { await s.close(); }
});
