import * as React from "react"
import { cn } from "cn"
import { ArrowSquareOutIcon, CaretDownIcon, CaretRightIcon, CheckCircleIcon, CubeIcon, InfoIcon, QuestionIcon, SparkleIcon, CaretLineLeftIcon, ArrowsInLineVerticalIcon, ArrowsOutLineVerticalIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Kbd } from "@/components/ui/kbd"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Panel } from "@/components/bits"
import { D, api, say } from "@/lib/dsa"
import { hashFor, replaceRoute, routePath, useApp } from "@/lib/app"
import { AskAgent } from "@/agent/AskAgent"
import { ThreadBadge } from "@/agent/ThreadBadge"
import { anchorKeyOf, canChat, useAgent, useAgentMaybe, type Subject, type Thread } from "@/agent/store"
import { Detail, useQueue } from "./Queue"
import { AnswerPlaces } from "./elements/Elements"
import { Conversation, scopeSubject, type ScopeIssue } from "@/agent/Conversation"
import { CheckAnswer } from "./ComponentCase"
import { PublishedThread, publishedThreadShown } from "@/agent/PublishedThread"

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

/**
 * The issues as they stand: the page's own at first, then (with dsa serve) fresh after anything changes,
 * so an answered, confirmed or dismissed issue leaves the list without a reload.
 */
function useIssues(): Issue[] {
  const [issues, setIssues] = React.useState<Issue[]>(D.issues ?? [])
  React.useEffect(() => {
    if (!D.serve) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => api("/api/issues").then(j => { if (Array.isArray(j.issues)) setIssues(j.issues) }).catch(() => {}), 250) }
    window.addEventListener("dsa:changed", refresh)
    return () => { clearTimeout(timer); window.removeEventListener("dsa:changed", refresh) }
  }, [])
  return issues
}

/**
 * The thread several ticked issues share: their component when they all have the same one; otherwise the
 * whole scan, with the issues named in the question (UX review A U-14, C U-18: it used the first one's).
 */
export function tickedSubject(list: Issue[]): Subject {
  // The ticked issues themselves, as one set (agentic Inbox): not their component or the whole scan.
  return scopeSubject(list.map(toScope), i => subjectOf(list.find(x => x.key === i.key)!))
}

/** An issue as the conversation scope carries it; a question brings its element ids. */
export function toScope(i: Issue): ScopeIssue {
  const src = i.source?.type === "question" ? { type: "question", ids: (D.elements?.questions ?? []).find((q: any) => q.key === i.source.key)?.ids ?? [] } : i.source
  return { key: i.key, title: i.title, source: src, apps: i.apps }
}

/** Why the scan doubts a component, with what it found (UX review B U-14, C U-07: the check asked with no evidence). */
function CheckEvidence({ name }: { name: string }) {
  const c = ((D.model?.components ?? []) as any[]).find(x => String(x.name).toLowerCase() === name.toLowerCase())
  if (!c) return null
  const why: string[] = []
  if (c.evidence?.tier === "convention") why.push("it was found by its name alone, not exported or declared by a system package")
  if (c.inferred) why.push("it was found only in app code")
  if (c.kind?.ambiguous) why.push(`its kind is unclear (${c.kind.kind}, close to another kind)`)
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <p><span className="font-medium">Why it asks:</span> {why.length ? why.join("; ") : "the scan isn't sure it belongs to the system"}.</p>
      {c.evidence?.file && <p className="text-muted-foreground">Found at <code className="font-mono text-xs">{c.evidence.file}{c.evidence.line ? `:${c.evidence.line}` : ""}</code>{c.evidence.extractor ? ` (by ${c.evidence.extractor})` : ""}.</p>}
      {c.uses && <p className="text-muted-foreground">Used {c.uses.consumer ?? 0} time{c.uses.consumer === 1 ? "" : "s"} in apps, {c.uses.internal ?? 0} inside the system, in {c.uses.files ?? 0} file{c.uses.files === 1 ? "" : "s"}.</p>}
    </div>
  )
}

const THREAD_SHUT = "dsa.inbox.threadShut"

/** Set by the Conversations tab before it opens the Inbox: the issues to tick again. */
export const inboxHandoff: { ticks: string[] | null } = { ticks: null }

