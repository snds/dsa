import * as React from "react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Note } from "@/components/bits"
import { D, short, SYS } from "@/lib/dsa"
import { Crop, Natural } from "./SameScale"
import { Conf, decidable, decideNow, nameOf, pickText, proposalFor, useEl } from "./shared"
import { KEEP, NO_HOME } from "./units"
import { byComponent, shows, statusOf, type Batch, type ComponentGroup, type Counts, type LookGroup, type PlaceStatus } from "./structure"

/**
 * Element Review by component. The rail lists where places go (a component, No fit yet, Keep as is),
 * each with how much is left. The selected one shows its batches (one per set of settings) and, inside
 * each, places that share a style. Every place shows the element as the app draws it beside the proposal,
 * at real size. Answer one place, a look group, or a whole batch; an answer moves a place to where it now goes.
 */

const VIEW_KEY = "dsa.elements.component"
const read = (k: string) => { try { return window.localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string) => { try { window.localStorage.setItem(k, v) } catch { /* kept for this visit */ } }

const NAMES = { noHome: NO_HOME, keep: KEEP, ignored: "Set aside", unclear: "Unclear" }
const FILTERS: [PlaceStatus | "all", string][] = [["todo", "To decide"], ["evidence", "Needs evidence"], ["proposed", "Proposed"], ["decided", "Decided"], ["all", "All"]]
const STATUS: Record<PlaceStatus, { text: string; cls: string }> = {
  todo: { text: "To decide", cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  evidence: { text: "Needs evidence", cls: "text-muted-foreground" },
  proposed: { text: "Proposed", cls: "border-primary/40 bg-primary/10 text-primary" },
  decided: { text: "Decided", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Progress for one component: decided, proposed, to decide, waiting on evidence. */
function Bar({ c }: { c: Counts }) {
  const w = (n: number) => `${c.total ? (n / c.total) * 100 : 0}%`
  return (
    <span className="flex h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <i className="block bg-emerald-500" style={{ width: w(c.decided) }} />
      <i className="block bg-primary/70" style={{ width: w(c.proposed) }} />
      <i className="block bg-amber-500" style={{ width: w(c.todo) }} />
    </span>
  )
}

const left = (c: Counts) => c.todo + c.evidence

/** The undecided places a batch answer covers: only those a person can see (a photo and a drawn proposal), never blind. */
const seen = (items: any[]) => items.filter(e => !e.decided && decidable(e)).map(e => e.id)

export function ByComponent({ evals }: { evals: any[] }) {
  const groups = byComponent(evals, NAMES, decideNow)
  const [sel, setSel] = React.useState<string>(() => { const k = read(VIEW_KEY); return k && groups.some(g => g.key === k) ? k : groups.find(g => g.counts.todo)?.key ?? groups[0]?.key ?? "" })
  const g = groups.find(x => x.key === sel) ?? groups[0]
  const [show, setShow] = React.useState<PlaceStatus | "all">(() => (g?.counts.todo ? "todo" : "all"))
  const choose = (k: string) => { setSel(k); write(VIEW_KEY, k); const next = groups.find(x => x.key === k); setShow(next?.counts.todo ? "todo" : "all") }
  if (!g) return <Note>No elements to place yet.</Note>
  const components = groups.filter(x => x.kind === "component"), others = groups.filter(x => x.kind !== "component")

  return (
    <div className="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)]" data-slot="by-component">
      <nav aria-label="Where places go" className="flex flex-col gap-1 md:sticky md:top-2 md:max-h-[calc(100vh-1rem)] md:self-start md:overflow-y-auto">
        <RailHead>Components</RailHead>
        {components.map(x => <RailItem key={x.key} g={x} on={x.key === g.key} onClick={() => choose(x.key)} />)}
        {others.length > 0 && <RailHead>Other answers</RailHead>}
        {others.map(x => <RailItem key={x.key} g={x} on={x.key === g.key} onClick={() => choose(x.key)} />)}
      </nav>

      <section className="flex min-w-0 flex-col gap-4" aria-labelledby="bc-title">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="bc-title" className="font-heading text-lg font-semibold">{g.kind === "component" ? `${SYS} ${g.name}` : g.name}</h2>
          <span className="text-sm text-muted-foreground">{plural(g.counts.total, "place")} · {plural(g.batches.length, "batch", "batches")} · {g.counts.todo} to decide</span>
        </div>
        <ToggleGroup aria-label="Show" value={[show]} onValueChange={(v: string[]) => v[0] && setShow(v[0] as any)} variant="outline" size="sm" className="flex-wrap">
          {FILTERS.map(([v, l]) => <ToggleGroupItem key={v} value={v}>{l} <span className="tabular-nums text-muted-foreground">{v === "all" ? g.counts.total : g.counts[v]}</span></ToggleGroupItem>)}
        </ToggleGroup>
        {!D.serve && <Note className="text-xs">Read-only snapshot: answer from the "By question" view, which stages decisions in this browser.</Note>}
        {g.batches.map(b => <BatchCard key={b.key} b={b} show={show} />)}
        {!g.batches.some(b => b.items.some(e => shows(e, show, decideNow))) && <Note>Nothing here matches this filter.</Note>}
      </section>
    </div>
  )
}

const RailHead = ({ children }: { children: React.ReactNode }) => <span className="mt-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground first:mt-0">{children}</span>

function RailItem({ g, on, onClick }: { g: ComponentGroup; on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-current={on ? "true" : undefined}
      className={cn("grid grid-cols-[1fr_auto] items-baseline gap-x-2 gap-y-1 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring", on && "bg-muted font-medium")}>
      <span className="truncate">{g.name}</span>
      <span className="text-xs tabular-nums text-muted-foreground" title={`${g.counts.todo} to decide, ${g.counts.total} places`}>{left(g.counts) ? `${left(g.counts)} / ${g.counts.total}` : g.counts.total}</span>
      <span className="col-span-2"><Bar c={g.counts} /></span>
    </button>
  )
}

function Answer({ ids, children, variant = "outline" }: { ids: string[]; children: React.ReactNode; variant?: "outline" | "ghost" }) {
  const { openPicker } = useEl()
  if (!D.serve) return null
  return <Button variant={variant} size="sm" onClick={() => openPicker({ ids })}>{children}</Button>
}

function BatchCard({ b, show }: { b: Batch; show: PlaceStatus | "all" }) {
  const looks = b.looks.map(l => ({ l, items: l.items.filter(e => shows(e, show, decideNow)) })).filter(x => x.items.length)
  if (!looks.length) return null
  const open = seen(b.items)
  return (
    <article className="rounded-lg border bg-card" data-slot="batch">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5">
        <h3 className="text-sm font-semibold">{pickText(b.pick)}</h3>
        <span className="text-xs text-muted-foreground">{plural(b.items.length, "place")} · {b.counts.todo} to decide{b.counts.decided ? ` · ${b.counts.decided} decided` : ""}</span>
        {open.length > 1 && <span className="ml-auto"><Answer ids={open}>Answer all {open.length}…</Answer></span>}
      </header>
      <div className="flex flex-col divide-y">
        {looks.map(({ l, items }) => <Look key={l.key} l={l} items={items} single={b.looks.length === 1} />)}
      </div>
    </article>
  )
}

function lookTitle(l: LookGroup) {
  if (l.kind === "shared") return <>Shared style <code className="font-mono text-xs">{l.name}</code></>
  if (l.kind === "same-classes") return "Same classes"
  return "One-off styles"
}

function Look({ l, items, single }: { l: LookGroup; items: any[]; single: boolean }) {
  const open = seen(l.items)
  return (
    <div className="flex flex-col" data-slot="look">
      {!single && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-muted/40 px-4 py-1.5">
          <span className="text-xs font-medium">{lookTitle(l)}</span>
          <span className="text-xs text-muted-foreground">{l.kind === "one-off" ? "each looks different: check one by one" : `${plural(l.items.length, "place")}, usually one answer`}</span>
          {l.kind !== "one-off" && open.length > 1 && <span className="ml-auto"><Answer ids={open} variant="ghost">Answer these {open.length}…</Answer></span>}
        </div>
      )}
      <ul className="flex flex-col divide-y" role="list">
        {items.map(e => <Place key={e.id} e={e} group={l.items.map(x => x.id)} />)}
      </ul>
    </div>
  )
}

function Place({ e, group }: { e: any; group: string[] }) {
  const { openLightbox, openCode, byId } = useEl()
  const st = statusOf(e, decideNow)
  const pick = e.decided ? e.decided.decision : e
  const drawn = proposalFor(pick, e)
  // The zoom view steps through this look group's photos.
  const openShot = () => { const ids = group.filter(id => byId.get(id)?.shot); openLightbox(ids, Math.max(0, ids.indexOf(e.id))) }
  return (
    <li className="grid gap-3 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-center" data-slot="place" data-status={st}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {e.shot ? (
          <button type="button" onClick={openShot} className="max-w-[12rem] cursor-zoom-in rounded border bg-background p-0.5" aria-label={`Open the screenshot of ${nameOf(e)}`}>
            <Crop url={e.shot.url} box={e.shot.box} alt={`${nameOf(e)} as the app draws it`} />
          </button>
        ) : <span className="grid h-10 w-24 place-items-center rounded border border-dashed text-[11px] text-muted-foreground">No photo</span>}
        <span aria-hidden className="text-xs text-muted-foreground">→</span>
        {drawn?.url ? <span className="max-w-[12rem] rounded border bg-background p-0.5"><Natural url={drawn.url} alt={`Proposed: ${pickText(pick)}`} /></span>
          : <span className="text-xs text-muted-foreground">{pick.verdict === "replace" ? "not drawn yet" : pickText(pick)}</span>}
      </div>
      <div className="flex min-w-0 flex-col text-sm">
        <span className="truncate font-medium">{nameOf(e)}</span>
        <span className="truncate text-xs text-muted-foreground">{e.review?.pageName ?? e.target}</span>
        <button type="button" onClick={() => openCode(e.id)} className="w-fit truncate font-mono text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" title="Open the code">{short(e.file)}:{e.line}</button>
        {e.decided?.note && <span className="text-xs text-muted-foreground">Note: {e.decided.note}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <Conf c={e.confidence} cap={e.evidenceCap} />
        <Badge variant="outline" className={cn("text-[11px] font-normal", STATUS[st].cls)}>{STATUS[st].text}</Badge>
        <Answer ids={[e.id]} variant="ghost">{e.decided ? "Change…" : "Answer…"}</Answer>
      </div>
    </li>
  )
}
