// Re-scan from the page. Every host gets a runner with the same three calls, so the page shows the
// same progress whatever runs the scan:
//   trigger()     start a scan, resolve to the new run
//   status(id)    where one run stands: queued, running (step n of m), done, failed
//   listActive()  runs going now, a scheduled one included
// A published page goes through the scan relay (D.actions.rescan.kind "relay"), which holds the
// runner credential and signs viewers in; `dsa serve` uses its own API. Nothing here imports the
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
  /** Kept false: no runner asks the viewer for a credential (the relay holds it). */
  needsToken: boolean
  trigger(): Promise<ScanRun>
  status(id: string): Promise<ScanRun>
  listActive(): Promise<ScanRun[]>
  /** Median seconds of recent successful scans, when the host can tell. */
  estimate?(): Promise<number | null>
}

export type RunnerSpec =
  | { type: "github"; api: string; server: string; repo: string; workflow: string; ref?: string | null }
  | { type: "webhook"; trigger: string; status?: string | null; active?: string | null }

/** Why a call failed, in words for the page, and what kind (auth failures ask the viewer to sign in). */
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

// ── The scan relay: it holds the runner credential; the viewer only signs in ────────────────────

/** Storage that may be missing or throw (private windows, blocked site data). */
export interface KeyStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/**
 * The relay session for this tab: a short-lived token the relay signed, kept in sessionStorage so it
 * survives "Load the new report" but not the tab. It is not a GitHub token. The relay also sets an
 * HttpOnly cookie, which is enough where the browser sends it (same-site hosting).
 */
export function relaySession(store: KeyStore | null, relay: string) {
  const k = `dsa.relay-session.${relay.replace(/^https?:\/\//, "")}`
  return {
    get: (): string | null => { try { return store?.getItem(k) || null } catch { return null } },
    set: (t: string) => { try { store?.setItem(k, t) } catch { /* not kept: the cookie, or sign in again */ } },
    forget: () => { try { store?.removeItem(k) } catch { /* nothing kept */ } },
  }
}

/** What the relay sent back after sign-in, from the page's fragment: #dsa-relay=<session> or #dsa-relay-error=<why>. */
export function readSignInReturn(hash: string): { session?: string; error?: string } | null {
  const m = hash.match(/(?:^#|&)dsa-relay(-error)?=([^&]*)/)
  if (!m) return null
  const v = decodeURIComponent(m[2]!)
  return m[1] ? { error: v } : { session: v }
}

/** Where "Sign in with GitHub" goes: the relay's sign-in, returning to this page. */
export const signInHref = (relay: string, page: string) => `${relay}auth/start?return=${encodeURIComponent(page.split("#")[0]!)}`

export interface RelaySessionInfo { signedIn: boolean; login: string | null; permission: string | null; canScan: boolean; minPermission: string; provider: string; resource: string }

export function relayRunner(relay: string, session: () => string | null, f: Fetch = fetch): ScanRunner & { session(): Promise<RelaySessionInfo>; signOut(): Promise<void> } {
  const host = new URL(relay).host
  const call = async (method: string, p: string) => {
    let r: Response
    const t = session()
    try {
      r = await f(`${relay}${p}`, { method, credentials: "include", headers: { Accept: "application/json", "X-DSA-Relay": "1", ...(t ? { Authorization: `Bearer ${t}` } : {}) } })
    } catch {
      throw new ScanError(`Couldn't reach the scan relay at ${host}.`, "network")
    }
    const j: any = await r.json().catch(() => ({}))
    if (r.status === 409 && method === "POST" && j.run) return j
    if (r.status === 401) throw new ScanError(j.error ?? "Sign in to re-scan.", "auth")
    if (r.status === 403) throw new ScanError(j.error ?? "The relay refused this.", "forbidden", j.url ?? undefined)
    if (r.status === 404) throw new ScanError(j.error ?? "The relay can't find that run.", "not-found", j.url ?? undefined)
    if (!r.ok) throw new ScanError(j.error ?? `The scan relay at ${host} answered ${r.status}.`, "other", j.url ?? undefined)
    return j
  }
  let estimate: number | null = null
  return {
    type: "relay",
    needsToken: false,
    trigger: async () => normalize((await call("POST", "scan")).run),
    status: async id => normalize((await call("GET", `scan/status?id=${encodeURIComponent(id)}`)).run, id),
    listActive: async () => { const j = await call("GET", "scan/active"); estimate = j.estimate ?? null; return (j.runs ?? []).map((x: any) => normalize(x)) },
    estimate: async () => estimate ?? (await call("GET", "scan/active")).estimate ?? null,
    session: async () => call("GET", "session"),
    signOut: async () => { await call("POST", "auth/sign-out") },
  }
}

/** The runner for this page: `dsa serve`, the scan relay, or a webhook the host adapter published (null: no in-page runs). */
export function runnerFor(d: { serve?: boolean; actions?: { rescan?: { kind?: string; url?: string; runner?: RunnerSpec } } | null }, at: (p: string) => string, session: () => string | null = () => null, f: Fetch = fetch): ScanRunner | null {
  if (d.serve) return serveRunner(at, f)
  const r = d.actions?.rescan
  if (r?.kind === "relay" && r.url) return relayRunner(r.url, session, f)
  if (r?.kind === "run" && r.runner?.type === "webhook") return webhookRunner(r.runner, f)
  return null
}
