import * as React from "react"
import { ArrowClockwiseIcon, ArrowSquareOutIcon, CheckCircleIcon, CircleNotchIcon, GithubLogoIcon, SignInIcon, WarningIcon } from "@phosphor-icons/react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { D, fmtWhen } from "@/lib/dsa"
import { nextScheduled } from "@/lib/cron"
import { aboutTime, progress } from "@/lib/scan"
import { canRun, closeAsk, dismiss, relayUrl, showOverlay, signIn, startScan, useScan, type ScanState } from "@/lib/useScan"
import { cn } from "cn"

/**
 * Re-scan from the page, with feedback the whole way: a full-screen overlay from the click (or from
 * page load, for a scan already going) to the new report or the reason it failed, and a pill in the
 * header while it runs in the background.
 */


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

const ACTIVE = new Set(["starting", "running", "deploying", "ready", "failed"])
/** "1:07" from seconds. */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
const elapsedOf = (s: ScanState) => {
  const from = s.run?.startedAt ? new Date(s.run.startedAt).getTime() : s.since
  return from ? Math.max(0, (Date.now() - from) / 1000) : 0
}

/** Re-scan, or while a scan is going (or just ended), a pill that reopens the overlay. */
export function ScanButton() {
  const s = useScan()
  if (!canRun()) return null
  if (ACTIVE.has(s.phase)) return <ScanPill />
  return (
    <span className="flex flex-col items-end gap-1">
      <Button onClick={() => startScan()} title={D.actions?.rescan?.help}>
        <ArrowClockwiseIcon data-icon="inline-start" />
        {D.run ? (D.serve ? "Re-run Scan" : "Re-scan") : "Run First Scan"}
      </Button>
      <NextScan prefix="Next scheduled scan" className="text-xs text-muted-foreground" />
    </span>
  )
}

/** The header's reminder of a scan running in the background. It reopens the overlay. */
export function ScanPill() {
  const s = useScan()
  useTick(1000)
  const label = s.phase === "ready" ? "New report ready" : s.phase === "failed" ? (s.run ? "Scan didn't complete" : "Scan didn't start") : s.phase === "deploying" ? "Publishing…" : `Scanning · ${clock(elapsedOf(s))}`
  return (
    <Button variant="outline" size="sm" className={cn("rounded-full tabular-nums", s.phase === "failed" && "text-destructive")} onClick={() => showOverlay(true)} aria-haspopup="dialog" title="Show the scan">
      {s.phase === "ready" ? <CheckCircleIcon className="text-success" data-icon="inline-start" /> : s.phase === "failed" ? <WarningIcon data-icon="inline-start" /> : <Spinner data-icon="inline-start" />}
      {label}
    </Button>
  )
}

/** Spins, unless the viewer asked for less motion: then a still dot. */
function Spinner({ className, ...p }: React.ComponentProps<"span">) {
  return (
    <span className={cn("inline-flex items-center justify-center", className)} aria-hidden {...p}>
      <CircleNotchIcon className="size-full motion-safe:animate-spin motion-reduce:hidden" />
      <span className="size-1/2 rounded-full bg-current motion-safe:hidden" />
    </span>
  )
}

