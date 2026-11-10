import * as React from "react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Note } from "@/components/bits"
import { D, api, reviewerName, say, short, SYS } from "@/lib/dsa"
import { Crop, Natural } from "./SameScale"
import { Conf, decidable, decideNow, nameOf, ownWords, pickText, proposalFor, useEl } from "./shared"
import { KEEP, NO_HOME } from "./units"
import { Focus } from "./Focus"
import { KEYS, keyAction } from "./keys"
import { Kbd } from "@/components/ui/kbd"
import { byComponent, neighboursOf, pickOf, shows, statusOf, withApart, type Batch, type ComponentGroup, type Counts, type LookGroup, type PlaceStatus } from "./structure"

/**
 * Element Review by component. The rail lists where places go (a component, No home yet, Keep native),
 * each with how much is left. The selected one shows its batches (one per set of settings) and, inside
 * each, places that share a style. Every place shows the element as the app draws it beside the proposal,
 * at real size.
 *
 * Answering many at once: tick places (a look group or a whole batch at once, shift-click for a range),
 * give any of them its own note, and answer them together from the bar at the bottom. Only places a
 * person can see (a photo and a drawn proposal) can be ticked. A spot check (a random check of an answer
 * dsa was already sure of) is answered on its own, never in a batch. The last answer can be undone.
 */

