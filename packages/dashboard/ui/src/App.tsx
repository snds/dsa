import * as React from "react"
import { GearSixIcon, ArrowClockwiseIcon, SparkleIcon } from "@phosphor-icons/react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Pre } from "@/components/bits"
import { D, SYS, ago, api, fmtD, fmtDT } from "@/lib/dsa"
import { Queue } from "@/views/Queue"
import { Federation } from "@/views/Federation"
import { Design } from "@/views/Design"
import { Trends } from "@/views/Trends"
import { Elements } from "@/views/elements/Elements"
import { preloadIconFont, warmStorybook } from "@/views/elements/Picker"
import { SettingsPage, SECTIONS, type SectionId } from "@/views/settings/SettingsPage"
import { Readiness } from "@/views/Readiness"
import { Overview } from "@/views/Overview"
import { System } from "@/views/System"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ROLES, useRole, type Role } from "@/lib/insight"
import { Usage } from "@/views/Usage"
import { AgentProvider, canChat, useAgent } from "@/agent/store"
import { AgentPanel } from "@/agent/AgentPanel"
import { cn } from "cn"

type ViewId = "overview" | "queue" | "system" | "federation" | "elements" | "usage" | "readiness" | "design" | "trends" | "settings"

// Ordered by the questions people bring: how are we doing, what do we do, what is the system, who uses it.
const VIEWS: { id: ViewId; label: string; hint: string }[] = [
  { id: "overview", label: "Overview", hint: "Health, what to do next, and how sure this scan is" },
  { id: "queue", label: "Actions", hint: "Definite fixes and recommendations to decide, by who acts" },
  { id: "system", label: "System", hint: "Every component: kind, variants, parts, tokens, use, and how it was found" },
  { id: "federation", label: "Apps", hint: "Child libraries and the apps that use the system" },
  ...(D.elements ? [{ id: "elements" as const, label: "Element Review", hint: D.elements.questions.length ? `${D.elements.questions.length} questions for a human` : `Native elements vs ${SYS}` }] : []),
  ...(D.usage ? [{ id: "usage" as const, label: "System Usage", hint: `Where ${SYS} tokens and components are used, per library` }] : []),
  ...(D.readiness?.length || D.bench?.length ? [{ id: "readiness" as const, label: "Agents & Benchmarks", hint: "Agent readiness per repo, the usage checker, and bench runs" }] : []),
  ...(D.modules?.figma ? [{ id: "design" as const, label: "Design Files", hint: "Figma crawl" }] : []),
  { id: "trends", label: "Trends", hint: `${D.runs.length} run${D.runs.length === 1 ? "" : "s"}` },
]

