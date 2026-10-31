// Re-scan from the page. Every host gets a runner with the same three calls, so the page shows the
// same progress whatever runs the scan:
//   trigger()     start a scan, resolve to the new run
//   status(id)    where one run stands: queued, running (step n of m), done, failed
//   listActive()  runs going now, a scheduled one included
// The host adapter that published the page says which runner and where (D.actions.rescan.runner,
// see RunnerSpec in src/deploy/types.ts); `dsa serve` uses its own API. Nothing here imports the
// React app, so the tests run it with a fake fetch and storage.

export type ScanStatus = "queued" | "running" | "done" | "failed" | "cancelled"

export interface ScanRun {
  id: string
  status: ScanStatus
  /** What started it: manual, schedule, push… (as the host names it). */
  event?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  /** The run's own page, for "see the run" links and errors. */
  url?: string | null
  steps?: { done: number; total: number; current?: string | null } | null
  error?: string | null
}

export interface ScanRunner {
  type: string
  /** A credential the viewer must give first (a GitHub token on a static site). */
  needsToken: boolean
  trigger(): Promise<ScanRun>
  status(id: string): Promise<ScanRun>
  listActive(): Promise<ScanRun[]>
  /** Median seconds of recent successful scans, when the host can tell. */
  estimate?(): Promise<number | null>
}

export type RunnerSpec =
  | { type: "github"; api: string; server: string; repo: string; workflow: string; ref?: string | null; tokenUrl: string }
  | { type: "webhook"; trigger: string; status?: string | null; active?: string | null }

/** Why a call failed, in words for the page, and what kind (auth failures ask for a new token). */
export class ScanError extends Error {
  readonly kind: "auth" | "forbidden" | "not-found" | "network" | "other"
  readonly url?: string
  /** The host's own answer, when it gave one. */
  detail?: unknown
  constructor(message: string, kind: ScanError["kind"], url?: string) {
    super(message)
    this.name = "ScanError"
    this.kind = kind
    if (url) this.url = url
  }
}

type Fetch = typeof fetch
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Seconds as people say them: "40 seconds", "about 3 minutes". */
export function aboutTime(s: number): string {
  if (s < 60) return `${Math.max(1, Math.round(s / 5) * 5)} seconds`
  const m = Math.round(s / 60)
  return `about ${m} minute${m === 1 ? "" : "s"}`
}

export function median(xs: number[]): number | null {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = v.length / 2
  return v.length % 2 ? v[Math.floor(mid)]! : (v[mid - 1]! + v[mid]!) / 2
}

/**
 * How far a run is: completed steps when the host reports them, else elapsed time against the
 * estimate (capped below 100% so a slow run never looks finished). Seconds left need an estimate.
 */
export function progress(run: ScanRun, estimate: number | null, now = Date.now()): { fraction: number; secondsLeft: number | null; elapsed: number } {
  const elapsed = run.startedAt ? Math.max(0, (now - new Date(run.startedAt).getTime()) / 1000) : 0
  if (run.status === "done") return { fraction: 1, secondsLeft: 0, elapsed }
  const byTime = estimate ? Math.min(0.95, elapsed / estimate) : null
  const bySteps = run.steps?.total ? Math.min(0.95, run.steps.done / run.steps.total) : null
  const fraction = bySteps ?? byTime ?? 0
  return { fraction, secondsLeft: estimate ? Math.max(0, Math.round(estimate - elapsed)) : null, elapsed }
}

/** The report's run id and build time, read from a page's embedded data. */
export function reportStamp(html: string): { run: string | null; generatedAt: string | null } | null {
  const m = html.match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)
  if (!m) return null
  try {
    const d = JSON.parse(m[1]!)
    return { run: d.run?.id ?? null, generatedAt: d.generatedAt ?? null }
  } catch {
    return null
  }
}

// ── GitHub: workflow_dispatch, then follow the run and its jobs' steps ──────────────────────────

