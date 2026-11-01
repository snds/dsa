// The page's one scan: started here or found running (a schedule, a teammate), followed until its
// report is live. Components read it with useScan(); the runner behind it is whatever lib/scan.ts
// picks for this page, so this file never knows which host it talks to.
import * as React from "react"
import { D, at } from "@/lib/dsa"
import { ScanError, reportStamp, runnerFor, tokenStore, type RunnerSpec, type ScanRun, type ScanRunner } from "@/lib/scan"

export type Phase = "idle" | "asking" | "starting" | "running" | "deploying" | "ready" | "failed"

export interface ScanState {
  phase: Phase
  run: ScanRun | null
  /** Seconds a scan usually takes (earlier runs), or null. */
  estimate: number | null
  /** The progress dialog: opens by itself for long scans, and can be hidden while the banner stays. */
  dialog: boolean
  error: { message: string; url?: string | null } | null
  /** Why the token dialog opened again (a refused token), if it did. */
  tokenProblem: string | null
  /** True when the scan was found running rather than started here. */
  found: boolean
}

const LONG = 60
const POLL_MS = 5000
const PAGE_POLL_MS = 10000
const PAGE_WAIT_MS = 20 * 60_000

const rescan = (): { kind?: string; runner?: RunnerSpec; fallbackUrl?: string; estimateSeconds?: number | null } | undefined => D.actions?.rescan
const githubSpec = () => { const r = rescan()?.runner; return r?.type === "github" ? r : null }
const storage = () => { try { return window.localStorage } catch { return null } }
export const token = () => { const g = githubSpec(); return g ? tokenStore(storage(), g) : null }
/** In-page runs are possible here: dsa serve, or a published page whose adapter gives a runner. */
export const canRun = () => Boolean(D.serve || (rescan()?.kind === "run" && rescan()?.runner))

let state: ScanState = { phase: "idle", run: null, estimate: D.actions?.rescan?.estimateSeconds ?? D.scanEstimate ?? null, dialog: false, error: null, tokenProblem: null, found: false }
const listeners = new Set<() => void>()
const set = (patch: Partial<ScanState>) => { state = { ...state, ...patch }; listeners.forEach(f => f()) }
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } }
export const useScan = () => React.useSyncExternalStore(subscribe, () => state, () => state)

let timer: ReturnType<typeof setTimeout> | null = null
const stop = () => { if (timer) clearTimeout(timer); timer = null }

function runner(): ScanRunner | null {
  return runnerFor(D, at, token()?.get() ?? null)
}

/** A refused token is forgotten and asked for again; anything else is shown with a link to look. */
function fail(e: unknown, url?: string | null) {
  stop()
  if (e instanceof ScanError && e.kind === "auth" && githubSpec()) { token()?.forget(); set({ phase: "asking", tokenProblem: e.message }); return }
  set({ phase: "failed", error: { message: e instanceof Error ? e.message : String(e), url: (e as ScanError)?.url ?? url ?? state.run?.url ?? rescan()?.fallbackUrl ?? null } })
}

async function learnEstimate(r: ScanRunner) {
  try { const s = await r.estimate?.(); if (s) set({ estimate: Math.round(s) }) } catch { /* keep the embedded one */ }
}

/** Follow a run until it finishes, then until the new report is published. */
function follow(r: ScanRunner, run: ScanRun) {
  stop()
  set({ run, phase: run.status === "done" ? "deploying" : run.status === "queued" || run.status === "running" ? "running" : "failed" })
  if (run.status === "failed" || run.status === "cancelled") return fail(new Error(run.error ?? (run.status === "cancelled" ? "The run was cancelled." : "The scan failed.")), run.url)
  if (run.status === "done") return awaitReport(Date.now())
  timer = setTimeout(async () => {
    try { follow(r, await r.status(run.id)) } catch (e) { fail(e) }
  }, POLL_MS)
}

/**
 * The run finished. `dsa serve` renders the page on request, so it's ready now. A published page is
 * ready once the deployed copy carries a different report than this one (the host's deploy and any
 * cache take a minute or two); after the wait, it's offered anyway.
 */
function awaitReport(since: number) {
  stop()
  if (D.serve) return set({ phase: "ready" })
  const mine = { run: D.run?.id ?? null, generatedAt: D.generatedAt ?? null }
  const check = async () => {
    try {
      const html = await (await fetch(location.href.split("#")[0]!, { cache: "no-store" })).text()
      const now = reportStamp(html)
      if (now && (now.run !== mine.run || now.generatedAt !== mine.generatedAt)) return set({ phase: "ready" })
    } catch { /* offline for a moment: try again */ }
    if (Date.now() - since > PAGE_WAIT_MS) return set({ phase: "ready" })
    timer = setTimeout(check, PAGE_POLL_MS)
  }
  set({ phase: "deploying" })
  void check()
}

/** Re-scan: ask for a token first where one is needed, then start and follow the run. */
export async function startScan() {
  const r = runner()
  if (!r) return
  if (r.needsToken && !token()?.get()) return set({ phase: "asking", tokenProblem: null })
  set({ phase: "starting", error: null, found: false, run: null })
  void learnEstimate(r)
  try {
    const run = await r.trigger()
    follow(r, run)
    if ((state.estimate ?? 0) > LONG) set({ dialog: true })
  } catch (e) {
    fail(e)
  }
}

export function saveToken(t: string) {
  token()?.set(t)
  set({ tokenProblem: null })
  void startScan()
}

export function forgetToken() {
  token()?.forget()
}

export const closeAsk = () => set({ phase: state.run ? state.phase : "idle", tokenProblem: null })
export const showDialog = (open: boolean) => set({ dialog: open })
export const dismiss = () => { stop(); set({ phase: "idle", error: null, run: null, dialog: false }) }

/**
 * On load: a scan already going (scheduled, or started by someone else) is shown as it runs. A
 * published GitHub page asks without a token too, which works for a public repo and quietly does
 * nothing for a private one.
 */
export async function detectRunning() {
  const r = runnerFor(D, at, token()?.get() ?? null)
  if (!r) return
  try {
    const [first] = await r.listActive()
    if (first && state.phase === "idle") {
      set({ found: true })
      void learnEstimate(r)
      follow(r, first)
    }
  } catch { /* no access or offline: nothing to show */ }
}
