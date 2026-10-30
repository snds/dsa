import * as React from "react"
import { cn } from "cn"
import { CaretDownIcon, CheckIcon, FlaskIcon, GitBranchIcon, PaperPlaneRightIcon, SparkleIcon, StopIcon, TrashIcon, WrenchIcon, XIcon, ChatCircleDotsIcon, ClockCounterClockwiseIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Pre } from "@/components/bits"
import { api, ago } from "@/lib/dsa"
import { BeforeAfter } from "./BeforeAfter"
import { Markdown } from "./Markdown"
import { useAgent, type Msg, type Proposal } from "./store"

const PROVIDER: Record<string, string> = { "claude-code": "Claude Code", cursor: "Cursor" }
const KIND: Record<string, string> = { decision: "Decision", policy: "Policy", hint: "Scanner hint", "scanner-note": "Scanner note", issue: "Issue draft" }

/**
 * The agent, docked on the right. Not modal: the card or queue item it's about stays in view.
 * Every change the agent wants comes back as a proposal card or a sandbox diff for the designer to
 * accept, keep, or throw away; the agent itself never writes to the review or the repo.
 */
export function AgentPanel() {
  const a = useAgent()
  const [draft, setDraft] = React.useState("")
  const end = React.useRef<HTMLDivElement>(null)
  const s = a.session
  const msgs = s?.messages ?? []
  React.useEffect(() => { end.current?.scrollIntoView({ block: "end" }) }, [msgs.length, a.streaming?.text.length, a.proposals.length])
  if (!a.open) return null

  const send = (text: string, mode?: "advise" | "try") => { if (!text.trim() || a.busy || a.visual.running) return; a.send(text, mode); setDraft("") }
  const open = a.proposals.filter(p => p.status === "open")
  const shown = (m: Msg) => a.proposals.filter(p => m.proposals?.includes(p.id))
  const orphan = a.proposals.filter(p => !msgs.some(m => m.proposals?.includes(p.id)))

  return (
    <aside aria-label="Agent" className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l bg-background shadow-xl sm:w-[440px]">
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <SparkleIcon className="mt-1 size-4 shrink-0 text-primary" weight="fill" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">DS engineer{s ? ` · ${PROVIDER[s.provider]}` : ""}</p>
          <h2 className="truncate font-heading text-sm font-semibold" title={s?.title}>{s?.title ?? (a.starting ? "Starting…" : "Agent")}</h2>
        </div>
        <Sessions />
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Close the agent" onClick={a.close} />}><XIcon /></TooltipTrigger>
          <TooltipContent>Close (the session is kept)</TooltipContent>
        </Tooltip>
      </header>

      {s && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2">
          <ToggleGroup value={[s.mode]} onValueChange={(v: any) => v[0] && v[0] !== s.mode && api("/api/agent/changes", { id: s.id, action: "mode", mode: v[0] }).then(a.refresh)} variant="outline" size="sm" disabled={a.busy}>
            <ToggleGroupItem value="advise" title="Reads and advises. Can't edit files.">Advise</ToggleGroupItem>
            <ToggleGroupItem value="try" title="May edit a throwaway copy of the repo to try a change."><FlaskIcon />Try in sandbox</ToggleGroupItem>
          </ToggleGroup>
          <span className="text-xs text-muted-foreground">{s.repo.name}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {a.starting && <p className="text-sm text-muted-foreground">Preparing the brief: the scan's evidence, the design-system entries, and the rules…</p>}
        {s && msgs.length === 0 && !a.busy && (
          <div className="mb-4 rounded-lg border bg-muted/30 p-3 text-sm">
            <p className="font-medium">I've read the scan for this.</p>
            <p className="mt-1 text-muted-foreground">Ask anything, or start with one of these. I'll show my evidence, and anything I'd change comes back to you to accept.</p>
          </div>
        )}
        <ol className="flex flex-col gap-4">
          {msgs.map((m, i) => <Message key={i} m={m} proposals={shown(m)} />)}
          {a.streaming && <Message m={a.streaming} live proposals={[]} />}
        </ol>
        {orphan.length > 0 && <div className="mt-4 flex flex-col gap-2">{orphan.map(p => <ProposalCard key={p.id} p={p} />)}</div>}
        {a.changes?.files.length ? <ChangesCard /> : null}
        {s?.kept && <p className="mt-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"><GitBranchIcon className="size-4" />Kept on <code className="font-mono">{s.kept.branch}</code> ({s.kept.commit}) in your local {s.repo.name} repo. Push it and open a pull request as usual.</p>}
        {a.error && <p role="alert" className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{a.error} {/install|not on PATH|isn't installed/i.test(a.error) && <a href="#settings/agents" className="underline underline-offset-4">Settings › Agents</a>}</p>}
        <div ref={end} />
      </div>

      {s && !a.busy && s.starters.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t px-4 pt-3">
          {s.starters.map(st => (
            <Button key={st.label} variant="outline" size="xs" className="h-auto py-1 whitespace-normal text-left" onClick={() => send(st.prompt, st.mode)} title={st.prompt}>
              {st.mode === "try" && <FlaskIcon data-icon="inline-start" />}{st.label}
            </Button>
          ))}
        </div>
      )}
      <form className="flex flex-col gap-2 px-4 py-3" onSubmit={e => { e.preventDefault(); send(draft) }}>
        <Textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder={s ? "Ask about this, or tell it what to try…" : "Start from a card, a queue item, or Agent Readiness."} disabled={!s}
          rows={2} className="max-h-40 min-h-16 resize-none" onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(draft) } }} aria-label="Message the agent" />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{open.length ? `${open.length} proposal${open.length === 1 ? "" : "s"} waiting for you` : "Enter sends · Shift+Enter for a new line"}</span>
          {a.busy
            ? <Button type="button" size="sm" variant="outline" onClick={a.cancel}><StopIcon data-icon="inline-start" />Stop</Button>
            : <Button type="submit" size="sm" disabled={!s || !draft.trim() || a.visual.running}><PaperPlaneRightIcon data-icon="inline-start" />Send</Button>}
        </div>
      </form>
    </aside>
  )
}

