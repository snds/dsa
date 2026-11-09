// The runners a relay starts scans with. Every one has the same three calls, so the relay (and the
// page behind it) shows the same progress whatever runs the scan:
//   trigger()     start a scan, resolve to the new run
//   status(id)    where one run stands: queued, running (step n of m), done, failed
//   listActive()  runs going now, a scheduled one included
// Which runner, and where, is a RunnerSpec (src/deploy/types.ts). The credential is the relay's own
// secret: it is passed in here and never leaves the relay. Web Fetch API only, so this runs on any host.

import type { RunnerSpec } from "../deploy/types.js";

export type ScanStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ScanRun {
  id: string;
  status: ScanStatus;
  /** What started it: manual, schedule, push… (as the host names it). */
  event?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** The run's own page, for "see the run" links and errors. */
  url?: string | null;
  steps?: { done: number; total: number; current?: string | null } | null;
  error?: string | null;
}

/** What a scan does with earlier photos: reuse them, retake them all, or try again for the ones not found. */
export const SHOTS_MODES = ["normal", "fresh", "retry-missing"] as const;
export type ShotsMode = (typeof SHOTS_MODES)[number];
export const isShotsMode = (v: unknown): v is ShotsMode => SHOTS_MODES.includes(v as ShotsMode);

export interface ScanRunner {
  type: string;
  trigger(o?: { shots?: ShotsMode | undefined }): Promise<ScanRun>;
  status(id: string): Promise<ScanRun>;
  listActive(): Promise<ScanRun[]>;
  /** Median seconds of recent successful scans, when the host can tell. */
  estimate?(): Promise<number | null>;
}

/** Why a runner call failed, in words for the page, and what kind. */
export class RunnerError extends Error {
  readonly kind: "auth" | "forbidden" | "not-found" | "network" | "other";
  readonly url?: string;
  /** The host's own answer, when it gave one. */
  detail?: unknown;
  constructor(message: string, kind: RunnerError["kind"], url?: string) {
    super(message);
    this.name = "RunnerError";
    this.kind = kind;
    if (url) this.url = url;
  }
}

type Fetch = typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function median(xs: number[]): number | null {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length / 2;
  return v.length % 2 ? v[Math.floor(mid)]! : (v[mid - 1]! + v[mid]!) / 2;
}

type GithubSpec = Extract<RunnerSpec, { type: "github" }>;

/** A workflow run and its jobs' steps, as one ScanRun. */
export function githubRun(r: any, jobs?: any[]): ScanRun {
  const status: ScanStatus = r.status !== "completed" ? (r.status === "in_progress" ? "running" : "queued") : r.conclusion === "success" ? "done" : r.conclusion === "cancelled" ? "cancelled" : "failed";
  const steps = jobs ? jobs.flatMap((j: any) => (j.steps ?? []).map((s: any) => ({ ...s, job: j.name }))) : null;
  const multi = jobs ? new Set(jobs.map((j: any) => j.name)).size > 1 : false;
  const now = steps?.find((s: any) => s.status === "in_progress") ?? steps?.find((s: any) => s.status !== "completed");
  const failed = steps?.find((s: any) => s.conclusion === "failure");
  return {
    id: String(r.id),
    status,
    event: r.event === "workflow_dispatch" ? "manual" : (r.event ?? null),
    startedAt: r.run_started_at ?? r.created_at ?? null,
    finishedAt: r.status === "completed" ? (r.updated_at ?? null) : null,
    url: r.html_url ?? null,
    steps: steps?.length ? { done: steps.filter((s: any) => s.status === "completed").length, total: steps.length, current: now ? (multi ? `${now.job}: ${now.name}` : now.name) : null } : null,
    error: status === "failed" ? `The run ${r.conclusion === "failure" ? "failed" : `ended: ${r.conclusion}`}${failed ? ` at "${failed.name}"` : ""}.` : null,
  };
}