export function Inbox() {
  const issues = useIssues()
  const app = useApp()
  const agent = useAgent()
  const { q, creating, create } = useQueue()
  const [filter, setFilter] = React.useState<Filter>("open")
  const [by, setBy] = React.useState<GroupBy>("component")
  const [closed, setClosed] = React.useState<Set<string>>(new Set())
  // A conversation reopened from the Conversations tab ticks its issues again.
  const [ticked, setTicked] = React.useState<Set<string>>(() => { const t = new Set(inboxHandoff.ticks ?? []); inboxHandoff.ticks = null; return t })
  const [current, setCurrent] = React.useState<string | null>(() => { const id = routePath().split("/")[1]; return id ? decodeURIComponent(id) : null })
  // Whether `current` came from a link (the page's address), not from acting in the list.
  const fromLink = React.useRef(Boolean(current))
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

  // An issue about several apps sits under each of them when grouped by app (UX review A U-13).
  const groupsOf = (i: Issue): string[] => by === "component" ? [i.component ?? ""] : by === "app" ? (i.apps.length ? i.apps : [""]) : [i.kind]
  const groups = React.useMemo(() => {
    const m = new Map<string, Issue[]>()
    for (const i of shown) for (const g of groupsOf(i)) m.set(g, [...(m.get(g) ?? []), i])
    // Named groups by size, then the issues not about one component or app.
    return [...m].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : b[1].length - a[1].length || a[0].localeCompare(b[0])))
  }, [shown, by])
  const groupLabel = (g: string) => g === "" ? (by === "component" ? "Not about one component" : "Every app") : by === "kind" ? KIND[g as Issue["kind"]] : g
  const order = groups.flatMap(([g, items]) => (closed.has(g) ? [] : items))
  const sel = order.find(i => i.key === current) ?? order[0] ?? null
  // A third column only when there is a thread to show in it (a published page may have none).
  const hasThread = sel ? canChat() || publishedThreadShown(subjectOf(sel)) : false
  // The thread column can be hidden, so the issue gets the width to be reviewed (design review). Kept per browser.
  const [threadShut, setThreadShut] = React.useState(() => { try { return localStorage.getItem(THREAD_SHUT) === "1" } catch { return false } })
  const shutThread = (v: boolean) => { setThreadShut(v); try { localStorage.setItem(THREAD_SHUT, v ? "1" : "0") } catch { /* private window */ } }
  const third = hasThread && !threadShut
  // The list as it was shown, so the issue after one that just left it can be found.
  const lastOrder = React.useRef<Issue[]>(order)
  React.useEffect(() => { if (current && order.some(i => i.key === current)) lastOrder.current = order })

  // A link to an issue the filter hides (done, say) shows that issue, under a filter that has it. One
  // this scan doesn't have says so, and the address follows what is shown.
  React.useEffect(() => {
    if (!current) return
    // The linked issue is on screen: from here on, acting on it moves on.
    if (order.some(i => i.key === current)) {
      // A linked issue is scrolled into view in the list, not left below its inner scroll (visual review B V-16).
      if (fromLink.current) ([...(list.current?.querySelectorAll("[data-key]") ?? [])].find(el => (el as HTMLElement).dataset.key === current) as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" })
      fromLink.current = false; return
    }
    const it = issues.find(i => i.key === current)
    // Acting on the open issue (answering, confirming, dismissing) moves on to the one after it.
    if (!fromLink.current) {
      const was = lastOrder.current, at = was.findIndex(i => i.key === current)
      const next = [...was.slice(at + 1), ...was.slice(0, Math.max(0, at)).reverse()].find(i => order.some(o => o.key === i.key))
      if (next ?? sel) pick((next ?? sel)!.key)
      return
    }
    if (it) {
      const f = (["open", "needs-person", "measured", "inferred", "done"] as Filter[]).find(f => pass[f](it))
      if (f && f !== filter) { setFilter(f); setClosed(new Set()); return }
      if (closed.size) { setClosed(new Set()); return }
    } else {
      say("That issue isn't in this scan any more. Showing the first one.", true)
      if (sel) replaceRoute(`inbox/${encodeURIComponent(sel.key)}`)
      setCurrent(sel?.key ?? null)
    }
  }, [current, issues])
  // The address can change by hand or by a link; follow it.
  React.useEffect(() => {
    const on = () => { const id = routePath().split("/")[1]; if (routePath().startsWith("inbox") && id !== (current ? encodeURIComponent(current) : undefined)) { fromLink.current = true; setCurrent(id ? decodeURIComponent(id) : null) } }
    addEventListener("hashchange", on)
    return () => removeEventListener("hashchange", on)
  }, [])

  const pick = (key: string) => { fromLink.current = false; setCurrent(key); replaceRoute(`inbox/${encodeURIComponent(key)}`) }
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

  if (!D.run) return <Empty className="border"><EmptyHeader><EmptyTitle>No scan yet</EmptyTitle><EmptyDescription>Press Run scan at the top right to fill the Inbox. To check where it will look first, open Settings (the gear) › Sources.</EmptyDescription></EmptyHeader></Empty>
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
        {D.elements && <> <a href={hashFor("elements")} className="whitespace-nowrap underline underline-offset-4 hover:text-foreground">Review elements by component</a></>}
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
          {/* With the list's own controls, set apart from the filters by a divider (design review). */}
          <Separator orientation="vertical" className="mx-1 h-5! self-center" />
          <span className="flex items-center gap-1" role="group" aria-label="Sections">
            <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Expand all sections" disabled={closed.size === 0} onClick={() => setClosed(new Set())} />}><ArrowsOutLineVerticalIcon /></TooltipTrigger><TooltipContent>Expand all</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Collapse all sections" disabled={groups.every(([g]) => closed.has(g))} onClick={() => setClosed(new Set(groups.map(([g]) => g)))} />}><ArrowsInLineVerticalIcon /></TooltipTrigger><TooltipContent>Collapse all</TooltipContent></Tooltip>
          </span>
        </div>
      </div>

      {tickedIssues.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm" data-slot="batch-bar">
          <Badge variant="outline">{tickedIssues.length} ticked</Badge>
          {canChat() && <Button size="sm" variant="outline" onClick={() => agent.start(tickedSubject(tickedIssues), { ask: `Look at these issues together and say what they share: ${tickedIssues.map(i => `${i.key} (${i.title})`).join("; ")}.` })}><SparkleIcon data-icon="inline-start" />Ask the agent about {tickedIssues.length}</Button>}
          {D.serve && q?.github.token && tickedIssues.some(i => i.source?.type === "queue") && (
            <Button size="sm" onClick={() => create(tickedIssues.filter(i => i.source?.type === "queue").map(i => i.source.id))} disabled={!!creating}>Create issues for {tickedIssues.filter(i => i.source?.type === "queue").length}</Button>
          )}
          <BatchDismiss issues={tickedIssues.filter(i => i.status === "open")} onDone={() => setTicked(new Set())} />
          <Button size="sm" variant="ghost" onClick={() => setTicked(new Set())}>Clear</Button>
          <span className="ml-auto hidden items-center gap-1 text-xs text-muted-foreground sm:flex"><Kbd>J</Kbd><Kbd>K</Kbd> move · <Kbd>X</Kbd> tick · <Kbd>Esc</Kbd> clear</span>
        </div>
      )}

      {/* Columns follow the room the Inbox has, not the window: the agent's side panel takes some of it.
          Wide: the list, the issue, and its thread (when there is one to show). Narrower: the thread opens
          as the side sheet. One column: the chosen issue comes first. */}
      <div className="@container">
      <div className={cn("grid items-start gap-6 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]", third && "@7xl:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)_minmax(22rem,26rem)]", hasThread && threadShut && "@7xl:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]")}>
        <div ref={list} className="order-2 flex min-w-0 flex-col overflow-hidden rounded-lg border @4xl:order-none @4xl:max-h-[calc(100vh-12rem)] @4xl:overflow-y-auto @4xl:shadow-[inset_0_-14px_10px_-12px_var(--color-border)]" role="list" aria-label="Issues">
          {!shown.length && <Empty><EmptyHeader><EmptyTitle>{filter === "waiting" ? "Nothing is waiting on you" : filter === "done" ? "Nothing done yet" : "Nothing here"}</EmptyTitle><EmptyDescription>{plural(count("open"), "issue")} open in all.</EmptyDescription></EmptyHeader></Empty>}
          {groups.map(([g, items]) => {
            const open = !closed.has(g)
            const groupSubject: Subject | null = g && by !== "kind" ? { kind: "group", by: by === "app" ? "app" : "component", value: g, title: `Everything about ${groupLabel(g)}` } : null
            return (
              <section key={g || "_"} aria-label={groupLabel(g)}>
                {/* One line at every width: the name truncates, the actions stay put (visual review C V-17). */}
                <header className="flex items-center gap-2 border-b bg-muted px-3 py-2">
                  <button type="button" className="flex min-w-0 items-center gap-2 text-left" title={groupLabel(g)} aria-expanded={open} onClick={() => setClosed(c => { const n = new Set(c); n.has(g) ? n.delete(g) : n.add(g); return n })}>
                    {open ? <CaretDownIcon className="size-4 text-muted-foreground" /> : <CaretRightIcon className="size-4 text-muted-foreground" />}
                    {by === "component" && g && <CubeIcon className="size-4" />}
                    <span className="truncate text-sm font-semibold">{groupLabel(g)}</span>
                  </button>
                  <Badge variant="outline" className="shrink-0">{plural(items.length, "issue")}</Badge>
                  {groupSubject && <span className="ml-auto flex shrink-0 items-center gap-2"><ThreadBadge subject={groupSubject} />{canChat() && <AskAgent subject={groupSubject} label={`Ask about all ${items.length}`} size="xs" variant="ghost" />}</span>}
                </header>
                {open && items.map(i => (
                  <IssueRow key={i.key} i={i} sel={sel?.key === i.key} ticked={ticked.has(i.key)} onPick={() => pick(i.key)} onTick={() => tick(i.key)} />
                ))}
              </section>
            )
          })}
        </div>
        <div className="order-1 flex min-w-0 flex-col gap-3 @4xl:order-none">
          {sel && canChat() && <Button variant="outline" size="sm" className="w-fit @7xl:hidden" onClick={() => agent.start(tickedIssues.length ? tickedSubject(tickedIssues) : subjectOf(sel))}><SparkleIcon data-icon="inline-start" />{tickedIssues.length > 1 ? `Talk about these ${tickedIssues.length}` : "Open the conversation"}</Button>}
          {hasThread && threadShut && <Button variant="outline" size="sm" className="hidden w-fit self-end @7xl:inline-flex" onClick={() => shutThread(false)}><CaretLineLeftIcon data-icon="inline-start" />Show the thread</Button>}
          {/* With nothing in the list, the empty state says it all; no second "Select an issue" card (visual review B V-13). */}
          {sel ? <IssueDetail i={sel} q={q} creating={!!creating} create={create} /> : shown.length > 0 && <Panel><p className="text-sm text-muted-foreground">Select an issue to see it here.</p></Panel>}
        </div>
        {/* The conversation: about the ticked issues, or the open one (agentic Inbox). */}
        {sel && canChat() && !threadShut && <Conversation scope={(tickedIssues.length ? tickedIssues : [sel]).map(toScope)} fromTicks={tickedIssues.length > 0}
          one={x => subjectOf(issues.find(i => i.key === x.key)!)} appOf={k => issues.find(i => i.key === k)?.apps[0]} onUntick={tick}
          onHide={() => shutThread(true)} className="hidden @7xl:sticky @7xl:top-36 @7xl:flex @7xl:h-[calc(100vh-10rem)]" />}
        {/* A published page: the thread as of publishing, and Discuss on GitHub (stage 9). */}
        {sel && !canChat() && <PublishedThread subject={subjectOf(sel)} title={sel.title} onHide={() => shutThread(true)} className={cn("order-3 @4xl:order-none @4xl:col-start-2 @7xl:col-start-auto @7xl:sticky @7xl:top-36", threadShut && "@7xl:hidden")} />}
      </div>
      </div>
    </div>
  )
}