function Message({ m, live, proposals }: { m: Msg; live?: boolean; proposals: Proposal[] }) {
  if (m.role === "user") return <li className="ml-8 rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{m.text}</li>
  return (
    <li className="flex flex-col gap-2">
      {(m.tools?.length ?? 0) > 0 && <Activity tools={m.tools!} live={live} />}
      {m.text ? <Markdown text={m.text} /> : live ? <p className="text-sm text-muted-foreground animate-pulse">Thinking…</p> : null}
      {m.error && <p className="text-sm text-destructive">{m.error}</p>}
      {proposals.map(p => <ProposalCard key={p.id} p={p} />)}
      {m.costUsd != null && !live && <span className="text-[11px] text-muted-foreground">${m.costUsd.toFixed(2)} this turn</span>}
    </li>
  )
}

/** What the agent looked at, in words. Collapsed once there's more than a few lines. */
function Activity({ tools, live }: { tools: { summary: string }[]; live?: boolean }) {
  const [open, setOpen] = React.useState(false)
  const last = tools[tools.length - 1]
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <WrenchIcon className="size-3.5" />
        {live ? last.summary : `Checked ${tools.length} thing${tools.length === 1 ? "" : "s"}`}
        <CaretDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent><ul className="mt-1 ml-5 list-disc space-y-0.5 text-xs text-muted-foreground">{tools.map((t, i) => <li key={i}>{t.summary}</li>)}</ul></CollapsibleContent>
    </Collapsible>
  )
}

