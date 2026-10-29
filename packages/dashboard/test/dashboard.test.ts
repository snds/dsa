import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decideMany, latestEvals, openStore, type Http } from '@snds/dsa/engine';
import { ACME_PROFILE, ACME_ROOT, contextFor, fixtureCopy, loadConfig, NOW, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { buildQueue, createIssues, syncLinks } from '../src/queue.js';
import { publish } from '../src/publish.js';
import { readView, saveView } from '../src/server.js';

// The dashboard's server side: Settings, the action queue, and the published site.

const ROOT = ACME_ROOT;

test('settings save: validates, logs rule changes, keeps tokens out of the config', async () => {
  const root = fixtureCopy();
  const data = tmp();
  const ctx = () => contextFor(root, data);
  const bad = await saveView(ctx(), { report: { timeZone: 'Mars/Olympus' } });
  assert.equal(bad.saved.length, 0);
  assert.ok(bad.errors[0].includes('time zone'));
  const ok = await saveView(ctx(), {
    report: { timeZone: 'America/Los_Angeles', title: 'Acme' },
    figma: { libraries: [{ name: 'Core', url: 'https://www.figma.com/design/AbCdEf1234567/Core' }], links: [{ url: 'https://www.figma.com/files/team/555/Acme' }], editedWithinDays: 30, maxFiles: 20 },
    rules: { misuse_cluster_threshold: 4 },
    secrets: { figmaToken: 'figd_supersecret_value_9999' },
  });
  assert.deepEqual(ok.errors, []);
  const cfgText = fs.readFileSync(path.join(root, 'dsa.config.json'), 'utf8');
  assert.ok(!cfgText.includes('supersecret'), 'tokens never land in dsa.config.json');
  assert.ok(cfgText.includes('AbCdEf1234567'));
  const view = readView(ctx());
  if (!process.env.FIGMA_TOKEN) assert.equal(view.figma.token, 'figd…9999');
  assert.equal(view.rules.misuse_cluster_threshold, 4);
  assert.equal(view.report.timeZone, 'America/Los_Angeles');
  const store = await openStore(data);
  try { assert.equal((await store.all('select * from settings_log')).length, 1); } finally { store.close(); }
  assert.equal((fs.statSync(path.join(data, 'secrets.json')).mode & 0o777), 0o600);
});

test('queue: approvals become items, get issues, and close to done; the prompt covers them', async () => {
  const root = fixtureCopy();
  const data = path.join(root, '.dsa');
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const { config } = loadConfig(root);
  const { evals } = await latestEvals(data, 'reporting');
  const pick = evals.filter(e => e.verdict === 'replace' && e.use && !e.exception).slice(0, 2);
  assert.ok(pick.length, 'fixture has replaceable elements');
  const decision = { verdict: 'replace' as const, role: pick[0].role, use: pick[0].use, props: pick[0].props ?? {} };
  await decideMany(root, config, data, { ids: pick.map(e => e.id) }, decision, 'Sean');
  let q = await buildQueue(root, config, data);
  const a = q.items.find(i => i.kind === 'approval')!;
  assert.ok(a && a.status === 'open' && a.ids!.length === pick.length);
  assert.ok(a.issue.title.startsWith(`[${a.id}] Replace`) && a.issue.body.includes(`dsa:approval ${a.id}`));
  assert.ok(q.prompt.includes(a.id) && q.prompt.includes('Ground rules'));
  // Same group, same id on a rebuild.
  assert.equal((await buildQueue(root, config, data)).items.find(i => i.kind === 'approval')!.id, a.id);

  let state = 'open';
  const calls: string[] = [];
  const http: Http = async (method, url, body: any) => {
    calls.push(`${method} ${url.split('?')[0]}`);
    if (method === 'POST') return { number: 42, html_url: `https://github.com/acme/x/issues/42`, title: body.title, updated_at: NOW.toISOString() };
    if (method === 'GET' && url.includes('labels=ds-approval')) return [{ number: 42, state, title: a.issue.title, body: a.issue.body, html_url: 'https://github.com/acme/x/issues/42', assignees: [{ login: 'olga' }], comments: 3, closed_at: state === 'closed' ? NOW.toISOString() : null }];
    return [];
  };
  (config as any).github = { ...(config.github ?? {}), defaultRepo: 'acme/x' };
  const r = await createIssues(root, config, data, [a.id], { http });
  assert.deepEqual(r.created.map(x => x.id), [a.id]);
  const again = await createIssues(root, config, data, [a.id], { http });
  assert.equal(again.created.length, 0, 'no duplicate while the issue is open');
  await syncLinks(root, config, data, { force: true, http });
  q = await buildQueue(root, config, data);
  assert.deepEqual(q.items.find(i => i.id === a.id)!.link?.assignees, ['olga']);
  state = 'closed';
  await syncLinks(root, config, data, { force: true, http });
  q = await buildQueue(root, config, data);
  const done = q.items.find(i => i.id === a.id)!;
  assert.equal(done.status, 'done');
  assert.ok(done.stillDetected, 'closed, but the elements are still in the code');
  assert.ok(!q.prompt.includes(a.id), 'done items leave the prompt');
});

test('publish: a static folder for Pages with site-relative images, only the ones the page shows, and no live mode', async () => {
  const data = tmp();
  await runPipeline({ root: ROOT, dataDir: data, git: false, now: NOW, readiness: false });
  // Two screenshots on disk; the index names only one of them, so only that one ships.
  fs.mkdirSync(path.join(data, 'shots'), { recursive: true });
  const store = await openStore(data);
  const id = (await store.all<any>('select id from element_evals limit 1'))[0]?.id;
  store.close();
  assert.ok(id, 'the fixture has evaluated elements');
  fs.writeFileSync(path.join(data, 'shots', 'kept.png'), 'png');
  fs.writeFileSync(path.join(data, 'shots', 'stale.png'), 'png');
  if (id) fs.writeFileSync(path.join(data, 'shots', 'index.json'), JSON.stringify({ shots: { [id]: { file: 'kept.png', matchScore: 0.9, page: '/' } }, missing: [] }));
  const out = path.join(tmp(), 'site');
  const r = await publish(ROOT, loadConfig(ROOT).config, data, ACME_PROFILE, out);
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const payload = JSON.parse(html.match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)![1]);
  assert.equal(payload.serve, false, 'the published copy never talks to a server');
  assert.equal(payload.published, true);
  if (id) {
    assert.ok(html.includes('"shots/kept.png"'), 'image paths are relative to the page');
    assert.ok(fs.existsSync(path.join(out, 'shots', 'kept.png')));
    assert.equal(fs.existsSync(path.join(out, 'shots', 'stale.png')), false, 'unreferenced images stay out of the commit');
    assert.equal(r.shots, 1);
  }
  assert.ok(!html.includes(data), 'no local data path in the page');
  assert.equal(payload.label, 'Acme', "the system's name comes from its profile");
});
