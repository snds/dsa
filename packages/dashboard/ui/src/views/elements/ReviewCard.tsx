import * as React from "react"
import { cn } from "cn"
import { ArrowRightIcon, CaretDownIcon, CheckIcon, ImageBrokenIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Pre } from "@/components/bits"
import { D, short, SYS } from "@/lib/dsa"
import { stageKey, useStaged } from "@/lib/staged"
import { AskAgent } from "@/agent/AskAgent"
import { Conf, ElementRow, NoShot, Reasons, ReviewControls, Ring, contentText, desc, nameOf, pickText, revealedText, useEl, useReviewState } from "./shared"
import { styleName } from "./units"

/**
 * One review decision. Read top to bottom, it answers four questions in order:
 *
 * 1. What is it? The design pattern in plain words, how many, where they sit, and where the card stands.
 * 2. What is the answer? The recommendation and how sure the scanner is; for a control whose parts
 *    need different answers, one row per part.
 * 3. What do I do? Approve, Change, Ignore, a note, and what the answer covers. In `dsa serve` that
 *    saves to the repo; on the published dashboard it stages in the browser for export.
 * 4. Why? The evidence: one tile per look (shared classes render the same), app next to the system, and only
 *    the properties that change. Reasons, alternatives and every element sit under Details.
 */
