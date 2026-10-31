import * as React from "react"
import { cn } from "cn"
import { CaretDownIcon, CheckIcon, ImageBrokenIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Code, Pre } from "@/components/bits"
import { D, api, say, short, SYS } from "@/lib/dsa"
import { type Staged, setStagedNote, stage, stageKey, unstage, useStaged } from "@/lib/staged"

export interface Ctx {
  th: number
  byId: Map<string, any>
  applyLocal: (ids: string[], decided: any) => void
  refresh: () => void
  openPicker: (t: { ids: string[]; pattern?: string | null }) => void
  openLightbox: (ids: string[], i: number) => void
  openCode: (id: string) => void
}
export const ElCtx = React.createContext<Ctx>(null as any)
export const useEl = () => React.useContext(ElCtx)

export const rec = (e: any) => (e.decided ? e.decided.decision : e)
export const desc = (r: any) => r.verdict === "ignore" ? "Ignored" : r.verdict === "gap" ? `Gap: ${r.role}` : r.verdict === "keep" ? "Keep native" : `${r.use}${r.props && Object.keys(r.props).length ? " " + Object.entries(r.props).map(([k, v]) => `${k}="${v}"`).join(" ") : ""}`
export const contentText = (c: any) => {
  if (!c) return "label and icons from each element"
  const part = (k: string, n: string) => (c[k] === "none" ? `no ${n}` : c[k] && typeof c[k] === "object" ? `${n} ${c[k].icon ?? `“${c[k].text}”`} for all` : null)
  const p = [part("leading", "leading icon"), part("trailing", "trailing icon"), c.label && typeof c.label === "object" ? `label “${c.label.text}” for all` : null].filter(Boolean)
  return p.length ? p.join(", ") : "label and icons from each element"
}
export const recText = (r: any) => r.verdict === "ignore" ? "Ignored" : r.verdict === "keep" ? "Keep native" : r.verdict === "gap" ? `System gap${r.gap ? `: ${r.gap}` : ""}` : [r.use, ...Object.entries(r.props ?? {}).map(([k, v]) => `${k} ${v}`), contentText(r.content)].filter(Boolean).join(" · ")
export const sameDecision = (a: any, b: any) => a && b && a.verdict === b.verdict && (a.use ?? "") === (b.use ?? "") && JSON.stringify(a.props ?? {}) === JSON.stringify(b.props ?? {})

export function Conf({ c }: { c: number }) {
  const { th } = useEl()
  return <Badge variant="outline" className={cn("tabular-nums", c >= th ? "border-success-soft-border text-success-soft-foreground" : c >= th - 0.15 ? "border-warning-soft-border text-warning-soft-foreground" : "border-destructive/40 text-destructive")}>{Math.round(c * 100)}%</Badge>
}

export const Where = ({ e }: { e: any }) => <Code>{short(e.file)}:{e.line}</Code>

/** The element's measured box, as a thin ring over the untouched screenshot (effects stay visible). */
export function Ring({ b }: { b: any }) {
  if (!b) return null
  return <span className="pointer-events-none absolute rounded-[3px] outline-2 outline-offset-2 outline-primary/80" style={{ left: `${(b.x / b.cw) * 100}%`, top: `${(b.y / b.ch) * 100}%`, width: `${(b.w / b.cw) * 100}%`, height: `${(b.h / b.ch) * 100}%` }} />
}

function Figure({ src, alt, caption, onOpen, box, ratio }: { src: string; alt: string; caption: React.ReactNode; onOpen?: () => void; box?: any; ratio?: string }) {
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      <button type="button" onClick={onOpen} disabled={!onOpen} className="relative overflow-hidden rounded-lg border bg-muted/40 enabled:cursor-zoom-in" style={ratio ? { aspectRatio: ratio } : undefined}>
        <img src={src} alt={alt} loading="lazy" className="block h-full max-h-56 w-full object-contain" />
        <Ring b={box} />
      </button>
      <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  )
}

