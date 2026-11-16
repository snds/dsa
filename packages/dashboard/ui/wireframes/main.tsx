import * as React from "react"
import { createRoot } from "react-dom/client"
import {
  ArrowSquareOutIcon, BookOpenIcon, CaretDownIcon, CaretRightIcon, ChatCircleDotsIcon, CheckIcon, ClockIcon,
  CopyIcon, FlaskIcon, GearSixIcon, GitBranchIcon, GitPullRequestIcon, GithubLogoIcon, InfoIcon, PaperPlaneTiltIcon,
  SparkleIcon, SpinnerGapIcon, WarningIcon,
} from "@phosphor-icons/react"
import "./wireframes.css"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { cn } from "cn"

// Low-fidelity layouts for docs/redesign. Every control is the dashboard's own kit component; grey boxes
// stand in for photos, drawings and charts. Names are made up: app-a, app-b, app-c are "the test app".

type Screen = "inbox" | "issue" | "component" | "published" | "health"
const SCREENS: { id: Screen; label: string; note: string }[] = [
  { id: "inbox", label: "1 · Inbox", note: "Home. Issues grouped by component, with thread state on every row and group." },
  { id: "issue", label: "2 · Issue + pinned thread", note: "The case on the left, evidence open first. The issue's own thread on the right." },
  { id: "component", label: "3 · Component", note: "System + System Usage in one page, its issues, and a thread for the whole component." },
  { id: "published", label: "4 · Published copy", note: "Same issue on GitHub Pages: thread history read-only, and Discuss on GitHub." },
  { id: "health", label: "5 · Health", note: "Measures beside their trends, how sure the scan is, agent readiness." },
]

/* ── Shared bits ─────────────────────────────────────────────────────────────────────────────────── */

/** A grey stand-in for a photo, drawing or chart. */
function Box({ label, className }: { label: string; className?: string }) {
  return <div className={cn("flex items-center justify-center rounded-md border border-dashed bg-muted/60 text-xs text-muted-foreground", className)}>{label}</div>
}

type Certainty = "Measured" | "Inferred" | "Needs a person"
function Sure({ c }: { c: Certainty }) {
  return <Badge variant={c === "Measured" ? "secondary" : c === "Inferred" ? "outline" : "default"}>{c}</Badge>
}

type ThreadState = "none" | "working" | "waiting" | "changes" | "branch" | "pr" | "settled" | "stale"
const STATE: Record<Exclude<ThreadState, "none">, { label: string; icon: React.ReactNode; tone?: string }> = {
  working: { label: "Working", icon: <SpinnerGapIcon className="animate-spin" /> },
  waiting: { label: "Waiting on you", icon: <span className="size-2 rounded-full bg-primary" />, tone: "text-primary" },
  changes: { label: "Changes ready", icon: <FlaskIcon /> },
  branch: { label: "On a branch", icon: <GitBranchIcon /> },
  pr: { label: "In PR #41", icon: <GitPullRequestIcon /> },
  settled: { label: "Settled", icon: <CheckIcon /> },
  stale: { label: "Out of date", icon: <ClockIcon /> },
}
function Thread({ s }: { s: ThreadState }) {
  if (s === "none") return <span className="text-xs text-muted-foreground">—</span>
  const t = STATE[s]
  return <span className={cn("inline-flex items-center gap-1 text-xs whitespace-nowrap [&_svg]:size-3.5", t.tone)}>{t.icon}{t.label}</span>
}

