import * as React from "react"
import { ArrowClockwiseIcon, ArrowSquareOutIcon, CheckCircleIcon, CircleNotchIcon, GithubLogoIcon, SignInIcon, WarningIcon } from "@phosphor-icons/react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { D, fmtWhen } from "@/lib/dsa"
import { nextScheduled } from "@/lib/cron"
import { aboutTime, progress, type ScanRun } from "@/lib/scan"
import { canRun, closeAsk, dismiss, relayUrl, showDialog, signIn, startScan, useScan } from "@/lib/useScan"

/**
 * Re-scan from the page, with feedback the whole way: Starting… on click, a banner while a scan runs
 * (found on load too, a scheduled one included), a progress dialog for scans that take over a minute,
 * "Load the new report" once it's live, and errors with a link to the run.
 */

const minutesAgo = (iso?: string | null) => {
  if (!iso) return ""
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  return m < 1 ? "just now" : `${m} min ago`
}
const stepText = (r: ScanRun | null) => (r?.steps?.total ? `step ${Math.min(r.steps.done + 1, r.steps.total)} of ${r.steps.total}` : "")
const who = (r: ScanRun | null) => (r?.event === "schedule" ? "A scheduled scan" : r?.event && r.event !== "manual" ? `A scan (${r.event})` : "A scan")

/** Re-renders every few seconds so "4 min ago" and the time left stay true. */
function useTick(ms = 5000) {
  const [, t] = React.useState(0)
  React.useEffect(() => { const i = setInterval(() => t(x => x + 1), ms); return () => clearInterval(i) }, [ms])
}

/** "Next scan: Mon, Nov 2, 1:47 AM PST", from the schedule the host declared; nothing without one. */
export function NextScan({ prefix = "Next scan", className }: { prefix?: string; className?: string }) {
  useTick(60000)
  const next = nextScheduled(D.schedule)
  if (!next) return null
  return <span className={className} title={`Scheduled: ${(D.schedule as string[]).join(" · ")} (cron, UTC)`}>{prefix}: <time dateTime={next.toISOString()}>{fmtWhen(next.toISOString())}</time></span>
}

export function ScanButton() {
  const s = useScan()
  if (!canRun()) return null
  const busy = s.phase === "starting" || s.phase === "running" || s.phase === "deploying"
  const text = s.phase === "starting" ? "Starting…" : s.phase === "running" ? `Scanning… ${stepText(s.run)}`.trim() : s.phase === "deploying" ? "Publishing…" : D.run ? (D.serve ? "Re-run Scan" : "Re-scan") : "Run First Scan"
  return (
    <span className="flex flex-col items-end gap-1">
      <Button onClick={() => (busy ? showDialog(true) : startScan())} aria-live="polite" title={busy ? "Show the scan's progress" : D.actions?.rescan?.help}>
        {busy ? <CircleNotchIcon className="animate-spin" data-icon="inline-start" /> : <ArrowClockwiseIcon data-icon="inline-start" />}
        {text}
      </Button>
      <NextScan prefix="Next scheduled scan" className="text-xs text-muted-foreground" />
    </span>
  )
}

/** One line under the header while a scan is going, finished, or failed. Stays when the dialog is hidden. */
export function ScanBanner() {
  const s = useScan()
  useTick()
  const r = s.run
  if (s.phase === "starting") return <Alert className="mb-6" role="status"><CircleNotchIcon className="animate-spin" /><AlertTitle>Starting a scan…</AlertTitle><AlertDescription>{D.serve ? "The server is starting the scan." : "Asking the scan relay to start the scan."}</AlertDescription></Alert>
  if (s.phase === "running") return (
    <Alert className="mb-6" role="status">
      <CircleNotchIcon className="animate-spin" />
      <AlertTitle>{who(r)} {r?.status === "queued" ? "is waiting to start" : `started ${minutesAgo(r?.startedAt)}`}{stepText(r) ? ` · ${stepText(r)}` : ""}</AlertTitle>
      <AlertDescription>
        <p>{r?.steps?.current ? `Now: ${r.steps.current}. ` : ""}This page keeps showing the current report until the new one is published.</p>
        <span className="mt-1 flex flex-wrap gap-2">
          <Button size="xs" variant="outline" onClick={() => showDialog(true)}>Show progress</Button>
          {r?.url && <a className={buttonVariants({ size: "xs", variant: "ghost" })} href={r.url} target="_blank" rel="noopener noreferrer">See the run<ArrowSquareOutIcon data-icon="inline-end" /></a>}
        </span>
      </AlertDescription>
    </Alert>
  )
  if (s.phase === "deploying") return (
    <Alert className="mb-6" role="status"><CircleNotchIcon className="animate-spin" /><AlertTitle>The scan finished. Publishing the new report…</AlertTitle><AlertDescription>The host is deploying it; this usually takes a minute or two. You can keep reading.</AlertDescription></Alert>
  )
  if (s.phase === "ready") return (
    <Alert className="mb-6" role="status">
      <CheckCircleIcon />
      <AlertTitle>The new report is ready</AlertTitle>
      <AlertDescription><span className="mt-1 flex gap-2"><Button size="xs" onClick={() => location.reload()}>Load the new report</Button><Button size="xs" variant="ghost" onClick={dismiss}>Later</Button></span></AlertDescription>
    </Alert>
  )
  if (s.phase === "failed" && s.error) return (
    <Alert variant="destructive" className="mb-6">
      <WarningIcon />
      <AlertTitle>{s.run ? "The scan didn't complete" : "The scan didn't start"}</AlertTitle>
      <AlertDescription>
        <p>{s.error.message}</p>
        <span className="mt-1 flex flex-wrap gap-2">
          {s.error.url && <a className={buttonVariants({ size: "xs", variant: "outline" })} href={s.error.url} target="_blank" rel="noopener noreferrer">{s.run ? "See the run" : "Open the run's page"}<ArrowSquareOutIcon data-icon="inline-end" /></a>}
          <Button size="xs" variant="ghost" onClick={dismiss}>Dismiss</Button>
        </span>
      </AlertDescription>
    </Alert>
  )
  return null
}