export interface Part { key: string; ask: string; ids: string[]; options: { label: string; decision: any }[]; auto: any; fit?: any }
export function ReviewCard({ items, auto, pattern, options, fit, kind, title, ask, note, parts, context }: {
  items: any[]; auto: any; pattern?: string | null; options?: { label: string; decision: any }[]; fit?: any; kind: "question" | "ready" | "gap"
  title?: string; ask?: string; note?: string | null; parts?: Part[] | null; context?: string[] | null
}) {
  const { byId } = useEl()
  const key = stageKey(items.map(e => e.id), pattern)
  const allStaged = useStaged()
  const staged = allStaged.find(s => s.key === key) ?? null
  const split = parts && parts.length > 1 ? parts : null
  // A split card stands where its parts stand: open until every part has an answer.
  const partStates = split?.map(p => useReviewState(p.ids.map(id => byId.get(id)).filter(Boolean), p.auto, allStaged.find(s => s.key === stageKey(p.ids, null)) ?? null))
  const { state: own, d } = useReviewState(items, auto, staged)
  const state = partStates ? (partStates.some(x => x.state === "open") ? "open" : partStates.every(x => x.state === "ignored") ? "ignored" : partStates.every(x => x.state === "approved") ? "approved" : "changed") : own
  const anyStaged = partStates ? partStates.some(x => x.staged) : Boolean(staged)
  const shown = state === "changed" && !split ? d.decision : auto
  const off = state === "ignored"
  const looks = React.useMemo(() => looksOf(items), [items])
  const captured = looks.filter(l => l.shot)
  const uncaptured = looks.filter(l => !l.shot).flatMap(l => l.items)
  const [allLooks, setAllLooks] = React.useState(false)
  const lo = Math.min(...items.map(e => e.confidence)), hi = Math.max(...items.map(e => e.confidence))
  const files = new Set(items.map(e => e.file)).size
  // Where most of them sit (an area half or more share), with the count, so one element in an aside doesn't label all 41.
  const regions = (() => {
    const n = new Map<string, number>()
    for (const e of items) for (const r of new Set<string>(e.regions ?? [])) n.set(r, (n.get(r) ?? 0) + 1)
    return [...n].filter(([, c]) => c * 2 >= items.length).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, c]) => (items.length > 1 && c < items.length ? `${r} (${c} of ${items.length})` : r))
  })()
  const visible = allLooks ? captured : captured.slice(0, 3)
  const hiddenLooks = captured.length - visible.length
  const showUncaptured = uncaptured.length > 0 && (allLooks || visible.length < 3)
  // A system rendering only means something for a replacement, so gap / keep tiles show the app alone.
  const compares = shown.verdict === "replace" && !split
  const unrendered = compares && !visible.some(l => l.rep.rendered?.systemShot || l.rep.systemPreview)
  const unmeasured = compares && !visible.some(l => deltaOf(l.rep))
  const answered = partStates?.filter(x => x.state !== "open").length ?? 0
  const status = split && state === "open" && answered ? `${answered} of ${split.length} parts answered`
    : anyStaged ? `Staged · ${STATE_LABEL[state]}` : state === "open" ? (kind === "question" ? "Needs a decision" : "Not decided") : STATE_LABEL[state]
  const n = items.length
  const named = styleName(pattern)
  const scope = n === 1 ? "Applies to this element."
    : pattern ? `One answer covers all ${n}: they look the same${named ? ` (shared style ${named})` : ""}.`
    : `Your answer applies to all ${n}.${D.serve ? " To answer one at a time, open Details." : ""}`
  const heading = title ?? `<${items[0].element}>`
  const label = `${heading} ×${n}`
  const tag = [...new Set(items.map(e => `<${e.element}>`))].join(" ")
  const ready = (context ?? []).map(id => byId.get(id)).filter(Boolean)

  return (
    <Card className={cn("gap-0 py-0", kind === "question" && state === "open" && "border-warning-soft-border", anyStaged && "border-primary/50")}>
      <CardHeader className="gap-3 border-b py-4">
        {/* 1. What it is, and where the card stands. */}
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h3 className="font-heading text-base font-semibold leading-snug">{heading}</h3>
            <span className="text-xs text-muted-foreground">
              {n} {tag} in {files} file{files === 1 ? "" : "s"}{regions.length > 0 && ` · in ${regions.join(", ")}`}{named && ` · shared style ${named}`}
            </span>
          </div>
          <Badge variant="outline" className={cn("shrink-0 text-[11px]", STATUS_TONE[anyStaged ? "staged" : state === "open" && kind === "question" ? "ask" : state])}>
            {state === "approved" && <CheckIcon data-icon="inline-start" />}{status}
          </Badge>
        </div>
        {note && <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">{note}</p>}
        {split ? (
          <div className="flex flex-col gap-3">
            {ask && <p className="text-sm text-muted-foreground">{ask}</p>}
            {split.map(p => <PartRow key={p.key} p={p} title={heading} />)}
          </div>
        ) : (
          <>
            {/* 2. The answer (or the human's choice) and how sure the scanner is. */}
            <div className={cn("flex flex-col gap-1", off && "opacity-50")}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <Pick label={state === "changed" ? (anyStaged ? "Your choice" : "Decided") : "Recommended"} r={shown} />
                <Confidence lo={lo} hi={hi} />
              </div>
              {state === "changed" && <p className="text-xs text-muted-foreground">Recommended: {pickText(auto)}</p>}
              {ask && shown.verdict !== "replace" && state === "open" && <p className="text-sm">{ask}</p>}
              {shown.parent && <ParentNote parent={shown.parent} />}
              {shown.how && <p className="text-sm text-muted-foreground">{shown.how}</p>}
              {fitNote(fit, shown, state) && <p className="text-xs text-muted-foreground">{fitNote(fit, shown, state)}</p>}
              {shown.verdict === "gap" && shown.gap && <p className="text-sm text-muted-foreground">{shown.gap}</p>}
            </div>
            {/* 3. The decision. */}
            <ReviewControls items={items} auto={auto} pattern={pattern} options={options} label={label} />
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{split ? "" : scope}{ready.length > 0 && `${split ? "" : " "}${ready.length} more of this kind are already sure; they're listed under Ready.`}</span>
          {D.serve && <AskAgent subject={{ kind: "review", ids: items.map(e => e.id), pattern: pattern ?? null }} label={kind === "question" ? "Talk it through" : "Ask the agent"} size="xs" variant="ghost" />}
        </div>
      </CardHeader>
      {/* 4. The evidence. */}
      <CardContent className={cn("flex flex-col gap-3 py-4", off && "opacity-50")}>
        <h4 className="text-xs font-medium text-muted-foreground">
          {captured.length ? `${looks.length === 1 ? "One look" : `${looks.length} looks`} · ${compares ? `the app next to ${SYS}` : "as the app renders it"}` : "Not captured in the app"}
        </h4>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map(l => <LookTile key={l.key} look={l} group={items.map(e => e.id)} target={shown} compare={compares && !unrendered} measure={compares && !unmeasured} />)}
          {showUncaptured && <Uncaptured items={uncaptured} />}
        </div>
        {(unrendered || unmeasured) && captured.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {unrendered ? `No Storybook rendering of ${shown.use}${Object.keys(shown.props ?? {}).length ? ` ${Object.values(shown.props).join("/")}` : ""} to show next to ${n === 1 ? "it" : "them"} yet.${unmeasured ? " Nothing is measured." : ""}` : `Not measured against ${SYS} yet.`}
          </p>
        )}
        {(hiddenLooks > 0 || (uncaptured.length > 0 && !showUncaptured) || allLooks) && (
          <Button variant="ghost" size="xs" className="self-start" onClick={() => setAllLooks(v => !v)}>
            {allLooks ? "Show fewer looks" : `Show ${[hiddenLooks && `${hiddenLooks} more look${hiddenLooks === 1 ? "" : "s"}`, uncaptured.length && !showUncaptured && `${uncaptured.length} not captured`].filter(Boolean).join(" and ")}`}
          </Button>
        )}
        <Details items={items} ready={ready} />
      </CardContent>
    </Card>
  )
}