/** GitHub Actions: workflow_dispatch, then follow the run and its jobs' steps. */
export function githubRunner(spec: GithubSpec, token: string, f: Fetch = fetch, opts: { wait?: (ms: number) => Promise<unknown>; tries?: number } = {}): ScanRunner {
  const wait = opts.wait ?? sleep;
  const base = `${spec.api.replace(/\/+$/, "")}/repos/${spec.repo}`;
  const wf = `${base}/actions/workflows/${encodeURIComponent(spec.workflow)}`;
  const page = `${spec.server.replace(/\/+$/, "")}/${spec.repo}/actions/workflows/${encodeURIComponent(spec.workflow)}`;
  let ref = spec.ref ?? null;

  async function call(method: string, url: string, body?: unknown): Promise<any> {
    let r: Response;
    try {
      r = await f(url, {
        method,
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new RunnerError("The relay couldn't reach GitHub.", "network");
    }
    // These name the relay's credential, not the viewer's: the relay's operator fixes them.
    if (r.status === 401) throw new RunnerError("GitHub refused the relay's runner token: it has expired or was revoked. The relay's operator needs to set a new one.", "auth", page);
    if (r.status === 403) throw new RunnerError(`GitHub said the relay's runner token can't do this. It needs Actions: read and write on ${spec.repo}${(await r.text().catch(() => "")).includes("rate limit") ? " (or GitHub's hourly limit was reached)" : ""}.`, "forbidden", page);
    if (r.status === 404) throw new RunnerError(`GitHub can't find ${spec.repo} or its ${spec.workflow} workflow with the relay's runner token.`, "not-found", page);
    if (r.status === 422) {
      const j: any = await r.json().catch(() => ({}));
      throw Object.assign(new RunnerError(`GitHub didn't start the workflow: ${j.message ?? "unprocessable request"}.`, "other", page), { detail: j });
    }
    if (!r.ok) throw new RunnerError(`GitHub answered ${r.status}.`, "other", page);
    return r.status === 204 ? null : r.json();
  }

  async function branch(): Promise<string> {
    if (!ref) ref = (await call("GET", base)).default_branch ?? "main";
    return ref!;
  }
  const recent = async (q: string): Promise<any[]> => (await call("GET", `${wf}/runs?${q}`))?.workflow_runs ?? [];

  const runner: ScanRunner = {
    type: "github",
    async trigger(o) {
      const on = await branch();
      const before = new Set((await recent("event=workflow_dispatch&per_page=10")).map((r: any) => r.id));
      // Only when it changes something: a workflow that declares no such input refuses the whole request.
      const inputs = o?.shots && o.shots !== "normal" ? { inputs: { shots: o.shots } } : {};
      let res: any;
      try {
        // Newer GitHub answers with the run it started; older ones answer 204 and the run is looked up.
        res = await call("POST", `${wf}/dispatches`, { ref: on, ...inputs, return_run_details: true });
      } catch (e: any) {
        if (!(e instanceof RunnerError && e.kind === "other" && /return_run_details/i.test(JSON.stringify(e.detail ?? "")))) throw e;
        res = await call("POST", `${wf}/dispatches`, { ref: on, ...inputs });
      }
      const id = res?.workflow_run_id ?? res?.id;
      if (id) return runner.status(String(id));
      for (let i = 0; i < (opts.tries ?? 10); i++) {
        await wait(1500);
        const fresh = (await recent("event=workflow_dispatch&per_page=10")).find((r: any) => !before.has(r.id));
        if (fresh) return githubRun(fresh);
      }
      throw new RunnerError("GitHub accepted the request but no run showed up yet. It may still start.", "other", page);
    },
    async status(id) {
      if (!/^\d+$/.test(id)) throw new RunnerError("That isn't a run id.", "not-found");
      const [r, jobs] = await Promise.all([call("GET", `${base}/actions/runs/${id}`), call("GET", `${base}/actions/runs/${id}/jobs?per_page=100`)]);
      return githubRun(r, jobs?.jobs ?? []);
    },
    async listActive() {
      const runs = [...(await recent("status=in_progress&per_page=5")), ...(await recent("status=queued&per_page=5"))];
      const out: ScanRun[] = [];
      for (const r of runs) out.push(r.status === "in_progress" ? await runner.status(String(r.id)) : githubRun(r));
      return out;
    },
    async estimate() {
      const done = await recent("status=success&per_page=10");
      return median(done.map((r: any) => (new Date(r.updated_at).getTime() - new Date(r.run_started_at ?? r.created_at).getTime()) / 1000));
    },
  };
  return runner;
}

/** A run in the webhook's own words, made into a ScanRun. */
export function normalizeRun(j: any, fallbackId = ""): ScanRun {
  const status: ScanStatus = ["queued", "running", "done", "failed", "cancelled"].includes(j?.status) ? j.status : j?.status === "success" ? "done" : j?.status === "in_progress" ? "running" : "queued";
  return { id: String(j?.id ?? fallbackId), status, event: j?.event ?? null, startedAt: j?.startedAt ?? null, finishedAt: j?.finishedAt ?? null, url: j?.url ?? null, steps: j?.steps ?? null, error: j?.error ?? null };
}

/** Any CI or job runner behind a webhook, with optional status and active URLs. The credential goes as a bearer token. */
export function webhookRunner(spec: Extract<RunnerSpec, { type: "webhook" }>, token: string | null, f: Fetch = fetch): ScanRunner {
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };
  const call = async (method: string, url: string, body?: unknown): Promise<any> => {
    let r: Response;
    try {
      r = await f(url, { method, headers: { Accept: "application/json", ...auth, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch {
      throw new RunnerError(`The relay couldn't reach ${hostOf(url)}.`, "network");
    }
    if (!r.ok) throw new RunnerError(`The scan job at ${hostOf(url)} answered ${r.status}.`, r.status === 401 ? "auth" : r.status === 403 ? "forbidden" : r.status === 404 ? "not-found" : "other");
    return r.json().catch(() => ({}));
  };
  return {
    type: "webhook",
    trigger: async () => normalizeRun({ status: "queued", startedAt: new Date().toISOString(), ...(await call("POST", spec.trigger, { dsa: "rescan" })) }),
    status: async (id) => (spec.status ? normalizeRun(await call("GET", spec.status.replace("{id}", encodeURIComponent(id))), id) : { id, status: "queued" }),
    listActive: async () => (spec.active ? ((await call("GET", spec.active)).runs ?? []).map((x: any) => normalizeRun(x)).filter((x: ScanRun) => x.status === "queued" || x.status === "running") : []),
  };
}

/** The built-in runner for a spec, with the relay's credential. Pass your own `runner` to createRelay for anything else. */
export function runnerFor(spec: RunnerSpec, credential: string | null, f: Fetch = fetch): ScanRunner {
  if (spec.type === "github") {
    if (!credential) throw new Error("The github runner needs the relay's runner token (DSA_RELAY_RUNNER_TOKEN).");
    return githubRunner(spec, credential, f);
  }
  return webhookRunner(spec, credential, f);
}