export function CertaintyWord({ c }: { c: Issue["certainty"] }) {
  const w = CERTAINTY_WORD[c]
  const Icon = w.icon
  return <Badge variant="outline" className={w.tone} title={w.hint}><Icon />{w.label}</Badge>
}

/** The thread a row shows: its own, else a conversation about several issues it is part of. */
function rowThread(i: Issue, threads: Record<string, Thread>): Subject {
  const own = subjectOf(i)
  if (threads[anchorKeyOf(own)]) return own
  const set = Object.values(threads).filter(t => t.members?.includes(i.key)).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0]
  return set?.members ? { kind: "set", items: set.members.map(key => ({ key })) } : own
}

function IssueRow({ i, sel, ticked, onPick, onTick }: { i: Issue; sel: boolean; ticked: boolean; onPick: () => void; onTick: () => void }) {
  const threadsHere = useAgentMaybe()?.threads ?? {}
  return (
    <div role="listitem" data-key={i.key} className={cn("flex items-start gap-3 border-b px-3 py-2.5 last:border-b-0", sel && "bg-muted/60", ticked && "bg-primary/5")}>
      <Checkbox checked={ticked} onCheckedChange={onTick} aria-label={`Tick ${i.title}`} className="mt-1" />
      <button type="button" onClick={onPick} aria-current={sel} className={cn("flex min-w-0 flex-1 flex-col gap-1 text-left", i.status === "done" && "opacity-70")}>
        {/* A long unbroken title wraps instead of running under the badges (visual review A V-11). */}
        <span className="text-sm font-medium [overflow-wrap:anywhere]">{i.title}</span>
        <span className="text-xs text-muted-foreground">{KIND[i.kind]}{i.apps.length ? ` · ${i.apps.slice(0, 3).join(", ")}${i.apps.length > 3 ? ` +${i.apps.length - 3}` : ""}` : ""}</span>
        {i.dismissed && <span className="text-xs text-muted-foreground" title={i.dismissed.reason}>Dismissed: {DISMISS_LABEL[i.dismissed.label] ?? i.dismissed.label}{i.dismissed.who ? ` · ${i.dismissed.who}` : ""}</span>}
      </button>
      <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        <CertaintyWord c={i.certainty} />
        <ThreadBadge subject={rowThread(i, threadsHere)} />
      </span>
    </div>
  )
}

