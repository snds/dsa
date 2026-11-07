import * as React from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Note } from "@/components/bits"
import { D, api, say, short, SYS } from "@/lib/dsa"
import { relayWho } from "@/lib/useScan"
import { ElCtx, atWidthOf, ownSays, ownWords, pickText, proposalFor, sourceLabel } from "@/views/elements/shared"
import { deltaOf } from "@/views/elements/ReviewCard"
import { CodeViewer } from "@/views/elements/CodeViewer"
import { Crop, InContext, Natural } from "@/views/elements/SameScale"

/**
 * Review one element at a time, to give dsa's "ready" bar labels it can be measured against. Written for
 * a designer: the element as the app draws it, beside the proposal drawn with the element's own words,
 * both at their real size; where it sits; why dsa thinks so, in plain words; where the app already uses
 * the proposal; and one click to say Right, Wrong (then pick the right answer from what the system
 * allows) or Not sure. The code is one click away for engineers, never needed.
 *
 * Every answer is a labels.jsonl row (method "human"). dsa serve saves it to <data>/labels/human.jsonl;
 * a published page keeps it in this browser to download. Only elements with real evidence are queued
 * (report.ts withReview): nothing here asks for a decision on a near-empty candidate.
 */

const REVIEWER = "dsa.reviewer"
const SAVED = "dsa.review-labels.v1"

const read = (k: string, d: any) => { try { return JSON.parse(window.localStorage.getItem(k) || "null") ?? d } catch { return d } }
const write = (k: string, v: any) => { try { window.localStorage.setItem(k, JSON.stringify(v)) } catch { /* kept for this visit */ } }

/** What an element is, in a person's words. */
const KIND: Record<string, string> = {
  button: "a button", "icon-button": "an icon-only button", "link-button": "a link styled as a button", "text-input": "a text field", textarea: "a text area",
  "menu-item": "a menu row", toggle: "an on/off button", "chip-toggle": "a chip that turns on and off", tab: "a tab", checkbox: "a checkbox", select: "a dropdown",
  "nav-item": "a navigation item", "record-link": "a link to a record", disclosure: "a show/hide control", "disclosure-icon": "a show/hide arrow", segmented: "a segmented control",
  "breadcrumb-back": "a back link", "number-input": "a number field", "color-input": "a colour field", range: "a slider",
}

/** "A button labelled "Save", 64 × 32 px, on Requests › Table." */
export function describe(e: any): string {
  const what = KIND[e.role] ?? (e.element === "a" ? "a link" : e.element === "input" ? "a field" : `a ${e.element} element`)
  const words = e.label ? ` labelled “${e.label}”` : ""
  const size = e.shot?.box ? `, ${Math.round(e.shot.box.w)} × ${Math.round(e.shot.box.h)} px` : ""
  return `${what.charAt(0).toUpperCase()}${what.slice(1)}${words}${size}, on ${e.review?.pageName ?? "its page"}.`
}

/** A colour in a word: "blue", "grey", "white", from rgb(), rgba() or #hex. Empty when it can't tell. */
export function colourName(v: string): string {
  let r = 0, g = 0, b = 0
  const m = v.match(/rgba?\(([^)]+)\)/), h = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})\b/i)
  if (m) { const [x, y, z, a] = m[1].split(",").map(s => Number(s.trim())); if (a === 0) return "transparent"; [r, g, b] = [x, y, z] }
  else if (h) { const s = h[1].length === 3 ? h[1].split("").map(c => c + c).join("") : h[1]; [r, g, b] = [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)) }
  else return ""
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2
  const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
  if (sat < 0.15) return l > 0.92 ? "white" : l < 0.12 ? "black" : "grey"
  const hue = (() => { const R = r / 255, G = g / 255, B = b / 255, d = max - min; const x = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4; return (x * 60 + 360) % 360 })()
  return hue < 15 || hue >= 345 ? "red" : hue < 40 ? "orange" : hue < 65 ? "yellow" : hue < 165 ? "green" : hue < 195 ? "teal" : hue < 255 ? "blue" : hue < 290 ? "purple" : "pink"
}

