import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { githubHost, isShotsMode, workflowTakesShots } from '@snds/dsa';
import { ACME_ROOT, contextFor, NOW, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { startServer } from '../src/server.js';
import { relayRunner, serveRunner } from '../ui/src/lib/scan.js';
import { githubRunner } from '../../../src/relay/runners.js';
import type { RunnerSpec } from '../../../src/deploy/types.js';

// What a re-scan does with earlier photos: each runner carries the setting, GitHub only hears about it
// when it changes something, and the page offers it only when the workflow declares it.

const GH: Extract<RunnerSpec, { type: 'github' }> = { type: 'github', api: 'https://api.github.test', server: 'https://github.test', repo: 'acme/site', workflow: 'pages.yml', ref: 'main' };

function fakeGithub() {
  const dispatched: any[] = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/dispatches')) {
      dispatched.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ workflow_run_id: 7 }), { status: 200 });
    }
    if (url.pathname.endsWith('/jobs')) return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    if (url.pathname.endsWith('/runs/7')) return new Response(JSON.stringify({ id: 7, status: 'queued' }), { status: 200 });
    return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
  }) as typeof fetch;
  return { f, dispatched };
}

describe('the photo setting', () => {
  it('is one of three values', () => {
    for (const v of ['normal', 'fresh', 'retry-missing']) expect(isShotsMode(v)).toBe(true);
    for (const v of ['', 'FRESH', 'fresh; rm -rf /', 1, null, undefined]) expect(isShotsMode(v)).toBe(false);
  });

  it('reaches GitHub as a workflow input, and only when it changes something', async () => {
    const { f, dispatched } = fakeGithub();
    const r = githubRunner(GH, 'token', f);
    await r.trigger();
    await r.trigger({ shots: 'normal' });
    await r.trigger({ shots: 'fresh' });
    expect(dispatched.map(d => d.inputs)).toEqual([undefined, undefined, { shots: 'fresh' }]);
  });

  it('goes to the relay in the request body', async () => {
    const bodies: unknown[] = [];
    const f = (async (_: string, init: RequestInit = {}) => {
      bodies.push(init.body ? JSON.parse(String(init.body)) : null);
      return new Response(JSON.stringify({ run: { id: '1', status: 'queued' } }), { status: 202 });
    }) as unknown as typeof fetch;
    const r = relayRunner('https://relay.test/', () => 'session', f);
    await r.trigger();
    await r.trigger({ shots: 'retry-missing' });
    expect(bodies).toEqual([null, { shots: 'retry-missing' }]);
  });

  it('is offered only when the workflow declares it', () => {
    const root = tmp();
    const dir = path.join(root, '.github', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'with.yml'), 'on:\n  workflow_dispatch:\n    inputs:\n      shots:\n        type: choice\n        options: [normal, fresh, retry-missing]\n');
    fs.writeFileSync(path.join(dir, 'without.yml'), 'on:\n  workflow_dispatch:\n');
    expect(workflowTakesShots(root, 'with.yml')).toBe(true);
    expect(workflowTakesShots(root, 'without.yml')).toBe(false);
    expect(workflowTakesShots(root, 'missing.yml')).toBe(false);

    const rescanFor = (workflow: string) => githubHost.actions({ root, host: { adapter: 'github', github: { repo: 'acme/site', workflow }, rescan: { url: 'https://github.test/acme/site/actions/workflows/x.yml', method: 'link' } } } as any).rescan;
    expect(rescanFor('with.yml')).toMatchObject({ kind: 'link', shots: true });
    expect(rescanFor('without.yml').shots).toBeUndefined();
  });

  it('dsa serve turns a value it does not know away, before anything runs', async () => {
    const data = tmp();
    await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW });
    const port = await new Promise<number>(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });
    const seen: Record<string, unknown>[] = [];
    const watch = { name: 'watch', afterRun: [{ id: 'watch', order: 1, run: async ({ options }: { options: Record<string, unknown> }) => { seen.push(options); } }] };
    const s = await startServer({ load: async () => contextFor(ACME_ROOT, data), port, addons: [watch as any], log: () => {} });
    try {
      const bad = await fetch(`http://127.0.0.1:${port}/api/run?async=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSA': '1' }, body: JSON.stringify({ shots: 'everything' }) });
      expect(bad.status).toBe(400);
      expect((await (await fetch(`http://127.0.0.1:${port}/api/run/active`, { headers: { 'X-DSA': '1' } })).json()).runs).toEqual([]);

      const r = serveRunner(p => `http://127.0.0.1:${port}${p}`);
      let run = await r.trigger({ shots: 'fresh' });
      for (let i = 0; i < 240 && run.status === 'running'; i++) { await new Promise(res => setTimeout(res, 250)); run = await r.status(run.id); }
      expect(run.status).toBe('done');
      expect(seen[0]).toMatchObject({ from: 'serve', shotsMode: 'fresh' });
    } finally { await s.close(); }
  }, 120_000);
});
