import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { ACME_ROOT, contextFor, NOW, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { startServer } from '../src/server.js';
import { ScanError, githubRunner, looksLikeToken, median, progress, reportStamp, runnerFor, serveRunner, tokenStore, webhookRunner, type RunnerSpec, type ScanRunner } from '../ui/src/lib/scan.js';

// The Re-scan contract every runner keeps: trigger() → a run, status(id) → where it stands (steps
// done of total, done, failed with why), listActive() → runs already going (scheduled ones too).
// GitHub and a webhook are faked at the HTTP level; dsa serve is the real server.

type Route = (req: { method: string; url: URL; body: any; headers: Record<string, string> }) => { status?: number; body?: unknown } | undefined;

/** A fetch that answers from handlers, and records every request (to check where a token goes). */
function fake(handler: Route) {
  const calls: { method: string; url: string; auth?: string | undefined; body: any }[] = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method ?? 'GET', url: url.toString(), auth: headers.authorization, body });
    const r = handler({ method: init.method ?? 'GET', url, body, headers });
    if (!r) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

const GH: Extract<RunnerSpec, { type: 'github' }> = { type: 'github', api: 'https://api.github.test', server: 'https://github.test', repo: 'acme/site', workflow: 'pages.yml', tokenUrl: 'https://github.test/settings/personal-access-tokens/new' };
const runJson = (id: number, o: Record<string, unknown> = {}) => ({ id, status: 'in_progress', conclusion: null, event: 'workflow_dispatch', run_started_at: '2026-10-31T10:00:00Z', created_at: '2026-10-31T10:00:00Z', updated_at: '2026-10-31T10:02:00Z', html_url: `https://github.test/acme/site/actions/runs/${id}`, ...o });
const jobsJson = (steps: { name: string; status: string; conclusion?: string | null }[], name = 'deploy') => ({ jobs: [{ name, steps }] });

/** A small fake of GitHub's Actions API for one workflow. */
function fakeGithub(o: { returnsRunDetails?: boolean; rejectsRunDetails?: boolean; runs?: any[]; jobs?: Record<number, any> } = {}) {
  let runs: any[] = o.runs ?? [runJson(1, { status: 'completed', conclusion: 'success' })];
  const jobs: Record<number, any> = o.jobs ?? {};
  const wf = '/repos/acme/site/actions/workflows/pages.yml';
  return fake(({ method, url, body, headers }) => {
    if (headers.authorization !== 'Bearer github_pat_good') return { status: 401, body: { message: 'Bad credentials' } };
    const p = url.pathname;
    if (p === '/repos/acme/site') return { body: { default_branch: 'trunk' } };
    if (p === `${wf}/runs`) {
      const st = url.searchParams.get('status'), ev = url.searchParams.get('event');
      return { body: { workflow_runs: runs.filter(r => (!st || (st === 'success' ? r.conclusion === 'success' : r.status === st)) && (!ev || r.event === ev)) } };
    }
    if (p === `${wf}/dispatches` && method === 'POST') {
      if (o.rejectsRunDetails && body.return_run_details) return { status: 422, body: { message: 'Invalid request. "return_run_details" is not a permitted key.' } };
      const id = 100 + runs.length;
      runs = [runJson(id, { status: 'queued', created_at: '2026-10-31T11:00:00Z', run_started_at: null, ref: body.ref }), ...runs];
      jobs[id] ??= jobsJson([{ name: 'Set up job', status: 'completed', conclusion: 'success' }, { name: 'Build', status: 'in_progress' }, { name: 'Scan', status: 'queued' }, { name: 'Deploy', status: 'queued' }]);
      return o.returnsRunDetails ? { status: 200, body: { workflow_run_id: id, run_url: `x`, html_url: `https://github.test/acme/site/actions/runs/${id}` } } : { status: 204 };
    }
    const m = p.match(/^\/repos\/acme\/site\/actions\/runs\/(\d+)(\/jobs)?$/);
    if (m) {
      const run = runs.find(r => String(r.id) === m[1]);
      if (!run) return undefined;
      return m[2] ? { body: jobs[run.id] ?? { jobs: [] } } : { body: run };
    }
    return undefined;
  });
}

const noWait = async () => {};