const PX = (v: string): number | null => { const r = v.match(/^(-?\d*\.?\d+)rem$/); if (r) return Math.round(Number(r[1]) * 16); const n = v.match(/^(-?\d*\.?\d+)(?:px)?$/); return n ? Math.round(Number(n[1])) : null }
const isSetting = (v: string) => /^(--|var\()/.test(v)
const isNone = (v: string) => !v || v === "unset" || v === "none"
const STATES: [RegExp, string][] = [[/^hover$/, "hover"], [/^active$/, "pressed"], [/^focus(-visible)?$/, "focus"], [/^aria-pressed$|^aria-selected$|^data-selected$/, "selected"], [/^aria-expanded$|^data-open$/, "open"], [/^disabled$/, "disabled"]]
const COLOUR_PROP = /^(bg|fg|background|text colou?r|border-?\s?colou?r|ring|outline-color)$/i
const whatColour = (l: string) => /^(bg|background)$/i.test(l) ? "background" : /border/i.test(l) ? "border colour" : /ring|outline/i.test(l) ? "focus outline" : "text colour"

/**
 * One difference, in what a person would see: classes and tokens become sizes, or "uses a density setting";
 * a hover or pressed look is "a different hover colour". The element first, the proposal second. Raw
 * values stay in Technical details.
 */
export function plainChange(c: { label: string; from: string; to: string }): string {
  const parts = c.label.split(":")
  const l = parts[parts.length - 1].trim().toLowerCase()
  const state = parts.slice(0, -1).map(p => STATES.find(([re]) => re.test(p))?.[1] ?? null)
  if (parts.length > 1) return `a different ${state.find(Boolean) ?? "state"} ${COLOUR_PROP.test(l) ? "colour" : "look"}`
  const a = PX(c.from), b = PX(c.to)
  const padding = /^(px|padding-x)$/.test(l) ? "side padding" : /^(py|padding-y)$/.test(l) ? "top and bottom padding" : /^(pt|pb|pl|pr|padding|gap|margin)/.test(l) ? l.replace(/^pt$/, "top padding").replace(/^pb$/, "bottom padding").replace(/^pl$/, "left padding").replace(/^pr$/, "right padding").replace(/-/g, " ") : null
  if (padding) {
    if (a != null && b != null) return `${a} px ${padding} instead of ${b} px`
    if (isSetting(c.to)) return `${a != null ? `${a} px ${padding}` : `its own ${padding}`}, where the system uses a ${/density/.test(c.to) ? "density" : "spacing"} setting`
    if (isNone(c.from)) return `no ${padding} of its own`
    return `a different ${padding}`
  }
  if (/^height$/.test(l) || /^width$/.test(l)) {
    if (a != null && b != null && a !== b) return /height/.test(l) ? `${Math.abs(a - b)} px ${a > b ? "taller" : "shorter"}` : `${Math.abs(a - b)} px ${a > b ? "wider" : "narrower"}`
    return `a different ${l}`
  }
  if (/radius|corner/.test(l)) {
    if (a != null && b != null) return a > b ? "rounder corners" : "squarer corners"
    if (isNone(c.from)) return "squarer corners"
    if (isNone(c.to)) return "rounder corners"
    return "different corners"
  }
  if (/font.?size|text size/.test(l)) return a != null && b != null ? `${a} px text instead of ${b} px` : "a different text size"
  if (/font.?weight/.test(l)) { const n = (v: string) => Number(v) || ({ normal: 400, regular: 400, medium: 500, semibold: 600, bold: 700 } as Record<string, number>)[v] || null; const x = n(c.from), y = n(c.to); return x && y ? (x > y ? "bolder text" : "lighter text") : "a different text weight" }
  if (/border.?width/.test(l)) return a === 0 || isNone(c.from) ? "no border of its own" : b === 0 || isNone(c.to) ? "a border the proposal doesn't have" : "a different border width"
  if (/shadow/.test(l)) return isNone(c.from) ? "no shadow" : isNone(c.to) ? "a shadow the proposal doesn't have" : "a different shadow"
  if (/decoration/.test(l)) return /underline/.test(c.from) ? "underlined" : /underline/.test(c.to) ? "not underlined" : "different text styling"
  if (COLOUR_PROP.test(l)) {
    const what = whatColour(l), ca = colourName(c.from), cb = colourName(c.to)
    if (ca && cb && ca !== cb) return `${ca} ${what.replace(" colour", "")} instead of ${cb}`
    return ca && cb ? `a slightly different ${what} (both ${ca})` : `a different ${what}`
  }
  return `a different ${l.replace(/[-_]/g, " ")}`
}

const CONTENT_SIZED = /^(static-table|data-table|clickable-region|native-dialog|drop-target|selector-card|choice-tile)$/

/** Near white: the page a proposal is drawn on. */
const whiteOrClear = (v: string) => { const n = colourName(v); return n === "white" || n === "transparent" }

/**
 * How the element differs from the proposal, in plain words: "4 px taller", "blue text instead of grey",
 * "12 px text instead of 14 px". The same thing said once. A proposal is drawn on white, so its background
 * says nothing beside an element on another surface.
 */
export function plainDifferences(e: any): string[] {
  const d = deltaOf(e)
  if (!d) return []
  const surface = e.shot?.surface
  const elsewhere = surface && !whiteOrClear(surface)
  // A table's height is its rows, a tile's its contents: beside a story's sample content, that says nothing.
  const inner = e.shot?.content?.inner
  const sized = CONTENT_SIZED.test(e.role ?? "") || e.element === "table" || (inner?.blocks ?? 0) > 1
  const kept = d.changes.filter(c => !(elsewhere && /^(bg|background)$/i.test(c.label)) && !(sized && /^(height|width)$/i.test(c.label)))
  return [...new Set(kept.map(plainChange))].slice(0, 5)
}

/** Instructions for whoever builds it, not reasons to judge by: they stay in Technical details. */
const BUILD_STEP = /^(Build|Migrate|Wrap|Check which|Keep|Use|Add|Put|Approve)\b|\bwraps the\b|\bholds an?\b/

/** A plain reason without its building instructions. Empty when nothing else is left. */
export function reasonToJudge(t: string): string {
  return t.split(/(?<=[.!?])\s+/).filter(x => !BUILD_STEP.test(x.trim())).join(" ").trim()
}

/** A pick in a person's words: "a link-style button, inline size". The prop names stay beside it, small. */
export function plainPick(r: any): string {
  if (!r) return ""
  if (r.verdict === "keep") return "keep it as it is"
  if (r.verdict === "gap") return `nothing in ${SYS} fits`
  if (r.verdict !== "replace" || !r.use) return pickText(r)
  const name = String(r.use).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
  const props = Object.entries<any>(r.props ?? {}).filter(([k]) => k !== "render" && k !== "asChild")
  const variant = props.find(([k]) => k === "variant")?.[1], size = props.find(([k]) => k === "size")?.[1]
  const rest = props.filter(([k]) => k !== "variant" && k !== "size").map(([k, v]) => (v === true || v === "true" ? k : `${k} ${v}`))
  const head = `${/^[aeiou]/i.test(variant ?? name) ? "an" : "a"} ${variant ? `${variant}-style ` : ""}${name}`
  return [head, ...(size ? [`${size} size`] : []), ...rest].join(", ")
}

/** "a link-style button, inline size" with its props small beside it. */
/** What a card's heading says it proposes. A card with no component says so, in words. */
export function proposalHeading(r: any): string {
  if (r?.verdict === "replace" && r.use) return `${SYS} ${pickText(r)}`
  if (r?.verdict === "gap") return `no ${SYS} component fits`
  if (r?.verdict === "keep") return "keep it as it is"
  return `no clear match in ${SYS}`
}

function PickName({ r }: { r: any }) {
  const props = pickText(r)
  return <><span>{plainPick(r)}</span>{r?.verdict === "replace" && <span className="ml-1 font-mono text-[10px] text-muted-foreground">({props})</span>}</>
}

/** The render stored for a component and props, if one was drawn (proposalKey's format), at this element's width. */
function renderOf(use: string, props: Record<string, any> | undefined, e?: any): any | null {
  const P = D.elements.proposals ?? {}
  const p = Object.entries(props ?? {}).filter(([k, v]) => k !== "render" && k !== "asChild" && v != null).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(";")
  const key = p ? `${use}|${p}` : use
  const hit = (e?.ownHash && P[`${key}#${e.ownHash}`]) || P[key]
  return hit?.url ? atWidthOf(hit, e) : null
}

type Verdict = "right" | "wrong" | "unsure"

export function LabelReview() {
  const R = D.elements.review
  const items: any[] = R?.items ?? []
  const byId = React.useMemo(() => new Map<string, any>(D.elements.evals.map((e: any) => [e.id, e])), [])
  const [i, setI] = React.useState(0)
  const [code, setCode] = React.useState<string | null>(null)
  const [name, setName] = React.useState<string>(() => read(REVIEWER, ""))
  const [signedIn, setSignedIn] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState<any[]>(() => read(SAVED, []))
  React.useEffect(() => { relayWho().then(w => { if (w?.signedIn && w.login) setSignedIn(w.login) }) }, [])
  const ctx = { th: D.elements.threshold, byId, applyLocal: () => {}, refresh: () => {}, openPicker: () => {}, openLightbox: () => {}, openCode: setCode }
  const labeler = signedIn ?? name.trim()

  if (!items.length) return <Note>Nothing to review: no element has both a photo and its proposal drawn with its own content yet.{R?.setAside ? ` ${R.setAside} need evidence first; their cards in Element Review say what's missing.` : ""}</Note>
  const item = items[Math.min(i, items.length - 1)]
  const e = byId.get(item.id)
  const done = new Set(saved.map(s => s.id))

  const record = async (row: any) => {
    const next = [...saved.filter(s => s.id !== row.id), row]
    if (D.serve && row.label) await api("/api/labels", { labels: [row.label] })
    setSaved(next); write(SAVED, next)
    say(row.label ? (D.serve ? "Saved as a label." : "Saved in this browser: download the labels when you're done.") : "Marked not sure.")
    setI(x => Math.min(items.length - 1, x + 1))
  }

  return (
    <ElCtx.Provider value={ctx}>
      <div className="flex flex-col gap-4" data-slot="label-review">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-heading text-lg font-semibold">Review one at a time</h2>
          <span className="text-sm text-muted-foreground" aria-live="polite">Element {i + 1} of {items.length} · {done.size} answered</span>
          <span className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setI(x => Math.max(0, x - 1))} disabled={i === 0}>Previous</Button>
            <Button variant="outline" size="sm" onClick={() => setI(x => Math.min(items.length - 1, x + 1))} disabled={i >= items.length - 1}>Next</Button>
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {item.why === "decide" ? "dsa isn't sure about this one, so a person decides." : item.why === "disagree" ? "dsa and an earlier answer disagree here." : "Picked at random from the ones dsa calls ready, to check them."}
          {R.setAside ? ` ${R.setAside} other elements need evidence before anyone can review them, so they aren't asked.` : ""}
        </p>
        {!signedIn && (
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span>Your name, saved with each answer</span>
            <input className="h-8 rounded-md border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring" value={name} onChange={ev => { setName(ev.target.value); write(REVIEWER, ev.target.value) }} aria-describedby="reviewer-why" />
            <span id="reviewer-why" className="text-xs text-muted-foreground">Signed in to the scan relay, your sign-in is used instead.</span>
          </label>
        )}
        <Item key={item.id} item={item} e={e} labeler={labeler} onAnswer={record} answered={saved.find(s => s.id === item.id) ?? null} onCode={() => setCode(e.id)} />
        {!D.serve && saved.some(s => s.label) && <Download rows={saved.filter(s => s.label).map(s => s.label)} />}
      </div>
      {code && <CodeViewer id={code} onClose={() => setCode(null)} />}
    </ElCtx.Provider>
  )
}

