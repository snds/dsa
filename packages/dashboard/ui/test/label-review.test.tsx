// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import axe from "axe-core"
import { CODE_TERMS } from "@snds/dsa/engine"

// Label Review is for people, a designer first: one element at a time, the element and the proposal at
// their real size side by side, where it sits, why in plain words, where the app already uses the
// proposal, and one click to answer. Nothing near-empty is ever asked.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
// Node's own localStorage (unconfigured) shadows the browser's here: a plain one in memory.
const mem = new Map<string, string>()
Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear() } })
let root: Root
let m: { LabelReview: any; Elements: any }
let payload: any

const box = { x: 20, y: 30, w: 64, h: 32, cw: 240, ch: 120 }
const shot = (id: string, o: object = {}) => ({ url: `shots/${id}.png`, match: 1, tagged: true, page: "http://127.0.0.1:5173/#/orders/table", box, ...o })
const el = (id: string, o: object = {}) => ({
  id, target: "ledger", file: `ledger/src/${id}.tsx`, line: 4, element: "button", role: "button", verdict: "replace", use: "Button", props: { variant: "outline" },
  confidence: 0.95, needsHuman: false, decided: null, exception: null, label: "Export", ownHash: "own1", title: "Outlined buttons", home: "Button", family: "button",
  alternatives: [{ verdict: "replace", use: "Toggle", props: {} }], a11y: [], snippet: '<button className="btn btn-outline px-2">Export</button>', styleSig: "s1", span: 1,
  reasons: [{ text: "Classes px-2 and --radius-md match Button outline.", plain: "It has a border and no fill, like the outlined button.", delta: 0 }, { text: "aria-pressed: no.", plain: null, delta: 0 }],
  shot: shot(id), rendered: null, systemPreview: null, ...o,
})

beforeAll(async () => {
  const { withReview } = await import("../../src/review")
  payload = withReview({
    serve: false, label: "Acme", targets: [{ name: "ledger", role: "consumer" }],
    elements: {
      threshold: 0.9, patterns: [], questions: [], shotsTaken: null, rendered: null, sources: {},
      evals: [
        el("ok", { shot: shot("ok", { context: { url: "shots/ok.ctx.png", box: { x: 368, y: 234, w: 64, h: 32, cw: 800, ch: 500 } } }) }),
        el("guess", { shot: shot("guess", { drawn: "mount", exact: true }) }),
        el("bare", { shot: null, shotMissing: true }),
      ],
      proposals: {
        "Button|variant=outline#own1": { use: "Button", props: { variant: "outline" }, check: "exact", url: "rendered/own.png", own: true, text: "Export" },
        Toggle: { use: "Toggle", props: {}, check: "exact", url: "rendered/toggle.png" },
      },
    },
  }, {
    audit: 1,
    system: [{ component: "Button", axes: { variant: ["default", "outline", "ghost"], size: ["default", "sm"] }, defaults: { variant: "default", size: "default" } }, { component: "Toggle", axes: {}, defaults: {} }],
    precedents: [{ app: "ledger", file: "ledger/src/Bar.tsx", line: 9, component: "Button", props: { variant: "outline" }, shot: { url: "shots/use.png", box, pageName: "Orders › Table" } }],
  })
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify(payload)
  document.head.append(data)
  m = { LabelReview: (await import("@/views/review/LabelReview")).LabelReview, Elements: (await import("@/views/elements/Elements")).Elements }
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  document.body.innerHTML = ""
})

async function mount(node: React.ReactNode) {
  const host = document.createElement("main")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(node))
  return host
}
/** What a reader sees without opening Technical details. */
const face = (el: Element) => { const c = el.cloneNode(true) as Element; c.querySelectorAll("details").forEach(d => d.remove()); return c.textContent ?? "" }

test("only reviewable elements are queued: a guessed drawing and an element with no photo are not", () => {
  expect(payload.elements.review.items.map((x: any) => x.id)).toEqual(["ok"])
  expect(payload.elements.review.setAside).toBe(2)
})

