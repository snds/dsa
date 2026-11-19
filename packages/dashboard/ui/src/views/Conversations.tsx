import * as React from "react"
import { ChatCircleDotsIcon, MagnifyingGlassIcon, PencilSimpleIcon, StarIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ago, api, fmtDT, say } from "@/lib/dsa"
import { openRoute } from "@/lib/app"
import { THREAD_STATE } from "@/agent/ThreadBadge"
import { aboutOf, keysOf, listConversations, nameOf, type ConvSummary } from "@/agent/history"
import { anchorKeyOf, useAgent } from "@/agent/store"
import { inboxHandoff } from "@/views/Inbox"

type Show = "all" | "waiting" | "starred"
const WAITING = new Set(["waiting-on-you", "changes-ready"])

/**
 * Every conversation with the agent (agentic Inbox, PR B): what each is about, where it stands, and when
 * it last moved. Rename and star them; open one to carry on. Conversations about issues reopen in the
 * Inbox with their issues ticked again; any other opens in the side panel.
 */
export function Conversations() {
  const a = useAgent()
  const [list, setList] = React.useState<ConvSummary[] | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const [show, setShow] = React.useState<Show>("all")
  const [q, setQ] = React.useState("")
  const load = React.useCallback(() => listConversations().then(setList, e => setErr(e.message)), [])
  React.useEffect(() => { void load() }, [load])

  if (err) return <Empty className="border"><EmptyHeader><EmptyTitle>Couldn't load conversations</EmptyTitle><EmptyDescription>{err}</EmptyDescription></EmptyHeader></Empty>
  if (!list) return <p className="text-sm text-muted-foreground">Loading conversations…</p>

  const talked = list.filter(c => c.turns > 0)
  const needle = q.trim().toLowerCase()
  const shown = talked
    .filter(c => show === "all" || (show === "starred" ? c.starred : WAITING.has(c.state)))
    .filter(c => !needle || [nameOf(c), c.asked ?? "", ...aboutOf(c.subject).flatMap(x => [x.label, x.key ?? "", x.app ?? ""])].some(t => t.toLowerCase().includes(needle)))
  const count = (s: Show) => talked.filter(c => s === "all" || (s === "starred" ? c.starred : WAITING.has(c.state))).length

  const open = (c: ConvSummary) => {
    const keys = keysOf(c.subject)
    // The conversation that is its issues' current one reopens in the Inbox, with the issues ticked again.
    if (keys.length && (c.subject.kind === "set" || c.subject.kind === "issue") && a.threads[anchorKeyOf(c.subject)]?.session === c.id) {
      inboxHandoff.ticks = keys.length > 1 ? keys : null
      try { localStorage.setItem("dsa.inbox.threadShut", "0") } catch { /* private window */ }
      openRoute(`inbox/${encodeURIComponent(keys[0]!)}`)
      return
    }
    void a.resume(c.id)
  }
  const meta = async (c: ConvSummary, body: { name?: string; starred?: boolean }) => {
    try { await api("/api/agent/session/meta", { id: c.id, ...body }); await load(); void a.refreshThreads() } catch (e: any) { say(e.message, true) }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Every conversation with the agent is kept. Open one to carry on where it left off.</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup value={[show]} onValueChange={(v: any) => { const s = Array.isArray(v) ? v[0] : v; if (s) setShow(s) }} variant="outline" size="sm" aria-label="Show">
          <ToggleGroupItem value="all">All <span className="ml-1 tabular-nums text-muted-foreground">{count("all")}</span></ToggleGroupItem>
          <ToggleGroupItem value="waiting">Waiting on you <span className="ml-1 tabular-nums text-muted-foreground">{count("waiting")}</span></ToggleGroupItem>
          <ToggleGroupItem value="starred">Starred <span className="ml-1 tabular-nums text-muted-foreground">{count("starred")}</span></ToggleGroupItem>
        </ToggleGroup>
        <div className="relative w-full max-w-xs">
          <MagnifyingGlassIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Find by issue, component or app" aria-label="Find a conversation" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>
      {!shown.length ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>{talked.length ? "Nothing matches" : "No conversations yet"}</EmptyTitle>
            <EmptyDescription>{talked.length ? "Try another filter or word." : "Open an issue in the Inbox, or tick several, and ask the agent about them."}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Conversations">
          {shown.map(c => <Row key={c.id} c={c} onOpen={() => open(c)} onMeta={b => meta(c, b)} />)}
        </ul>
      )}
    </div>
  )
}

function Row({ c, onOpen, onMeta }: { c: ConvSummary; onOpen: () => void; onMeta: (b: { name?: string; starred?: boolean }) => void }) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(nameOf(c))
  const st = THREAD_STATE[c.state] ?? THREAD_STATE.settled
  const about = aboutOf(c.subject)
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
      <Button variant="ghost" size="icon-sm" aria-label={c.starred ? "Unstar" : "Star"} aria-pressed={Boolean(c.starred)} onClick={() => onMeta({ starred: !c.starred })}
        className={c.starred ? "text-warning-soft-foreground" : "text-muted-foreground"}><StarIcon weight={c.starred ? "fill" : "regular"} /></Button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {editing ? (
          <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); onMeta({ name: draft }); setEditing(false) }}>
            <Input autoFocus value={draft} onChange={e => setDraft(e.target.value)} aria-label="Conversation name" className="h-8" />
            <Button size="sm" type="submit">Save</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => { setDraft(nameOf(c)); setEditing(false) }}>Cancel</Button>
          </form>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <button type="button" onClick={onOpen} className="min-w-0 truncate text-left text-sm font-medium hover:underline">{nameOf(c)}</button>
            <Button variant="ghost" size="icon-xs" aria-label="Rename" onClick={() => setEditing(true)}><PencilSimpleIcon /></Button>
          </div>
        )}
        {/* One issue named like the conversation needs no chip. */}
        {!(about.length === 1 && about[0]!.label === nameOf(c)) && <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {about.slice(0, 4).map((x, i) => <span key={i} className="max-w-[18rem] truncate rounded-full border bg-muted/50 px-2 py-0.5" title={x.label}>{x.label}{x.app ? ` · ${x.app}` : ""}</span>)}
          {about.length > 4 && <span className="text-muted-foreground">and {about.length - 4} more</span>}
        </div>}
        {c.asked && <p className="line-clamp-1 text-xs text-muted-foreground">Asked: {c.asked}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
        <Badge variant="outline" className={st.tone} title={st.hint}><st.icon />{st.label}</Badge>
        <span className="text-xs text-muted-foreground" title={fmtDT(c.updatedAt)}>{c.turns} message{c.turns === 1 ? "" : "s"} · {ago(c.updatedAt)}</span>
        <Button size="sm" variant="outline" onClick={onOpen}><ChatCircleDotsIcon data-icon="inline-start" />Open</Button>
      </div>
    </li>
  )
}