describe('the GitHub runner', () => {
  it('starts the workflow on the default branch, finds the new run, and reports its steps', async () => {
    const { f, calls } = fakeGithub();
    const r = githubRunner(GH, 'github_pat_good', f, { wait: noWait });
    const run = await r.trigger();
    const dispatch = calls.find(c => c.method === 'POST')!;
    expect(dispatch.body).toEqual({ ref: 'trunk', return_run_details: true });
    expect(run).toMatchObject({ id: '101', status: 'queued', event: 'manual', url: 'https://github.test/acme/site/actions/runs/101' });
    const s = await r.status(run.id);
    expect(s.steps).toEqual({ done: 1, total: 4, current: 'Build' });
    // The token only ever goes to the API host.
    expect(calls.every(c => new URL(c.url).host === 'api.github.test')).toBe(true);
  });

  it('uses the run GitHub returns when it does, and falls back when the field is refused', async () => {
    const withId = fakeGithub({ returnsRunDetails: true });
    expect((await githubRunner(GH, 'github_pat_good', withId.f, { wait: noWait }).trigger()).id).toBe('101');
    const refuses = fakeGithub({ rejectsRunDetails: true });
    expect((await githubRunner(GH, 'github_pat_good', refuses.f, { wait: noWait }).trigger()).id).toBe('101');
    expect(refuses.calls.filter(c => c.method === 'POST').map(c => c.body)).toEqual([{ ref: 'trunk', return_run_details: true }, { ref: 'trunk' }]);
  });

  it('says plainly why it failed: a refused token, a missing permission, a repo it can\'t see, a run that never appeared', async () => {
    await expect(githubRunner(GH, 'github_pat_expired', fakeGithub().f, { wait: noWait }).trigger()).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/expired or was revoked/) });
    const forbidden = fake(() => ({ status: 403, body: { message: 'Resource not accessible by personal access token' } }));
    await expect(githubRunner(GH, 'github_pat_good', forbidden.f).trigger()).rejects.toMatchObject({ kind: 'forbidden', message: expect.stringMatching(/Actions: read and write on acme\/site/) });
    await expect(githubRunner({ ...GH, repo: 'acme/other', ref: 'main' }, 'github_pat_good', fakeGithub().f).trigger()).rejects.toMatchObject({ kind: 'not-found' });
    const silent = fake(({ url, method }) => (method === 'POST' ? { status: 204 } : url.pathname.endsWith('/runs') ? { body: { workflow_runs: [] } } : { body: { default_branch: 'main' } }));
    await expect(githubRunner(GH, 'github_pat_good', silent.f, { wait: noWait, tries: 2 }).trigger()).rejects.toMatchObject({ url: 'https://github.test/acme/site/actions/workflows/pages.yml' });
    const offline = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    await expect(githubRunner(GH, 'github_pat_good', offline).status('1')).rejects.toBeInstanceOf(ScanError);
  });

  it('maps finished runs: done, cancelled, failed with the step that failed', async () => {
    const runs = [
      runJson(7, { status: 'completed', conclusion: 'success' }),
      runJson(8, { status: 'completed', conclusion: 'failure' }),
      runJson(9, { status: 'completed', conclusion: 'cancelled' }),
    ];
    const jobs = { 8: jobsJson([{ name: 'Build', status: 'completed', conclusion: 'success' }, { name: 'Scan', status: 'completed', conclusion: 'failure' }]) };
    const r = githubRunner(GH, 'github_pat_good', fakeGithub({ runs, jobs }).f);
    expect((await r.status('7')).status).toBe('done');
    expect(await r.status('8')).toMatchObject({ status: 'failed', error: 'The run failed at "Scan".' });
    expect((await r.status('9')).status).toBe('cancelled');
  });

  it('lists runs already going, a scheduled one included, and estimates from recent successful runs', async () => {
    const runs = [
      runJson(20, { event: 'schedule' }),
      runJson(21, { status: 'queued', run_started_at: null }),
      runJson(5, { status: 'completed', conclusion: 'success', run_started_at: '2026-10-30T10:00:00Z', updated_at: '2026-10-30T10:04:00Z' }),
      runJson(6, { status: 'completed', conclusion: 'success', run_started_at: '2026-10-30T11:00:00Z', updated_at: '2026-10-30T11:02:00Z' }),
      runJson(4, { status: 'completed', conclusion: 'success', run_started_at: '2026-10-30T09:00:00Z', updated_at: '2026-10-30T09:03:00Z' }),
    ];
    const jobs = { 20: jobsJson([{ name: 'Build', status: 'completed', conclusion: 'success' }, { name: 'Scan', status: 'completed', conclusion: 'success' }, { name: 'Publish', status: 'in_progress' }]) };
    const r = githubRunner(GH, 'github_pat_good', fakeGithub({ runs, jobs }).f);
    const active = await r.listActive();
    expect(active.map(a => [a.id, a.event, a.status])).toEqual([['20', 'schedule', 'running'], ['21', 'manual', 'queued']]);
    expect(active[0]!.steps).toEqual({ done: 2, total: 3, current: 'Publish' });
    expect(await r.estimate!()).toBe(180);
  });
});