test("one item: no code on its face; both images at real size; where it sits; an example; plain reasons", async () => {
  const host = await mount(<m.LabelReview />)
  const item = host.querySelector('[data-slot="review-item"]')!
  expect(item.getAttribute("data-element-id")).toBe("ok")
  expect(CODE_TERMS.test(face(item)), face(item)).toBe(false)
  expect(face(item)).toContain("It has a border and no fill, like the outlined button.")
  expect(face(item)).toContain("A button labelled “Export”, 64 × 32 px, on Orders › Table.")
  // The element and the proposal, side by side, both drawn at CSS scale 1.
  const pair = item.querySelector('[data-slot="same-scale"]')!
  expect(pair.querySelector('[data-pane="app"] [data-scale="1"] img')?.getAttribute("src")).toBe("shots/ok.png")
  expect(pair.querySelector('[data-pane="proposed"] img[data-scale="1"]')?.getAttribute("src")).toBe("rendered/own.png")
  expect(item.querySelector('[data-slot="in-context"]')?.textContent).toContain("In context, on Orders › Table")
  // The crawler's wider crop of the page, the element ringed where its box says.
  expect(item.querySelector('[data-slot="in-context"] img')?.getAttribute("src")).toBe("shots/ok.ctx.png")
  expect((item.querySelector('[data-slot="in-context"] [data-scale="1"]') as HTMLElement).style.width).toBe("800px")
  const ex = item.querySelectorAll('[data-slot="examples"] [data-slot="example"]')
  expect(ex.length).toBeGreaterThanOrEqual(1)
  expect(ex[0]!.querySelector("img")?.getAttribute("src")).toBe("shots/use.png")
  expect(item.querySelector('[data-slot="alternatives"] img')?.getAttribute("src")).toBe("rendered/toggle.png")
  // The engineer's way in is there, behind the disclosure.
  expect([...item.querySelectorAll("details button")].some(b => /Open the code/.test(b.textContent ?? ""))).toBe(true)
})

test("the verdict is keyboard-operable: Right, Wrong and Not sure are focusable radios; Wrong offers only allowed values", async () => {
  const host = await mount(<m.LabelReview />)
  const radios = [...host.querySelectorAll('[data-slot="verdict"] [role="radiogroup"] > [role="radio"]')] as HTMLElement[]
  expect(radios.map(b => b.textContent)).toEqual(["Right", "Wrong", "Not sure"])
  for (const b of radios) { expect(b.tabIndex).not.toBe(-1); b.focus(); expect(document.activeElement).toBe(b) }
  await act(async () => { radios[1]!.click() })
  expect(radios[1]!.getAttribute("aria-checked")).toBe("true")
  const values = [...host.querySelectorAll('[aria-label="variant"] [role="radio"]')].map(b => b.textContent?.replace(" (chosen)", ""))
  expect(values).toEqual(["default", "outline", "ghost"])
  const options = [...host.querySelectorAll("select option")].map(o => o.textContent)
  expect(options).toEqual(["Button", "Toggle"])
})

test("saving writes a labels.jsonl row with method human, the reviewer and the time", async () => {
  window.localStorage.setItem("dsa.reviewer", JSON.stringify("Pat"))
  const host = await mount(<m.LabelReview />)
  const right = [...host.querySelectorAll('[role="radio"]')].find(b => b.textContent === "Right") as HTMLElement
  await act(async () => { right.click() })
  const save = [...host.querySelectorAll("button")].find(b => b.textContent === "Save answer") as HTMLElement
  await act(async () => { save.click() })
  const saved = JSON.parse(window.localStorage.getItem("dsa.review-labels.v1")!)
  expect(saved[0].label).toMatchObject({ id: "ok", app: "ledger", method: "human", labeler: "Pat", truth: { verdict: "replace", use: "Button", props: { variant: "outline" } } })
  expect(Date.parse(saved[0].label.at)).toBeGreaterThan(0)
  const { LabelSchema } = await import("@snds/dsa")
  expect(LabelSchema.safeParse(saved[0].label).success).toBe(true)
})