export function githubRunner(spec: Extract<RunnerSpec, { type: "github" }>, token: string | null, f: Fetch = fetch, opts: { wait?: (ms: number) => Promise<unknown>; tries?: number } = {}): ScanRunner {
  const wait = opts.wait ?? sleep
  const base = `${spec.api.replace(/\/+$/, "")}/repos/${spec.repo}`
  const wf = `${base}/actions/workflows/${encodeURIComponent(spec.workflow)}`
  let ref = spec.ref ?? null

  async function call(method: string, url: string, body?: unknown): Promise<any> {
    let r: Response
    try {
      r = await f(url, {
        method,
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      throw new ScanError("Couldn't reach GitHub. Check your connection, or whether a browser extension blocks api.github.com.", "network")
    }
    if (r.status === 401) throw new ScanError("GitHub refused the token: it has expired or was revoked. Add a new one.", "auth")
    if (r.status === 403) throw new ScanError(`GitHub said the token can't do this. It needs Actions: read and write on ${spec.repo}${(await r.text().catch(() => "")).includes("rate limit") ? " (or the hourly limit was reached)" : ""}.`, "forbidden")
    if (r.status === 404) throw new ScanError(`GitHub can't find ${spec.repo} or its ${spec.workflow} workflow with this token. Check the token covers that repo.`, "not-found")
    if (r.status === 422) {
      const j: any = await r.json().catch(() => ({}))
      throw Object.assign(new ScanError(`GitHub didn't start the workflow: ${j.message ?? "unprocessable request"}.`, "other"), { detail: j })
    }
    if (!r.ok) throw new ScanError(`GitHub answered ${r.status}.`, "other")
    return r.status === 204 ? null : r.json()
  }

  const runOf = (r: any, jobs?: any[]): ScanRun => {
    const status: ScanStatus = r.status !== "completed" ? (r.status === "in_progress" ? "running" : "queued") : r.conclusion === "success" ? "done" : r.conclusion === "cancelled" ? "cancelled" : "failed"
    const steps = jobs ? jobs.flatMap((j: any) => (j.steps ?? []).map((s: any) => ({ ...s, job: j.name }))) : null
    const multi = jobs ? new Set(jobs.map((j: any) => j.name)).size > 1 : false
    const now = steps?.find((s: any) => s.status === "in_progress") ?? steps?.find((s: any) => s.status !== "completed")
    const failed = steps?.find((s: any) => s.conclusion === "failure")
    return {
      id: String(r.id),
      status,
      event: r.event === "workflow_dispatch" ? "manual" : r.event ?? null,
      startedAt: r.run_started_at ?? r.created_at ?? null,
      finishedAt: r.status === "completed" ? r.updated_at ?? null : null,
      url: r.html_url ?? null,
      steps: steps?.length ? { done: steps.filter((s: any) => s.status === "completed").length, total: steps.length, current: now ? (multi ? `${now.job}: ${now.name}` : now.name) : null } : null,
      error: status === "failed" ? `The run ${r.conclusion === "failure" ? "failed" : `ended: ${r.conclusion}`}${failed ? ` at "${failed.name}"` : ""}.` : null,
    }
  }

  async function branch(): Promise<string> {
    if (!ref) ref = (await call("GET", base)).default_branch ?? "main"
    return ref!
  }

  async function recent(q: string): Promise<any[]> {
    return (await call("GET", `${wf}/runs?${q}`))?.workflow_runs ?? []
  }

  const runner: ScanRunner = {
    type: "github",
    needsToken: true,
    async trigger() {
      const on = await branch()
      const before = new Set((await recent("event=workflow_dispatch&per_page=10")).map((r: any) => r.id))
      let res: any
      try {
        // Newer GitHub answers with the run it started; older ones answer 204 and the run is looked up.
        res = await call("POST", `${wf}/dispatches`, { ref: on, return_run_details: true })
      } catch (e: any) {
        if (!(e instanceof ScanError && e.kind === "other" && /return_run_details/i.test(JSON.stringify(e.detail ?? "")))) throw e
        res = await call("POST", `${wf}/dispatches`, { ref: on })
      }
      const id = res?.workflow_run_id ?? res?.id
      if (id) return runner.status(String(id))
      for (let i = 0; i < (opts.tries ?? 10); i++) {
        await wait(1500)
        const fresh = (await recent("event=workflow_dispatch&per_page=10")).find((r: any) => !before.has(r.id))
        if (fresh) return runOf(fresh)
      }
      throw new ScanError("GitHub accepted the request but no run showed up. It may still start: check the workflow page.", "other", `${spec.server}/${spec.repo}/actions/workflows/${encodeURIComponent(spec.workflow)}`)
    },
    async status(id) {
      const [r, jobs] = await Promise.all([call("GET", `${base}/actions/runs/${id}`), call("GET", `${base}/actions/runs/${id}/jobs?per_page=100`)])
      return runOf(r, jobs?.jobs ?? [])
    },
    async listActive() {
      const runs = [...(await recent("status=in_progress&per_page=5")), ...(await recent("status=queued&per_page=5"))]
      const out: ScanRun[] = []
      for (const r of runs) out.push(r.status === "in_progress" ? await runner.status(String(r.id)) : runOf(r))
      return out
    },
    async estimate() {
      const done = await recent("status=success&per_page=10")
      return median(done.map((r: any) => (new Date(r.updated_at).getTime() - new Date(r.run_started_at ?? r.created_at).getTime()) / 1000))
    },
  }
  return runner
}

// ── A webhook, with optional status and active URLs ─────────────────────────────────────────────

function normalize(j: any, fallbackId = ""): ScanRun {
  const status: ScanStatus = ["queued", "running", "done", "failed", "cancelled"].includes(j?.status) ? j.status : j?.status === "success" ? "done" : j?.status === "in_progress" ? "running" : "queued"
  return { id: String(j?.id ?? fallbackId), status, event: j?.event ?? null, startedAt: j?.startedAt ?? null, finishedAt: j?.finishedAt ?? null, url: j?.url ?? null, steps: j?.steps ?? null, error: j?.error ?? null }
}

export function webhookRunner(spec: Extract<RunnerSpec, { type: "webhook" }>, f: Fetch = fetch): ScanRunner {
  const get = async (url: string) => {
    let r: Response
    try { r = await f(url, { credentials: "include", headers: { Accept: "application/json" } }) } catch { throw new ScanError(`Couldn't reach ${new URL(url).host}.`, "network") }
    if (!r.ok) throw new ScanError(`${new URL(url).host} answered ${r.status}.`, r.status === 401 ? "auth" : r.status === 403 ? "forbidden" : "other")
    return r.json()
  }
  const runner: ScanRunner = {
    type: "webhook",
    needsToken: false,
    async trigger() {
      let r: Response
      try { r = await f(spec.trigger, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ dsa: "rescan" }) }) } catch { throw new ScanError(`Couldn't reach ${new URL(spec.trigger).host}.`, "network") }
      if (!r.ok) throw new ScanError(`The scan job at ${new URL(spec.trigger).host} answered ${r.status}.`, "other")
      const j: any = await r.json().catch(() => ({}))
      return normalize({ status: "queued", startedAt: new Date().toISOString(), ...j })
    },
    async status(id) {
      if (!spec.status) return { id, status: "queued" }
      return normalize(await get(spec.status.replace("{id}", encodeURIComponent(id))), id)
    },
    async listActive() {
      if (!spec.active) return []
      return ((await get(spec.active)).runs ?? []).map((x: any) => normalize(x)).filter((x: ScanRun) => x.status === "queued" || x.status === "running")
    },
  }
  return runner
}