function Shell({ tab, children, published }: { tab: string; children: React.ReactNode; published?: boolean }) {
  return (
    // Desktop layouts: on a narrow screen the frame scrolls sideways, never the page.
    <div className="overflow-x-auto rounded-xl border bg-background shadow-sm"><div className="min-w-[1000px]">
      <header className="border-b px-5 pt-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-heading text-lg font-semibold">Design System Analytics · Core</h1>
            <p className="text-xs text-muted-foreground">Last scan 8 minutes ago · {published ? "Published copy from 16 Nov · threads as of then" : <>dsa serve · <span className="text-primary">3 waiting on you</span></>}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm">All apps <CaretDownIcon data-icon="inline-end" /></Button>
            {!published && <Button variant="outline" size="sm"><SparkleIcon data-icon="inline-start" />Ask about this scan</Button>}
            <Button size="sm">Re-scan</Button>
          </div>
        </div>
        <Tabs value={tab}>
          <TabsList variant="line" className="mt-2 h-10">
            <TabsTrigger value="settings" className="flex-none px-2"><GearSixIcon /></TabsTrigger>
            <Separator orientation="vertical" className="mx-1.5 h-5! self-center" />
            {["Inbox", "Components", "Apps", "Health"].map(t => <TabsTrigger key={t} value={t} className="px-2.5">{t}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      </header>
      <main className="p-5">{children}</main>
    </div></div>
  )
}

/* ── 1 · Inbox ──────────────────────────────────────────────────────────────────────────────────── */

interface Row { title: string; kind: string; c: Certainty; apps: string; places: number; who: string; t: ThreadState }
const GROUPS: { name: string; summary: string; t: ThreadState; rows: Row[] }[] = [
  { name: "Select", summary: "12 places · 3 issues", t: "waiting", rows: [
    { title: "Hand-built selects in 3 apps: coverage or docs gap", kind: "Gap", c: "Inferred", apps: "app-a, app-b, app-c", places: 12, who: "System", t: "waiting" },
    { title: "4 raw <select> in app-c should be Select", kind: "Decide", c: "Needs a person", apps: "app-c", places: 4, who: "app-c", t: "none" },
    { title: "8 raw <select> in app-a and app-b should be Select", kind: "Decide", c: "Needs a person", apps: "app-a, app-b", places: 8, who: "App teams", t: "stale" },
  ]},
  { name: "DataTable", summary: "15 places · 2 issues", t: "none", rows: [
    { title: "3 apps override DataTable with className: API or docs gap", kind: "Gap", c: "Inferred", apps: "3 apps", places: 15, who: "System", t: "changes" },
    { title: "1 raw <table> in app-a should be DataTable", kind: "Migrate", c: "Needs a person", apps: "app-a", places: 1, who: "app-a", t: "none" },
  ]},
  { name: "Button", summary: "11 places · 2 issues", t: "none", rows: [
    { title: "7 raw <button> in app-a should be Button", kind: "Migrate", c: "Inferred", apps: "app-a", places: 7, who: "app-a", t: "pr" },
    { title: "4 raw <button> in app-b should be Button", kind: "Migrate", c: "Inferred", apps: "app-b", places: 4, who: "app-b", t: "settled" },
  ]},
  { name: "No component", summary: "3 issues", t: "none", rows: [
    { title: "app-c is 2 majors behind Core", kind: "Upgrade", c: "Measured", apps: "app-c", places: 1, who: "app-c", t: "none" },
    { title: "12 hard-coded style values in new app-a code", kind: "Tokens", c: "Measured", apps: "app-a", places: 12, who: "app-a", t: "branch" },
    { title: "app-b's repo has no agent rules file", kind: "Readiness", c: "Measured", apps: "app-b", places: 1, who: "app-b", t: "none" },
  ]},
]

function Inbox() {
  return (
    <Shell tab="Inbox">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup defaultValue={["waiting"]} variant="outline" size="sm">
          <ToggleGroupItem value="all">All open · 10</ToggleGroupItem>
          <ToggleGroupItem value="waiting">Waiting on you · 3</ToggleGroupItem>
          <ToggleGroupItem value="person">Needs a person · 4</ToggleGroupItem>
          <ToggleGroupItem value="pr">In PR · 1</ToggleGroupItem>
          <ToggleGroupItem value="done">Done this week · 2</ToggleGroupItem>
        </ToggleGroup>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">Group by
          <ToggleGroup defaultValue={["component"]} variant="outline" size="sm">
            <ToggleGroupItem value="component">Component</ToggleGroupItem>
            <ToggleGroupItem value="kind">Kind</ToggleGroupItem>
            <ToggleGroupItem value="app">App</ToggleGroupItem>
            <ToggleGroupItem value="who">Who acts</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><InfoIcon className="size-3.5" />This scan: sources found, 4 components need a check (Components). Details on Health.</p>

      <div className="mt-4 flex flex-col gap-4">
        {GROUPS.map(g => (
          <Card key={g.name} size="sm" className="gap-0 py-0">
            <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2.5">
              <CaretDownIcon className="size-4" />
              <span className="font-medium">{g.name}</span>
              <span className="text-xs text-muted-foreground">{g.summary}</span>
              <span className="ml-auto flex items-center gap-3"><Thread s={g.t} /><Button size="xs" variant="ghost"><ChatCircleDotsIcon data-icon="inline-start" />Group thread</Button></span>
            </div>
            {g.rows.map((r, i) => (
              <div key={i} className={cn("grid grid-cols-[auto_1fr_auto_auto_auto_9rem] items-center gap-3 px-4 py-2.5 text-sm", i > 0 && "border-t", i === 0 && g.name === "Select" && "bg-accent/40")}>
                <Checkbox />
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.title}</p>
                  <p className="text-xs text-muted-foreground">{r.kind} · {r.apps} · {r.places} place{r.places === 1 ? "" : "s"}</p>
                </div>
                <Sure c={r.c} />
                <span className="text-xs text-muted-foreground">{r.who}</span>
                <CaretRightIcon className="size-4 text-muted-foreground" />
                <Thread s={r.t} />
              </div>
            ))}
          </Card>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <KbdGroup><Kbd>J</Kbd><Kbd>K</Kbd></KbdGroup> next / previous <KbdGroup><Kbd>X</Kbd></KbdGroup> tick <KbdGroup><Kbd>Enter</Kbd></KbdGroup> open with its thread <KbdGroup><Kbd>C</Kbd></KbdGroup> approve ticked
      </div>
    </Shell>
  )
}

/* ── 2 · Issue + pinned thread ──────────────────────────────────────────────────────────────────── */

function Known({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const items: [string, string, boolean][] = [
    ["Evidence", "12 places · 9 photos · 12 drawings · scanner reasons", true],
    ["The system", "Select docs · usage guidelines · variants · 6 tokens", true],
    ["Memory", "2 past decisions · 1 rejected proposal · team notes", true],
    ["The repo", "AGENTS.md · usage checker", true],
    ["Missing", "No photo for 3 places in app-c", false],
  ]
  return (
    <div className="border-b px-4 py-2">
      <button onClick={onToggle} className="flex w-full items-center gap-1.5 text-xs font-medium"><BookOpenIcon className="size-3.5" />What the agent knows {open ? <CaretDownIcon className="size-3" /> : <CaretRightIcon className="size-3" />}</button>
      {open && <ul className="mt-2 flex flex-col gap-1 text-xs">{items.map(([k, v, ok]) => <li key={k} className={cn("flex gap-2", !ok && "text-destructive")}><span className="w-20 shrink-0 text-muted-foreground">{k}</span>{v}</li>)}</ul>}
    </div>
  )
}

function Ladder({ at }: { at: number }) {
  const steps = ["Explain", "Propose", "Try", "Keep", "Draft PR"]
  return (
    <ol className="flex items-center gap-1 text-[11px]">
      {steps.map((s, i) => <li key={s} className={cn("flex items-center gap-1", i <= at ? "text-foreground" : "text-muted-foreground")}>
        <span className={cn("flex size-4 items-center justify-center rounded-full border text-[10px]", i < at && "bg-primary text-primary-foreground", i === at && "border-primary")}>{i < at ? "✓" : i + 1}</span>{s}{i < steps.length - 1 && <span className="text-muted-foreground">›</span>}
      </li>)}
    </ol>
  )
}

function ThreadPanel({ readOnly }: { readOnly?: boolean }) {
  const [known, setKnown] = React.useState(true)
  return (
    <Card className="gap-0 py-0 lg:sticky lg:top-4">
      <div className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">Thread on this issue{readOnly ? " · history from 14 Nov" : " · Claude Code"}</p>
          <p className="truncate text-sm font-medium">Hand-built selects in 3 apps</p>
        </div>
        <Thread s={readOnly ? "settled" : "waiting"} />
        {!readOnly && <Button size="icon-sm" variant="ghost" aria-label="Copy brief"><CopyIcon /></Button>}
      </div>
      <Known open={known} onToggle={() => setKnown(!known)} />
      <div className="px-4 py-2"><Ladder at={readOnly ? 1 : 1} /></div>
      <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm">
        <div className="ml-8 rounded-lg bg-muted px-3 py-2">Is this really a docs gap, or are teams just unaware Select exists?</div>
        <div className="flex flex-col gap-2">
          <p><strong>Docs gap, high confidence.</strong> All three apps import Select elsewhere, so they know it. Each hand-built one needs grouped options, which Select's docs never show (Select docs, "Options").</p>
          <p className="text-xs text-muted-foreground">Looked at: get_element ×6 · view_screenshot ×3 · component_guidelines Select · past_decisions</p>
          <p className="text-xs">Would change my mind: a grouped-options example that already exists somewhere I didn't look.</p>
          <Card size="sm" className="gap-2 border-primary/50">
            <CardHeader><CardTitle className="text-sm">Proposal · Issue text for the system team</CardTitle><CardDescription>Add a grouped-options example and a `groups` prop note to Select's docs.</CardDescription></CardHeader>
            {!readOnly ? <CardFooter className="gap-2"><Button size="sm">Accept</Button><Button size="sm" variant="outline">Reject…</Button></CardFooter>
              : <CardFooter><Badge variant="secondary">Accepted 14 Nov by a reviewer</Badge></CardFooter>}
          </Card>
        </div>
      </div>
      {readOnly ? (
        <div className="flex flex-col gap-2 border-t px-4 py-3">
          <p className="text-xs text-muted-foreground">Chatting needs dsa serve, or GitHub: a comment there gets the agent's reply in a few minutes.</p>
          <Button variant="outline"><GithubLogoIcon data-icon="inline-start" />Discuss on GitHub<ArrowSquareOutIcon data-icon="inline-end" /></Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-t px-4 py-3">
          <div className="flex flex-wrap gap-1.5">{["Walk me through it", "One decision for all?", "Draft the fix"].map(s => <Button key={s} size="xs" variant="outline">{s}</Button>)}</div>
          <Textarea placeholder="Ask about this issue…" className="min-h-16" />
          <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Advise · <button className="underline">allow sandbox</button></span><Button size="sm"><PaperPlaneTiltIcon data-icon="inline-start" />Send</Button></div>
        </div>
      )}
    </Card>
  )
}

function IssueCase({ published }: { published?: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xs text-muted-foreground">Inbox › Select ›</p>
        <h2 className="font-heading text-xl font-semibold">Hand-built selects in 3 apps: coverage or docs gap</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><Badge variant="outline">Gap</Badge><Sure c="Inferred" /><span className="text-muted-foreground">Who acts: System · app-a, app-b, app-c · Status: Proposed</span></div>
      </div>
      <Card size="sm">
        <CardHeader><CardTitle>Recommendation</CardTitle><CardAction><span className="text-xs text-muted-foreground">Confidence high · 89%</span></CardAction></CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p>Document grouped options in Select. Then migrate the 12 places.</p>
          <p className="text-muted-foreground"><strong className="text-foreground">Why:</strong> three apps (the threshold) hand-build the same thing. Each needs grouped options.</p>
          <p className="text-muted-foreground"><strong className="text-foreground">Would change it:</strong> if Select can't do groups at all, this is a component gap, not docs.</p>
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader><CardTitle>Evidence</CardTitle><CardDescription>One example first. Every place below.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3"><Box label="Photo: app-a, Invoices page" className="h-32" /><Box label="Drawing: Select, as proposed" className="h-32" /></div>
          <Tabs defaultValue="places">
            <TabsList variant="line"><TabsTrigger value="places">Places · 12</TabsTrigger><TabsTrigger value="code">Code</TabsTrigger><TabsTrigger value="numbers">Numbers</TabsTrigger><TabsTrigger value="history">History</TabsTrigger></TabsList>
            <TabsContent value="places" className="mt-2 flex flex-col divide-y rounded-md border text-xs">
              {["app-a/src/Invoices.tsx:12", "app-a/src/Invoices.tsx:13", "app-b/src/Cart.tsx:15", "app-c/src/Report.vue:16"].map(p => <div key={p} className="flex items-center gap-3 px-3 py-1.5"><Box label="" className="h-6 w-10" /><code className="font-mono">{p}</code><span className="ml-auto text-muted-foreground">89%</span></div>)}
              <div className="px-3 py-1.5 text-muted-foreground">…and 8 more</div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      <Card size="sm">
        <CardContent className="flex flex-wrap items-center gap-2">
          {published ? <>
            <p className="text-sm text-muted-foreground">Answers on this copy go out as a pull request.</p>
            <Button className="ml-auto" variant="outline">Answer by PR…</Button>
          </> : <>
            <span className="text-sm">1 open proposal from the thread</span>
            <Button className="ml-auto">Approve</Button><Button variant="outline">Change to…</Button><Button variant="ghost">Dismiss with a reason…</Button>
          </>}
        </CardContent>
      </Card>
    </div>
  )
}

function Issue() {
  return <Shell tab="Inbox"><div className="grid gap-5 lg:grid-cols-[1fr_400px]"><IssueCase /><ThreadPanel /></div></Shell>
}

function Published() {
  return (
    <Shell tab="Inbox" published>
      <div className="grid gap-5 lg:grid-cols-[1fr_400px]"><IssueCase published /><ThreadPanel readOnly /></div>
    </Shell>
  )
}

/* ── 3 · Component ──────────────────────────────────────────────────────────────────────────────── */

function Component() {
  return (
    <Shell tab="Components">
      <div className="grid gap-5 lg:grid-cols-[1fr_400px]">
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Components ›</p>
            <h2 className="font-heading text-xl font-semibold">DataTable</h2>
            <p className="mt-1 text-sm text-muted-foreground">Table · 3 variants · found only in app code, so it needs a check</p>
          </div>
          <Alert><WarningIcon /><AlertTitle>Is DataTable part of the system?</AlertTitle><AlertDescription>The scan found it only in how apps write it, not in the system's exports.</AlertDescription>
            <div className="col-start-2 mt-2 flex gap-2"><Button size="sm">Confirm</Button><Button size="sm" variant="outline">Correct…</Button></div></Alert>
          <Card size="sm">
            <CardHeader><CardTitle>Open issues · 2</CardTitle></CardHeader>
            <CardContent className="flex flex-col divide-y text-sm">
              <div className="flex items-center gap-3 py-2"><span className="flex-1">3 apps override DataTable with className</span><Sure c="Inferred" /><Thread s="changes" /></div>
              <div className="flex items-center gap-3 py-2"><span className="flex-1">1 raw &lt;table&gt; in app-a should be DataTable</span><Sure c="Needs a person" /><Thread s="none" /></div>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader><CardTitle>Use by app</CardTitle><CardDescription>One count. The system's own usage scan agrees (24 uses).</CardDescription></CardHeader>
            <CardContent>
              <div className="grid grid-cols-4 gap-2 text-xs"><span className="text-muted-foreground">App</span><span className="text-muted-foreground">Uses</span><span className="text-muted-foreground">Used as intended</span><span className="text-muted-foreground">Look-alikes</span>
                {[["app-a", "9", "33%", "1"], ["app-b", "8", "50%", "0"], ["app-c", "7", "29%", "0"]].map(r => r.map((v, i) => <span key={r[0] + i}>{v}</span>))}</div>
            </CardContent>
          </Card>
          <div className="grid grid-cols-2 gap-3"><Box label="Variants and parts" className="h-24" /><Box label="Tokens it uses" className="h-24" /></div>
        </div>
        <Card className="gap-0 py-0">
          <div className="border-b px-4 py-3"><p className="text-xs text-muted-foreground">Thread on the whole component</p><p className="text-sm font-medium">DataTable</p></div>
          <div className="flex flex-col gap-3 px-4 py-3 text-sm">
            <p className="text-muted-foreground">Ask about patterns across issues. Issue threads stay on their issues.</p>
            <div className="flex flex-wrap gap-1.5">{["Why do teams keep overriding it?", "Is it really ours?", "What would an API fix look like?"].map(s => <Button key={s} size="xs" variant="outline">{s}</Button>)}</div>
            <Separator />
            <p className="text-xs text-muted-foreground">Other threads on DataTable: 1 · changes ready</p>
            <Textarea placeholder="Ask about DataTable…" className="min-h-16" />
          </div>
        </Card>
      </div>
    </Shell>
  )
}

/* ── 5 · Health ─────────────────────────────────────────────────────────────────────────────────── */

function Health() {
  const m: [string, string, string][] = [["Used as intended", "61%", "Measured"], ["Apps on a current version", "75%", "Measured"], ["Tokens in new code", "53%", "Measured"], ["Custom look-alikes", "24", "Estimated"], ["Agent readiness", "68/100", "Measured"]]
  return (
    <Shell tab="Health">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {m.map(([l, v, how]) => (
          <Card key={l} size="sm"><CardHeader><CardDescription>{l}</CardDescription><CardTitle className="text-2xl">{v}</CardTitle><CardAction><Badge variant="outline">{how}</Badge></CardAction></CardHeader>
            <CardContent><Box label="Trend line, every run" className="h-16" /><p className="mt-2 text-xs text-primary">3 issues in the Inbox move this →</p></CardContent></Card>
        ))}
        <Card size="sm"><CardHeader><CardTitle>How sure is this scan</CardTitle><CardDescription>Read before acting on a number</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm"><p>✓ Sources found: 3 folders</p><p>✓ 9 components</p><p className="text-destructive">! 4 need a check (Components)</p><p>· 2 not used by any app</p></CardContent></Card>
      </div>
    </Shell>
  )
}

/* ── Frame ──────────────────────────────────────────────────────────────────────────────────────── */

function Wireframes() {
  const [s, setS] = React.useState<Screen>(() => (SCREENS.find(x => `#${x.id}` === location.hash)?.id ?? "inbox"))
  const go = (id: Screen) => { setS(id); history.replaceState(null, "", `#${id}`) }
  React.useEffect(() => {
    const on = () => { const id = SCREENS.find(x => `#${x.id}` === location.hash)?.id; if (id) setS(id) }
    addEventListener("hashchange", on); return () => removeEventListener("hashchange", on)
  }, [])
  const cur = SCREENS.find(x => x.id === s)!
  return (
    <div className="min-h-svh bg-muted/40 p-4 sm:p-6">
      <div className="mx-auto max-w-[1400px]">
        <div className="mb-4 flex flex-col gap-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">DSA redesign · low-fidelity layouts · built from the dashboard's UI kit</p>
          <Tabs value={s} onValueChange={(v: any) => go(v)}>
            <TabsList className="h-auto flex-wrap">{SCREENS.map(x => <TabsTrigger key={x.id} value={x.id}>{x.label}</TabsTrigger>)}</TabsList>
          </Tabs>
          <p className="text-sm">{cur.note}</p>
        </div>
        {s === "inbox" ? <Inbox /> : s === "issue" ? <Issue /> : s === "component" ? <Component /> : s === "published" ? <Published /> : <Health />}
        <p className="mt-4 text-xs text-muted-foreground">Grey dashed boxes stand in for photos, drawings and charts. Names are made up. Thread states: {Object.values(STATE).map(t => t.label).join(" · ")}.</p>
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><Wireframes /></React.StrictMode>)
