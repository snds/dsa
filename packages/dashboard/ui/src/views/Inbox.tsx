import * as React from "react"
import { cn } from "cn"
import { ArrowSquareOutIcon, CaretDownIcon, CaretRightIcon, CheckCircleIcon, CubeIcon, InfoIcon, QuestionIcon, SparkleIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Kbd } from "@/components/ui/kbd"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Panel } from "@/components/bits"
import { D } from "@/lib/dsa"
import { hashFor, replaceRoute, routePath, useApp } from "@/lib/app"
import { AskAgent } from "@/agent/AskAgent"
import { ThreadBadge } from "@/agent/ThreadBadge"
import { anchorKeyOf, canChat, useAgent, type Subject } from "@/agent/store"
import { Detail, useQueue } from "./Queue"
import { AnswerPlaces } from "./elements/Elements"
import { PinnedThread } from "@/agent/PinnedThread"

/**
 * The Inbox: every issue in one list (the report's `issues`, redesign stage 4). One problem is one row,
 * whichever screen used to hold it: an Action, an Element Review question, a System flag, a readiness
 * check. Grouped by the component it is about (or app, or kind), filtered by what needs whom, each with
 * one certainty word and the state of its agent thread. Replaces Actions; #queue links land here.
 */

type Issue = {
  key: string; kind: "finding" | "approval" | "question" | "component-check" | "component-unused" | "readiness"
  rule: string; title: string; certainty: "measured" | "inferred" | "needs-person"; component: string | null; apps: string[]
  owner: string | null; status: "open" | "done"; source: any
  dismissed?: { label: string; reason: string; who?: string; date: string } | null
}

/** The reasons a person can dismiss an issue with (stage 7), in plain words. */
export const DISMISS_LABEL: Record<string, string> = {
  "scanner-misread": "The scanner read this wrong", intended: "Meant to be this way", "not-worth-it": "Not worth fixing", duplicate: "Another issue covers it",
}

/** One certainty word (decision D2), its colour, and what it means. */
export const CERTAINTY_WORD: Record<Issue["certainty"], { label: string; tone: string; icon: typeof InfoIcon; hint: string }> = {
  measured: { label: "Measured", tone: "border-success-soft-border bg-success/10 text-success-soft-foreground", icon: CheckCircleIcon, hint: "Counted from the code, with a known fix." },
  inferred: { label: "Inferred", tone: "bg-secondary text-secondary-foreground", icon: InfoIcon, hint: "The scanner's best reading. Check the evidence before you act." },
  "needs-person": { label: "Needs a person", tone: "border-warning-soft-border bg-warning-soft text-warning-soft-foreground", icon: QuestionIcon, hint: "Only a person can answer this one." },
}