test("no accessibility violations axe can find in the review view", async () => {
  const host = await mount(<m.LabelReview />)
  // Contrast needs layout, which happy-dom doesn't do: it is checked in a real browser (see the PR).
  const r = await axe.run(host, { rules: { "color-contrast": { enabled: false } } })
  expect(r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`)).toEqual([])
})

test("on a card, every element has its own tile; one without evidence says so instead of offering a decision", async () => {
  const host = await mount(<m.Elements />)
  const tiles = [...host.querySelectorAll("figure[data-element-id]")].map(f => f.getAttribute("data-element-id"))
  expect(tiles).toContain("ok")
  expect(host.querySelectorAll('[aria-label^="The other"]').length).toBe(0)
  expect(host.textContent).toContain("Needs evidence before review")
  expect(host.textContent).toContain("guessed props")
})

test("in a designer's words: no score on the face, differences said as what you'd see, alternatives named plainly", async () => {
  const host = await mount(<m.LabelReview />)
  // The scanner's score sits behind Technical details, never on the face.
  expect(face(host)).not.toMatch(/\d+%/)
  const L = await import("@/views/review/LabelReview")
  expect(L.plainPick({ verdict: "replace", use: "Button", props: { variant: "link", size: "inline" } })).toBe("a link-style button, inline size")
  expect(L.plainPick({ verdict: "replace", use: "MenuItem", props: { inset: "true" } })).toBe("a menu item, inset")
  expect(L.colourName("rgb(37, 99, 235)")).toBe("blue")
  expect(L.colourName("rgb(115, 115, 115)")).toBe("grey")
  expect(L.plainDifferences({ rendered: { diff: { same: [], score: 0.58, diffs: [
    { label: "height", element: "36px", system: "32px" },
    { label: "text color", element: "rgb(37, 99, 235)", system: "rgb(115, 115, 115)" },
    { label: "font size", element: "12px", system: "14px" },
  ] } } })).toEqual(["4 px taller", "blue text instead of grey", "12 px text instead of 14 px"])
})

test("\"with its own words\" only when the drawing's words are the element's", async () => {
  const S = await import("@/views/elements/shared")
  const e = { label: "Library", shot: { content: { text: "Library" } } }
  expect(S.ownWords({ own: true, text: "Library" }, e)).toBe(true)
  expect(S.ownWords({ own: true, text: "Schemas" }, e)).toBe(false)
  expect(S.ownWords({ own: true }, e), "a drawing that didn't record its words isn't taken on trust").toBe(false)
  expect(S.ownWords({ own: false, text: "Library" }, e)).toBe(false)
})

test("differences are said as what you'd see, never as classes or tokens", async () => {
  const L = await import("@/views/review/LabelReview")
  const sig = (mismatched: string[], o: object = {}) => ({ signature: { score: 0.1, matched: [], mismatched }, ...o })
  const said = L.plainDifferences(sig(["px ✗ 0.75rem vs 0.375rem", "py ✗ 0.375rem vs --density-menu-item-py", "hover:bg ✗ zinc-4 vs unset", "active:bg ✗ zinc-4 vs unset", "radius ✗ unset vs --radius-md"]))
  expect(said).toEqual(["12 px side padding instead of 6 px", "6 px top and bottom padding, where the system uses a density setting", "a different hover colour", "a different pressed colour", "squarer corners"])
  expect(said.join(" ")).not.toMatch(/--|zinc|rem\b|unset|:/)
  // On a dark surface the proposal's white page isn't a difference; on white, it can be.
  const bg = { rendered: { diff: { same: [], score: 0.5, diffs: [{ label: "background", element: "rgb(0, 0, 0)", system: "rgb(255, 255, 255)" }, { label: "height", element: "40", system: "36" }] } } }
  expect(L.plainDifferences({ ...bg, shot: { surface: "rgb(20, 20, 20)" } })).toEqual(["4 px taller"])
  expect(L.plainDifferences({ ...bg, shot: { surface: "rgb(255, 255, 255)" } })).toEqual(["black background instead of white", "4 px taller"])
})

test("building instructions aren't reasons to judge by", async () => {
  const L = await import("@/views/review/LabelReview")
  expect(L.reasonToJudge("It only works inside a menu. Build the right-click menu with ContextMenu: ContextMenuTrigger wraps the target.")).toBe("It only works inside a menu.")
  expect(L.reasonToJudge("Migrate ContextMenu with its parts.")).toBe("")
})

test("a table's height is its rows: not a difference beside the story's sample rows", async () => {
  const L = await import("@/views/review/LabelReview")
  const diff = { rendered: { diff: { same: [], score: 0.5, diffs: [{ label: "height", element: "86", system: "252" }, { label: "radius", element: "0px", system: "8px" }] } } }
  expect(L.plainDifferences({ ...diff, role: "static-table", element: "table" })).toEqual(["squarer corners"])
  expect(L.plainDifferences({ ...diff, role: "button", element: "button", shot: { content: { inner: { marks: 0, blocks: 2, lost: 0 } } } })).toEqual(["squarer corners"])
  expect(L.plainDifferences({ ...diff, role: "button", element: "button" })).toEqual(["166 px shorter", "squarer corners"])
})

test("the header says when the photos and drawings were taken", async () => {
  const { EvidenceTimes } = await import("@/components/bits")
  const host = await mount(<EvidenceTimes photos={new Date().toISOString()} drawings="2026-11-05T19:02:05Z" />)
  const times = [...host.querySelectorAll('[data-slot="evidence-time"]')].map(n => n.textContent)
  expect(times[0]).toMatch(/^ · Photos: \S/)
  expect(times[1]).toMatch(/^ · Drawings: \S/)
})