export function ProposalCard({ p }: { p: Proposal }) {
  const a = useAgent()
  const [busy, setBusy] = React.useState(false)
  const act = async (x: "accept" | "reject") => { setBusy(true); await a.decide(p, x); setBusy(false) }
  return (
    <div className={cn("rounded-lg border p-3 text-sm", p.status === "open" ? "border-primary/40 bg-primary/5" : "opacity-80")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{KIND[p.kind] ?? p.kind}</Badge>
        {p.confidence && <Badge variant="outline">{p.confidence} confidence</Badge>}
        {p.status !== "open" && <Badge variant="outline" className="gap-1">{p.status === "accepted" && <CheckIcon />}{p.status}</Badge>}
      </div>
      <p className="mt-2 font-medium">{p.title}</p>
      <p className="mt-1 text-muted-foreground">{p.rationale}</p>
      {p.kind === "hint" && <Pre className="mt-2 max-h-40">{JSON.stringify({ when: p.payload.when, prefer: p.payload.prefer, avoid: p.payload.avoid }, null, 1)}</Pre>}
      {p.kind === "issue" && <Pre className="mt-2 max-h-48">{`${p.payload.title}\n\n${p.payload.body}`}</Pre>}
      {p.evidence?.length ? <p className="mt-2 text-xs text-muted-foreground">Evidence: {p.evidence.join(" · ")}</p> : null}
      {p.result && <p className="mt-2 text-xs">{/^https:/.test(p.result) ? "Opened a new GitHub issue page for you to file." : p.result}</p>}
      {p.status === "open" && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => act("accept")} disabled={busy}><CheckIcon data-icon="inline-start" />{busy ? (p.kind === "hint" ? "Applying and re-scoring…" : "Applying…") : p.kind === "issue" ? "Accept and open on GitHub" : "Accept"}</Button>
          <Button size="sm" variant="outline" onClick={() => act("reject")} disabled={busy}>Reject</Button>
        </div>
      )}
    </div>
  )
}

function ChangesCard() {
  const a = useAgent()
  const c = a.changes!
  const [open, setOpen] = React.useState(false)
  return (
    <div className="mt-4 rounded-lg border p-3 text-sm">
      <p className="flex items-center gap-2 font-medium"><FlaskIcon className="size-4" />Changes in the sandbox ({c.files.length} file{c.files.length === 1 ? "" : "s"})</p>
      <p className="mt-1 text-xs text-muted-foreground">A throwaway copy of {a.session?.repo.name}. Keep makes a local branch with these changes; nothing is pushed.</p>
      <ul className="mt-2 font-mono text-xs">{c.files.map(f => <li key={f.file}>{f.status} {f.file}</li>)}</ul>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="mt-2 flex items-center gap-1 text-xs font-medium text-muted-foreground hover:underline" onClick={() => !c.diff && a.refresh()}>
          <CaretDownIcon className={cn("transition-transform", open && "rotate-180")} />{open ? "Hide the diff" : "Show the diff"}
        </CollapsibleTrigger>
        <CollapsibleContent><Pre className="mt-2 max-h-96">{c.diff || c.stat || "Loading…"}</Pre></CollapsibleContent>
      </Collapsible>
      <BeforeAfter />
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={() => a.changesAction("keep")} disabled={a.busy || a.visual.running}><GitBranchIcon data-icon="inline-start" />Keep as a branch</Button>
        <Button size="sm" variant="outline" onClick={() => a.changesAction("discard")} disabled={a.busy || a.visual.running}><TrashIcon data-icon="inline-start" />Throw away</Button>
      </div>
    </div>
  )
}

/** Earlier sessions, newest first. */
function Sessions() {
  const a = useAgent()
  const [list, setList] = React.useState<any[]>([])
  return (
    <DropdownMenu onOpenChange={(o: boolean) => { if (o) api("/api/agent/sessions").then(r => setList(r.sessions)).catch(() => {}) }}>
      <Tooltip>
        <TooltipTrigger render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Earlier sessions" />} />}><ClockCounterClockwiseIcon /></TooltipTrigger>
        <TooltipContent>Earlier sessions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-80">
        {/* A group label must sit inside a group (Base UI throws, and the whole page goes blank, otherwise). */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Sessions</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => a.start({ kind: "scan" })}><ChatCircleDotsIcon />New: talk about the whole scan</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {list.length ? list.slice(0, 15).map(x => (
          <DropdownMenuItem key={x.id} onClick={() => a.resume(x.id)} className="flex-col items-start gap-0">
            <span className="w-full truncate">{x.title}</span>
            <span className="text-xs text-muted-foreground">{PROVIDER[x.provider]} · {x.turns} message{x.turns === 1 ? "" : "s"} · {ago(x.updatedAt)}</span>
          </DropdownMenuItem>
        )) : <p className="px-2 py-1.5 text-xs text-muted-foreground">None yet.</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
