// The page's one scan: started here or found running (a schedule, a teammate), followed until its
// report is live. Components read it with useScan(); the runner behind it is whatever lib/scan.ts
// picks for this page, so this file never knows which host it talks to.
import * as React from "react"
import { D, at } from "@/lib/dsa"
import { ScanError, readSignInReturn, relayRunner, relaySession, reportStamp, runnerFor, signInHref, type RelaySessionInfo, type RunnerSpec, type ScanRun, type ScanRunner } from "@/lib/scan"

export type Phase = "idle" | "asking" | "starting" | "running" | "deploying" | "ready" | "failed"

export interface ScanState {
  phase: Phase
  run: ScanRun | null
  /** Seconds a scan usually takes (earlier runs), or null. */
  estimate: number | null
  /** The full-screen scan overlay: opens with every scan; hidden, a pill in the header reopens it. */
  overlay: boolean
  error: { message: string; url?: string | null } | null
  /** Why the sign-in dialog opened again (an expired sign-in, a refusal), if it did. */
  signInProblem: string | null
  /** True when the scan was found running rather than started here. */
  found: boolean
  /** When this page started following the scan (ms), for elapsed time when the run has no start. */
  since: number | null
}

const POLL_MS = 5000
const PAGE_POLL_MS = 10000
const PAGE_WAIT_MS = 20 * 60_000

const rescan = (): { kind?: string; url?: string; runner?: RunnerSpec; estimateSeconds?: number | null } | undefined => D.actions?.rescan
/** The scan relay's address when this page re-scans through one. */
export const relayUrl = () => (!D.serve && rescan()?.kind === "relay" && rescan()?.url) || null
const storage = () => { try { return window.sessionStorage } catch { return null } }
export const relaySessionStore = () => { const r = relayUrl(); return r ? relaySession(storage(), r) : null }
const PENDING = "dsa.relay-pending-scan"
/** In-page runs are possible here: dsa serve, the scan relay, or a webhook runner. */
export const canRun = () => Boolean(D.serve || relayUrl() || (rescan()?.kind === "run" && rescan()?.runner?.type === "webhook"))

let state: ScanState = { phase: "idle", run: null, estimate: D.actions?.rescan?.estimateSeconds ?? D.scanEstimate ?? null, overlay: false, error: null, signInProblem: null, found: false, since: null }
const listeners = new Set<() => void>()
const set = (patch: Partial<ScanState>) => { state = { ...state, ...patch }; listeners.forEach(f => f()) }
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } }
export const useScan = () => React.useSyncExternalStore(subscribe, () => state, () => state)

let timer: ReturnType<typeof setTimeout> | null = null
const stop = () => { if (timer) clearTimeout(timer); timer = null }

function runner(): ScanRunner | null {
  return runnerFor(D, at, () => relaySessionStore()?.get() ?? null)
}

/** An expired or missing sign-in asks the viewer to sign in; anything else is shown with a link to look. */
function fail(e: unknown, url?: string | null) {
  stop()
  if (e instanceof ScanError && e.kind === "auth" && relayUrl()) { relaySessionStore()?.forget(); set({ phase: "asking", signInProblem: state.phase === "starting" ? null : e.message }); return }
  set({ phase: "failed", overlay: true, error: { message: e instanceof Error ? e.message : String(e), url: (e as ScanError)?.url ?? url ?? state.run?.url ?? null } })
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

/** Re-scan: start and follow the run. Through the relay, a viewer who isn't signed in is asked to first. */
export async function startScan() {
  const r = runner()
  if (!r) return
  set({ phase: "starting", overlay: true, error: null, found: false, run: null, since: Date.now() })
  void learnEstimate(r)
  try {
    follow(r, await r.trigger())
  } catch (e) {
    fail(e)
  }
}

/** Off to the relay's sign-in; back here afterwards, where the scan starts by itself. */
export function signIn() {
  const r = relayUrl()
  if (!r) return
  try { storage()?.setItem(PENDING, "1") } catch { /* the viewer presses Re-scan again */ }
  location.assign(signInHref(r, location.href))
}

/** Who is signed in at the relay (null: no relay, or it can't be reached). */
export async function relayWho(): Promise<RelaySessionInfo | null> {
  const r = relayUrl()
  if (!r) return null
  try { return await relayRunner(r, () => relaySessionStore()?.get() ?? null).session() } catch { return null }
}

export async function signOut() {
  const r = relayUrl()
  if (!r) return
  try { await relayRunner(r, () => relaySessionStore()?.get() ?? null).signOut() } catch { /* the session expires on its own */ }
  relaySessionStore()?.forget()
}

/** Back from sign-in: keep the session the relay sent in the fragment, clear the fragment, and carry on. */
function takeSignInReturn(): boolean {
  if (!relayUrl()) return false
  const back = readSignInReturn(location.hash)
  if (!back) return false
  history.replaceState(null, "", location.pathname + location.search)
  let pending = false
  try { pending = storage()?.getItem(PENDING) === "1"; storage()?.removeItem(PENDING) } catch { /* no storage */ }
  if (back.error) { set({ phase: "failed", overlay: true, error: { message: back.error, url: null } }); return true }
  if (back.session) relaySessionStore()?.set(back.session)
  if (pending) { void startScan(); return true }
  return false
}

export const closeAsk = () => set({ phase: state.run ? state.phase : "idle", signInProblem: null })
export const showOverlay = (open: boolean) => set({ overlay: open })
export const dismiss = () => { stop(); set({ phase: "idle", error: null, run: null, overlay: false, since: null }) }

/**
 * On load: finish a sign-in that just came back, then show a scan already going (scheduled, or
 * started by someone else) as it runs.
 */
export async function detectRunning() {
  if (takeSignInReturn()) return
  const r = runner()
  if (!r) return
  try {
    const [first] = await r.listActive()
    if (first && state.phase === "idle") {
      set({ found: true, overlay: true, since: Date.now() })
      void learnEstimate(r)
      follow(r, first)
    }
  } catch { /* no access or offline: nothing to show */ }
}
