import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { NotLiveError, deployFor, localHistory, parseConfig, type Deploy, type EngineContext } from '@snds/dsa';
import { ACME_PROFILE, ACME_ROOT, NOW, contextFor, loadConfig, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { startServer } from '../src/server.js';
import { publish } from '../src/publish.js';

// Hosting modes: dsa serve under a sub-path behind a proxy, its Run button's live check, and the
// published site carrying the host adapter's actions and the scanned revision.

const freePort = () => new Promise<number>(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });
const request = (port: number, p: string, host: string) => new Promise<{ status: number; location?: string | undefined }>((ok, fail) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, r => { r.resume(); ok({ status: r.statusCode ?? 0, location: r.headers.location }); }).on('error', fail);
});
const payloadOf = (html: string) => JSON.parse(html.match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)![1]!);

const LIVE = { state: 'live', ok: true, label: 'Scanned 1234567, the live revision (env GITHUB_SHA).', head: '1234567abcdef', revision: { sha: '1234567abcdef', via: 'env GITHUB_SHA', liveAt: '2026-10-05T10:00:00Z' } };

test('serve: mounted under /dsa/ behind a proxy, with the public host name allowed', async () => {
  const data = tmp();
  await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW });
  const port = await freePort();
  const s = await startServer({ load: async () => contextFor(ACME_ROOT, data), port, addons: [], log: () => {}, base: '/dsa/', allowHosts: ['dsa.example.test'] });
  try {
    assert.equal(s.url, `http://localhost:${port}/dsa/`);
    assert.deepEqual(await request(port, '/dsa', 'dsa.example.test'), { status: 301, location: '/dsa/' });
    assert.equal((await request(port, '/dsa/', 'dsa.example.test')).status, 200, 'the public name is accepted');
    assert.equal((await request(port, '/dsa/', 'evil.example')).status, 403);
    const html = await (await fetch(`http://127.0.0.1:${port}/dsa/`)).text();
    const payload = payloadOf(html);
    assert.equal(payload.base, '/dsa/', 'the page sends its API calls under the mount path');
    assert.equal(payload.actions, null, 'the live server needs no static actions');
    assert.equal((await fetch(`http://127.0.0.1:${port}/dsa/api/settings`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/settings`)).status, 404, 'nothing answers outside the mount path');
  } finally { await s.close(); }
});

test('serve: listening beyond localhost needs the public host name', async () => {
  const data = tmp();
  await assert.rejects(startServer({ load: async () => contextFor(ACME_ROOT, data), port: await freePort(), addons: [], log: () => {}, host: '0.0.0.0' }), /--allow-host/);
});

test("serve: the Run button refuses a checkout that isn't live, as dsa run does", async () => {
  const data = tmp();
  await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW });
  const port = await freePort();
  const notLive = { state: 'other-commit', ok: false, head: 'aaaaaaa', revision: { sha: 'bbbbbbb', via: 'test' }, label: 'The checkout is aaaaaaa but bbbbbbb is live (test).' } as const;
  const deploy = async (_c: EngineContext) => ({ ...deployFor({ root: ACME_ROOT, config: loadConfig(ACME_ROOT).config }), history: localHistory.create({} as never), check: async () => { throw new NotLiveError(notLive as never); } }) as Deploy;
  const s = await startServer({ load: async () => contextFor(ACME_ROOT, data), port, addons: [], log: () => {}, deploy });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/run`, { method: 'POST', headers: { 'X-DSA': '1' } });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /bbbbbbb is live/);
  } finally { await s.close(); }
});

test('publish: the static site carries the host adapter\'s buttons and the revision it scanned', async () => {
  const data = tmp();
  await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW, sources: { live: LIVE } });
  const config = { ...loadConfig(ACME_ROOT).config, ...parseConfig({ host: { adapter: 'github', github: { repo: 'acme/site', workflow: 'dsa.yml' } } }) };
  const actions = deployFor({ root: ACME_ROOT, config: config as never, env: {} }).actions();
  const out = path.join(tmp(), 'site');
  await publish(ACME_ROOT, config as never, data, ACME_PROFILE, out, actions);
  const payload = payloadOf(fs.readFileSync(path.join(out, 'index.html'), 'utf8'));
  assert.equal(payload.serve, false);
  assert.equal(payload.base, null, 'a published page uses relative links, so it works under any sub-path');
  assert.equal(payload.actions.rescan.kind, 'run');
  assert.equal(payload.actions.rescan.fallbackUrl, 'https://github.com/acme/site/actions/workflows/dsa.yml');
  assert.equal(payload.actions.decisions.kind, 'issue');
  assert.deepEqual(payload.live, { state: 'live', ok: true, unreleased: false, label: LIVE.label, head: LIVE.head, revision: LIVE.revision });

  // A labelled run (onMismatch "label") says so on the page.
  const data2 = tmp();
  await runPipeline({ root: ACME_ROOT, dataDir: data2, git: false, now: NOW, sources: { live: { ...LIVE, state: 'other-commit', ok: false, unreleased: true, label: 'NOT LIVE: …' } } });
  await publish(ACME_ROOT, config as never, data2, ACME_PROFILE, out, actions);
  assert.equal(payloadOf(fs.readFileSync(path.join(out, 'index.html'), 'utf8')).live.unreleased, true);
});

test('the page carries how long a scan usually takes, from recorded scans', async () => {
  const { recordScanTime } = await import('@snds/dsa');
  const data = tmp();
  await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW });
  for (const s of [100, 300, 200]) recordScanTime(data, s * 1000);
  const config = { ...loadConfig(ACME_ROOT).config, ...parseConfig({ host: { adapter: 'github', github: { repo: 'acme/site' } } }) };
  const out = path.join(tmp(), 'site');
  await publish(ACME_ROOT, config as never, data, ACME_PROFILE, out, deployFor({ root: ACME_ROOT, config: config as never, env: {} }).actions());
  const payload = payloadOf(fs.readFileSync(path.join(out, 'index.html'), 'utf8'));
  assert.equal(payload.actions.rescan.estimateSeconds, 200, 'the median of the recorded scans');
  assert.equal(payload.scanEstimate, 200);
});