/** One kind of part in a split card: its own answer, its own decision. */
function PartRow({ p, title }: { p: Part; title: string }) {
  const { byId } = useEl()
  const items = p.ids.map(id => byId.get(id)).filter(Boolean)
  const staged = useStaged().find(s => s.key === stageKey(p.ids, null)) ?? null
  const { state, d } = useReviewState(items, p.auto, staged)
  const shown = state === "changed" ? d.decision : p.auto
  const lo = Math.min(...items.map(e => e.confidence)), hi = Math.max(...items.map(e => e.confidence))
  // What the parts say (their labels); a file name here would tell the reader nothing new.
  const names = [...new Set(items.filter(e => e.label).map(nameOf))]
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border p-3", state === "ignored" && "opacity-60")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Pick label={`${items.length} ${items.length === 1 ? "part" : "parts"}`} r={shown} />
        <Confidence lo={lo} hi={hi} />
      </div>
      {names.length > 0 && <p className="text-xs text-muted-foreground">{names.slice(0, 5).join(", ")}{names.length > 5 ? "…" : ""}</p>}
      {shown.parent && <ParentNote parent={shown.parent} small />}
      {shown.how && <p className="text-xs text-muted-foreground">{shown.how}</p>}
      {shown.verdict === "gap" && shown.gap && <p className="text-xs text-muted-foreground">{shown.gap}</p>}
      <ReviewControls items={items} auto={p.auto} pattern={null} options={p.options} label={`${title} · ${pickText(p.auto)}`} />
    </div>
  )
}

/** The measured size fit, when it argues with the pick or no size is close. */
const fitNote = (fit: any, shown: any, state: string) => !fit || state === "changed" || shown.verdict !== "replace" ? ""
  : fit.best !== (shown.props?.size ?? fit.recSize) ? `Closest measured size: ${fit.best} (${Math.round(fit.score * 100)}%).`
  : fit.score < 0.7 ? `Size ${fit.best} is the closest, at ${Math.round(fit.score * 100)}%: no size is close.` : ""

const STATE_LABEL = { open: "Not decided", approved: "Approved", changed: "Changed", ignored: "Ignored" } as const
const STATUS_TONE: Record<string, string> = {
  ask: "border-warning-soft-border text-warning-soft-foreground",
  approved: "border-success-soft-border text-success-soft-foreground",
  staged: "border-primary/50 text-primary",
}

/** "Recommended  Button · variant ghost · size sm", or a gap / keep native. */
/** A part needs its container: name it, with its props, and how the parts sit inside it. */
function ParentNote({ parent, small }: { parent: { use: string; props?: Record<string, string>; how: string }; small?: boolean }) {
  const props = Object.entries(parent.props ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ")
  return (
    <p className={cn(small ? "text-xs" : "text-sm", "text-muted-foreground")}>
      <span className="font-medium text-foreground">Needs its container: {parent.use}{props ? ` · ${props}` : ""}.</span> {parent.how}
    </p>
  )
}

function Pick({ label, r }: { label: string; r: any }) {
  const to = r.verdict === "gap" ? <span className="text-warning-soft-foreground">System gap</span> : r.verdict === "keep" ? "Keep native" : r.verdict === "ignore" ? "Ignored" : r.use
  // render={<button />} is how it's built, not a look: say it in words.
  const props = Object.entries(r.props ?? {}).filter(([k]) => k !== "render") as [string, string][]
  const asButton = /<button/.test(r.props?.render ?? "")
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="font-heading text-base font-semibold">{to}</span>
      {asButton && <Badge variant="outline" className="text-[11px] font-normal">as a button</Badge>}
      {props.map(([k, v]) => <Badge key={k} variant="secondary" className="font-mono text-[11px] font-normal">{k} <b className="font-semibold">{v}</b></Badge>)}
      {r.verdict === "replace" && r.content && <Badge variant="outline" className="text-[11px] font-normal">{contentText(r.content)}</Badge>}
    </div>
  )
}

/** The scanner's confidence, labelled, as one range. */
function Confidence({ lo, hi }: { lo: number; hi: number }) {
  const { th } = useEl()
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex cursor-default items-center gap-1.5 text-xs text-muted-foreground" tabIndex={0} />}>
        Confidence {lo === hi ? <Conf c={lo} /> : <><Conf c={lo} /><span aria-hidden>–</span><Conf c={hi} /></>}
      </TooltipTrigger>
      <TooltipContent>How sure the scanner is of this recommendation. Below {Math.round(th * 100)}% a human decides.</TooltipContent>
    </Tooltip>
  )
}

