import * as React from "react"
import { cn } from "cn"
import { ArrowRightIcon, CheckIcon, ImageBrokenIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Code, Disclosure, Pre } from "@/components/bits"
import { D, short, SYS } from "@/lib/dsa"
import { stageKey, useStaged } from "@/lib/staged"
import { AskAgent } from "@/agent/AskAgent"
import { Conf, ElementRow, NoShot, Reasons, ReviewControls, contentText, desc, nameOf, pickText, proposalCheck, proposalFor, revealedText, sourceLabel, sourceTip, useEl, useReviewState } from "./shared"
import { InContext, SameScale } from "./SameScale"
import { useApp } from "@/lib/app"
import { styleName } from "./units"

/**
 * One review decision. Read top to bottom, it answers four questions in order:
 *
 * 1. What is it? The design pattern in plain words, how many, where they sit, and where the card stands.
 * 2. What is the answer? The recommendation and how sure the scanner is; for a control whose parts
 *    need different answers, one row per part.
 * 3. What do I do? Approve, Change, Ignore, a note, and what the answer covers. In `dsa serve` that
 *    saves to the repo; on the published dashboard it stages in the browser for export.
 * 4. Why? The evidence: every case the answer covers, grouped by look (shared classes render the same), each
 *    look next to the proposal rendered with its props, and only the properties that change. Reasons,
 *    alternatives and every element sit under Details.
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
  // With an app chosen, the evidence is that app's; the answer still covers every element, and says so.
  const app = useApp()
  const mine = app ? items.filter(e => e.target === app) : items
  const elsewhere = app ? items.filter(e => e.target !== app) : []
  const looks = React.useMemo(() => looksOf(mine.length ? mine : items), [mine, items])
  const captured = looks.filter(l => l.shot)
  const uncaptured = looks.filter(l => !l.shot).flatMap(l => l.items)
  const lo = Math.min(...items.map(e => e.confidence)), hi = Math.max(...items.map(e => e.confidence))
  const files = new Set(items.map(e => e.file)).size
  // Where most of them sit (an area half or more share), with the count, so one element in an aside doesn't label all 41.
  const regions = (() => {
    const n = new Map<string, number>()
    for (const e of items) for (const r of new Set<string>(e.regions ?? [])) n.set(r, (n.get(r) ?? 0) + 1)
    return [...n].filter(([, c]) => c * 2 >= items.length).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, c]) => (items.length > 1 && c < items.length ? `${r} (${c} of ${items.length})` : r))
  })()
  // Every look and every case, so a reviewer can see they really are the same before one answer covers them.
  const visible = captured
  const shotCount = (mine.length ? mine : items).filter(e => e.shot).length
  // A system rendering only means something for a replacement, so gap / keep tiles show the app alone.
  const compares = shown.verdict === "replace" && !split
  const proposal = compares ? proposalFor(shown) : null
  const unrendered = compares && !proposal?.url && !visible.some(l => l.rep.rendered?.systemShot || l.rep.systemPreview)
  const unmeasured = compares && !visible.some(l => deltaOf(l.rep))
  const answered = partStates?.filter(x => x.state !== "open").length ?? 0
  const partShown = (p: Part) => { const i = split!.indexOf(p); const ps = partStates?.[i]; return ps?.state === "changed" ? ps.d.decision : p.auto }
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
  // Only an element a person can see both halves of is offered for a decision (report.ts withReview).
  const reviewable = items.filter(e => !e.review || e.review.ready)

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
              <HeldBack items={items} />
              {ask && shown.verdict !== "replace" && state === "open" && <p className="text-sm">{ask}</p>}
              {shown.parent && <ParentNote parent={shown.parent} />}
              {shown.how && <p className="text-sm text-muted-foreground">{shown.how}</p>}
              {fitNote(fit, shown, state) && <p className="text-xs text-muted-foreground">{fitNote(fit, shown, state)}</p>}
              {shown.verdict === "gap" && shown.gap && <p className="text-sm text-muted-foreground">{shown.gap}</p>}
            </div>
            {/* 3. The decision. */}
            {reviewable.length ? <ReviewControls items={reviewable} auto={auto} pattern={reviewable.length === items.length ? pattern : null} options={options} label={label} /> : <NeedsEvidence items={items} />}
            {reviewable.length > 0 && reviewable.length < items.length && <NeedsEvidence items={items.filter(e => !reviewable.includes(e))} some />}
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{split || !reviewable.length ? "" : scope}{ready.length > 0 && `${split ? "" : " "}${ready.length} more of this kind are already sure; they're listed under Ready.`}{elsewhere.length > 0 && ` ${otherApps(elsewhere)}`}</span>
          {D.serve && <AskAgent subject={{ kind: "review", ids: items.map(e => e.id), pattern: pattern ?? null }} label={kind === "question" ? "Talk it through" : "Ask the agent"} size="xs" variant="ghost" />}
        </div>
      </CardHeader>
      {/* 4. The evidence. */}
      <CardContent className={cn("flex flex-col gap-3 py-4", off && "opacity-50")}>
        <h4 className="text-xs font-medium text-muted-foreground">
          {captured.length ? `${app && elsewhere.length ? `${mine.length === 1 ? "The case" : `${mine.length} cases`} in ${app}` : n === 1 ? "The case" : `All ${n} cases`} · ${(n => n === 1 ? "one look" : `${n} looks`)(new Set(looks.map(l => l.style)).size)} · ${shotCount} captured · ${compares ? `the app next to ${SYS} ${pickText(shown)}` : "as the app renders it"}` : "Not captured in the app"}
        </h4>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((l, i) => {
            // A split card proposes per part: each look sits beside its own part's answer.
            const part = split?.find(p => p.ids.includes(l.rep.id))
            const t = part ? partShown(part) : shown
            const c = t?.verdict === "replace" && Boolean(t.use) && (!split || Boolean(part))
            const first = l.same && visible[i - 1]?.style !== l.style
            return <LookTile key={l.key} look={l} sameAs={first ? visible.filter(x => x.style === l.style).length : 0} group={items.map(e => e.id)} target={t} proposal={c ? proposalFor(t, l.rep) : null} compare={c} measure={c && !unmeasured} />
          })}
          {uncaptured.length > 0 && <Uncaptured items={uncaptured} />}
        </div>
        {unmeasured && !unrendered && captured.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {`Not measured against ${SYS} yet.`}
          </p>
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

/**
 * Why the confidence stops under the "ready" bar though the scanner was surer: what a person can't see
 * yet (no photo, the proposal not drawn exactly). Said once per card, for the elements it holds back.
 */
export function HeldBack({ items }: { items: any[] }) {
  const { th } = useEl()
  const held = items.filter(e => e.evidenceCap)
  if (!held.length) return null
  const why = [...new Set(held.flatMap(e => e.evidenceCap.why as string[]))]
  const from = Math.max(...held.map(e => e.evidenceCap.from))
  return (
    <p className="text-xs text-warning-soft-foreground" data-slot="held-back">
      Held under {Math.round(th * 100)}% (the scanner said {Math.round(from * 100)}%{held.length < items.length ? ` for ${held.length} of ${items.length}` : ""}): {why.join("; ")}.
    </p>
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
  const why = [...new Set(items.flatMap(e => e.reasons.filter((r: any) => r.delta < 0).map((r: any) => (r.plain === undefined ? r.text : r.plain)).filter(Boolean)))].slice(0, 4)
  const n = items.length
  return (
    <Disclosure label="Details" hint={`reasons, alternatives, ${n === 1 ? "the element" : `all ${n} elements`}`}>
      {why.length > 0 && (
        <section>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">Why it's uncertain</h4>
          <ul className="ml-4 list-disc space-y-1 text-sm">{why.map(t => <li key={t}>{t}</li>)}</ul>
        </section>
      )}
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
      <Disclosure label="Technical details" hint="how the pick was made">
        <p className="text-xs text-muted-foreground">From <Code>{short(items[0].file)}:{items[0].line}</Code></p>
        <Reasons e={items[0]} raw />
        {[...new Set(items.flatMap(e => [e.howRaw, e.parent?.howRaw]).filter(Boolean))].map(t => <p key={t} className="font-mono text-xs text-muted-foreground">{t}</p>)}
      </Disclosure>
    </Disclosure>
  )
}

interface Look { key: string; items: any[]; rep: any; shot: any | null; files: number; style: string; same: boolean }

/**
 * Every element with its own photo gets its own tile: its photo, where it sits, its label and its code.
 * Elements that look the same (same classes) and say the same (same words and content) sit next to each
 * other, marked as the same look, but none stands in for another. Elements without a photo are grouped
 * by their classes, to say once what's missing.
 */
export function looksOf(items: any[]): Look[] {
  const style = (e: any) => e.styleSig ?? e.styleKey ?? `id:${e.id}`
  const content = (e: any) => `${style(e)}\u0001${e.ownHash ?? ""}\u0001${e.label ?? ""}`
  const shot = items.filter(e => e.shot)
  const groups = new Map<string, any[]>()
  for (const e of shot) groups.set(content(e), [...(groups.get(content(e)) ?? []), e])
  const captured = [...groups.values()].sort((a, b) => b.length - a.length).flatMap(list =>
    [...list].sort((a, b) => b.shot.match - a.shot.match).map(e => ({ key: `id:${e.id}`, items: [e], rep: e, shot: e.shot, files: 1, style: content(e), same: list.length > 1 })))
  const rest = new Map<string, any[]>()
  for (const e of items.filter(e => !e.shot)) rest.set(style(e), [...(rest.get(style(e)) ?? []), e])
  const uncaptured = [...rest].map(([key, list]) => ({ key, items: list, rep: list[0], shot: null, files: new Set(list.map(e => e.file)).size, style: key, same: false }))
  return [...captured, ...uncaptured]
}

export function deltaOf(e: any): { source: "measured" | "source"; changes: { label: string; from: string; to: string }[]; same: number; score: number } | null {
  const d = e.rendered?.diff
  if (d) return { source: "measured", changes: d.diffs.map((x: any) => ({ label: x.label, from: x.element, to: x.system })), same: d.same.length, score: d.score }
  const s = e.signature
  if (!s) return null
  const changes = (s.mismatched as string[]).map(t => { const m = t.match(/^(.+?) ✗ (.+) vs (.+)$/); return m ? { label: m[1], from: m[2], to: m[3] } : { label: t, from: "", to: "" } })
  return { source: "source", changes, same: s.matched.length, score: s.score }
}

/**
 * One look, as evidence: the element in the app beside the proposal, at the same CSS scale (both are
 * captured at 2x and drawn at half their pixels), each labelled with what it is. The photo is cropped
 * to the element; a wide one (a table, a panel) keeps its size and scrolls instead of shrinking.
 */
function LookTile({ look, sameAs, group, target, proposal, compare, measure }: { look: Look; sameAs: number; group: string[]; target: any; proposal: any; compare: boolean; measure: boolean }) {
  const { openLightbox, openCode, byId } = useEl()
  const e = look.rep, r = e.rendered
  const delta = deltaOf(e)
  const shotIds = group.filter(id => byId.get(id)?.shot)
  const openAt = (id: string) => openLightbox(shotIds, Math.max(0, shotIds.indexOf(id)), compare ? target : undefined)
  const caption = e.shot.revealedBy ? revealedText(e.shot.revealedBy) : null
  // The exact proposal when there is one. Otherwise the closest variant Storybook showed, said as such.
  const exact = proposal?.url ? proposal : null
  // Not drawn with these props: the closest variant measured, else the component's story as written.
  const closest = !exact ? (r?.systemShot ? { url: r.systemShot, key: r.key } : e.systemPreview ? { url: e.systemPreview.url, key: e.systemPreview.key } : proposal?.fallback ? { url: proposal.fallback, key: "" } : null) : null
  const chk = proposalCheck(proposal)
  const wide = (e.shot.box?.w ?? 0) > 340
  return (
    <figure className={cn("m-0 flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/20 p-2", wide && "md:col-span-2 xl:col-span-3", look.same && "border-primary/40")} data-element-id={e.id} data-same-look={look.same ? look.style : undefined}>
      {sameAs > 1 && <span className="text-[11px] font-medium text-muted-foreground">Same look and words: {sameAs} elements, each shown</span>}
      <SameScale
        app={{ url: e.shot.url, box: e.shot.box, alt: `${sourceLabel(e.shot)}: ${e.snippet.slice(0, 60)}`, onOpen: () => openAt(e.id) }}
        proposed={compare ? (exact ? { url: exact.url, alt: `Proposed: ${SYS} ${pickText(target)}` } : closest ? { url: closest.url, alt: `Closest ${SYS} variant: ${target.use} ${closest.key}` } : null) : undefined}
        appLabel={
          <>
            {/* A photo of the running app (a covering layer may have been hidden), an isolated render, drawn from the app's code, or markup only. */}
            <span className="font-medium text-foreground" title={sourceTip(e.shot)}>{sourceLabel(e.shot)}</span>
            <Badge variant="outline" className="text-[10px] font-normal" title="The app this element is in">{e.target}</Badge>
            <button type="button" onClick={() => openCode(e.id)} className="truncate font-mono text-[11px] underline-offset-4 hover:text-foreground hover:underline" title="Open the code">{short(e.file)}:{e.line}</button>
            {e.shot.drawn || e.shot.source === "isolated" ? null : e.shot.tagged ? <span title="The app was built with source tags: this is the node this line of code made">matched by source tag</span>
              : <span className="tabular-nums" title="How sure the crawler is that this is the element">match {Math.round(e.shot.match * 100)}%</span>}
            {e.shot.drawn || e.shot.source === "isolated" ? null : e.shot.tagged ? (e.shot.ties > 1 ? <span title="This line renders several nodes (a list); any of them stands for it">one of {e.shot.ties} rendered by this line</span> : null)
              : e.shot.shared > 1 ? <span title="Identical controls in other files match the same place on the page; which is which is a guess">one of {e.shot.shared} lines that look the same</span>
              : e.shot.ties > 1 && e.shot.alike >= e.shot.ties ? <span title="Several identical elements on the page match it; any of them shows how it looks">one of {e.shot.ties} alike on the page</span> : null}
            {e.shot.via && <span>shown on {e.shot.via}</span>}
          </>
        }
        proposedLabel={compare ? (
          <>
            <span className="font-medium text-foreground">{exact ? "Proposed" : closest?.key ? "Closest variant" : closest ? "Its story as written" : "Proposed"}</span>
            <b className="font-medium text-foreground">{target.use}</b>
            {Object.entries(exact ? target.props ?? {} : closest ? keyProps(closest.key) : target.props ?? {}).filter(([k]) => k !== "render").map(([k, v]) => <Badge key={k} variant="secondary" className="font-mono text-[10px] font-normal">{k} {String(v)}</Badge>)}
            {exact && chk && <span className={cn(chk.warn && "text-warning-soft-foreground")}>{chk.text}</span>}
            {!exact && <span className="text-warning-soft-foreground">{proposal?.note ?? (closest ? "The exact props aren't rendered yet" : chk?.text ?? "Not rendered yet")}</span>}
            {exact?.own && <span>with this element's own content</span>}
            {exact?.content && <span className="text-warning-soft-foreground" title={exact.content}>{/stand-in|^icon/.test(exact.content) ? "Stand-in icon: the app's own icon wasn't captured" : "The story's sample label, not this element's"}</span>}
          </>
        ) : undefined}
      />
      <InContext url={e.shot.context?.url ?? e.shot.url} box={e.shot.context?.box ?? e.shot.box} alt={`Where it sits: ${e.snippet.slice(0, 40)}`} page={e.review?.pageName ?? "its page"} />
      {e.review && !e.review.ready && <EvidenceNote e={e} />}
      <figcaption className="flex flex-col gap-1.5 px-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <span>{short(e.file)}:{e.line}</span>
          {caption && <span className="truncate" title={caption}>{caption}</span>}
        </span>
        {measure && <Changes delta={delta} />}
      </figcaption>
    </figure>
  )
}

/** "outline/sm" → { variant: outline, size: sm }: the closest variant's props, to label it. */
const keyProps = (key: string) => { const [variant, size] = key.split("/"); return { ...(variant ? { variant } : {}), ...(size ? { size } : {}) } }

/** "That includes 3 in checkout and 1 in admin, not shown here." */
function otherApps(items: any[]) {
  const n = new Map<string, number>()
  for (const e of items) n.set(e.target, (n.get(e.target) ?? 0) + 1)
  const parts = [...n].map(([a, c]) => `${c} in ${a}`)
  return `That includes ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}, not shown here.`
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
  const e = items.find(x => x.badShot) ?? items.find(x => x.reach) ?? items[0]
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-dashed p-3">
      <span className="flex items-center gap-1.5 text-xs font-medium"><ImageBrokenIcon className="text-muted-foreground" />{items.length} not {items.some(x => x.badShot) ? "shown" : "captured"}</span>
      {e.shotMissing || e.weakShot || e.badShot || e.reach?.status === "unused" ? <NoShot e={e} /> : <p className="text-xs text-muted-foreground">Not picked as an example this run.</p>}
      {e.review && !e.review.ready && <EvidenceNote e={e} />}
      {/* The code is for engineers: behind a disclosure, never on the face a designer decides from. */}
      {!e.systemPreview && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Its code (for engineers)</summary><Pre className="mt-1 max-h-28 text-[11px]">{e.snippet}</Pre></details>}
      {items.length > 1 && <span className="text-[11px] text-muted-foreground">{[...new Set(items.map(x => short(x.file)))].slice(0, 3).join(", ")}{new Set(items.map(x => x.file)).size > 3 ? "…" : ""}</span>}
    </div>
  )
}


/** What's missing for a person to review one element, and what would fix it. */
function EvidenceNote({ e }: { e: any }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-dashed px-2 py-1.5 text-xs" data-slot="needs-evidence">
      <b className="font-medium">Needs evidence before review</b>
      {e.review.missing.map((m: any, i: number) => <span key={i}>{m.why} <span className="text-muted-foreground">To fix: {m.fix}</span></span>)}
    </div>
  )
}

/** Elements on this card that can't be decided yet: why, once per reason, and what would fix it. */
function NeedsEvidence({ items, some }: { items: any[]; some?: boolean }) {
  const reasons = new Map<string, { fix: string; n: number }>()
  for (const e of items) for (const m of e.review?.missing ?? []) { const r = reasons.get(m.why) ?? { fix: m.fix, n: 0 }; r.n++; reasons.set(m.why, r) }
  return (
    <div className="flex flex-col gap-1 rounded-md border border-dashed px-3 py-2 text-sm" data-slot="needs-evidence">
      <b className="font-medium">{some ? `${items.length} of these need evidence before review` : "Needs evidence before review"}</b>
      <span className="text-xs text-muted-foreground">A decision needs the element as the app shows it and the proposal drawn with its own content. Until both exist, nothing is asked.</span>
      <ul className="list-disc pl-4 text-xs">{[...reasons].map(([why, r]) => <li key={why}>{why}{items.length > 1 ? ` (${r.n})` : ""} <span className="text-muted-foreground">To fix: {r.fix}</span></li>)}</ul>
    </div>
  )
}