export function NoShot({ e }: { e: any }) {
  const r = e.reach
  if (e.weakShot && r?.status !== "unused") return (
    <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
      <b className="font-medium text-foreground">No reliable screenshot.</b> The closest element the crawler found was only {Math.round(e.weakShot.match * 100)}% alike, so it may be a different element. It isn't shown.
    </p>
  )
  if (!e.shotMissing && r?.status !== "unused") return null
  const head = r?.status === "unused" ? <><b className="font-medium text-foreground">Unused code.</b> {r.why} Delete it rather than migrate it.</>
    : r ? <><b className="font-medium text-foreground">No screenshot.</b> {r.why}{r.steps.length ? ` The crawler tried ${r.steps.map((x: string) => `“${x}”`).join(" then ")} where it found ${r.steps.length > 1 ? "them" : "it"}.` : r.status === "gated" ? " Nothing in the source says which control turns that on, so the crawler can’t open it on its own; add a route that shows it (apps.routes) or review from the code." : " It should be on a page; the crawler didn’t reach that page within its budget (shots.maxPages) or couldn’t match it."}</>
    : <><b className="font-medium text-foreground">No screenshot.</b> Not found on any page visited.</>
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border border-dashed p-3", r?.status === "unused" && "border-solid bg-muted/40")}>
      <p className="text-sm text-muted-foreground">{head}</p>
      {r?.gates?.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-4 hover:underline">{r.gates.length} condition{r.gates.length > 1 ? "s" : ""} between the page and this element</CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="mt-2 ml-5 list-decimal space-y-0.5 text-xs">
              {r.gates.map((g: any, i: number) => <li key={i}>{g.kind === "overlay" ? <>inside a <b>{g.overlay}</b>{g.test && <> open when <Code>{g.test}</Code></>}</> : <>{g.negated ? "not " : ""}<Code>{g.test}</Code></>}{g.component && <span className="text-muted-foreground"> in {g.component}</span>}</li>)}
            </ol>
            {r.via?.length > 1 && <p className="mt-1 text-xs text-muted-foreground">{r.via.join(" › ")}</p>}
          </CollapsibleContent>
        </Collapsible>
      )}
      {e.systemPreview && r?.status !== "unused" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Pre className="max-h-36">{e.snippet}</Pre>
          <Figure src={e.systemPreview.url} alt={`${SYS} ${e.use || ""} ${e.systemPreview.key}`} caption={`Becomes ${SYS} ${e.use || ""} ${e.systemPreview.key} (Storybook)`} />
        </div>
      )}
    </div>
  )
}

/** "opening “Filters” › hovering “row”" from the explorer; older captures stored only the label. */
export const revealedText = (r: string) => /^(opening|hovering|right-clicking)\b/.test(r) ? `after ${r}` : `after opening “${r}”`

/** The element as the app renders it, next to the recommended system variant as Storybook renders it. */
export function Shot({ e, group }: { e: any; group?: string[] }) {
  const { openLightbox, byId } = useEl()
  if (!e.shot) return <NoShot e={e} />
  const open = () => { const ids = (group ?? [e.id]).filter(id => byId.get(id)?.shot); openLightbox(ids, Math.max(0, ids.indexOf(e.id))) }
  const b = e.shot.box
  const where = `${e.shot.page ? `on ${e.shot.page.replace(/^https?:\/\/[^/]+/, "") || "/"} ` : ""}(match ${Math.round(e.shot.match * 100)}%)`
  const app = <Figure src={e.shot.url} alt={`Screenshot of ${e.snippet.slice(0, 60)}`} box={b} ratio={b ? `${b.cw}/${b.ch}` : undefined} onOpen={open} caption={<><Where e={e} /> · {where}{e.shot.revealedBy && ` · ${revealedText(e.shot.revealedBy)}`}</>} />
  const r = e.rendered
  if (!r?.systemShot) return app
  const d = r.diff
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-3 sm:grid-cols-2">
        {app}
        <Figure src={r.systemShot} alt={`${SYS} ${e.use || ""} ${r.key}`} onOpen={open} caption={`${SYS} ${e.use || ""} ${r.key} (Storybook${r.sizeMissing ? `; no story shows size ${r.key.split("/")[1]}, so this is ${r.key.split("/")[0]} at its default size and only colors are compared` : r.composed ? "; size measured separately" : ""})`} />
      </div>
      {d && (
        <div className="text-xs">
          <b className="font-medium">Rendered parity {Math.round(d.score * 100)}%</b>{r.closest && r.closest.key !== r.key && <> · renders closest to <b>{r.closest.key}</b> ({Math.round(r.closest.score * 100)}%)</>}
          <Dims bad={d.diffs.map((x: any) => `${x.label}: ${x.element} vs ${x.system}`)} ok={d.same} />
        </div>
      )}
    </div>
  )
}