function Item({ item, e, labeler, onAnswer, answered, onCode }: { item: any; e: any; labeler: string; onAnswer: (row: any) => void; answered: any; onCode: () => void }) {
  const pick = item.pick
  const drawn = pick?.verdict === "replace" ? proposalFor(pick, e) : null
  const proposal = drawn?.url ? drawn : null
  const [verdict, setVerdict] = React.useState<Verdict | null>(null)
  const [note, setNote] = React.useState("")
  const [choice, setChoice] = React.useState<any>(null)
  // In a designer's words: no scores or property counts on the face (they sit in Technical details), and the
  // differences said as what you'd see.
  const reasons = ((e.reasons ?? []).map((r: any) => r.plain).filter(Boolean) as string[])
    .map(t => t.replace(/\s*\((?:its |the )?(?:handler|onClick|prop|props|code)\b[^)]*\)/i, ""))
    .filter(t => !/\d+\s*%|\d+ of \d+ propert|\bmeasures\b/i.test(t))
    .map(reasonToJudge).filter(Boolean)
  const differs = plainDifferences(e)
  const alts = (e.alternatives ?? []).filter((a: any) => a?.use && a.use !== pick?.use).slice(0, 3)
  // With no proposal, these stand in its place, each drawn with the element's own content.
  const candidates = pick?.verdict === "replace" ? [] : alts.filter((a: any) => ownWords(renderOf(a.use, a.props, e), e))
  const unclear = pick?.verdict !== "replace" && pick?.verdict !== "gap" && pick?.verdict !== "keep"

  const label = (truth: any) => ({
    id: e.id, ...item.label, truth: truth.verdict === "replace" ? { verdict: "replace", use: truth.use, props: Object.fromEntries(Object.entries(truth.props ?? {}).map(([k, v]) => [k, String(v)])) } : { verdict: truth.verdict },
    acceptableAlts: [], labeler, method: "human", at: new Date().toISOString(), ...(note.trim() ? { notes: note.trim() } : {}),
  })
  const save = () => {
    if (!labeler) { say("Add your name first, so the answer says who gave it.", true); return }
    if (verdict === "right") onAnswer({ id: e.id, verdict, label: label(pick) })
    else if (verdict === "wrong" && choice) onAnswer({ id: e.id, verdict, label: label(choice) })
    else if (verdict === "unsure") onAnswer({ id: e.id, verdict, note, label: null })
  }

  return (
    <article className="flex flex-col gap-5 rounded-lg border p-4" aria-labelledby={`h-${e.id}`} data-slot="review-item" data-element-id={e.id}>
      <header className="flex flex-col gap-1">
        <h3 id={`h-${e.id}`} className="font-heading text-base font-semibold">{e.title ?? "This element"} → {proposalHeading(pick)}</h3>
        <p className="text-sm">{describe(e)}</p>
        {answered && <p className="text-xs text-muted-foreground">You answered: {answered.verdict === "right" ? "Right" : answered.verdict === "wrong" ? `Wrong, should be ${pickText(answered.label.truth)}` : "Not sure"}. Answer again to change it.</p>}
      </header>

      <section aria-label="The element and the proposal, at their real size" className="flex flex-wrap items-start gap-6" data-slot="same-scale">
        <figure className="m-0 flex max-w-full min-w-0 flex-col gap-1" data-pane="app">
          <div className="w-fit max-w-full rounded-md border bg-background p-1"><Crop url={e.shot.url} box={e.shot.box} alt={`The element now: ${describe(e)}`} /></div>
          <figcaption className="text-xs"><b className="font-medium">Now</b> · {sourceLabel(e.shot)}{e.review?.current === "isolated" ? " (drawn with the props it was recorded with)" : ""} · {e.target}</figcaption>
        </figure>
        {pick?.verdict === "replace" ? (
          <figure className="m-0 flex max-w-full min-w-0 flex-col gap-1" data-pane="proposed">
            <div className="w-fit max-w-full rounded-md border bg-background p-1">{proposal ? <Natural url={proposal.url} alt={`Proposed: ${SYS} ${proposal.partUse ?? pickText(pick)}${ownSays(proposal, e) ? `, ${ownSays(proposal, e)}` : ""}`} /> : <span className="text-xs">{pickText(pick)}: nothing to draw</span>}</div>
            <figcaption className="text-xs"><b className="font-medium">Proposed</b> · {SYS} {proposal?.partUse ? <>{proposal.partUse}, the part of {pick.use} this element would be</> : <PickName r={pick} />}{ownSays(proposal, e) ? ` · ${ownSays(proposal, e)}` : ""}</figcaption>
          </figure>
        ) : (
          <div className="flex max-w-full min-w-0 flex-col gap-1" data-pane="proposed">
            <p className="text-sm">{pick?.verdict === "gap" ? `${SYS} has no such component.` : pick?.verdict === "keep" ? "dsa suggests keeping it as it is." : `dsa isn't sure which ${SYS} component this is. ${candidates.length === 1 ? "Here is the closest one" : "Here are the closest ones"}${candidates.some((a: any) => ownSays(renderOf(a.use, a.props, e), e) === "with its own words") ? ", with its own words" : ""}.`}</p>
            <div className="flex flex-wrap gap-4">{candidates.map((a: any, k: number) => { const r = renderOf(a.use, a.props, e); return (
              <figure key={k} className="m-0 flex max-w-full min-w-0 flex-col gap-1" data-slot="candidate"><div className="w-fit max-w-full rounded-md border bg-background p-1"><Natural url={r.url} alt={`${pick?.verdict === "gap" ? "Suggested stand-in" : "Candidate"}: ${SYS} ${pickText(a)}, with its own words`} /></div><figcaption className="text-xs"><b className="font-medium">{pick?.verdict === "gap" ? "Suggested stand-in" : "Candidate"}</b> · {SYS} <PickName r={a} /></figcaption></figure>
            ) })}</div>
          </div>
        )}
        <InContext url={e.shot.context?.url ?? e.shot.url} box={e.shot.context?.box ?? e.shot.box} alt={`Where it sits on ${e.review?.pageName}`} page={e.review?.pageName ?? "its page"} />
      </section>

      <section aria-labelledby={`why-${e.id}`} className="flex flex-col gap-1">
        <h4 id={`why-${e.id}`} className="text-sm font-medium">Why dsa thinks so</h4>
        {reasons.length ? <ul className="list-disc pl-5 text-sm">{reasons.map((r, k) => <li key={k}>{r}</li>)}</ul> : <p className="text-sm text-muted-foreground">dsa gave no reason in plain words for this one.</p>}
        {differs.length > 0 && <p className="text-sm" data-slot="differences"><span className="text-muted-foreground">How it differs from the proposal: </span>{differs.join("; ")}.</p>}
      </section>

      {pick?.use && <section aria-labelledby={`ex-${e.id}`} className="flex flex-col gap-2" data-slot="examples">
        <h4 id={`ex-${e.id}`} className="text-sm font-medium">Where the app already uses {pickText(pick)}</h4>
        {item.examples.length ? (
          <div className="flex flex-wrap gap-4">{item.examples.map((x: any, k: number) => <Example key={k} x={x} pick={pick} />)}</div>
        ) : item.usesCount ? (
          <p className="text-sm text-muted-foreground" data-slot="no-photos">The app uses {pickText(pick)} in {item.usesCount === 1 ? "one place" : `${item.usesCount} places`}, but dsa has no photo of {item.usesCount === 1 ? "it" : "them"} yet.</p>
        ) : item.nearest ? (
          <div className="flex flex-col gap-2" data-slot="nearest">
            <p className="text-sm">{item.nearest.label}</p>
            {item.nearest.examples.length > 0 && <div className="flex flex-wrap gap-4">{item.nearest.examples.map((x: any, k: number) => <Example key={k} x={x} pick={{ use: x.component, props: x.props }} />)}</div>}
          </div>
        ) : item.searched?.whole ? (
          <p className="text-sm text-muted-foreground">The app doesn't use {pick.use} anywhere: dsa read its {item.searched.files} component files.</p>
        ) : (
          <p className="text-sm text-muted-foreground">{item.searched ? `dsa could only read ${item.searched.files - item.searched.unread} of the app's ${item.searched.files} component files` : "dsa didn't search the app's code for this"}, so it can't say whether the app uses {pick.use}.</p>
        )}
        {item.systemExample && (
          <figure className="m-0 flex max-w-full min-w-0 flex-col gap-1" data-slot="system-example">
            <div className="w-fit max-w-full rounded-md border bg-background p-1"><Natural url={item.systemExample.url} alt={`${SYS} ${pickText(pick)}, the system's own example`} /></div>
            <figcaption className="text-xs">The system's own example of {pickText(pick)}</figcaption>
          </figure>
        )}
        {item.examples.length > 0 && item.usesCount > item.examples.length && <p className="text-xs text-muted-foreground">{item.usesCount} places in all.</p>}
        {item.altExamples.length > 0 && alts[0] && (
          <div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">And where it uses the main alternative, {pickText(alts[0])}:</span>
            <div className="flex flex-wrap gap-4">{item.altExamples.map((x: any, k: number) => <Example key={k} x={x} pick={alts[0]} />)}</div></div>
        )}
      </section>}

      {pick?.verdict === "replace" && alts.length > 0 && (
        <section aria-labelledby={`alt-${e.id}`} className="flex flex-col gap-2" data-slot="alternatives">
          <h4 id={`alt-${e.id}`} className="text-sm font-medium">What else dsa considered</h4>
          <div className="flex flex-wrap gap-4">{alts.map((a: any, k: number) => { const r = renderOf(a.use, a.props, e); return (
            <figure key={k} className="m-0 flex max-w-full min-w-0 flex-col gap-1"><div className="w-fit max-w-full rounded-md border bg-background p-1">{r ? <Natural url={r.url} alt={`${SYS} ${pickText(a)}`} /> : <span className="text-xs">Not drawn</span>}</div><figcaption className="text-xs"><PickName r={a} /></figcaption></figure>
          ) })}</div>
        </section>
      )}

      <section aria-labelledby={`v-${e.id}`} className="flex flex-col gap-3" data-slot="verdict">
        <h4 id={`v-${e.id}`} className="text-sm font-medium">{unclear ? "Which is the right answer?" : pick?.verdict === "gap" ? `Is it right that nothing in ${SYS} fits?` : `Is ${pickText(pick)} the right answer?`}</h4>
        <div role="radiogroup" aria-labelledby={`v-${e.id}`} className="flex flex-wrap gap-2">
          {(unclear ? ["wrong", "unsure"] : ["right", "wrong", "unsure"] as Verdict[]).map((v: any) => (
            <Button key={v} role="radio" aria-checked={verdict === v} variant={verdict === v ? "default" : "outline"} onClick={() => setVerdict(v)}>
              {v === "right" ? "Right" : v === "wrong" ? (unclear ? "Choose" : "Wrong") : "Not sure"}{verdict === v ? " (chosen)" : ""}
            </Button>
          ))}
        </div>
        {verdict === "wrong" && <Choose e={e} pick={pick} alts={alts} value={choice} onChange={setChoice} />}
        <label className="flex flex-col gap-1 text-sm">
          <span>{verdict === "unsure" ? "What would help you decide? (optional)" : "Comment (optional)"}</span>
          <Textarea value={note} onChange={ev => setNote(ev.target.value)} rows={2} />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={!verdict || (verdict === "wrong" && !choice)}>Save answer</Button>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground underline-offset-4 hover:underline">Technical details (for engineers)</summary>
            <div className="mt-2 flex flex-col gap-2">
              <Button variant="outline" size="sm" className="self-start" onClick={onCode}>Open the code at {short(e.file)}:{e.line}</Button>
              <ul className="list-disc pl-5 text-xs text-muted-foreground">{(e.reasons ?? []).map((r: any, k: number) => <li key={k}>{r.text}</li>)}</ul>
              <p className="text-xs text-muted-foreground">The scanner's score: {Math.round((e.evidenceCap?.from ?? e.confidence) * 100)}% (not a checked track record).</p>
              {(deltaOf(e)?.changes.length ?? 0) > 0 && <ul className="list-disc pl-5 text-xs text-muted-foreground" data-slot="raw-differences">{deltaOf(e)!.changes.map((c, k) => <li key={k}>{c.label}: {c.from} (element), {c.to} (proposal)</li>)}</ul>}
              {e.signature && <p className="text-xs text-muted-foreground">Measured: {[...(e.signature.matched ?? []), ...(e.signature.mismatched ?? [])].join(", ")}</p>}
            </div>
          </details>
        </div>
      </section>
    </article>
  )
}

