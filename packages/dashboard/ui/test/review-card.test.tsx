// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// A review card shows its evidence plainly: each photo labelled (in the app, which app, file:line that
// opens the code, match), the proposal labelled with its component and props, both drawn at one CSS
// scale, reasons in plain words, and the zoom view proposing what the card proposes. Each check here
// backs a claim in trust.ts's CARD, which the trust rubric scores against.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let m: { Elements: any; app: typeof import("@/lib/app"); CARD: Record<string, boolean> }

const box = { x: 20, y: 30, w: 100, h: 36, cw: 240, ch: 120 }
const ghost = { verdict: "replace", role: "button", use: "Button", props: { variant: "ghost" } }
const el = (id: string, target: string, file: string, o: object = {}) => ({
  id, target, file, line: 4, element: "button", verdict: "replace", role: "button", use: "Button", props: { variant: "ghost" }, confidence: 0.6, needsHuman: true,
  decided: null, exception: null, alternatives: [], a11y: [], snippet: "<button>Filter</button>", family: "button", title: "Ghost buttons", home: "Button", regions: null, label: "Filter",
  signature: null, span: 1, styleSig: `look-${id}`, rendered: null, systemPreview: null,
  shot: { url: `shots/${id}.png`, match: 1, page: "/", box, revealedBy: "opening “Filters”" },
  reasons: [{ text: "aria-pressed: a latch.", plain: "It works as a latch.", delta: -0.1 }],
  how: "An icon-only Button: an accessible name.", howRaw: "An icon-only Button: an aria-label.",
  ...o,
})

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({
    serve: false, label: "Acme",
    targets: [{ name: "atlas", role: "consumer" }, { name: "ledger", role: "consumer" }],
    elements: {
      threshold: 0.9, patterns: [], shotsTaken: "2026-10-06T12:00:00Z", rendered: null,
      evals: [
        el("b1", "ledger", "ledger/src/Toolbar.tsx"),
        el("b2", "atlas", "atlas/src/Bar.tsx"),
        el("t1", "ledger", "ledger/src/Filters.tsx", { use: "Toggle", props: {}, title: "Filter toggles", home: "Toggle", rendered: { key: "outline/default", systemShot: "rendered/closest.png" } }),
      ],
      questions: [
        { key: "q1", kind: "group", title: "Ghost buttons", ask: "Replace with Button (variant ghost)?", home: "Button", ids: ["b1", "b2"], options: [{ label: "Button · variant ghost", decision: ghost }], auto: ghost, fit: null, parts: null, context: null, note: null },
        { key: "q2", kind: "group", title: "Filter toggles", ask: "Replace with Toggle?", home: "Toggle", ids: ["t1"], options: [{ label: "Toggle", decision: { verdict: "replace", role: "button", use: "Toggle", props: {} } }], auto: { verdict: "replace", role: "button", use: "Toggle", props: {} }, fit: null, parts: null, context: null, note: null },
      ],
      proposals: {
        "Button|variant=ghost": { use: "Button", props: { variant: "ghost" }, check: "exact", url: "rendered/ghost.png", content: null },
        Toggle: { use: "Toggle", props: {}, check: "none", url: null, note: "No Toggle story." },
      },
      sources: {},
    },
  })
  document.head.append(data)
  m = { Elements: (await import("@/views/elements/Elements")).Elements, app: await import("@/lib/app"), CARD: (await import("../../src/trust")).CARD as any }
})

beforeEach(() => m.app.setApp(null))
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  document.body.innerHTML = ""
})

async function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<m.Elements />))
  return host
}
const card = (title: string) => [...document.querySelectorAll('[data-slot="card"]')].find(c => c.querySelector("h3")?.textContent === title)!
const click = (el: Element) => act(async () => { (el as HTMLElement).click() })
const button = (scope: ParentNode, text: RegExp) => [...scope.querySelectorAll("button")].find(b => text.test(b.textContent ?? ""))!

test("each photo is labelled: in the app, which app, file:line, match", async () => {
  await mount()
  const panes = [...card("Ghost buttons").querySelectorAll('[data-pane="app"]')].map(p => p.textContent)
  expect(panes).toEqual(["In the appledgersrc/Toolbar.tsx:4match 100%", "In the appatlassrc/Bar.tsx:4match 100%"])
  expect(m.CARD.photoLabels).toBe(true)
})

