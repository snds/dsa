import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { deployFor, parseConfig } from '@snds/dsa';
import { createRelay, relayOptionsFromEnv } from '@snds/dsa/relay';
import { ACME_PROFILE, ACME_ROOT, NOW, contextFor, loadConfig, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { publish } from '../src/publish.js';
import { startServer } from '../src/server.js';

// The scan relay rides along in dsa serve, and a published page knows where it is.

const freePort = () => new Promise<number>(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });
const payloadOf = (html: string) => JSON.parse(html.match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)![1]!);

test('dsa serve mounts the relay at its public path, beside the dashboard', async () => {
  const data = tmp();
  await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW });
  const port = await freePort();
  const publicUrl = `http://localhost:${port}/relay/`;
  const env = { DSA_RELAY_URL: publicUrl, DSA_RELAY_ORIGINS: 'https://acme.example.test', DSA_RELAY_SESSION_SECRET: 'x'.repeat(40), DSA_RELAY_CLIENT_ID: 'id', DSA_RELAY_CLIENT_SECRET: 'secret', DSA_RELAY_REPO: 'acme/site', DSA_RELAY_RUNNER_TOKEN: 'runner' };
  const s = await startServer({ load: async () => contextFor(ACME_ROOT, data), port, addons: [], log: () => {}, relay: { handler: createRelay(relayOptionsFromEnv(env)), publicUrl } });
  try {
    const who = await fetch(`http://localhost:${port}/relay/session`, { headers: { Origin: 'https://acme.example.test' } });
    assert.equal(who.status, 200);
    assert.equal(who.headers.get('access-control-allow-origin'), 'https://acme.example.test');
    assert.deepEqual(await who.json(), { signedIn: false, login: null, permission: null, canScan: false, minPermission: 'write', provider: 'GitHub', resource: 'acme/site', signIn: `${publicUrl}auth/start` });
    // The relay's own checks, not the dashboard's X-DSA header.
    assert.equal((await fetch(`http://localhost:${port}/relay/scan`, { method: 'POST', headers: { Origin: 'https://acme.example.test', 'X-DSA-Relay': '1' } })).status, 401);
    assert.equal((await fetch(`http://localhost:${port}/`)).status, 200, 'the dashboard is still there');
  } finally { await s.close(); }
});

test('publish writes the relay into the page; without one, Re-scan says how to add it', async () => {
  const data = tmp();
  await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW });
  const base = loadConfig(ACME_ROOT).config;
  const out = path.join(tmp(), 'site');
  const withRelay = { ...base, ...parseConfig({ host: { adapter: 'github', github: { repo: 'acme/site' }, relay: { url: 'https://relay.example.test' } } }) };
  await publish(ACME_ROOT, withRelay as never, data, ACME_PROFILE, out, deployFor({ root: ACME_ROOT, config: withRelay as never, env: {} }).actions());
  const p = payloadOf(fs.readFileSync(path.join(out, 'index.html'), 'utf8'));
  assert.equal(p.actions.rescan.kind, 'relay');
  assert.equal(p.actions.rescan.url, 'https://relay.example.test/');
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /DSA_RELAY_|runner-token|client_secret/, 'no relay secret reaches the page');
  const without = { ...base, ...parseConfig({ host: { adapter: 'github', github: { repo: 'acme/site' } } }) };
  await publish(ACME_ROOT, without as never, data, ACME_PROFILE, out, deployFor({ root: ACME_ROOT, config: without as never, env: {} }).actions());
  const q = payloadOf(fs.readFileSync(path.join(out, 'index.html'), 'utf8'));
  assert.equal(q.actions.rescan.kind, 'none');
  assert.match(q.actions.rescan.help, /deploys the dsa scan relay/);
});