/** A place the app already uses the component with these props: its photo, and where. */
function Example({ x, pick }: { x: any; pick: any }) {
  return (
    <figure className="m-0 flex max-w-full min-w-0 flex-col gap-1" data-slot="example">
      <div className="w-fit max-w-full rounded-md border bg-background p-1"><Crop url={x.shot.url} box={x.shot.box} alt={`${SYS} ${pickText(pick)} on ${x.shot.pageName}`} /></div>
      <figcaption className="text-xs">On {x.shot.pageName}</figcaption>
    </figure>
  )
}

/** The right answer, from the system's allowed values only (its components and their props), drawn when a render exists. */
function Choose({ e, pick, alts, value, onChange }: { e: any; pick: any; alts: any[]; value: any; onChange: (v: any) => void }) {
  const system: any[] = D.elements.review?.system ?? []
  const first = [...new Set([pick?.use, ...alts.map(a => a.use)].filter(Boolean))]
  const names = [...first, ...system.map(c => c.component).filter(n => !first.includes(n)).sort()]
  const [use, setUse] = React.useState<string>(value?.use ?? pick?.use ?? alts[0]?.use ?? names[0] ?? "")
  const comp = system.find(c => c.component === use)
  // Start from what dsa proposed, so the reviewer changes only what's wrong.
  const [props, setProps] = React.useState<Record<string, string>>(() => ({ ...(comp?.defaults ?? {}), ...(use === pick?.use ? Object.fromEntries(Object.entries(pick?.props ?? {}).map(([k, v]) => [k, String(v)])) : {}) }))
  const kind = value?.verdict ?? "replace"
  React.useEffect(() => { onChange(kind === "replace" ? { verdict: "replace", use, props } : value) }, [use, props]) // eslint-disable-line react-hooks/exhaustive-deps
  const r = kind === "replace" ? renderOf(use, Object.fromEntries(Object.entries(props).filter(([k, v]) => comp?.defaults?.[k] !== v)), e) ?? renderOf(use, props, e) : null
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">The right answer</legend>
      <div role="radiogroup" aria-label="Kind of answer" className="flex flex-wrap gap-2">
        {[["replace", `A ${SYS} component`], ["keep", "Keep it as it is"], ["gap", `Nothing in ${SYS} fits`]].map(([k, t]) => (
          <Button key={k} size="sm" role="radio" aria-checked={kind === k} variant={kind === k ? "secondary" : "outline"} onClick={() => onChange(k === "replace" ? { verdict: "replace", use, props } : { verdict: k })}>{t}</Button>
        ))}
      </div>
      {kind === "replace" && <>
        <label className="flex flex-col gap-1 text-sm"><span>Component</span>
          <NativeSelect className="bg-background text-foreground" value={use} onChange={ev => { const c = system.find(x => x.component === ev.target.value); setUse(ev.target.value); setProps({ ...(c?.defaults ?? {}) }) }}>
            {names.map(n => <NativeSelectOption key={n} value={n}>{n}</NativeSelectOption>)}
          </NativeSelect>
        </label>
        {Object.entries<string[]>(comp?.axes ?? {}).map(([axis, values]) => (
          <fieldset key={axis} className="flex flex-col gap-1"><legend className="text-sm">{axis}</legend>
            <div role="radiogroup" aria-label={axis} className="flex flex-wrap gap-1">
              {values.map(v => <Button key={v} size="xs" role="radio" aria-checked={props[axis] === v} variant={props[axis] === v ? "secondary" : "outline"} onClick={() => setProps(p => ({ ...p, [axis]: v }))}>{v}{props[axis] === v ? " (chosen)" : ""}</Button>)}
            </div>
          </fieldset>
        ))}
        <figure className="m-0 flex max-w-full min-w-0 flex-col gap-1"><div className="w-fit max-w-full rounded-md border bg-background p-1">{r ? <Natural url={r.url} alt={`${SYS} ${use}`} /> : <span className="text-xs">Not drawn with these props yet</span>}</div><figcaption className="text-xs"><PickName r={{ verdict: "replace", use, props }} /></figcaption></figure>
      </>}
    </fieldset>
  )
}

function Download({ rows }: { rows: any[] }) {
  const href = React.useMemo(() => URL.createObjectURL(new Blob([rows.map(r => JSON.stringify(r)).join("\n") + "\n"], { type: "application/x-ndjson" })), [rows])
  return <Button variant="outline" className="self-start" nativeButton={false} render={<a href={href} download="labels.jsonl" />}>Download {rows.length} label{rows.length === 1 ? "" : "s"} (labels.jsonl)</Button>
}

export const reviewCount = () => (D.elements?.review?.items?.length ?? 0)