/** A labelled progress bar (no shadcn one in this kit). */
function Bar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(value * 100)
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
    </div>
  )
}

/** Progress for a long scan. Hiding it keeps the banner; the Re-scan button reopens it. */
export function ScanDialog() {
  const s = useScan()
  useTick(2000)
  const open = s.dialog && (s.phase === "running" || s.phase === "deploying" || s.phase === "ready" || s.phase === "starting")
  const r = s.run
  const p = r ? progress(r, s.estimate) : { fraction: 0, secondsLeft: s.estimate, elapsed: 0 }
  const value = s.phase === "deploying" ? 0.97 : s.phase === "ready" ? 1 : p.fraction
  return (
    <Dialog open={open} onOpenChange={o => showDialog(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{s.phase === "ready" ? "The new report is ready" : s.phase === "deploying" ? "Publishing the new report" : s.found ? `${who(r)} is running` : "Scanning"}</DialogTitle>
          <DialogDescription>
            {s.phase === "ready" ? "Load it to see the new numbers." : s.phase === "deploying" ? "The scan finished. The host is deploying the new report." : `This usually takes ${s.estimate ? aboutTime(s.estimate) : "a few minutes"}. You can hide this and keep reading; the banner stays.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Bar value={value} label="Scan progress" />
          <div className="flex justify-between gap-3 text-xs text-muted-foreground tabular-nums">
            <span>{s.phase === "starting" ? "Starting…" : r?.status === "queued" ? "Waiting for a runner…" : r?.steps?.total ? `${stepText(r)[0]!.toUpperCase()}${stepText(r).slice(1)}${r.steps.current ? `: ${r.steps.current}` : ""}` : s.phase === "running" ? "Running…" : ""}</span>
            <span>{s.phase === "running" && p.secondsLeft != null ? (p.secondsLeft > 0 ? `${aboutTime(p.secondsLeft)} left` : "Taking longer than usual") : ""}</span>
          </div>
        </div>
        <DialogFooter>
          {r?.url && <a className={buttonVariants({ variant: "ghost" })} href={r.url} target="_blank" rel="noopener noreferrer">See the run<ArrowSquareOutIcon data-icon="inline-end" /></a>}
          {s.phase === "ready" ? <Button onClick={() => location.reload()}>Load the new report</Button> : <Button variant="outline" onClick={() => showDialog(false)}>Hide</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Re-scan through the scan relay: the relay holds the credential that starts the scan, so the viewer
 * only signs in (once per tab). After sign-in the page comes back here and the scan starts by itself.
 */
export function SignInDialog() {
  const s = useScan()
  const relay = relayUrl()
  if (!relay) return null
  const host = new URL(relay).host
  return (
    <Dialog open={s.phase === "asking"} onOpenChange={o => { if (!o) closeAsk() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><SignInIcon />Sign in to re-scan</DialogTitle>
          <DialogDescription>Re-scan starts a new scan through the team's scan relay at <b>{host}</b>. It checks that you can change the repo first.</DialogDescription>
        </DialogHeader>
        {s.signInProblem && <Alert variant="destructive"><WarningIcon /><AlertDescription>{s.signInProblem}</AlertDescription></Alert>}
        <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          <p><b className="text-foreground">What it asks for:</b> only who you are. GitHub asks no permissions; the relay reads your access to the repo and forgets your GitHub sign-in.</p>
          <p className="mt-1"><b className="text-foreground">What it keeps:</b> a short sign-in for this tab (it ends when you close it, or in a few hours). Sign out any time in Settings.</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => closeAsk()}>Not now</Button>
          <Button onClick={() => signIn()}><GithubLogoIcon data-icon="inline-start" />Sign in with GitHub</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