describe('the webhook runner', () => {
  it('posts to start, follows the status URL, and lists active runs', async () => {
    const { f, calls } = fake(({ method, url }) => {
      if (method === 'POST' && url.pathname === '/scan') return { status: 202, body: { id: 'job 1', url: 'https://ci.test/jobs/1' } };
      if (url.pathname === '/scan/job%201') return { body: { id: 'job 1', status: 'running', steps: { done: 2, total: 5, current: 'Screenshots' } } };
      if (url.pathname === '/scan/active') return { body: { runs: [{ id: 'nightly', status: 'running', event: 'schedule' }, { id: 'old', status: 'done' }] } };
      return undefined;
    });
    const r = webhookRunner({ type: 'webhook', trigger: 'https://ci.test/scan', status: 'https://ci.test/scan/{id}', active: 'https://ci.test/scan/active' }, f);
    const run = await r.trigger();
    expect(run).toMatchObject({ id: 'job 1', status: 'queued', url: 'https://ci.test/jobs/1' });
    expect(await r.status(run.id)).toMatchObject({ status: 'running', steps: { done: 2, total: 5 } });
    expect((await r.listActive()).map(x => x.id)).toEqual(['nightly']);
    expect(calls[0]!.body).toEqual({ dsa: 'rescan' });
    await expect(webhookRunner({ type: 'webhook', trigger: 'https://ci.test/down' }, f).trigger()).rejects.toThrow(/answered 404/);
  });
});

const freePort = () => new Promise<number>(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });

describe('the dsa serve runner', () => {
  it('starts a background scan, reports it as active with steps, and finishes it', async () => {
    const data = tmp();
    await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW });
    const port = await freePort();
    // A stage that holds the scan open long enough to see it running.
    const slow = { name: 'slow', stages: [{ id: 'slow', phase: 'scan' as const, run: () => new Promise<void>(res => setTimeout(res, 1500)) }] };
    const s = await startServer({ load: async () => contextFor(ACME_ROOT, data), port, addons: [slow], log: () => {} });
    try {
      const r: ScanRunner = serveRunner(p => `http://127.0.0.1:${port}${p}`);
      const run = await r.trigger();
      expect(run.status).toBe('running');
      expect(run.steps?.total).toBe(3);
      // A second click while it runs gets the same run back, not a second scan.
      expect((await r.trigger()).id).toBe(run.id);
      let now = run;
      for (let i = 0; i < 120 && now.status === 'running'; i++) {
        if (i === 0) expect((await r.listActive()).map(x => x.id)).toEqual([run.id]);
        await new Promise(res => setTimeout(res, 250));
        now = await r.status(run.id);
      }
      expect(now).toMatchObject({ status: 'done', steps: { done: 3, total: 3 } });
      expect(await r.listActive()).toEqual([]);
    } finally { await s.close(); }
  }, 120_000);
});

describe('helpers the page uses', () => {
  it('progress comes from steps, else from time against the estimate, never 100% until done', () => {
    const now = new Date('2026-10-31T10:02:00Z').getTime();
    expect(progress({ id: '1', status: 'running', startedAt: '2026-10-31T10:00:00Z', steps: { done: 3, total: 6 } }, 240, now)).toEqual({ fraction: 0.5, secondsLeft: 120, elapsed: 120 });
    expect(progress({ id: '1', status: 'running', startedAt: '2026-10-31T10:00:00Z' }, 60, now).fraction).toBe(0.95);
    expect(progress({ id: '1', status: 'done' }, null, now).fraction).toBe(1);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });

  it('reads a report\'s run and build time, to tell when the deployed copy is new', () => {
    const page = (run: string) => `<script id="dsa-data" type="application/json">{"run":{"id":"${run}"},"generatedAt":"t"}</script>`;
    expect(reportStamp(page('R-1'))).toEqual({ run: 'R-1', generatedAt: 't' });
    expect(reportStamp('<html></html>')).toBeNull();
  });

  it('keeps the token in this browser only, and survives storage that throws', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const t = tokenStore(store, GH);
    t.set('  github_pat_abc  ');
    expect([...mem.keys()]).toEqual(['dsa.github-token.github.test/acme/site']);
    expect(t.get()).toBe('github_pat_abc');
    t.forget();
    expect(t.get()).toBeNull();
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    const b = tokenStore(broken, GH);
    expect(() => { b.set('x'); b.forget(); }).not.toThrow();
    expect(b.get()).toBeNull();
    expect(looksLikeToken('github_pat_11ABCDEFG0123456789_abcdefghij')).toBe(true);
    expect(looksLikeToken('my password')).toBe(false);
  });

  it('picks the runner the page was published with', () => {
    const at = (p: string) => p;
    expect(runnerFor({ serve: true }, at, null)?.type).toBe('serve');
    expect(runnerFor({ actions: { rescan: { kind: 'run', runner: GH } } }, at, 't')?.type).toBe('github');
    expect(runnerFor({ actions: { rescan: { kind: 'run', runner: { type: 'webhook', trigger: 'https://x.test' } } } }, at, null)?.type).toBe('webhook');
    expect(runnerFor({ actions: { rescan: { kind: 'link' } } }, at, null)).toBeNull();
  });
});
