import { test } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { ACME_ROOT, contextFor, NOW, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { startServer } from '../src/server.js';

// `dsa serve`: the live dashboard on localhost, its data endpoints, and its guards (Host header, X-DSA on writes).

/** A GET with a chosen Host header (fetch won't send one). */
const statusWithHost = (port: number, host: string) => new Promise<number>((ok, fail) => { http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: host } }, r => { r.resume(); ok(r.statusCode ?? 0); }).on('error', fail); });

const freePort = () => new Promise<number>(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });

test('serve: the dashboard and its data answer on localhost; other hosts and header-less writes are refused', async () => {
  const data = tmp();
  await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW });
  const port = await freePort();
  const s = await startServer({ load: async () => contextFor(ACME_ROOT, data), port, addons: [], log: () => {} });
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const payload = JSON.parse(html.match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)![1]!);
    assert.equal(payload.serve, true, 'the live page knows it can write back');
    assert.equal(payload.label, 'Acme');
    assert.ok(payload.elements.evals.length > 0);
    const settings = await (await fetch(`http://localhost:${port}/api/settings`)).json();
    assert.equal(settings.sources.core.name, 'Core');
    const queue = await (await fetch(`http://localhost:${port}/api/queue`)).json();
    assert.ok(Array.isArray(queue.items) && queue.prompt.includes('Ground rules'));
    // DNS-rebinding guard and the write header.
    assert.equal(await statusWithHost(port, 'evil.example'), 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/notes/clear`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/notes/clear`, { method: 'POST', headers: { 'X-DSA': '1' } })).status, 200);
  } finally { await s.close(); }
});
