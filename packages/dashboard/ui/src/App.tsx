import * as React from "react"
import { GearSixIcon, ArrowClockwiseIcon, ArrowSquareOutIcon, CopyIcon, PaperPlaneTiltIcon, SparkleIcon, WarningIcon } from "@phosphor-icons/react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button, buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { EvidenceTimes, Pre } from "@/components/bits"
import { D, SYS, ago, api, copy, fmtD, fmtDT } from "@/lib/dsa"
import { Inbox } from "@/views/Inbox"
import { Federation } from "@/views/Federation"
import { Design } from "@/views/Design"
import { Elements } from "@/views/elements/Elements"
import { LabelReview } from "@/views/review/LabelReview"
import { preloadIconFont, warmStorybook } from "@/views/elements/Picker"
import { SettingsPage, SECTIONS, type SectionId } from "@/views/settings/SettingsPage"
import { Health } from "@/views/Health"
import { System } from "@/views/System"
import { Usage } from "@/views/Usage"
import { AgentProvider, canChat, useAgent } from "@/agent/store"
import { WaitingOnYou } from "@/agent/ThreadBadge"
import { AgentPanel } from "@/agent/AgentPanel"
import { cn } from "cn"
import { ACTIONS, rescan as hostRescan, rescanIssueUrl } from "@/lib/host"
import { NextScan, ScanButton, ScanOverlay, ShotsMenu, ShotsNote, SignInDialog } from "@/components/scan"
import { ButtonGroup } from "@/components/ui/button-group"
import { canRun, detectRunning, offersShots, useScan } from "@/lib/useScan"
import { hashFor, replaceRoute, routePath, useApp } from "@/lib/app"
import { AppSelect } from "@/components/app-select"

type ViewId = "inbox" | "system" | "federation" | "health" | "elements" | "review" | "usage" | "design" | "settings"

// Five pages (redesign stage 8, decision D1): what needs doing, what the system is, how each app is
// doing, and whether we are getting better; Settings is the gear. Element Review, System Usage and
// Design Files are still pages, reached from the Inbox and Components, and old links still open them.
const VIEWS: { id: ViewId; label: string; hint: string }[] = [
  { id: "inbox", label: "Inbox", hint: "Every issue in one list: what needs whom, grouped by component" },
  { id: "system", label: "Components", hint: "What the system is, and how each part is used" },
  { id: "federation", label: "Apps", hint: "Child libraries and the apps that use the system" },
  { id: "health", label: "Health", hint: "Measures over time, how sure this scan is, agent readiness and bench runs" },
]
/** The routes that aren't tabs, and the tab that holds them. */
const HOME: Partial<Record<ViewId, ViewId>> = { elements: "inbox", review: "inbox", usage: "system", design: "system" }
const ROUTES: ViewId[] = [...VIEWS.map(v => v.id), ...(D.elements ? (["elements"] as ViewId[]) : []), ...(D.usage ? (["usage"] as ViewId[]) : []), ...(D.modules?.figma ? (["design"] as ViewId[]) : [])]