export function Dims({ bad, ok }: { bad: string[]; ok: string[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {bad.map(x => <Badge key={x} variant="outline" className="border-destructive/40 font-mono text-[11px] font-normal">{x}</Badge>)}
      {ok.map(x => <Badge key={x} variant="outline" className="gap-1 font-mono text-[11px] font-normal text-muted-foreground"><CheckIcon />{x}</Badge>)}
    </div>
  )
}

export function SigBlock({ e }: { e: any }) {
  const s = e.signature
  if (!s) return null
  return (
    <div className="text-xs">
      <b className="font-medium">Signature</b> {s.component} {s.variant}/{s.size} · visual parity {Math.round(s.score * 100)}%{s.runnerUp && ` · next ${s.runnerUp.variant}/${s.runnerUp.size} ${Math.round(s.runnerUp.score * 100)}%`}
      <Dims bad={s.mismatched} ok={s.matched} />
    </div>
  )
}

export function Reasons({ e }: { e: any }) {
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {e.reasons.map((r: any, i: number) => (
        <li key={i} className="flex gap-2">
          <span className={cn("w-8 shrink-0 text-right font-mono text-xs tabular-nums", r.delta > 0 ? "text-success-soft-foreground" : r.delta < 0 ? "text-destructive" : "text-muted-foreground")}>{r.delta ? `${r.delta > 0 ? "+" : "−"}${Math.abs(Math.round(r.delta * 100))}` : "·"}</span>
          <span>{r.text}</span>
        </li>
      ))}
    </ul>
  )
}

/** What to call an element in a list: its visible text or label, else the component file it lives in. */
export const nameOf = (e: any) => (e.label ? `“${e.label}”` : (e.file.split("/").pop() ?? e.file).replace(/\.[jt]sx?$/, ""))

/**
 * One element, folded. Confidence leads (one column, so the eye runs down it), then what the element
 * says, then where it lives: the path opens the code viewer. Open the row for the evidence.
 */