/** Title Case for the page heading, keeping short words lower and acronyms as written. */
const titleCase = (s: string) => s.split(/\s+/).map((w, i) => (i > 0 && /^(a|an|and|of|the|for|to|in|on|or|vs)$/i.test(w) ? w.toLowerCase() : /[A-Z]{2,}/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ")

function readHash(): { view: ViewId; section: SectionId } {
  const [v0, s] = (location.hash || "").slice(1).split("/")
  // Older links: #components is the System view now.
  const v = v0 === "components" ? "system" : v0
  const view = (v === "settings" || VIEWS.some(x => x.id === v) ? v : D.run ? "overview" : "settings") as ViewId
  // The old Rules tab lives in Settings now.
  if (v === "rules") return { view: "settings", section: "rules" }
  return { view, section: (SECTIONS.some(x => x.id === s) ? s : "general") as SectionId }
}

export function App() {
  return <AgentProvider><Shell /></AgentProvider>
}

/** Who is looking: the Overview and Actions put that role's work first. Kept per browser. */
function RolePicker() {
  const [role, setRole] = useRole()
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="hidden sm:inline">View as</span>
      <NativeSelect value={role} onChange={(e: any) => setRole(e.target.value as Role)} aria-label="View as role" className="w-36">
        {ROLES.map(r => <NativeSelectOption key={r.id} value={r.id}>{r.label}</NativeSelectOption>)}
      </NativeSelect>
    </label>
  )
}

/** Opens the agent on the whole scan, or back on the last session. */
function AgentButton() {
  const a = useAgent()
  if (!canChat()) return null
  return (
    <Button variant="outline" onClick={() => (a.session ? a.setOpen(!a.open) : a.start({ kind: "scan" }))} aria-pressed={a.open}>
      <SparkleIcon data-icon="inline-start" />Ask the DS Engineer
    </Button>
  )
}

function Shell() {
  const agent = useAgent()
  const [{ view, section }, setRoute] = React.useState(readHash)
  const [, tick] = React.useState(0)
  const [title, setTitle] = React.useState<string>(D.title || D.root)
  const [scan, setScan] = React.useState<{ busy: boolean; error?: string; log?: string[] }>({ busy: false })
  React.useEffect(() => { const t = setInterval(() => tick(x => x + 1), 60000); return () => clearInterval(t) }, [])
  // Live previews: Storybook is already starting on the server; wait for it in the background.
  React.useEffect(() => { if (D.serve && D.elements) { warmStorybook().catch(() => { /* the picker shows the error */ }); preloadIconFont() } }, [])
  React.useEffect(() => { const on = () => setRoute(readHash()); addEventListener("hashchange", on); return () => removeEventListener("hashchange", on) }, [])
  const go = (v: ViewId, s: SectionId = "general") => {
    // Keep a sub-path a view set itself (#queue/<id>, #system/check) when it is the view being opened.
    const keep = location.hash.slice(1).split("/")[0] === v && location.hash.includes("/")
    try { if (!keep) history.replaceState(null, "", "#" + (v === "settings" ? `settings/${s}` : v)) } catch { /* file:// in some browsers */ }
    setRoute({ view: v, section: s })
    window.scrollTo({ top: 0 })
  }

  async function rerun() {
    setScan({ busy: true })
    try {
      await api("/api/run", {})
      location.reload()
    } catch (e: any) {
      setScan({ busy: false, error: e.message, log: e.data?.log })
    }
  }

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
              {figma && <span> · {figma}</span>}
              {!D.serve && <span> · Snapshot from {fmtD(D.generatedAt)}{D.published ? ". Read-only: review decisions are staged in your browser and exported; scans and the agent need dsa serve" : ""}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <RolePicker />
          {D.serve && (
            <>
            <AgentButton />
            <Button onClick={rerun} disabled={scan.busy}>
              <ArrowClockwiseIcon className={scan.busy ? "animate-spin" : ""} data-icon="inline-start" />
              {scan.busy ? "Scanning…" : D.run ? "Re-run Scan" : "Run First Scan"}
            </Button>
            </>
          )}
          </div>
        </div>
        <div className="mx-auto mt-3 max-w-[1400px] px-4 sm:px-6">
          {/* Settings leads the tab row as an icon tab, set apart from the views by a divider. No
              overflow wrapper: it clipped the active underline and showed a stray scrollbar. */}
          <Tabs value={view} onValueChange={(v: any) => go(v, v === "settings" ? section : "general")}>
            <TabsList variant="line" className="h-10 flex-wrap">
              <Tooltip>
                <TooltipTrigger render={<TabsTrigger value="settings" aria-label="Settings" className="flex-none px-2" />}>
                  <GearSixIcon weight={view === "settings" ? "fill" : "regular"} />
                </TooltipTrigger>
                <TooltipContent>Settings, notes, rules, and history</TooltipContent>
              </Tooltip>
              <Separator orientation="vertical" className="mx-1.5 h-5! self-center" />
              {VIEWS.map(v => (
                <TabsTrigger key={v.id} value={v.id} title={v.hint} className="px-2.5">{v.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
        {scan.busy && <Alert className="mb-6"><AlertTitle>Scanning</AlertTitle><AlertDescription>This usually takes 10–30 seconds. The page reloads when it's done.</AlertDescription></Alert>}
        {scan.error && (
          <Alert variant="destructive" className="mb-6">
            <AlertTitle>The scan failed</AlertTitle>
            <AlertDescription>{scan.error} It's also in Settings › Notes.{scan.log?.length ? <Pre className="mt-2 max-h-60">{scan.log.join("\n")}</Pre> : null}</AlertDescription>
          </Alert>
        )}
        {view === "settings" ? (
          <SettingsPage section={section} onSection={s => go("settings", s)} onTitle={setTitle} />
        ) : !D.run ? (
          <Empty className="border"><EmptyHeader><EmptyTitle>Nothing scanned yet</EmptyTitle><EmptyDescription>Open Settings to check sources and tokens, then run the first scan.</EmptyDescription></EmptyHeader></Empty>
        ) : view === "overview" ? <Overview go={(v: string) => go(v as ViewId)} />
          : view === "queue" ? <Queue key={location.hash} />
          : view === "system" ? <System />
          : view === "federation" ? <Federation />
          : view === "elements" ? <Elements />
          : view === "readiness" ? <Readiness />
          : view === "usage" ? <Usage />
          : view === "design" ? <Design onSettings={() => go("settings", "general")} />
          : <Trends />}
      </main>
      <AgentPanel />
    </div>
  )
}

export default App