/** Title Case for the page heading, keeping short words lower and acronyms as written. */
const titleCase = (s: string) => s.split(/\s+/).map((w, i) => (i > 0 && /^(a|an|and|of|the|for|to|in|on|or|vs)$/i.test(w) ? w.toLowerCase() : /[A-Z]{2,}/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ")

function readHash(): { view: ViewId; section: SectionId; part?: string } {
  const [v0, s] = routePath().split("/")
  // Overview, Trends and Agents & Benchmarks are sections of Health now (stage 8).
  if (v0 === "overview" || v0 === "trends" || v0 === "readiness") return { view: "health", section: "general", part: v0 }
  // Older links: #components is the System view now; #review is part of Element Review.
  // Actions folded into the Inbox (redesign stage 4): #queue and #queue/<id> land on the same issue there.
  const v = v0 === "components" ? "system" : v0 === "apps" ? "federation" : v0 === "review" && D.elements ? "elements" : v0 === "queue" ? "inbox" : v0
  // The Inbox first, before the first scan too: its empty state says what to press (UX review C U-25).
  const view = (v === "settings" || ROUTES.includes(v as ViewId) ? v : "inbox") as ViewId
  // The old Rules tab lives in Settings now.
  if (v === "rules") return { view: "settings", section: "rules" }
  return { view, section: (SECTIONS.some(x => x.id === s) ? s : "general") as SectionId }
}

/** Components holds what System, System Usage and Design Files showed: one page, three parts. */
function ComponentsNav({ view }: { view: ViewId }) {
  const parts = [["system", "Inventory"], ...(D.usage ? [["usage", "Usage by library"]] : []), ...(D.modules?.figma ? [["design", "Design files"]] : [])] as [ViewId, string][]
  if (parts.length < 2) return null
  return (
    <nav aria-label="Components" className="mb-4 flex flex-wrap gap-1 text-sm">
      {parts.map(([id, label]) => (
        <a key={id} href={hashFor(id)} aria-current={view === id ? "page" : undefined}
          className={cn("rounded-md px-2.5 py-1", view === id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>{label}</a>
      ))}
    </nav>
  )
}

/** The Inbox tab carries its open count (the page's issues), as a nav with counts would. */
const openIssues = ((D.issues ?? []) as any[]).filter(i => i.status === "open").length

export function App() {
  return <AgentProvider><Shell /></AgentProvider>
}

/** Opens the agent on the whole scan, or back on the last session. */
function AgentButton() {
  const a = useAgent()
  if (!canChat()) return null
  return (
    <Button variant="outline" onClick={() => (a.session ? a.setOpen(!a.open) : a.start({ kind: "scan" }))} aria-pressed={a.open}>
      <SparkleIcon data-icon="inline-start" />Ask the agent
    </Button>
  )
}

/**
 * A published page can't scan. Its Re-scan hands off to where the host adapter says, and says so in one
 * line: a filled-in GitHub issue that a workflow turns into a scan (no service, no token), a page that
 * opens in a new tab, or a request sent to a webhook. The terminal command, when there is one, waits
 * behind "Run it from a terminal" so the header stays a button and a time.
 */
export function StaticRescan({ onPost }: { onPost: () => void }) {
  const r = ACTIONS!.rescan
  const { shots } = useScan()
  const target = (r.url ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "")
  // Nothing can start a scan from here: say when the next one runs and how to enable the button.
  if (r.kind === "none") return (
    <div className="flex max-w-sm flex-col items-end gap-1">
      <NextScan prefix="Next scan" className="text-xs text-muted-foreground" />
      <p className="text-right text-xs text-muted-foreground">{r.help}</p>
    </div>
  )
  const setting = offersShots() && shots !== "normal"
  const href = r.kind === "issue" ? rescanIssueUrl(r, shots) : r.url
  const opens = r.kind === "issue" || r.kind === "link"
  const button = opens ? (
    <a data-slot="button" href={href} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline" })} title={r.help}>
      <ArrowSquareOutIcon data-icon="inline-start" />{r.label}
    </a>
  ) : (
    <Button variant="outline" onClick={onPost} title={r.help}><PaperPlaneTiltIcon data-icon="inline-start" />{r.label}</Button>
  )
  // A link can't fill in GitHub's Run workflow form; the command can, so it carries the setting.
  const command = r.kind === "link" && r.command ? `${r.command}${setting ? ` -f shots=${shots}` : ""}` : null
  const where = r.kind === "issue" ? "Opens a filled-in GitHub issue: submit it to start the scan." : opens ? `Opens ${target.split("/")[0]} in a new tab.` : `Sends a request to ${target.split("/")[0]}.`
  return (
    <div className="flex max-w-sm flex-col items-end gap-1" data-slot="static-rescan">
      {offersShots() && opens ? <ButtonGroup>{button}<ShotsMenu variant="outline" /></ButtonGroup> : button}
      {offersShots() && <ShotsNote />}
      <p className="flex flex-wrap justify-end gap-x-2 text-right text-xs text-muted-foreground">
        <NextScan prefix="Next scan" /><span>{where}{setting && r.kind === "link" ? ` On GitHub's page, choose ${shots} under Photos.` : ""}</span>
      </p>
      {command && (
        <details className="w-full text-right text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">Run it from a terminal</summary>
          <div className="mt-1 flex items-center gap-1 rounded-md border bg-muted/40 py-1 pr-1 pl-2 text-left">
            <code className="min-w-0 flex-1 font-mono break-all">{command}</code>
            <Button size="icon-sm" variant="ghost" aria-label="Copy command" title="Copy command" onClick={() => copy(command, "Command copied. Run it in a terminal.")}><CopyIcon /></Button>
          </div>
        </details>
      )}
    </div>
  )
}

/** The revision the scan read and when it went live, or that it wasn't checked against production. */
function LiveRevision() {
  const l = D.live
  const sha = String(l.head ?? l.revision?.sha ?? "").slice(0, 7)
  const text = l.state === "live" ? `Live revision ${sha}${l.revision?.liveAt ? `, live since ${fmtD(l.revision.liveAt)}` : ""}` : l.state === "unchecked" ? `Checkout ${sha || "?"}, not checked against production` : `Not live: ${sha || "?"}`
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("cursor-default underline decoration-dotted underline-offset-4", l.unreleased && "font-medium text-destructive")} />}>{text}</TooltipTrigger>
      <TooltipContent>{l.label}{l.revision?.liveAt ? ` · ${fmtDT(l.revision.liveAt)}` : ""}</TooltipContent>
    </Tooltip>
  )
}

function Shell() {
  const agent = useAgent()
  const app = useApp()
  const [{ view, section, part }, setRoute] = React.useState(readHash)
  const [, tick] = React.useState(0)
  const [title, setTitle] = React.useState<string>(D.title || D.root)
  const [scan, setScan] = React.useState<{ busy: boolean; error?: string; log?: string[] }>({ busy: false })
  React.useEffect(() => { const t = setInterval(() => tick(x => x + 1), 60000); return () => clearInterval(t) }, [])
  // Live previews: Storybook is already starting on the server; wait for it in the background.
  React.useEffect(() => { if (D.serve && D.elements) { warmStorybook().catch(() => { /* the picker shows the error */ }); preloadIconFont() } }, [])
  React.useEffect(() => { const on = () => setRoute(readHash()); addEventListener("hashchange", on); return () => removeEventListener("hashchange", on) }, [])
  const go = (v: ViewId, s: SectionId = "general") => {
    // Keep a sub-path a view set itself (#queue/<id>, #system/check) when it is the view being opened.
    const keep = routePath().split("/")[0] === v && routePath().includes("/")
    if (!keep) replaceRoute(v === "settings" ? `settings/${s}` : v)
    setRoute({ view: v, section: s })
    window.scrollTo({ top: 0 })
  }

  // A published page whose host can't run a scan from here (a link, a fire-and-forget webhook).
  async function rerun() {
    try { await hostRescan() } catch (e: any) { setScan({ busy: false, error: e.message }) }
  }
  // A scan already going when the page opens (scheduled, or started elsewhere) opens the scan overlay.
  React.useEffect(() => { void detectRunning() }, [])

  const figma = D.modules?.figma && D.run ? (() => { const g = D.run.sources?.figmaDiag; return g?.error ? "Figma crawl failed" : !D.run.sources?.figma ? "Figma not crawled" : g ? `${g.crawled} Figma file${g.crawled === 1 ? "" : "s"} crawled` : "Figma crawled" })() : null

  return (
    <div className={cn("min-h-svh bg-background", agent.open && "xl:pr-[440px]")}>
      {/* Everything from the tabs up stays docked while the page scrolls. */}
      <header className="sticky top-0 z-30 border-b bg-background">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-4 px-4 pt-5 sm:px-6">
          <div className="min-w-0">
            <h1 className="font-heading text-xl font-semibold tracking-tight">Design System Analytics · {titleCase(title)}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {D.run ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="cursor-default underline decoration-dotted underline-offset-4" />}>Last scan: {ago(D.run.takenAt)}</TooltipTrigger>
                  <TooltipContent>{fmtDT(D.run.takenAt)} · run {D.run.id}</TooltipContent>
                </Tooltip>
              ) : "No scans yet"}
              <EvidenceTimes photos={D.elements?.shotsTaken} drawings={D.elements?.drawingsTaken} />
              {D.live && <span> · <LiveRevision /></span>}
              {D.schedule?.length > 0 && <span> · <NextScan /></span>}
              {figma && <span> · {figma}</span>}
              {/* How a static page differs is detail, not a headline: it's on hover and focus. */}
              {!D.serve && <span> · {D.published ? (
                <Tooltip>
                  <TooltipTrigger render={<span tabIndex={0} className="cursor-default underline decoration-dotted underline-offset-4" />}>Snapshot from {fmtD(D.generatedAt)}</TooltipTrigger>
                  <TooltipContent className="max-w-xs">A static copy. Review decisions are staged in your browser and {ACTIONS?.decisions.kind === "issue" ? "filed as an issue" : ACTIONS?.decisions.kind === "post" ? "sent to the team" : "exported"}; the agent needs dsa serve.</TooltipContent>
                </Tooltip>
              ) : <>Snapshot from {fmtD(D.generatedAt)}</>}</span>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
          <AppSelect />
          {D.serve && <WaitingOnYou />}
          {D.serve && <AgentButton />}
          {canRun() ? <ScanButton /> : !D.serve && D.published && ACTIONS && <StaticRescan onPost={rerun} />}
          </div>
        </div>
        <div className="mx-auto mt-3 max-w-[1400px] px-4 sm:px-6">
          {/* Settings leads the tab row as an icon tab, set apart from the views by a divider. No
              overflow wrapper: it clipped the active underline and showed a stray scrollbar. */}
          <Tabs value={HOME[view] ?? view} onValueChange={(v: any) => go(v, v === "settings" ? section : "general")}>
            <TabsList variant="line" className="h-10 flex-nowrap">
              <Tooltip>
                <TooltipTrigger render={<TabsTrigger value="settings" aria-label="Settings" className="flex-none px-2" />}>
                  <GearSixIcon weight={view === "settings" ? "fill" : "regular"} />
                  {/* Named where there's room; the icon alone on a phone, with the same name for screen readers. */}
                  <span className="hidden sm:inline">Settings</span>
                </TooltipTrigger>
                <TooltipContent>Settings, notes, rules, and history</TooltipContent>
              </Tooltip>
              <Separator orientation="vertical" className="mx-1.5 h-5! self-center" />
              {VIEWS.map(v => (
                <TabsTrigger key={v.id} value={v.id} title={v.hint} className="px-1.5 sm:px-2.5">{v.label}{v.id === "inbox" && openIssues > 0 && <span className="ml-1 rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground" aria-label={`${openIssues} open`}>{openIssues}</span>}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
        {D.live?.unreleased && (
          <Alert variant="destructive" className="mb-6">
            <WarningIcon />
            <AlertTitle>This scan is not what is live</AlertTitle>
            <AlertDescription>{D.live.label} Numbers and screenshots here may include unreleased work.</AlertDescription>
          </Alert>
        )}
        <ScanOverlay />
        <SignInDialog />
        {scan.error && (
          <Alert variant="destructive" className="mb-6">
            <AlertTitle>The scan request didn't go through</AlertTitle>
            <AlertDescription>{scan.error}</AlertDescription>
          </Alert>
        )}
        {view === "settings" ? (
          <SettingsPage section={section} onSection={s => go("settings", s)} onTitle={setTitle} />
        ) : !D.run ? (
          <Empty className="border"><EmptyHeader><EmptyTitle>Nothing scanned yet</EmptyTitle><EmptyDescription>Open Settings to check sources and tokens, then run the first scan.</EmptyDescription></EmptyHeader></Empty>
        ) : view === "health" ? <Health go={(v: string) => go((v === "queue" ? "inbox" : v) as ViewId)} section={part} />
          : view === "inbox" ? <Inbox key={routePath().split("/")[0]} />
          : view === "system" ? <><ComponentsNav view={view} /><System /></>
          : view === "federation" ? <Federation />
          : view === "elements" ? <Elements key={app ?? ""} />
          : view === "review" ? <LabelReview />
          : view === "usage" ? <><ComponentsNav view={view} /><Usage /></>
          : view === "design" ? <><ComponentsNav view={view} /><Design onSettings={() => go("settings", "general")} /></>
          : <Inbox />}
      </main>
      <AgentPanel />
    </div>
  )
}

export default App
