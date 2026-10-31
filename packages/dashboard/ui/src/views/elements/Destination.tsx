import * as React from "react"
import { cn } from "cn"
import { CaretDownIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { D, api, ratio, say, SYS } from "@/lib/dsa"
import { ElementRow, desc, useEl } from "./shared"
import { ReviewCard } from "./ReviewCard"
import { KEEP, NO_HOME, type Destination as Dest, type Status, type Unit, styleName } from "./units"

const PER_GROUP = 6

const ABOUT: Record<string, string> = {
  [NO_HOME]: `Patterns ${SYS} doesn’t cover yet. For each: propose a component, map it to the closest one, or keep it native.`,
  [KEEP]: "Elements a reviewer chose to keep as native HTML.",
  Ignored: "Set aside by a reviewer; not migrated and not asked again.",
}

const STATUS_WORD: Record<Status, string> = { open: "to decide", staged: "staged", ready: "ready", decided: "decided" }
const STATUS_BAR: Record<Status, string> = { open: "bg-warning-soft-foreground/70", staged: "bg-primary/60", ready: "bg-success-soft-foreground/60", decided: "bg-muted-foreground/40" }

/** One destination: its name, what is waiting, a bar of where its elements stand, then its cards. */
export function Destination({ d, units, open, onOpenChange }: { d: Dest; units: Unit[]; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [limit, setLimit] = React.useState(PER_GROUP)
  const statuses = (["open", "staged", "ready", "decided"] as Status[]).filter(s => d.cards[s] > 0)
  const all = statuses.reduce((a, s) => a + d.elements[s], 0)
  const isComponent = !(d.home in ABOUT)
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="border-t pt-4 first:border-t-0 first:pt-0">
      <CollapsibleTrigger className="group flex w-full flex-col gap-2 text-left">
        <span className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1">
          <CaretDownIcon className={cn("shrink-0 self-center text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
          <span className={cn("font-heading text-lg font-semibold group-hover:underline underline-offset-4", isComponent && "font-mono text-base")}>{d.home}</span>
          <span className="text-sm text-muted-foreground">{statuses.map(s => `${d.cards[s]} ${STATUS_WORD[s]}`).join(" · ")}</span>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">{all} element{all === 1 ? "" : "s"}</span>
        </span>
        {/* Where this destination's elements stand, as one bar (counts are in the line above). */}
        <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          {statuses.map(s => <span key={s} className={STATUS_BAR[s]} style={{ width: `${ratio(d.elements[s], all) ?? 0}%` }} />)}
        </span>
        {ABOUT[d.home] && <span className="text-sm text-muted-foreground">{ABOUT[d.home]}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-4 flex flex-col gap-4">
        {units.slice(0, limit).map(u => <UnitCard key={u.key} u={u} />)}
        {!units.length && <p className="text-sm text-muted-foreground">Nothing here matches this filter.</p>}
        {units.length > limit && <Button variant="outline" size="sm" className="self-start" onClick={() => setLimit(l => l + PER_GROUP)}>Show {Math.min(PER_GROUP, units.length - limit)} more of {units.length - limit}</Button>}
      </CollapsibleContent>
    </Collapsible>
  )
}

function UnitCard({ u }: { u: Unit }) {
  if (u.kind === "decided") return <DecidedCard u={u} />
  const auto = u.q?.auto ?? { verdict: u.items[0].verdict, role: u.items[0].role, use: u.items[0].use, from: u.items[0].from, props: u.items[0].props, gap: u.items[0].gap, how: u.items[0].how, parent: u.items[0].parent }
  return <ReviewCard kind={u.kind === "question" ? "question" : u.kind} title={u.title} items={u.items} auto={auto} pattern={u.pattern ?? null} options={u.q?.options} fit={u.q?.fit} ask={u.q?.ask} note={u.q?.note} parts={u.q?.parts} context={u.q?.context} />
}

/** A recorded decision outside the questions: one line, the elements folded, undo in dsa serve. */
function DecidedCard({ u }: { u: Unit }) {
  const { applyLocal, refresh } = useEl()
  const n = u.items.length, d = u.items[0].decided
  const name = styleName(u.pattern)
  const undo = async () => { try { const r = await api("/api/undecide", u.pattern ? { pattern: u.pattern } : { ids: u.items.map(i => i.id) }); applyLocal(r.ids, null); say(`Undone for ${r.ids.length} element(s)`); refresh() } catch (x: any) { say(x.message, true) } }
  return (
    <Card className="gap-0 py-0"><CardContent className="py-3">
      <Collapsible>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <CollapsibleTrigger className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-left text-sm underline-offset-4 hover:underline">
            <b className="font-medium">{u.title}</b>
            <span className="text-xs text-muted-foreground">×{n} · {desc(d.decision)} · {u.pattern ? `one answer for a shared style${name ? ` (${name})` : ""}` : `decided by ${d.by === "agent" ? "an agent" : d.who ?? "a person"}`}{d.note && !/^pattern /.test(d.note) ? ` · “${d.note}”` : ""}</span>
          </CollapsibleTrigger>
          {D.serve && <Button variant="outline" size="xs" onClick={undo}>Undo</Button>}
        </div>
        <CollapsibleContent className="mt-2">{u.items.map(e => <ElementRow key={e.id} e={e} group={u.items.map(x => x.id)} />)}</CollapsibleContent>
      </Collapsible>
    </CardContent></Card>
  )
}