const KIND: Record<Issue["kind"], string> = {
  finding: "Finding", approval: "Approved migration", question: "Question", "component-check": "Component to confirm", "component-unused": "Unused component", readiness: "Agent readiness",
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

type Filter = "open" | "waiting" | "needs-person" | "measured" | "inferred" | "done"
type GroupBy = "component" | "app" | "kind"

/**
 * The thread subject for an issue. A question shares its thread with the Element Review batch of the
 * same elements, so a conversation started in either place shows in both.
 */
export function subjectOf(i: Issue): Subject {
  const src = i.source
  if (src?.type === "question") {
    const ids: string[] = (D.elements?.questions ?? []).find((q: any) => q.key === src.key)?.ids ?? []
    if (ids.length) return { kind: "review", ids, title: i.title }
  }
  return { kind: "issue", key: i.key, title: i.title, source: src }
}

export function Inbox() {
  const issues: Issue[] = D.issues ?? []
  const app = useApp()
  const agent = useAgent()
  const { q, creating, create } = useQueue()
  const [filter, setFilter] = React.useState<Filter>("open")
  const [by, setBy] = React.useState<GroupBy>("component")
  const [closed, setClosed] = React.useState<Set<string>>(new Set())
  const [ticked, setTicked] = React.useState<Set<string>>(new Set())
  const [current, setCurrent] = React.useState<string | null>(() => { const id = routePath().split("/")[1]; return id ? decodeURIComponent(id) : null })
  const list = React.useRef<HTMLDivElement>(null)

  const waiting = (i: Issue) => { const t = agent.threads[anchorKeyOf(subjectOf(i))]; return Boolean(t && t.turns > 0 && (t.state === "waiting-on-you" || t.state === "changes-ready")) }
  const inApp = (i: Issue) => !app || i.apps.includes(app)
  const pass: Record<Filter, (i: Issue) => boolean> = {
    open: i => i.status === "open", waiting: i => i.status === "open" && waiting(i), "needs-person": i => i.status === "open" && i.certainty === "needs-person",
    measured: i => i.status === "open" && i.certainty === "measured", inferred: i => i.status === "open" && i.certainty === "inferred", done: i => i.status === "done",
  }
  const mine = issues.filter(inApp)
  const shown = mine.filter(pass[filter])
  const count = (f: Filter) => mine.filter(pass[f]).length

  const groupOf = (i: Issue) => by === "component" ? (i.component ?? "") : by === "app" ? (i.apps[0] ?? "") : i.kind
  const groups = React.useMemo(() => {
    const m = new Map<string, Issue[]>()
    for (const i of shown) { const g = groupOf(i); m.set(g, [...(m.get(g) ?? []), i]) }
    // Named groups by size, then the issues not about one component or app.
    return [...m].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : b[1].length - a[1].length || a[0].localeCompare(b[0])))
  }, [shown, by])
  const groupLabel = (g: string) => g === "" ? (by === "component" ? "Not about one component" : "Every app") : by === "kind" ? KIND[g as Issue["kind"]] : g
  const order = groups.flatMap(([g, items]) => (closed.has(g) ? [] : items))
  const sel = order.find(i => i.key === current) ?? order[0] ?? null

  const pick = (key: string) => { setCurrent(key); replaceRoute(`inbox/${encodeURIComponent(key)}`) }
  const tick = (key: string) => setTicked(t => { const n = new Set(t); n.has(key) ? n.delete(key) : n.add(key); return n })

  // Keys, as in Element Review: J / K move, X ticks, Esc clears the ticks.
  React.useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return
      const at = sel ? order.findIndex(i => i.key === sel.key) : -1
      // A question's places take J / K themselves (Element Review's keys); Shift+J / K still moves between issues.
      const placesOpen = Boolean(document.querySelector('[data-slot="by-component"]'))
      if ((e.key === "j" || e.key === "k" || e.key === "J" || e.key === "K") && placesOpen && !e.shiftKey) return
      if (e.key === "J" || e.key === "K") { const n = order[Math.max(0, Math.min(order.length - 1, at + (e.key === "J" ? 1 : -1)))]; if (n) { pick(n.key); e.preventDefault() } return }
      if (e.key === "x" && placesOpen) return
      if (e.key === "j" || e.key === "k") { const n = order[Math.max(0, Math.min(order.length - 1, at + (e.key === "j" ? 1 : -1)))]; if (n) { pick(n.key); e.preventDefault(); list.current?.querySelector(`[data-key="${CSS.escape(n.key)}"]`)?.scrollIntoView({ block: "nearest" }) } }
      if (e.key === "x" && sel) { tick(sel.key); e.preventDefault() }
      if (e.key === "Escape") setTicked(new Set())
    }
    addEventListener("keydown", on)
    return () => removeEventListener("keydown", on)
  }, [order, sel])

  if (!D.run) return <Empty className="border"><EmptyHeader><EmptyTitle>No scan yet</EmptyTitle><EmptyDescription>Run a scan to fill the Inbox.</EmptyDescription></EmptyHeader></Empty>
  if (!issues.length) return <Empty className="border"><EmptyHeader><EmptyTitle>No issues in this report</EmptyTitle><EmptyDescription>Re-run the scan to build the Inbox.</EmptyDescription></EmptyHeader></Empty>

  const tickedIssues = shown.filter(i => ticked.has(i.key))
  const filters: [Filter, string, string][] = [
    ["open", "All open", "Every open issue"],
    ...(canChat() ? [["waiting", "Waiting on you", "The agent answered or proposed something, and it's your turn"] as [Filter, string, string]] : []),
    ["needs-person", "Needs a person", CERTAINTY_WORD["needs-person"].hint],
    ["measured", "Measured", CERTAINTY_WORD.measured.hint],
    ["inferred", "Inferred", CERTAINTY_WORD.inferred.hint],
    ["done", "Done", "Closed, resolved by a scan, migrated, or dismissed with a reason"],
  ]

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {plural(count("open"), "open issue")}{app ? ` in ${app}` : ""}. {count("needs-person") ? `${count("needs-person")} need a person.` : "None need a person."}
        {canChat() && count("waiting") ? ` ${count("waiting")} waiting on you.` : ""}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup value={[filter]} onValueChange={(v: any) => { const f = Array.isArray(v) ? v[0] : v; if (f) setFilter(f) }} variant="outline" size="sm" aria-label="Show">
          {filters.map(([f, l, h]) => (
            <Tooltip key={f}><TooltipTrigger render={<ToggleGroupItem value={f} />}>{l}<span className="ml-1 tabular-nums text-muted-foreground">{count(f)}</span></TooltipTrigger><TooltipContent>{h}</TooltipContent></Tooltip>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Group by</span>
          <ToggleGroup value={[by]} onValueChange={(v: any) => { const b = Array.isArray(v) ? v[0] : v; if (b) setBy(b) }} variant="outline" size="sm" aria-label="Group by">
            <ToggleGroupItem value="component">Component</ToggleGroupItem>
            <ToggleGroupItem value="app">App</ToggleGroupItem>
            <ToggleGroupItem value="kind">Kind</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {tickedIssues.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm" data-slot="batch-bar">
          <Badge variant="outline">{tickedIssues.length} ticked</Badge>
          {canChat() && <Button size="sm" variant="outline" onClick={() => agent.start({ kind: "group", by: "component", value: tickedIssues[0]!.component ?? "these issues", title: `${tickedIssues.length} ticked issues` }, { ask: `Look at these issues together and say what they share: ${tickedIssues.map(i => `${i.key} (${i.title})`).join("; ")}.` })}><SparkleIcon data-icon="inline-start" />Ask the agent about {tickedIssues.length}</Button>}
          {D.serve && q?.github.token && tickedIssues.some(i => i.source?.type === "queue") && (
            <Button size="sm" onClick={() => create(tickedIssues.filter(i => i.source?.type === "queue").map(i => i.source.id))} disabled={!!creating}>Create issues for {tickedIssues.filter(i => i.source?.type === "queue").length}</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setTicked(new Set())}>Clear</Button>
          <span className="ml-auto hidden items-center gap-1 text-xs text-muted-foreground sm:flex"><Kbd>J</Kbd><Kbd>K</Kbd> move · <Kbd>X</Kbd> tick · <Kbd>Esc</Kbd> clear</span>
        </div>
      )}

      {/* Wide: the list, the issue, and its pinned thread. Narrower: the thread opens as the side sheet. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] xl:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)_minmax(22rem,26rem)]">
        <div ref={list} className="flex min-w-0 flex-col overflow-hidden rounded-lg border lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto" role="list" aria-label="Issues">
          {!shown.length && <Empty><EmptyHeader><EmptyTitle>{filter === "waiting" ? "Nothing is waiting on you" : filter === "done" ? "Nothing done yet" : "Nothing here"}</EmptyTitle><EmptyDescription>{plural(count("open"), "issue")} open in all.</EmptyDescription></EmptyHeader></Empty>}
          {groups.map(([g, items]) => {
            const open = !closed.has(g)
            const groupSubject: Subject | null = g && by !== "kind" ? { kind: "group", by: by === "app" ? "app" : "component", value: g, title: `Everything about ${groupLabel(g)}` } : null
            return (
              <section key={g || "_"} aria-label={groupLabel(g)}>
                <header className="flex flex-wrap items-center gap-2 border-b bg-muted px-3 py-2">
                  <button type="button" className="flex items-center gap-2 text-left" aria-expanded={open} onClick={() => setClosed(c => { const n = new Set(c); n.has(g) ? n.delete(g) : n.add(g); return n })}>
                    {open ? <CaretDownIcon className="size-4 text-muted-foreground" /> : <CaretRightIcon className="size-4 text-muted-foreground" />}
                    {by === "component" && g && <CubeIcon className="size-4" />}
                    <span className="text-sm font-semibold">{groupLabel(g)}</span>
                  </button>
                  <Badge variant="outline">{plural(items.length, "issue")}</Badge>
                  {groupSubject && <span className="ml-auto flex items-center gap-2"><ThreadBadge subject={groupSubject} />{canChat() && <AskAgent subject={groupSubject} label={`Ask about all ${items.length}`} size="xs" variant="ghost" />}</span>}
                </header>
                {open && items.map(i => (
                  <IssueRow key={i.key} i={i} sel={sel?.key === i.key} ticked={ticked.has(i.key)} onPick={() => pick(i.key)} onTick={() => tick(i.key)} />
                ))}
              </section>
            )
          })}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {sel && canChat() && <Button variant="outline" size="sm" className="w-fit xl:hidden" onClick={() => agent.start(subjectOf(sel))}><SparkleIcon data-icon="inline-start" />Open this issue's thread</Button>}
          {sel ? <IssueDetail i={sel} q={q} creating={!!creating} create={create} /> : <Panel><p className="text-sm text-muted-foreground">Select an issue.</p></Panel>}
        </div>
        {sel && <PinnedThread subject={subjectOf(sel)} className="hidden xl:sticky xl:top-36 xl:flex xl:max-h-[calc(100vh-10rem)]" />}
      </div>
    </div>
  )
}

function CertaintyWord({ c }: { c: Issue["certainty"] }) {
  const w = CERTAINTY_WORD[c]
  const Icon = w.icon
  return <Badge variant="outline" className={w.tone} title={w.hint}><Icon />{w.label}</Badge>
}

function IssueRow({ i, sel, ticked, onPick, onTick }: { i: Issue; sel: boolean; ticked: boolean; onPick: () => void; onTick: () => void }) {
  return (
    <div role="listitem" data-key={i.key} className={cn("flex items-start gap-3 border-b px-3 py-2.5 last:border-b-0", sel && "bg-muted/60", ticked && "bg-primary/5")}>
      <Checkbox checked={ticked} onCheckedChange={onTick} aria-label={`Tick ${i.title}`} className="mt-1" />
      <button type="button" onClick={onPick} aria-current={sel} className={cn("flex min-w-0 flex-1 flex-col gap-1 text-left", i.status === "done" && "opacity-70")}>
        <span className="text-sm font-medium">{i.title}</span>
        <span className="text-xs text-muted-foreground">{KIND[i.kind]}{i.apps.length ? ` · ${i.apps.slice(0, 3).join(", ")}${i.apps.length > 3 ? ` +${i.apps.length - 3}` : ""}` : ""}</span>
        {i.dismissed && <span className="text-xs text-muted-foreground" title={i.dismissed.reason}>Dismissed: {DISMISS_LABEL[i.dismissed.label] ?? i.dismissed.label}{i.dismissed.who ? ` · ${i.dismissed.who}` : ""}</span>}
      </button>
      <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        <CertaintyWord c={i.certainty} />
        <ThreadBadge subject={subjectOf(i)} />
      </span>
    </div>
  )
}

/** The open issue: Actions items keep their full detail; the others say what they are and where to act. */
function IssueDetail({ i, q, creating, create }: { i: Issue; q: any; creating: boolean; create: (ids?: string[]) => Promise<void> }) {
  if (i.source?.type === "queue" && q) {
    const item = q.items.find((x: any) => x.id === i.source.id)
    if (item) return <Detail i={item} q={q} busy={creating} onCreate={() => create([item.id])} base="inbox" />
  }
  const subject = subjectOf(i)
  if (i.kind === "question") {
    const ids: string[] = (D.elements?.questions ?? []).find((x: any) => x.key === i.source?.key)?.ids ?? []
    if (ids.length) return (
      <section aria-label={i.title} className="flex flex-col gap-3">
        <header className="flex flex-wrap items-center gap-2">
          <h2 className="font-heading text-lg font-semibold">{i.title}</h2>
          <CertaintyWord c={i.certainty} />
          <span className="text-xs text-muted-foreground">{plural(ids.length, "place")}{i.apps.length ? ` in ${i.apps.join(", ")}` : ""} · Shift+J / K for the next issue</span>
        </header>
        <AnswerPlaces ids={ids} />
      </section>
    )
  }
  const where: Record<string, [string, string]> = {
    question: ["Answer it in Element Review", "elements"],
    "component-check": ["Confirm or correct it in System", "system"],
    "component-unused": ["See it in System", "system"],
    readiness: ["See the checks in Agents & Benchmarks", "readiness"],
  }
  const [label, route] = where[i.kind] ?? ["", ""]
  const say: Record<string, string> = {
    question: "The scanner can't decide this alone. Look at the places and their photos, then answer: the answer becomes the decision and a label.",
    "component-check": "The scan found this component by its name alone, only in app code, or with an unclear kind. Confirm it is part of the system, or correct it.",
    "component-unused": "No app uses this system component. Promote it, document it, or retire it.",
    readiness: "An agent working in this repo is missing something it needs. The check says what to add.",
  }
  return (
    <Panel title={i.title} action={<CertaintyWord c={i.certainty} />} className="lg:sticky lg:top-36">
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">{say[i.kind]}</p>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-muted-foreground">Kind</dt><dd>{KIND[i.kind]}</dd>
          {i.component && <><dt className="text-muted-foreground">Component</dt><dd>{i.component}</dd></>}
          {i.apps.length > 0 && <><dt className="text-muted-foreground">Apps</dt><dd>{i.apps.join(", ")}</dd></>}
          <dt className="text-muted-foreground">Issue</dt><dd className="font-mono text-xs">{i.key}</dd>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          {route && <Button variant="outline" nativeButton={false} render={<a href={hashFor(route)} />}><ArrowSquareOutIcon data-icon="inline-start" />{label}</Button>}
          <AskAgent subject={subject} label="Ask the agent" />
          <ThreadBadge subject={subject} className="self-center" />
        </div>
      </div>
    </Panel>
  )
}