export function ElementRow({ e, group }: { e: any; group?: string[] }) {
  const { openPicker, applyLocal, refresh, openCode } = useEl()
  const undo = async () => {
    try { const r = await api("/api/undecide", { ids: [e.id] }); applyLocal(r.ids, null); say(`Undone for ${r.ids.length} element(s)`); refresh() } catch (x: any) { say(x.message, true) }
  }
  return (
    <Collapsible className="border-b last:border-b-0">
      <div className="grid grid-cols-[3.25rem_1fr_auto] items-center gap-3 py-1.5 text-sm">
        <span className="justify-self-start"><Conf c={e.confidence} /></span>
        <CollapsibleTrigger className="flex min-w-0 items-center gap-1.5 text-left underline-offset-4 hover:underline">
          <span className={cn("truncate", !e.label && "text-muted-foreground")}>{nameOf(e)}</span>
          {e.regions?.length > 0 && <span className="shrink-0 text-xs text-muted-foreground">in {e.regions.join(", ")}</span>}
        </CollapsibleTrigger>
        <button type="button" onClick={() => openCode(e.id)} className="truncate font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" title="Open the code">
          {short(e.file)}:{e.line}
        </button>
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 pb-4 pl-[4rem]">
          <Shot e={e} group={group} />
          <Reasons e={e} />
          <SigBlock e={e} />
          {e.alternatives.length > 0 && <p className="text-xs text-muted-foreground">Alternatives: {e.alternatives.map((a: any) => `${pickText(a)} (${Math.round(a.confidence * 100)}%)`).join(" · ")}</p>}
          {e.a11y.length > 0 && <p className="text-xs text-muted-foreground"><b>Accessibility:</b> {e.a11y.join(" ")}</p>}
          {e.decided && <p className="text-xs text-muted-foreground"><b>Decided by {e.decided.by}{e.decided.who ? ` (${e.decided.who})` : ""}:</b> {pickText(e.decided.decision)}{e.decided.note ? ` — ${e.decided.note}` : ""}</p>}
          {D.serve && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => openPicker({ ids: [e.id] })}>Change this one</Button>
              {e.decided && <Button variant="ghost" size="sm" onClick={undo}>Undo decision</Button>}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Where a review card stands. In `dsa serve` that's the decision in the repo. On the published
 * dashboard a decision staged in this browser wins, so the card shows what will be exported.
 */
export function useReviewState(items: any[], auto: any, staged?: Staged | null) {
  const d = staged ? { decision: staged.decision, note: staged.note, by: "human" } : items.every(e => e.decided) ? items[0].decided : null
  const state: "open" | "approved" | "changed" | "ignored" = !d ? "open" : d.decision.verdict === "ignore" ? "ignored" : sameDecision(d.decision, auto) ? "approved" : "changed"
  return { d, state, staged: Boolean(staged) }
}

/** A decision in a few words: "Button · variant ghost · size sm", "System gap", "Keep native". */
export const pickText = (r: any) => r.verdict === "gap" ? "System gap" : r.verdict === "keep" ? "Keep native" : r.verdict === "ignore" ? "Ignored" : [r.use, ...Object.entries(r.props ?? {}).map(([k, v]) => `${k} ${v}`)].join(" · ")

/** A decision as a menu item: "Button · variant ghost · size sm", "Keep the native element", "System gap". */
export const optionText = (r: any) => r.verdict === "keep" ? "Keep the native element" : r.verdict === "gap" ? `System gap: no ${SYS} component fits` : r.verdict === "ignore" ? "Ignore" : [r.use, ...Object.entries(r.props ?? {}).map(([k, v]) => `${k} ${v}`)].join(" · ")

/** The ways a card can be answered without the live picker: the question's options and alternatives, then keep or gap. */
/** The engine's proposalKey: the component and its look props in name order, without render or asChild. */
export const proposalKey = (use: string, props?: Record<string, unknown> | null) => {
  const p = Object.entries(props ?? {}).filter(([k, v]) => k !== "render" && k !== "asChild" && v != null).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(";")
  return p ? `${use}|${p}` : use
}
/** The proposed replacement rendered with exactly its props (dsa render), when there is one. */
export const proposalFor = (r: any): any | null => (r?.verdict === "replace" && r.use ? D.elements?.proposals?.[proposalKey(r.use, r.props)] ?? null : null)

/** How far a rendered proposal can be trusted, in words. */
export const proposalCheck = (p: any): { text: string; warn: boolean } | null =>
  !p ? { text: "Not rendered yet: dsa render draws it", warn: true }
  : p.check === "exact" ? null
  : p.check === "unverified" ? { text: "Props set; the component doesn't expose them to confirm", warn: false }
  : p.check === "closest" ? { text: `Nearest story: ${Object.entries(p.actual ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")}. Its stories don't take these props`, warn: true }
  : { text: p.note ?? "Not rendered", warn: true }

/**
 * Every replacement the card could take, drawn as the system component with its props, so the reviewer
 * picks by look. The recommendation comes first; the current decision is pressed. Click to choose.
 */
function OptionTiles({ choices, current, onPick, disabled }: { choices: { decision: any; recommended: boolean }[]; current: any; onPick: (d: any, recommended: boolean) => void; disabled: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" role="group" aria-label="Options, rendered">
      {choices.map(({ decision, recommended }) => {
        const p = proposalFor(decision)
        const chk = proposalCheck(p)
        const on = sameDecision(decision, current)
        return (
          <button key={desc(decision)} type="button" disabled={disabled} aria-pressed={on} onClick={() => onPick(decision, recommended)}
            className={cn("flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-2 text-left transition-colors hover:bg-muted/60 disabled:opacity-60", on && "border-primary ring-1 ring-primary")}>
            <span className="grid h-20 place-items-center overflow-hidden rounded-md border bg-background p-2">
              {p?.url ? <img src={p.url} alt={`${SYS} ${pickText(decision)}`} loading="lazy" className="block max-h-16 w-auto max-w-full object-contain" />
                : <span className="flex flex-col items-center gap-1 text-[11px] text-muted-foreground"><ImageBrokenIcon />No rendering</span>}
            </span>
            <span className="flex flex-wrap items-center gap-1 text-xs">
              <b className="font-medium">{decision.use}</b>
              {Object.entries(decision.props ?? {}).filter(([k]) => k !== "render").map(([k, v]) => <Badge key={k} variant="secondary" className="font-mono text-[10px] font-normal">{k} {String(v)}</Badge>)}
            </span>
            <span className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              {recommended && <Badge variant="outline" className="text-[10px]">Recommended</Badge>}
              {on && <span className="inline-flex items-center gap-0.5 text-primary"><CheckIcon />Chosen</span>}
              {chk && <span className={cn(chk.warn && "text-warning-soft-foreground")} title={chk.text}>{chk.text}</span>}
              {p?.content && <span title={p.content}>{p.content.startsWith("icon") ? "Stand-in icon" : "Story's sample label"}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function staticOptions(items: any[], auto: any, options?: { label: string; decision: any }[]) {
  const role = items[0].role
  const alts = (items[0].alternatives ?? []).map((a: any) => ({ verdict: a.verdict ?? "replace", role: a.role ?? role, use: a.use, from: a.from, props: a.props ?? {}, gap: a.gap }))
  const list: any[] = [...(options ?? []).map(o => o.decision), ...alts, { verdict: "keep", role }, { verdict: "gap", role, gap: auto.gap }]
  const seen = new Set<string>()
  return list.filter(r => !sameDecision(r, auto) && !seen.has(desc(r)) && seen.add(desc(r))).map(r => ({ label: optionText(r), decision: r }))
}

/**
 * The decision bar: Approve the recommendation, Change it, or Ignore the card, with an optional note.
 * In `dsa serve` each action saves to the repo. On the published dashboard the same actions stage
 * the decision in this browser (lib/staged), to export from the bar at the top of the tab.
 */
export function ReviewControls({ items, auto, pattern, options, label }: { items: any[]; auto: any; pattern?: string | null; options?: { label: string; decision: any }[]; label: string }) {
  const { applyLocal, refresh, openPicker } = useEl()
  const ids = items.map(e => e.id)
  const key = stageKey(ids, pattern)
  const staged = useStaged().find(s => s.key === key) ?? null
  const { d, state } = useReviewState(items, auto, staged)
  const live = Boolean(D.serve)
  const [note, setNote] = React.useState(d?.note && !/^pattern /.test(d.note) ? d.note : "")
  const [busy, setBusy] = React.useState(false)
  const off = state === "ignored"
  const where = pattern ? { pattern } : { ids }
  const members = () => (pattern ? D.elements.evals.filter((e: any) => e.styleKey === pattern || e.styleSig === pattern).map((e: any) => e.id) : ids)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn() } catch (x: any) { say(x.message, true) }
    setBusy(false); refresh()
  }
  // Live: write to the repo. Static: stage here.
  const decide = (decision: any, done: string) => live
    ? run(async () => { const r = await api("/api/decide", { ...where, decision, note: note || undefined }); applyLocal(members(), r.decided); say(`${done} for ${r.recorded} element(s)`) })
    : (stage({ key, target: items[0].target, ids, pattern, decision, note: note || undefined, label }), say(`${done}: staged in this browser. Download it from the bar at the bottom.`))
  const undo = (done: string) => live
    ? run(async () => { const r = await api("/api/undecide", where); applyLocal(r.ids, null); say(done) })
    : (unstage(key), say(done))
  // A decision already in the repo when this page was published can be replaced here (staged), but
  // only undone in dsa serve: a decisions file records decisions, not removals.
  const locked = !live && !staged && state !== "open"
  // The replacements this card could take: the recommendation, then every scored alternative.
  const choices = [auto, ...staticOptions(items, auto, options).map(o => o.decision)].filter(r => r?.verdict === "replace" && r.use).map((decision, i) => ({ decision, recommended: i === 0 && auto?.verdict === "replace" }))
  const current = state === "changed" ? d.decision : state === "approved" ? auto : null

  return (
    <div className="flex flex-col gap-2">
      {choices.length > 0 && (
        <OptionTiles choices={choices} current={current} disabled={busy || off || locked}
          onPick={(r, recommended) => (sameDecision(r, current) ? undo("Choice removed") : recommended ? decide(auto, "Approved") : decide(r, `Changed to ${pickText(r)}`))} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={state === "approved" ? "secondary" : "default"} aria-pressed={state === "approved"} disabled={busy || off || (locked && state === "approved")}
          onClick={() => (state === "approved" ? undo("Approval removed") : decide(auto, "Approved"))}>
          {state === "approved" && <CheckIcon data-icon="inline-start" />}{state === "approved" ? "Approved" : "Approve"}
        </Button>
        {live ? (
          <Button size="sm" variant={state === "changed" ? "secondary" : "outline"} disabled={busy || off} onClick={() => openPicker({ ids, pattern })}>{state === "changed" ? "Changed" : "Change…"}</Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" variant={state === "changed" ? "secondary" : "outline"} disabled={off} />}>
              {state === "changed" ? "Changed" : "Change"}<CaretDownIcon data-icon="inline-end" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Instead of the recommendation</DropdownMenuLabel>
                {staticOptions(items, auto, options).map(o => (
                  <DropdownMenuItem key={desc(o.decision)} onClick={() => decide(o.decision, `Changed to ${pickText(o.decision)}`)}>{o.label}</DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <p className="px-2 py-1.5 text-xs text-muted-foreground">Another component, size, label or icon: use the picker in <code className="font-mono">dsa serve</code>.</p>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button size="sm" variant={off ? "secondary" : "ghost"} aria-pressed={off} disabled={busy || (locked && off)}
          onClick={() => (off ? undo("No longer ignored") : decide({ verdict: "ignore", role: items[0].role }, "Ignored"))}>{off ? "Ignored" : "Ignore"}</Button>
        <Input value={note} onChange={e => { setNote(e.target.value); if (staged) setStagedNote(key, e.target.value) }} placeholder="Note for the decision (optional)" aria-label="Note for the decision" disabled={off}
          className="h-7 max-w-lg min-w-48 flex-1 text-sm" />
      </div>
      {/* The page-level note (Questions for a human) explains staging once; a card only says where it stands. */}
      {!live && (staged || locked) && (
        <p className="text-xs text-muted-foreground">
          {staged
            ? <>Staged in this browser, not in the repo yet. Download it from the bar at the bottom of the page.</>
            : <>Decided in the repo{d?.who ? ` by ${d.who}` : ""}{d?.note ? `: “${d.note}”` : ""}. A new decision here is staged to replace it; undoing it needs <code className="font-mono">dsa serve</code>.</>}
        </p>
      )}
    </div>
  )
}