test("the proposal is labelled with its component and props", async () => {
  await mount()
  const p = card("Ghost buttons").querySelector('[data-pane="proposed"]')!
  expect(p.textContent).toContain("Proposed")
  expect(p.textContent).toContain("Buttonvariant ghost")
  expect(p.querySelector("img")!.getAttribute("src")).toBe("rendered/ghost.png")
  expect(m.CARD.proposalLabels).toBe(true)
})

test("photo and proposal are drawn at one scale: real CSS size, the photo cropped to the element", async () => {
  await mount()
  const s = card("Ghost buttons").querySelector('[data-slot="same-scale"]')!
  const crop = s.querySelector<HTMLElement>('[data-pane="app"] [data-scale="1"]')!
  // The element (100×36) and 6px around it; the screenshot under it at its CSS size, not shrunk to fit.
  expect([crop.style.width, crop.style.height]).toEqual(["112px", "48px"])
  const img = crop.querySelector("img")!
  expect([img.style.width, img.style.left, img.style.top]).toEqual(["240px", "-14px", "-24px"])
  // The proposal: its pixels over the capture's 2x, once loaded.
  const p = s.querySelector<HTMLImageElement>('[data-pane="proposed"] img')!
  Object.defineProperty(p, "naturalWidth", { value: 180 })
  await act(async () => { p.dispatchEvent(new Event("load")) })
  expect(p.style.width).toBe("90px")
  expect(m.CARD.sameScale).toBe(true)
})

test("the place opens the code", async () => {
  await mount()
  await click(button(card("Ghost buttons").querySelector('[data-pane="app"]')!, /Toolbar\.tsx:4/))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Toolbar.tsx")
  expect(m.CARD.placeOpens).toBe(true)
})

test("reasons are plain on the face; the scanner's words are under Technical details", async () => {
  await mount()
  const c = card("Ghost buttons")
  expect(c.textContent).not.toContain("aria-")
  await click(button(c, /^Details/))
  expect(c.textContent).toContain("It works as a latch.")
  expect(c.textContent).not.toContain("aria-pressed")
  await click(button(c, /^Technical details/))
  expect(c.textContent).toContain("aria-pressed: a latch.")
  expect(c.textContent).toContain("An icon-only Button: an aria-label.")
  expect(m.CARD.plainReasons).toBe(true)
})

test("no exact render: the closest variant stands in, said as such, with why", async () => {
  await mount()
  const p = card("Filter toggles").querySelector('[data-pane="proposed"]')!
  expect(p.textContent).toContain("Closest variant")
  expect(p.textContent).toContain("The exact props aren't rendered yet")
  expect(p.querySelector("img")!.getAttribute("src")).toBe("rendered/closest.png")
  expect(m.CARD.fallback).toBe(true)
})

test("the zoom view says how the element was revealed once, and proposes what the card proposes", async () => {
  await mount()
  await click(card("Ghost buttons").querySelector('[data-pane="app"] button')!)
  const d = document.querySelector('[role="dialog"]')!
  expect(d.textContent).toContain("In the app · ledger · match 100% · after opening “Filters”")
  expect(d.textContent).not.toContain("opening “opening")
  expect(d.textContent).toContain("Proposed · Acme Button · variant ghost")
  expect([...d.querySelectorAll("img")].map(i => i.getAttribute("src"))).toEqual(["shots/b1.png", "rendered/ghost.png"])
})

test("one app chosen: its evidence only, and the answer says what else it covers", async () => {
  m.app.setApp("ledger")
  await mount()
  const c = card("Ghost buttons")
  expect([...c.querySelectorAll('[data-pane="app"]')].map(p => p.textContent)).toEqual(["In the appledgersrc/Toolbar.tsx:4match 100%"])
  expect(c.textContent).toContain("That includes 1 in atlas, not shown here.")
  // A question is the app's when any of its elements is, not only its first.
  m.app.setApp("atlas")
  await act(async () => root.render(<m.Elements key="atlas" />))
  expect(card("Ghost buttons")).toBeTruthy()
  expect(card("Ghost buttons").textContent).toContain("That includes 1 in ledger, not shown here.")
})
