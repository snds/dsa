import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { genericHost, githubHost, parseConfig, type HostContext } from '@snds/dsa';
import { materializeRemotes } from '@snds/dsa/engine';
import { ACME_PROFILE, ACME_ROOT, NOW, loadConfig, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { renderReport } from '../src/report.js';

// What a static publish showed wrong on a real site: counts that arrive as text and divide into NaN,
// a scan whose app repos all failed to fetch looking like empty numbers, and a Re-scan that didn't say
// where it goes.

const payloadOf = (html: string) => JSON.parse(html.match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)![1]!);

test('counts reach the page as numbers, so ratios never divide text', async () => {
  const data = tmp();
  await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW });
  const p = payloadOf(await renderReport(ACME_ROOT, loadConfig(ACME_ROOT).config, data, ACME_PROFILE, { site: true }));
  const r = p.runs.at(-1);
  for (const k of ['consumers', 'current_consumers', 'lookalikes', 'instances']) assert.equal(typeof r[k], 'number', `${k} is ${typeof r[k]}`);
  for (const t of p.targets) assert.equal(typeof t.instances, 'number');
  assert.deepEqual(p.coverage.skipped, []);
  assert.equal(p.coverage.none, false);
});

test("a repo that can't be fetched is recorded as skipped, with why", () => {
  const root = tmp();
  const base = loadConfig(ACME_ROOT).config;
  const config = { ...base, consumers: [{ name: 'remote-app', git: { url: path.join(root, 'no-such-repo.git') } }] };
  const r = materializeRemotes(config as never, root, path.join(root, '.dsa'));
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0]!.name, 'remote-app');
  assert.ok(r.skipped[0]!.why.length > 0);
  assert.match(r.notes[0]!, /Skipped it this run/);
});

test("a run whose only app repo can't be fetched finishes, and the page says no app was scanned", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'dsa.config.json'), JSON.stringify({ system: { name: 'Acme UI', packages: ['@acme/ui'] }, consumers: [{ name: 'storefront', git: { url: path.join(root, 'missing.git') } }] }));
  const { engineConfig, loadConfig: load, NEUTRAL_PROFILE, runPipeline: run, openStore } = await import('@snds/dsa');
  const config = engineConfig(load({ cwd: root }).config);
  const data = path.join(root, '.dsa');
  await run({ root, dataDir: data, config, profile: NEUTRAL_PROFILE, store: d => openStore(d), git: false });
  const p = payloadOf(await renderReport(root, config, data, NEUTRAL_PROFILE, { site: true }));
  assert.equal(p.coverage.none, true);
  assert.equal(p.coverage.skipped[0].name, 'storefront');
  assert.ok(p.runs.at(-1).consumers === 0, 'nothing measured is 0 consumers, as a number');
});

test('when no app was scanned, the page says so and why', async () => {
  const data = tmp();
  const skipped = [{ name: 'storefront', url: 'https://git.example.test/acme/storefront.git', why: 'Authentication failed' }];
  await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW });
  // As the run records it when every app repo failed to fetch.
  const store = await (await import('@snds/dsa/engine')).openStore(data);
  try {
    const [run] = await store.all<any>('select run_id, sources from runs');
    const src = JSON.parse(run.sources);
    src.apps = { scanned: [], skipped };
    await store.exec('update runs set sources = $1 where run_id = $2', [JSON.stringify(src), run.run_id]);
  } finally { store.close(); }
  const p = payloadOf(await renderReport(ACME_ROOT, loadConfig(ACME_ROOT).config, data, ACME_PROFILE, { site: true }));
  assert.equal(p.coverage.none, true);
  assert.deepEqual(p.coverage.skipped, skipped);
});

test('runs from before coverage was recorded: skips are read from the notes', async () => {
  const data = tmp();
  await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW });
  const store = await (await import('@snds/dsa/engine')).openStore(data);
  try {
    const [run] = await store.all<any>('select run_id, sources from runs');
    const src = JSON.parse(run.sources);
    delete src.apps;
    src.notes = ['Could not fetch storefront from https://git.example.test/s.git (fatal: Authentication failed). Skipped it this run. Check git credentials for that URL.'];
    await store.exec('update runs set sources = $1 where run_id = $2', [JSON.stringify(src), run.run_id]);
  } finally { store.close(); }
  const p = payloadOf(await renderReport(ACME_ROOT, loadConfig(ACME_ROOT).config, data, ACME_PROFILE, { site: true }));
  assert.deepEqual(p.coverage.skipped, [{ name: 'storefront', url: 'https://git.example.test/s.git', why: 'fatal: Authentication failed' }]);
});

test('Re-scan names where it goes and when the page changes', () => {
  const ctx = (host: unknown): HostContext => ({ root: '/', host: parseConfig({ host }).host!, config: {}, env: {}, fetch });
  const gh = githubHost.actions(ctx({ adapter: 'github', github: { repo: 'acme/site', workflow: 'pages.yml' } })).rescan;
  assert.equal(gh.label, 'Re-scan on GitHub');
  assert.match(gh.help, /pages\.yml workflow's page on GitHub in a new tab/);
  assert.match(gh.help, /Run workflow/);
  assert.match(gh.help, /updates after that run finishes deploying/);
  const link = genericHost.actions(ctx({ rescan: { url: 'https://ci.example.test/pipelines/new' } })).rescan;
  assert.equal(link.label, 'Re-scan on ci.example.test');
  assert.match(link.help, /new tab/);
  const post = genericHost.actions(ctx({ rescan: { url: 'https://hooks.example.test/scan', method: 'post' } })).rescan;
  assert.equal(post.label, 'Request a re-scan');
  assert.match(post.help, /doesn't change by itself/);
});