const VIEW_KEY = "dsa.elements.component"
const read = (k: string) => { try { return window.localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string) => { try { window.localStorage.setItem(k, v) } catch { /* kept for this visit */ } }

const NAMES = { noHome: NO_HOME, keep: KEEP, ignored: "Set aside", unclear: "Unclear" }
const FILTERS: [PlaceStatus | "all", string][] = [["todo", "To decide"], ["evidence", "Needs evidence"], ["proposed", "Proposed"], ["decided", "Decided"], ["all", "All"]]
const STATUS: Record<PlaceStatus | "check", { text: string; cls: string }> = {
  todo: { text: "To decide", cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  evidence: { text: "Needs evidence", cls: "text-muted-foreground" },
  proposed: { text: "Proposed", cls: "border-primary/40 bg-primary/10 text-primary" },
  decided: { text: "Decided", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  check: { text: "Spot check", cls: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300" },
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const left = (c: Counts) => c.todo + c.evidence

/** Places dsa was sure of, drawn at random for a person to check: answered one at a time. */
const spotChecks = (): Set<string> => new Set((D.elements?.review?.items ?? []).filter((i: any) => i.why === "audit").map((i: any) => i.id))

/** Why a place can't be ticked for a batch answer, or null when it can. */
function whyNot(e: any, checks: Set<string>): string | null {
  if (!D.serve) return "Answers need dsa serve"
  if (e.decided) return "Already decided: use Change… on its row"
  if (checks.has(e.id)) return "A spot check is answered on its own"
  if (!decidable(e)) return "No photo or drawn proposal yet, so it can't be answered in a batch"
  return null
}

/** The decision "Confirm" records for a place: dsa's pick for it, as is. */
const confirmOf = (e: any) => { const r = pickOf(e); return { verdict: r.verdict, role: r.role ?? e.role, ...(r.use ? { use: r.use } : {}), ...(r.from ? { from: r.from } : {}), ...(r.props ? { props: r.props } : {}), ...(r.gap ? { gap: r.gap } : {}), ...(r.content ? { content: r.content } : {}) } }

interface Sel {
  selected: Set<string>; toggle: (ids: string[], on: boolean) => void; click: (id: string, shift: boolean) => void
  notes: Record<string, string>; setNote: (id: string, v: string) => void; checks: Set<string>; see: (e: any) => boolean
  /** Answer the ticked places in `ids` with another component from the strip. */
  useFor: (pick: any, ids: string[]) => void
  busy: boolean
  /** Open the one-place view at this place, stepping through the places on screen. */
  look: (id: string) => void
  /** Places with their evidence, as Label Review offers them: they open side by side. */
  reviewable: Set<string>
  /** The place the keyboard is on. */
  cursor: string | null
  /** Places set apart from their look group in this browser. */
  apart: Set<string>
}

const APART_KEY = "dsa.elements.apart"
const readApart = (): Set<string> => { try { const v = JSON.parse(window.localStorage.getItem(APART_KEY) || "[]"); return new Set(Array.isArray(v) ? v.filter((x: unknown) => typeof x === "string") : []) } catch { return new Set() } }
const SelCtx = React.createContext<Sel>(null as any)

/** One saved answer, kept so it can be undone: its elements and the moment its labels were written. */
interface Done { text: string; parts: { ids: string[]; labelsAt?: string }[] }

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

export function ByComponent({ evals }: { evals: any[] }) {
  const { byId, applyLocal, refresh, openPicker } = useEl()
  const groups = byComponent(evals, NAMES, decideNow)
  const [sel, setSel] = React.useState<string>(() => { const k = read(VIEW_KEY); return k && groups.some(g => g.key === k) ? k : groups.find(g => g.counts.todo)?.key ?? groups[0]?.key ?? "" })
  const g = groups.find(x => x.key === sel) ?? groups[0]
  const [show, setShow] = React.useState<PlaceStatus | "all">(() => (g?.counts.todo ? "todo" : "all"))
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [notes, setNotes] = React.useState<Record<string, string>>({})
  const [batchNote, setBatchNote] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState<Done | null>(null)
  // Places answered here stay where they were until the filter or component changes, so an answer
  // (and its note) doesn't vanish mid-review.
  const [stay, setStay] = React.useState<Set<string>>(new Set())
  const keep = (ids: string[]) => setStay(s => new Set([...s, ...ids]))
  const filter = (v: PlaceStatus | "all") => { setShow(v); setStay(new Set()) }
  const see = (e: any) => shows(e, show, decideNow) || stay.has(e.id)
  // Places that look like their group but need another answer: pulled into their own group, remembered here.
  const [apart, setApart] = React.useState<Set<string>>(readApart)
  const setApartIds = (ids: string[], on: boolean) => setApart(a => { const n = new Set(a); for (const id of ids) if (on) n.add(id); else n.delete(id); write(APART_KEY, JSON.stringify([...n])); return n })
  const anchor = React.useRef<string | null>(null)
  const checks = React.useMemo(spotChecks, [])
  // Places Label Review would offer (a photo and a drawn proposal): they open in the one-place view.
  const reviewable = React.useMemo(() => new Set<string>((D.elements?.review?.items ?? []).map((x: any) => x.id)), [])
  const [focus, setFocus] = React.useState<{ ids: string[]; i: number } | null>(null)
  // Keyboard review: the place the keys act on, and the handler (set each render, so it sees current state).
  const [cursor, setCursor] = React.useState<string | null>(null)
  const onKey = React.useRef<(ev: KeyboardEvent) => void>(() => {})
  React.useEffect(() => { const f = (ev: KeyboardEvent) => onKey.current(ev); window.addEventListener("keydown", f); return () => window.removeEventListener("keydown", f) }, [])

  const choose = (k: string) => { setSel(k); write(VIEW_KEY, k); setSelected(new Set()); const next = groups.find(x => x.key === k); filter(next?.counts.todo ? "todo" : "all") }
  if (!g) return <Note>No elements to place yet.</Note>
  const components = groups.filter(x => x.kind === "component"), others = groups.filter(x => x.kind !== "component")

  // The order places are listed in, for shift-click ranges.
  const visible = g.batches.flatMap(b => withApart(b.looks, apart, decideNow).flatMap(l => l.items)).filter(see)
  const toggle = (ids: string[], on: boolean) => setSelected(s => { const n = new Set(s); for (const id of ids) if (on) n.add(id); else n.delete(id); return n })
  const click = (id: string, shift: boolean) => {
    const on = !selected.has(id)
    if (shift && anchor.current) {
      const a = visible.findIndex(e => e.id === anchor.current), b = visible.findIndex(e => e.id === id)
      if (a >= 0 && b >= 0) { toggle(visible.slice(Math.min(a, b), Math.max(a, b) + 1).filter(e => !whyNot(e, checks)).map(e => e.id), on); anchor.current = id; return }
    }
    toggle([id], on); anchor.current = id
  }
  const setNote = (id: string, v: string) => setNotes(n => ({ ...n, [id]: v }))
  const chosen = [...selected].map(id => byId.get(id)).filter(Boolean)
  const rowNotes = (ids: string[]) => { const o: Record<string, string> = {}; for (const id of ids) if (notes[id]?.trim()) o[id] = notes[id]!.trim(); return Object.keys(o).length ? o : undefined }

  const clear = () => { setSelected(new Set()); setNotes(n => Object.fromEntries(Object.entries(n).filter(([id]) => !selected.has(id)))); setBatchNote("") }

  /** Save one answer for the ticked places: grouped so each call carries one decision, all sharing the batch note. */
  async function answer(kind: "confirm" | "gap" | "keep" | { pick: any }, only?: string[]) {
    const parts = new Map<string, { decision: any; ids: string[] }>()
    const use = typeof kind === "object" ? kind.pick : null
    for (const e of only ? only.map(id => byId.get(id)).filter(Boolean) : chosen) {
      const decision = use ? { verdict: "replace", role: e.role, use: use.use, props: use.props ?? {} }
        : kind === "confirm" ? confirmOf(e) : kind === "gap" ? { verdict: "gap", role: e.role, ...(e.gap ? { gap: e.gap } : {}) } : { verdict: "keep", role: e.role }
      const k = JSON.stringify(decision)
      parts.set(k, { decision, ids: [...(parts.get(k)?.ids ?? []), e.id] })
    }
    setBusy(true)
    const saved: Done["parts"] = []
    try {
      for (const { decision, ids } of parts.values()) {
        const r = await api("/api/decide", { ids, decision, note: batchNote.trim() || undefined, notes: rowNotes(ids), who: reviewerName() })
        applyLocal(ids, r.decided)
        for (const id of ids) { const n = notes[id]?.trim(); const e = n ? byId.get(id) : null; if (e?.decided) e.decided = { ...e.decided, note: n } }
        saved.push({ ids, labelsAt: r.labelsAt })
        keep(ids)
      }
      const n = saved.reduce((a, p) => a + p.ids.length, 0)
      const text = `${use ? `Changed to ${pickText(use)}` : kind === "confirm" ? "Confirmed" : kind === "gap" ? `Marked ${NO_HOME.toLowerCase()}` : "Kept native"}: ${plural(n, "place")}`
      setDone({ text, parts: saved }); say(text)
      if (only) { toggle(only, false); setNotes(x => Object.fromEntries(Object.entries(x).filter(([id]) => !only.includes(id)))) } else clear()
    } catch (x: any) {
      say(saved.length ? `${x.message} (${saved.reduce((a, p) => a + p.ids.length, 0)} saved before it stopped; undo them below)` : x.message, true)
      if (saved.length) setDone({ text: "Saved before the error", parts: saved })
    }
    setBusy(false); refresh()
  }

  function change() {
    const ids = chosen.map(e => e.id)
    const merged: Record<string, string> = {}
    for (const id of ids) { const n = notes[id]?.trim() || batchNote.trim(); if (n) merged[id] = n }
    openPicker({ ids, ...(Object.keys(merged).length ? { notes: merged } : {}), onDone: (r, saved) => { keep(saved); setDone({ text: `Changed: ${plural(saved.length, "place")}`, parts: [{ ids: saved, labelsAt: r.labelsAt }] }); clear() } })
  }

  // The keys (keys.ts). Only in dsa serve, where answers can be saved.
  onKey.current = (ev: KeyboardEvent) => {
    if (!D.serve) return
    const act = keyAction(ev, Boolean(document.querySelector('[role="dialog"]')))
    if (!act) return
    const at = cursor ? visible.findIndex(e => e.id === cursor) : -1
    const move = (i: number) => {
      const e = visible[Math.max(0, Math.min(visible.length - 1, i))]
      if (!e) return
      setCursor(e.id)
      document.querySelector(`[data-place="${CSS.escape(e.id)}"]`)?.scrollIntoView?.({ block: "nearest" })
    }
    const here = at >= 0 ? visible[at] : null
    if (act === "next") move(at + 1)
    else if (act === "prev") move(at < 0 ? 0 : at - 1)
    else if (act === "tick") { if (here && !whyNot(here, checks)) click(here.id, false) }
    else if (act === "confirm") { if (selected.size) answer("confirm"); else if (here && !whyNot(here, checks)) answer("confirm", [here.id]) }
    else if (act === "change") { if (selected.size) change(); else if (here) openPicker({ ids: [here.id] }) }
    else if (act === "note") { const n = here && document.getElementById(`note-${here.id}`); if (!n) return; (n as HTMLInputElement).focus() }
    else if (act === "open") { if (here && reviewable.has(here.id)) setFocus({ ids: visible.map(e => e.id), i: at }) }
    else if (act === "undo") { if (done && !busy) undo() }
    else if (act === "clear") { if (!selected.size) return; clear() }
    else return
    ev.preventDefault()
  }

  async function undo() {
    if (!done) return
    setBusy(true)
    try {
      let n = 0
      for (const p of done.parts) { const r = await api("/api/undecide", { ids: p.ids, ...(p.labelsAt ? { labelsAt: p.labelsAt } : {}) }); applyLocal(r.ids, null); n += r.ids.length }
      say(`Undone: ${plural(n, "place")}`); setDone(null)
    } catch (x: any) { say(x.message, true) }
    setBusy(false); refresh()
  }

  return (
    <SelCtx.Provider value={{ selected, toggle, click, notes, setNote, checks, see, useFor: (pick, ids) => answer({ pick }, ids), busy, apart, reviewable, cursor,
      look: (id: string) => { const ids = visible.map(e => e.id); setFocus({ ids, i: Math.max(0, ids.indexOf(id)) }) } }}>
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
          <ToggleGroup aria-label="Show" value={[show]} onValueChange={(v: string[]) => v[0] && filter(v[0] as any)} variant="outline" size="sm" className="flex-wrap">
            {FILTERS.map(([v, l]) => <ToggleGroupItem key={v} value={v}>{l} <span className="tabular-nums text-muted-foreground">{v === "all" ? g.counts.total : g.counts[v]}</span></ToggleGroupItem>)}
          </ToggleGroup>
          {D.serve ? (
            <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              <p>Tick places to answer them together; shift-click ticks a range. A note on a row stays with that place.</p>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Keyboard shortcuts" data-slot="keys">
                {KEYS.map(k => <span key={k.action} className="flex items-center gap-1">{k.keys.map(x => <Kbd key={x}>{x}</Kbd>)} {k.says}</span>)}
              </p>
            </div>
          )
            : <Note className="text-xs">Read-only snapshot: answer from the "By question" view, which stages decisions in this browser.</Note>}
          {done && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <span>{done.text}.</span>
              <Button variant="outline" size="sm" onClick={undo} disabled={busy}>Undo</Button>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setDone(null)}>Dismiss</Button>
            </div>
          )}
          {g.batches.map(b => <BatchCard key={b.key} b={b} />)}
          {!g.batches.some(b => b.items.some(see)) && <Note>Nothing here matches this filter.</Note>}
        </section>
      </div>

      {selected.size > 0 && (
        <div role="region" aria-label="Answer the ticked places" className="sticky bottom-0 z-20 mt-4 flex flex-wrap items-center gap-2 border-t bg-background/95 px-3 py-2.5 backdrop-blur" data-slot="action-bar">
          <span className="mr-1 text-sm font-semibold tabular-nums" aria-live="polite">{selected.size} selected</span>
          <Button size="sm" onClick={() => answer("confirm")} disabled={busy} title="Each place gets the answer its row proposes">Confirm</Button>
          <Button variant="outline" size="sm" onClick={change} disabled={busy}>Change to…</Button>
          <Button variant="outline" size="sm" onClick={() => answer("gap")} disabled={busy}>{NO_HOME}</Button>
          <Button variant="outline" size="sm" onClick={() => answer("keep")} disabled={busy}>{KEEP}</Button>
          {(() => { const ids = [...selected], back = ids.every(id => apart.has(id)); return (
            <Button variant="ghost" size="sm" disabled={busy}
              onClick={() => { setApartIds(ids, !back); setSelected(new Set()) }}>{back ? "Put back" : "Set apart"}</Button>
          ) })()}
          <Button variant="ghost" size="sm" onClick={clear} disabled={busy}>Clear</Button>
          <label className="flex min-w-[12rem] flex-1 items-center gap-2 text-xs">
            <span className="sr-only">Note for all ticked places</span>
            <input id="bc-batch-note" value={batchNote} onChange={ev => setBatchNote(ev.target.value)} placeholder="Note for all ticked places (a row's own note wins)"
              className="h-8 w-full rounded-md border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring" />
          </label>
        </div>
      )}
      {focus && <Focus ids={focus.ids} start={focus.i} onClose={() => setFocus(null)}
        onSaved={(id, labelsAt, text) => { keep([id]); setDone({ text, parts: [{ ids: [id], labelsAt }] }) }} />}
    </SelCtx.Provider>
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

/** A tick box for several places: all of those that can be ticked, with a mixed state when some are. */
function TickAll({ items, label }: { items: any[]; label: string }) {
  const { selected, toggle, checks } = React.useContext(SelCtx)
  const ok = items.filter(e => !whyNot(e, checks)).map(e => e.id)
  const ref = React.useRef<HTMLInputElement>(null)
  const n = ok.filter(id => selected.has(id)).length
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = n > 0 && n < ok.length }, [n, ok.length])
  // One place is ticked on its own row.
  if (!D.serve || ok.length < 2) return null
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <input ref={ref} type="checkbox" checked={n === ok.length} onChange={ev => toggle(ok, ev.target.checked)} className="size-4 accent-primary" />
      {label.replace("{n}", String(ok.length))}
    </label>
  )
}

/**
 * The related components for a batch, drawn with one of its own places' words, side by side, so the
 * choice is made by job and not by look. With places ticked here, one click answers them with any of them.
 */
function Neighbours({ b }: { b: Batch }) {
  const { selected, useFor, busy } = React.useContext(SelCtx)
  const list = neighboursOf(b)
  if (list.length < 2) return null
  // Drawn with a place a person can see, when there is one.
  const rep = b.items.find(e => decidable(e)) ?? b.items[0]
  const ticked = b.items.filter(e => selected.has(e.id)).map(e => e.id)
  return (
    <div className="flex flex-col gap-1.5 border-b px-4 py-2.5" data-slot="neighbours">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Related components</span>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {list.map(n => {
          const drawn = proposalFor(n.pick, rep)
          return (
            <figure key={`${n.pick.use}|${JSON.stringify(n.pick.props)}`} className={cn("m-0 flex min-w-[9rem] flex-none flex-col gap-1.5 rounded-md border bg-background p-2", n.mine && "border-primary ring-1 ring-primary")} data-slot="neighbour">
              <div className="grid min-h-10 place-items-start">{drawn?.url ? <Natural url={drawn.url} alt={`${SYS} ${pickText(n.pick)}`} /> : <span className="text-xs text-muted-foreground">Not drawn yet</span>}</div>
              <figcaption className="text-xs">
                <b className="font-medium">{pickText(n.pick)}</b>
                <span className="block text-muted-foreground">{n.mine ? "dsa's pick for this batch" : `weighed for ${plural(n.places, "place")}`}</span>
                {/* Say whose words a drawing shows: this place's own, or the component's example. */}
                {drawn?.url && <span className="block text-[11px] text-muted-foreground">{ownWords(drawn, rep) ? `with “${rep.label ?? nameOf(rep)}”'s own words` : "example content, not this place's"}</span>}
              </figcaption>
              {D.serve && !n.mine && (
                <Button variant="outline" size="sm" disabled={busy || !ticked.length} onClick={() => useFor(n.pick, ticked)} title={ticked.length ? undefined : "Tick places in this batch first"}>
                  {ticked.length ? `Use for ${ticked.length} ticked` : "Tick places to use"}
                </Button>
              )}
            </figure>
          )
        })}
      </div>
    </div>
  )
}

function BatchCard({ b }: { b: Batch }) {
  const { see, apart } = React.useContext(SelCtx)
  const grouped = withApart(b.looks, apart, decideNow)
  const looks = grouped.map(l => ({ l, items: l.items.filter(see) })).filter(x => x.items.length)
  if (!looks.length) return null
  return (
    <article className="rounded-lg border bg-card" data-slot="batch">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5">
        <h3 className="text-sm font-semibold">{pickText(b.pick)}</h3>
        <span className="text-xs text-muted-foreground">{plural(b.items.length, "place")} · {b.counts.todo} to decide{b.counts.decided ? ` · ${b.counts.decided} decided` : ""}</span>
        <span className="ml-auto"><TickAll items={b.items} label="Select all {n}" /></span>
      </header>
      <Neighbours b={b} />
      <div className="flex flex-col divide-y">
        {looks.map(({ l, items }) => <Look key={l.key} l={l} items={items} single={grouped.length === 1} />)}
      </div>
    </article>
  )
}

function lookTitle(l: LookGroup) {
  if (l.kind === "shared") return <>Shared style <code className="font-mono text-xs">{l.name}</code></>
  if (l.kind === "same-classes") return "Same classes"
  if (l.kind === "apart") return "Set apart"
  return "One-off styles"
}

function Look({ l, items, single }: { l: LookGroup; items: any[]; single: boolean }) {
  return (
    <div className="flex flex-col" data-slot="look">
      {!single && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-muted/40 px-4 py-1.5">
          <span className="text-xs font-medium">{lookTitle(l)}</span>
          <span className="text-xs text-muted-foreground">{l.kind === "one-off" ? "each looks different: check one by one" : l.kind === "apart" ? "you set these apart from their group: answer them on their own (saved in this browser)" : `${plural(l.items.length, "place")}, usually one answer`}</span>
          {l.kind !== "one-off" && <span className="ml-auto"><TickAll items={l.items} label="Select these {n}" /></span>}
        </div>
      )}
      <ul className="flex flex-col divide-y" role="list">
        {items.map(e => <Place key={e.id} e={e} group={l.items.map(x => x.id)} />)}
      </ul>
    </div>
  )
}

function Place({ e, group }: { e: any; group: string[] }) {
  const { openLightbox, openCode, openPicker, byId } = useEl()
  const { selected, click, notes, setNote, checks, look, reviewable, cursor } = React.useContext(SelCtx)
  const here = cursor === e.id
  const canLook = reviewable.has(e.id)
  const check = !e.decided && checks.has(e.id)
  const st = statusOf(e, decideNow)
  const chip = check ? STATUS.check : STATUS[st]
  const pick = e.decided ? e.decided.decision : e
  const drawn = proposalFor(pick, e)
  const why = whyNot(e, checks)
  const on = selected.has(e.id)
  // The zoom view steps through this look group's photos.
  const openShot = () => { const ids = group.filter(id => byId.get(id)?.shot); openLightbox(ids, Math.max(0, ids.indexOf(e.id))) }
  return (
    <li className={cn("grid gap-3 px-4 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-center", on && "bg-primary/5", here && "shadow-[inset_3px_0_0_var(--color-primary)] ring-1 ring-primary/40 ring-inset")}
      data-slot="place" data-place={e.id} data-status={check ? "check" : st} aria-current={here ? "true" : undefined}>
      <span className="flex sm:self-center">
        {D.serve && (
          <input type="checkbox" checked={on} disabled={Boolean(why)} title={why ?? "Tick to answer with others"} aria-label={`Select ${nameOf(e)}`}
            onChange={ev => { if (!why) click(e.id, Boolean((ev.nativeEvent as MouseEvent).shiftKey)) }} className="size-4 accent-primary disabled:opacity-40" />
        )}
      </span>
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
      <div className="flex min-w-0 flex-col gap-1 text-sm">
        {canLook ? <button type="button" onClick={() => look(e.id)} className="w-fit max-w-full truncate text-left font-medium underline-offset-4 hover:underline" title="Look at this place on its own">{nameOf(e)}</button>
          : <span className="truncate font-medium">{nameOf(e)}</span>}
        <span className="truncate text-xs text-muted-foreground">{e.review?.pageName ?? e.target}</span>
        <button type="button" onClick={() => openCode(e.id)} className="w-fit max-w-full truncate text-left font-mono text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" title="Open the code">{short(e.file)}:{e.line}</button>
        {e.decided ? (e.decided.note && <span className="text-xs text-muted-foreground">Note: {e.decided.note}</span>)
          : D.serve && !why && <input id={`note-${e.id}`} value={notes[e.id] ?? ""} onChange={ev => setNote(e.id, ev.target.value)} onKeyDown={ev => { if (ev.key === "Escape" || ev.key === "Enter") (ev.target as HTMLInputElement).blur() }} placeholder="Note for this place" aria-label={`Note for ${nameOf(e)}`}
              className="h-7 w-full rounded border bg-background px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring" />}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <Conf c={e.confidence} cap={e.evidenceCap} />
        <Badge variant="outline" className={cn("text-[11px] font-normal", chip.cls)}>{chip.text}</Badge>
        {/* Undecided places with their evidence open on their own (a spot check always does); the rest use the full dialog. */}
        {D.serve && <Button variant="ghost" size="sm" onClick={() => !e.decided && canLook ? look(e.id) : openPicker({ ids: [e.id], ...(notes[e.id]?.trim() ? { notes: { [e.id]: notes[e.id]!.trim() } } : {}) })}>{e.decided ? "Change…" : "Answer…"}</Button>}
      </div>
    </li>
  )
}