/** The open issue: Actions items keep their full detail; the others say what they are and where to act. */
function IssueDetail({ i, q, creating, create }: { i: Issue; q: any; creating: boolean; create: (ids?: string[]) => Promise<void> }) {
  if (i.source?.type === "queue" && q) {
    const item = q.items.find((x: any) => x.id === i.source.id)
    if (item) return <div className="flex flex-col gap-3"><Detail i={item} q={q} busy={creating} onCreate={() => create([item.id])} base="inbox" /><DismissIssue i={i} /></div>
  }
  const subject = subjectOf(i)
  if (i.kind === "question") {
    const ids: string[] = (D.elements?.questions ?? []).find((x: any) => x.key === i.source?.key)?.ids ?? []
    if (ids.length) return (
      <section aria-label={i.title} className="flex flex-col gap-3">
        <header className="flex flex-wrap items-center gap-2">
          <h2 className="font-heading text-lg font-semibold">{i.title}</h2>
          <CertaintyWord c={i.certainty} />
          <span className="text-xs text-muted-foreground">{plural(ids.length, "place")}{i.apps.length ? ` in ${i.apps.join(", ")}` : ""}</span>
        </header>
        <DismissIssue i={i} />
        <AnswerPlaces ids={ids} />
      </section>
    )
  }
  const where: Record<string, [string, string]> = {
    question: ["Answer it in Element Review", "elements"],
    "component-check": ["See it in Components", "system/check"],
    "component-unused": ["See it in Components", "system/unused"],
    readiness: ["See the checks on Health", "readiness"],
  }
  const [label, route] = where[i.kind] ?? ["", ""]
  const say: Record<string, string> = {
    question: "The scanner can't decide this alone. Look at the places and their photos, then answer: the answer becomes the decision and a label.",
    "component-check": "The scan found this component by its name alone, only in app code, or with an unclear kind. Confirm it is part of the system, or correct it.",
    "component-unused": "No app uses this system component. Promote it, document it, or retire it.",
    readiness: "An agent working in this repo is missing something it needs. The check says what to add.",
  }
  return (
    <Panel title={i.title} action={<CertaintyWord c={i.certainty} />} className="@4xl:sticky @4xl:top-36">
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">{say[i.kind]}</p>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-muted-foreground">Kind</dt><dd>{KIND[i.kind]}</dd>
          {i.component && <><dt className="text-muted-foreground">Component</dt><dd>{i.component}</dd></>}
          {i.apps.length > 0 && <><dt className="text-muted-foreground">Apps</dt><dd>{i.apps.join(", ")}</dd></>}
          <dt className="text-muted-foreground">Issue</dt><dd className="font-mono text-xs">{i.key}</dd>
        </dl>
        {i.kind === "component-check" && i.component && <CheckEvidence name={i.component} />}
        {i.kind === "component-check" && i.component && <CheckAnswer name={i.component} />}
        <div className="flex flex-wrap items-center gap-2">
          {route && <Button variant="outline" nativeButton={false} render={<a href={hashFor(route)} />}><ArrowSquareOutIcon data-icon="inline-start" />{label}</Button>}
          <AskAgent subject={subject} label="Ask the agent" />
          <ThreadBadge subject={subject} className="self-center" />
        </div>
        <DismissIssue i={i} />
      </div>
    </Panel>
  )
}

