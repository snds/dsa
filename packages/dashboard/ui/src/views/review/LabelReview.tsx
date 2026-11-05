import * as React from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Note } from "@/components/bits"
import { D, api, say, short, SYS } from "@/lib/dsa"
import { relayWho } from "@/lib/useScan"
import { ElCtx, pickText, sourceLabel } from "@/views/elements/shared"
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

/** The render stored for a component and props, if one was drawn (proposalKey's format). */
function renderOf(use: string, props: Record<string, any> | undefined, ownHash?: string | null): any | null {
  const P = D.elements.proposals ?? {}
  const p = Object.entries(props ?? {}).filter(([k, v]) => k !== "render" && k !== "asChild" && v != null).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(";")
  const key = p ? `${use}|${p}` : use
  const hit = (ownHash && P[`${key}#${ownHash}`]) || P[key]
  return hit?.url ? hit : null
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
          {item.why === "disagree" ? "dsa and an earlier answer disagree here." : "Picked at random from the ones dsa calls ready, to check them."}
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
  const proposal = pick?.verdict === "replace" ? renderOf(pick.use, pick.props, e.ownHash) : null
  const [verdict, setVerdict] = React.useState<Verdict | null>(null)
  const [note, setNote] = React.useState("")
  const [choice, setChoice] = React.useState<any>(null)
  const reasons = (e.reasons ?? []).map((r: any) => r.plain).filter(Boolean) as string[]
  const alts = (e.alternatives ?? []).filter((a: any) => a?.use && a.use !== pick?.use).slice(0, 3)

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
        <h3 id={`h-${e.id}`} className="font-heading text-base font-semibold">{e.title ?? "This element"} → {SYS} {pickText(pick)}</h3>
        <p className="text-sm">{describe(e)}</p>
        {answered && <p className="text-xs text-muted-foreground">You answered: {answered.verdict === "right" ? "Right" : answered.verdict === "wrong" ? `Wrong, should be ${pickText(answered.label.truth)}` : "Not sure"}. Answer again to change it.</p>}
      </header>

      <section aria-label="The element and the proposal, at their real size" className="flex flex-wrap items-start gap-6" data-slot="same-scale">
        <figure className="m-0 flex flex-col gap-1" data-pane="app">
          <div className="w-fit rounded-md border bg-background p-1"><Crop url={e.shot.url} box={e.shot.box} alt={`The element now: ${describe(e)}`} /></div>
          <figcaption className="text-xs"><b className="font-medium">Now</b> · {sourceLabel(e.shot)}{e.review?.current === "isolated" ? " (drawn with the props it was recorded with)" : ""} · {e.target}</figcaption>
        </figure>
        <figure className="m-0 flex flex-col gap-1" data-pane="proposed">
          <div className="w-fit rounded-md border bg-background p-1">{proposal ? <Natural url={proposal.url} alt={`Proposed: ${SYS} ${pickText(pick)}, with its own words`} /> : <span className="text-xs">{pickText(pick)}: nothing to draw</span>}</div>
          <figcaption className="text-xs"><b className="font-medium">Proposed</b> · {SYS} {pickText(pick)}{proposal?.own ? " · with its own words" : ""}</figcaption>
        </figure>
        <InContext url={e.shot.url} box={e.shot.box} alt={`Where it sits on ${e.review?.pageName}`} page={e.review?.pageName ?? "its page"} />
      </section>

      <section aria-labelledby={`why-${e.id}`} className="flex flex-col gap-1">
        <h4 id={`why-${e.id}`} className="text-sm font-medium">Why dsa thinks so</h4>
        {reasons.length ? <ul className="list-disc pl-5 text-sm">{reasons.map((r, k) => <li key={k}>{r}</li>)}</ul> : <p className="text-sm text-muted-foreground">dsa gave no reason in plain words for this one.</p>}
        <p className="text-xs text-muted-foreground">dsa is {Math.round((e.evidenceCap?.from ?? e.confidence) * 100)}% sure.</p>
      </section>

      <section aria-labelledby={`ex-${e.id}`} className="flex flex-col gap-2" data-slot="examples">
        <h4 id={`ex-${e.id}`} className="text-sm font-medium">Where the app already uses {pickText(pick)}</h4>
        {item.examples.length ? (
          <div className="flex flex-wrap gap-4">{item.examples.map((x: any, k: number) => <Example key={k} x={x} pick={pick} />)}</div>
        ) : <p className="text-sm text-muted-foreground">The app doesn't use {pickText(pick)} anywhere yet.</p>}
        {item.usesCount > item.examples.length && <p className="text-xs text-muted-foreground">{item.usesCount} places in all.</p>}
        {item.altExamples.length > 0 && alts[0] && (
          <div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">And where it uses the main alternative, {pickText(alts[0])}:</span>
            <div className="flex flex-wrap gap-4">{item.altExamples.map((x: any, k: number) => <Example key={k} x={x} pick={alts[0]} />)}</div></div>
        )}
      </section>

      {alts.length > 0 && (
        <section aria-labelledby={`alt-${e.id}`} className="flex flex-col gap-2" data-slot="alternatives">
          <h4 id={`alt-${e.id}`} className="text-sm font-medium">What else dsa considered</h4>
          <div className="flex flex-wrap gap-4">{alts.map((a: any, k: number) => { const r = renderOf(a.use, a.props, e.ownHash); return (
            <figure key={k} className="m-0 flex flex-col gap-1"><div className="w-fit rounded-md border bg-background p-1">{r ? <Natural url={r.url} alt={`${SYS} ${pickText(a)}`} /> : <span className="text-xs">Not drawn</span>}</div><figcaption className="text-xs">{pickText(a)}</figcaption></figure>
          ) })}</div>
        </section>
      )}

      <section aria-labelledby={`v-${e.id}`} className="flex flex-col gap-3" data-slot="verdict">
        <h4 id={`v-${e.id}`} className="text-sm font-medium">Is {pickText(pick)} the right answer?</h4>
        <div role="radiogroup" aria-labelledby={`v-${e.id}`} className="flex flex-wrap gap-2">
          {(["right", "wrong", "unsure"] as Verdict[]).map(v => (
            <Button key={v} role="radio" aria-checked={verdict === v} variant={verdict === v ? "default" : "outline"} onClick={() => setVerdict(v)}>
              {v === "right" ? "Right" : v === "wrong" ? "Wrong" : "Not sure"}{verdict === v ? " (chosen)" : ""}
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
              {e.signature && <p className="text-xs text-muted-foreground">Measured: {[...(e.signature.matched ?? []), ...(e.signature.mismatched ?? [])].join(", ")}</p>}
            </div>
          </details>
        </div>
      </section>
    </article>
  )
}

/** A place the app already uses the component with these props: its photo when there is one, else the render, and where. */
function Example({ x, pick }: { x: any; pick: any }) {
  const r = renderOf(pick.use, pick.props)
  return (
    <figure className="m-0 flex flex-col gap-1" data-slot="example">
      <div className="w-fit rounded-md border bg-background p-1">
        {x.shot ? <Crop url={x.shot.url} box={x.shot.box} alt={`${SYS} ${pickText(pick)} on ${x.shot.pageName}`} />
          : r ? <Natural url={r.url} alt={`${SYS} ${pickText(pick)}`} /> : <span className="text-xs">No picture yet</span>}
      </div>
      <figcaption className="text-xs">{x.shot ? `On ${x.shot.pageName}` : `In ${x.app}, no photo yet (the system's drawing)`}</figcaption>
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
  const r = kind === "replace" ? renderOf(use, Object.fromEntries(Object.entries(props).filter(([k, v]) => comp?.defaults?.[k] !== v)), e.ownHash) ?? renderOf(use, props, e.ownHash) : null
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
        <figure className="m-0 flex flex-col gap-1"><div className="w-fit rounded-md border bg-background p-1">{r ? <Natural url={r.url} alt={`${SYS} ${use}`} /> : <span className="text-xs">Not drawn with these props yet</span>}</div><figcaption className="text-xs">{pickText({ verdict: "replace", use, props })}</figcaption></figure>
      </>}
    </fieldset>
  )
}

function Download({ rows }: { rows: any[] }) {
  const href = React.useMemo(() => URL.createObjectURL(new Blob([rows.map(r => JSON.stringify(r)).join("\n") + "\n"], { type: "application/x-ndjson" })), [rows])
  return <Button variant="outline" className="self-start" nativeButton={false} render={<a href={href} download="labels.jsonl" />}>Download {rows.length} label{rows.length === 1 ? "" : "s"} (labels.jsonl)</Button>
}

export const reviewCount = () => (D.elements?.review?.items?.length ?? 0)