/** A labelled progress bar (no shadcn one in this kit). No value: it slides, or sits still for reduced motion. */
function Bar({ value, label }: { value: number | null; label: string }) {
  const pct = value == null ? null : Math.round(value * 100)
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} className="h-2 w-full overflow-hidden rounded-full bg-muted">
      {pct == null
        ? <div className="h-full w-1/4 rounded-full bg-primary motion-safe:animate-[dsa-indeterminate_1.6s_ease-in-out_infinite] motion-reduce:w-full motion-reduce:opacity-40" />
        : <div className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${pct}%` }} />}
    </div>
  )
}

/** The steps seen so far, then how many are left. Runners name only the current step, so later ones are a count. */
function Steps({ s }: { s: ScanState }) {
  const total = s.run?.steps?.total ?? 0
  const done = s.phase === "deploying" ? total : Math.min(s.run?.steps?.done ?? 0, total)
  const going = done < total
  const seen = s.seen.slice(-5)
  const earlier = Math.max(0, done - (seen.length - (going ? 1 : 0)))
  const rest = Math.max(0, total - done - (going ? 1 : 0))
  return (
    <ol className="flex flex-col gap-1.5 text-sm" aria-label="Steps">
      {earlier > 0 && <li className="text-xs text-muted-foreground">{earlier} earlier step{earlier === 1 ? "" : "s"} done</li>}
      {seen.map((name, i) => {
        const current = going && i === seen.length - 1
        return (
          <li key={`${i}-${name}`} className={cn("flex items-center gap-2", current ? "font-medium" : "text-muted-foreground")} aria-current={current ? "step" : undefined}>
            {current ? <Spinner className="size-4 text-primary" /> : <CheckCircleIcon className="size-4 text-success" aria-hidden />}
            <span className="truncate">{name}</span>
          </li>
        )
      })}
      {rest > 0 && <li className="text-xs text-muted-foreground">{rest} more step{rest === 1 ? "" : "s"} to go</li>}
    </ol>
  )
}

const RELOAD_MS = 2000

/**
 * Every scan takes over the page: started here (dsa serve, the relay), or found running when the page
 * opened. The page behind is dimmed and blurred and inert; "Keep working in the background" hides it
 * and leaves a pill in the header. It ends on the new report (loaded by itself while open) or on the
 * reason it failed, with Try again; it never closes by itself on a failure.
 */
export function ScanOverlay() {
  const s = useScan()
  useTick(1000)
  const keep = React.useRef<HTMLButtonElement>(null)
  const open = s.overlay && ACTIVE.has(s.phase)
  const r = s.run
  const steps = r?.steps?.total ? r.steps : null
  const p = r ? progress(r, s.estimate) : { fraction: 0, secondsLeft: s.estimate, elapsed: 0 }
  // A bar that fills only when the runner reports steps; a time estimate alone is a guess, not progress.
  const value = s.phase === "deploying" ? 0.97 : steps ? p.fraction : null
  const elapsed = elapsedOf(s)

  // The new report: load it while the overlay is open; hidden, the pill says it's ready.
  React.useEffect(() => {
    if (!open || s.phase !== "ready") return
    const t = setTimeout(() => location.reload(), RELOAD_MS)
    return () => clearTimeout(t)
  }, [open, s.phase])

  const title = s.phase === "ready" ? "The new report is ready"
    : s.phase === "failed" ? (r ? "The scan didn't complete" : "The scan didn't start")
    : s.phase === "deploying" ? "Publishing the new report"
    : s.phase === "starting" ? "Starting the scan"
    : "Scanning"
  const now = s.phase === "starting" ? (D.serve ? "The server is starting the scan." : "Asking the scan relay to start the scan.")
    : s.phase === "deploying" ? "The scan finished. The host is deploying the new report."
    : s.phase === "ready" ? "Loading it now."
    : s.phase === "failed" ? s.error?.message ?? "The scan failed."
    : r?.status === "queued" ? "Waiting for a runner to pick it up."
    : steps ? `Step ${Math.min(steps.done + 1, steps.total)} of ${steps.total}${steps.current ? `: ${steps.current}` : ""}.`
    : "Running."
  // Said once per change of phase or step, never per tick.
  const announce = `${title}. ${s.phase === "failed" ? "" : now}`

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) s.phase === "failed" ? dismiss() : showOverlay(false) }}>
      <DialogContent
        showCloseButton={false}
        initialFocus={keep}
        aria-modal="true"
        // Dimmed with the theme's own tokens (darker in both themes), blurred where the browser can;
        // without backdrop-filter, a heavier solid dim does the same job.
        overlayClassName="bg-foreground/50 supports-backdrop-filter:bg-foreground/25 supports-backdrop-filter:backdrop-blur-md dark:bg-background/90 dark:supports-backdrop-filter:bg-background/60"
        className="gap-5 p-6 shadow-lg sm:max-w-md"
        data-testid="scan-overlay"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <span className={cn("flex size-12 items-center justify-center rounded-full", s.phase === "failed" ? "bg-destructive/10 text-destructive" : s.phase === "ready" ? "bg-success/10 text-success" : "bg-primary/10 text-primary")}>
            {s.phase === "failed" ? <WarningIcon className="size-6" aria-hidden /> : s.phase === "ready" ? <CheckCircleIcon className="size-6" aria-hidden /> : <Spinner className="size-6" />}
          </span>
          <DialogHeader className="items-center">
            <DialogTitle className="text-base">{title}</DialogTitle>
            <DialogDescription>
              {s.phase === "failed" ? now
                : s.phase === "ready" ? "Loading it now."
                : <>{s.found && r ? `${r.event === "schedule" ? "A scheduled scan" : "A scan"} was already running. ` : ""}{s.estimate ? `This usually takes ${aboutTime(s.estimate)}.` : "This can take a few minutes."}</>}
            </DialogDescription>
          </DialogHeader>
        </div>

        {s.phase !== "failed" && s.phase !== "ready" && (
          <div className="flex flex-col gap-3">
            <Bar value={value} label="Scan progress" />
            <div className="flex justify-between gap-3 text-xs text-muted-foreground tabular-nums">
              <span>Elapsed {clock(elapsed)}</span>
              <span>{s.phase === "running" && p.secondsLeft != null && value != null ? (p.secondsLeft > 0 ? `${aboutTime(p.secondsLeft)} left` : "Taking longer than usual") : ""}</span>
            </div>
            {steps && s.seen.length > 0 ? <Steps s={s} /> : <p className="text-sm text-muted-foreground">{now}</p>}
          </div>
        )}

        <p className="sr-only" aria-live="polite" aria-atomic>{announce}</p>

        <DialogFooter className="sm:justify-center">
          {s.phase === "failed" ? (
            <>
              <Button variant="ghost" onClick={dismiss}>Close</Button>
              {(s.error?.url ?? r?.url) && <a className={buttonVariants({ variant: "outline" })} href={(s.error?.url ?? r?.url)!} target="_blank" rel="noopener noreferrer">See the run<ArrowSquareOutIcon data-icon="inline-end" /></a>}
              <Button ref={keep} onClick={() => startScan()}><ArrowClockwiseIcon data-icon="inline-start" />Try again</Button>
            </>
          ) : s.phase === "ready" ? (
            <>
              <Button variant="ghost" onClick={() => showOverlay(false)}>Later</Button>
              <Button ref={keep} onClick={() => location.reload()}>Load the new report</Button>
            </>
          ) : (
            <>
              {r?.url && <a className={buttonVariants({ variant: "ghost" })} href={r.url} target="_blank" rel="noopener noreferrer">See the run<ArrowSquareOutIcon data-icon="inline-end" /></a>}
              <Button ref={keep} variant="outline" onClick={() => showOverlay(false)}>Keep working in the background</Button>
            </>
          )}
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