// ── dsa serve: the server runs the scan itself ──────────────────────────────────────────────────

export function serveRunner(at: (p: string) => string, f: Fetch = fetch): ScanRunner {
  const call = async (method: string, p: string) => {
    const r = await f(at(p), { method, headers: { "Content-Type": "application/json", "X-DSA": "1" } })
    const j: any = await r.json().catch(() => ({}))
    if (r.status === 409 && j.run) return j.run
    if (!r.ok) throw new ScanError(j.error ?? `The server answered ${r.status}.`, "other")
    return j
  }
  return {
    type: "serve",
    needsToken: false,
    trigger: async () => normalize(await call("POST", "/api/run?async=1")),
    status: async id => normalize(await call("GET", `/api/run/status?id=${encodeURIComponent(id)}`), id),
    listActive: async () => ((await call("GET", "/api/run/active")).runs ?? []).map((x: any) => normalize(x)),
  }
}

// ── The viewer's GitHub token, kept only in this browser ────────────────────────────────────────

/** Storage that may be missing or throw (private windows, blocked site data). */
export interface KeyStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export const tokenKey = (spec: Extract<RunnerSpec, { type: "github" }>) => `dsa.github-token.${spec.server.replace(/^https?:\/\//, "")}/${spec.repo}`

export function tokenStore(store: KeyStore | null, spec: Extract<RunnerSpec, { type: "github" }>) {
  const k = tokenKey(spec)
  return {
    get: (): string | null => { try { return store?.getItem(k) || null } catch { return null } },
    set: (t: string) => { try { store?.setItem(k, t.trim()) } catch { /* not kept: asked again next visit */ } },
    forget: () => { try { store?.removeItem(k) } catch { /* nothing kept */ } },
  }
}

/** A fine-grained token (github_pat_…) or a classic one (ghp_…); anything else is a paste mistake. */
export const looksLikeToken = (t: string) => /^(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})$/.test(t.trim())

/** The runner for this page: `dsa serve`, or what the host adapter published (null: no in-page runs). */
export function runnerFor(d: { serve?: boolean; actions?: { rescan?: { kind?: string; runner?: RunnerSpec } } | null }, at: (p: string) => string, token: string | null, f: Fetch = fetch): ScanRunner | null {
  if (d.serve) return serveRunner(at, f)
  const r = d.actions?.rescan
  if (r?.kind !== "run" || !r.runner) return null
  if (r.runner.type === "github") return githubRunner(r.runner, token, f)
  if (r.runner.type === "webhook") return webhookRunner(r.runner, f)
  return null
}