/** Everything behind the recommendation, folded: why it's uncertain, how it was made, alternatives, every element. */
function Details({ items, ready = [] }: { items: any[]; ready?: any[] }) {
  const [open, setOpen] = React.useState(false)
  const why = [...new Set(items.flatMap(e => e.reasons.filter((r: any) => r.delta < 0).map((r: any) => r.text)))].slice(0, 4)
  const n = items.length
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t pt-3">
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground underline-offset-4 hover:underline">
        <CaretDownIcon className={cn("transition-transform", open && "rotate-180")} />
        Details <span className="font-normal">· reasons, alternatives, {n === 1 ? "the element" : `all ${n} elements`}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 flex flex-col gap-4">
        {why.length > 0 && (
          <section>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">Why it's uncertain</h4>
            <ul className="ml-4 list-disc space-y-1 text-sm">{why.map(t => <li key={t}>{t}</li>)}</ul>
          </section>
        )}
        <section>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">How the pick was made ({short(items[0].file)}:{items[0].line})</h4>
          <Reasons e={items[0]} />
        </section>
        {items[0].alternatives?.length > 0 && <p className="text-xs text-muted-foreground"><b className="font-medium">Alternatives:</b> {items[0].alternatives.map((a: any) => `${desc(a)} (${Math.round(a.confidence * 100)}%)`).join(" · ")}</p>}
        {items.some(e => e.a11y?.length) && <p className="text-xs text-muted-foreground"><b className="font-medium">Accessibility:</b> {[...new Set(items.flatMap(e => e.a11y))].join(" ")}</p>}
        <section>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">{n === 1 ? "The element" : `All ${n} elements`}</h4>
          <div>{items.map(e => <ElementRow key={e.id} e={e} group={items.map(x => x.id)} />)}</div>
        </section>
        {ready.length > 0 && (
          <section>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">Same kind, already sure ({ready.length}): for comparison, decided in Ready</h4>
            <div>{ready.map(e => <ElementRow key={e.id} e={e} group={ready.map(x => x.id)} />)}</div>
          </section>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

interface Look { key: string; items: any[]; rep: any; shot: any | null; files: number }

/** Elements with the same classes render the same: one look, one screenshot. Captured looks first, biggest first. */
export function looksOf(items: any[]): Look[] {
  const m = new Map<string, any[]>()
  for (const e of items) { const k = e.styleSig ?? e.styleKey ?? `id:${e.id}`; m.set(k, [...(m.get(k) ?? []), e]) }
  return [...m].map(([key, list]) => {
    const withShot = list.filter(e => e.shot).sort((a, b) => b.shot.match - a.shot.match)[0] ?? null
    return { key, items: list, rep: withShot ?? list[0], shot: withShot?.shot ?? null, files: new Set(list.map(e => e.file)).size }
  }).sort((a, b) => Number(Boolean(b.shot)) - Number(Boolean(a.shot)) || b.items.length - a.items.length)
}

/** What changes, measured in the app against Storybook when possible, else read from the source against the signature. */
export function deltaOf(e: any): { source: "measured" | "source"; changes: { label: string; from: string; to: string }[]; same: number; score: number } | null {
  const d = e.rendered?.diff
  if (d) return { source: "measured", changes: d.diffs.map((x: any) => ({ label: x.label, from: x.element, to: x.system })), same: d.same.length, score: d.score }
  const s = e.signature
  if (!s) return null
  const changes = (s.mismatched as string[]).map(t => { const m = t.match(/^(.+?) ✗ (.+) vs (.+)$/); return m ? { label: m[1], from: m[2], to: m[3] } : { label: t, from: "", to: "" } })
  return { source: "source", changes, same: s.matched.length, score: s.score }
}

function LookTile({ look, group, target, compare, measure }: { look: Look; group: string[]; target: any; compare: boolean; measure: boolean }) {
  const { openLightbox, byId } = useEl()
  const e = look.rep, r = e.rendered
  const delta = deltaOf(e)
  const open = () => { const ids = group.filter(id => byId.get(id)?.shot); openLightbox(ids, Math.max(0, ids.indexOf(e.id))) }
  const b = e.shot.box
  const caption = e.shot.revealedBy ? revealedText(e.shot.revealedBy) : null
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/20 p-2">
      <button type="button" onClick={open} className={cn("grid cursor-zoom-in items-center gap-1.5 text-left", compare && "grid-cols-[1fr_auto_1fr]")} aria-label={compare ? "Open side by side" : "Open the screenshot"}>
        {/* Sized to the crop's ratio and at most 160px tall, so the image fills the box and the ring lines up. */}
        <span className="relative mx-auto block w-full overflow-hidden rounded-md border bg-background" style={b ? { aspectRatio: `${b.cw}/${b.ch}`, maxWidth: `${Math.round((160 * b.cw) / b.ch)}px` } : undefined}>
          <img src={e.shot.url} alt={`In the app: ${e.snippet.slice(0, 60)}`} loading="lazy" className={cn("block w-full object-contain", b ? "h-full" : "max-h-40")} />
          <Ring b={b} />
        </span>
        {compare && <ArrowRightIcon className="text-muted-foreground" aria-hidden />}
        {compare && (r?.systemShot || e.systemPreview ? (
          <span className="grid h-full min-h-16 place-items-center overflow-hidden rounded-md border bg-background p-3">
            <img src={r?.systemShot ?? e.systemPreview.url} alt={`${SYS} ${target.use ?? ""}`} loading="lazy" className="block max-h-16 w-auto max-w-full object-contain" />
          </span>
        ) : <span className="grid h-full place-items-center rounded-md border border-dashed p-2 text-center text-[11px] text-muted-foreground">No rendering for this look</span>)}
      </button>
      <figcaption className="flex flex-col gap-1.5 px-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <b className="font-medium text-foreground tabular-nums">×{look.items.length}</b>
          <span>{look.files} file{look.files === 1 ? "" : "s"}</span>
          {caption && <span className="truncate" title={caption}>{caption}</span>}
        </span>
        {measure && <Changes delta={delta} />}
      </figcaption>
    </figure>
  )
}

/** Only what changes. Matches are a count, not a list. */
function Changes({ delta }: { delta: ReturnType<typeof deltaOf> }) {
  if (!delta || (!delta.changes.length && !delta.same)) return <span className="text-xs text-muted-foreground">Not measured for this look.</span>
  if (!delta.changes.length) return <span className="flex items-center gap-1 text-xs text-success-soft-foreground"><CheckIcon />Looks the same ({delta.same} properties match)</span>
  return (
    <div className="flex flex-col gap-1">
      <ul className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
        {delta.changes.slice(0, 6).map(c => (
          <li key={c.label} className="contents">
            <span className="text-muted-foreground">{c.label}</span>
            <span className="flex min-w-0 items-center gap-1 font-mono text-[11px]"><Val v={c.from} /><ArrowRightIcon className="shrink-0 text-muted-foreground" aria-label="becomes" /><Val v={c.to} strong /></span>
          </li>
        ))}
      </ul>
      <span className="text-[11px] text-muted-foreground">{delta.changes.length > 6 ? `+${delta.changes.length - 6} more · ` : ""}{delta.same} match · {delta.source === "measured" ? "measured in the app vs Storybook" : "read from the source"}</span>
    </div>
  )
}

/** A value, with a swatch when it's a color. */
function Val({ v, strong }: { v: string; strong?: boolean }) {
  const color = /^(rgba?|#)/.test(v) ? v : null
  const text = color ? shortColor(v) : v.replace(/^--/, "")
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 truncate", strong && "font-semibold")} title={v}>
      {color && <span className="size-2.5 shrink-0 rounded-[2px] border" style={{ background: color }} />}
      {text}
    </span>
  )
}
const shortColor = (v: string) => { const m = v.match(/rgba?\(([^)]+)\)/); if (!m) return v; const [r, g, b, a] = m[1].split(",").map(s => Number(s.trim())); if (a === 0) return "transparent"; return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("") + (a != null && a < 1 ? ` ${Math.round(a * 100)}%` : "") }

/** Looks the crawler couldn't find: say why once, with the first element's trace. */
function Uncaptured({ items }: { items: any[] }) {
  const e = items.find(x => x.reach) ?? items[0]
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-dashed p-3">
      <span className="flex items-center gap-1.5 text-xs font-medium"><ImageBrokenIcon className="text-muted-foreground" />{items.length} not captured</span>
      {e.shotMissing || e.weakShot || e.reach?.status === "unused" ? <NoShot e={e} /> : <p className="text-xs text-muted-foreground">Not picked as an example this run.</p>}
      {!e.systemPreview && <Pre className="max-h-28 text-[11px]">{e.snippet}</Pre>}
      {items.length > 1 && <span className="text-[11px] text-muted-foreground">{[...new Set(items.map(x => short(x.file)))].slice(0, 3).join(", ")}{new Set(items.map(x => x.file)).size > 3 ? "…" : ""}</span>}
    </div>
  )
}