/** Dismiss every ticked issue with one reason (UX review A U-15, B U-19: ticking offered only Ask). */
function BatchDismiss({ issues, onDone }: { issues: Issue[]; onDone: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [label, setLabel] = React.useState("intended")
  const [busy, setBusy] = React.useState(false)
  if (!D.serve || !issues.length) return null
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Dismiss {issues.length}…</Button>
  const go = async () => {
    setBusy(true)
    let n = 0
    for (const i of issues) { try { await api("/api/agent/dismissal", { key: i.key, label, reason: "", title: i.title }); n++ } catch (e: any) { say(`${i.key}: ${e.message}`, true) } }
    setBusy(false); setOpen(false)
    if (n) { say(`Dismissed ${n}: ${DISMISS_LABEL[label]}. Undo on each one, under Done.`); onDone() }
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <NativeSelect size="sm" aria-label="Why" value={label} onChange={e => setLabel(e.target.value)}>
        {Object.entries(DISMISS_LABEL).map(([k, v]) => <NativeSelectOption key={k} value={k}>{v}</NativeSelectOption>)}
      </NativeSelect>
      <Button size="sm" onClick={() => void go()} disabled={busy}>Dismiss {issues.length}</Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </span>
  )
}

/**
 * Dismiss an issue with a reason, or undo a dismissal (dsa serve). A person can do this directly; the agent
 * can only propose it. The reason stays with the issue under Done, and "the scanner read this wrong" is
 * the cue for a scanner hint.
 */
function DismissIssue({ i }: { i: Issue }) {
  const [open, setOpen] = React.useState(false)
  const [label, setLabel] = React.useState("intended")
  const [reason, setReason] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  if (!D.serve) return null
  const undo = async () => {
    try { await api("/api/agent/dismissal/undo", { key: i.key }); say("Dismissal undone: the issue is open again.") } catch (e: any) { say(e.message, true) }
  }
  if (i.dismissed) return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>Dismissed: {DISMISS_LABEL[i.dismissed.label] ?? i.dismissed.label}{i.dismissed.reason ? ` — ${i.dismissed.reason}` : ""}{i.dismissed.who ? ` · ${i.dismissed.who}, ${i.dismissed.date}` : ""}</span>
      <Button size="sm" variant="outline" onClick={undo}>Undo the dismissal</Button>
    </p>
  )
  if (i.status === "done") return null
  if (!open) return <Button size="sm" variant="ghost" className="w-fit text-muted-foreground" onClick={() => setOpen(true)}>Dismiss this issue…</Button>
  const go = async () => {
    setBusy(true)
    try {
      await api("/api/agent/dismissal", { key: i.key, label, reason: reason.trim(), title: i.title })
      setOpen(false); setReason("")
      toast.success(`Dismissed: ${DISMISS_LABEL[label]}`, { duration: 10000, action: { label: "Undo", onClick: () => { void undo() } } })
    } catch (e: any) { say(e.message, true) }
    setBusy(false)
  }
  return (
    <form className="flex flex-col gap-2 rounded-lg border p-3" aria-label="Dismiss this issue" onSubmit={e => { e.preventDefault(); void go() }}>
      <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Why</span>
        <NativeSelect value={label} onChange={e => setLabel(e.target.value)}>
          {Object.entries(DISMISS_LABEL).map(([k, v]) => <NativeSelectOption key={k} value={k}>{v}</NativeSelectOption>)}
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Note <span className="font-normal text-muted-foreground">(optional, kept with the issue)</span></span>
        <Textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} />
      </label>
      <div className="flex gap-2"><Button size="sm" type="submit" disabled={busy}>Dismiss</Button><Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
    </form>
  )
}
