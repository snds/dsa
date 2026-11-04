// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// A review card shows its evidence plainly: each photo labelled (in the app, which app, file:line that
// opens the code, match), the proposal labelled with its component and props, both drawn at one CSS
// scale, reasons in plain words, and the zoom view proposing what the card proposes. The trust rubric
// reads these same facts from the rendered card (card-dom.ts), so the last test runs it on this card.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let m: { Elements: any; app: typeof import("@/lib/app"); probe: typeof import("../../src/card-dom"); trust: typeof import("../../src/trust") }
let payload: any

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
  payload = {
    serve: false, label: "Acme",
    targets: [{ name: "atlas", role: "consumer" }, { name: "ledger", role: "consumer" }],
    elements: {
      threshold: 0.9, patterns: [], shotsTaken: "2026-10-06T12:00:00Z", rendered: null,
      evals: [
        el("b1", "ledger", "ledger/src/Toolbar.tsx"),
        el("b2", "atlas", "atlas/src/Bar.tsx"),
        el("t1", "ledger", "ledger/src/Filters.tsx", { use: "Toggle", props: {}, title: "Filter toggles", home: "Toggle", rendered: { key: "outline/default", systemShot: "rendered/closest.png" } }),
        // Photographed but nothing drawn in its box; a row from a list, one of three alike; one drawn with its own label.
        el("k1", "ledger", "ledger/src/Rows.tsx", { title: "Row actions", shot: { url: "shots/k1.png", match: 1, page: "/", box, blank: true } }),
        el("k2", "ledger", "ledger/src/Rows.tsx", { title: "Row actions", styleSig: "look-k2", ownHash: "own123", label: "Open", shot: { url: "shots/k2.png", match: 0.95, page: "/", box, ties: 3, alike: 3 } }),
        el("m1", "ledger", "ledger/src/Menu.tsx", { use: "MenuItem", props: {}, title: "Menu rows", home: "MenuItem", confidence: 0.89, evidenceCap: { from: 0.96, why: ["there is no photo of it in the app", "the proposal (MenuItem) isn't drawn exactly yet"] } }),
      ],
      questions: [
        { key: "q1", kind: "group", title: "Ghost buttons", ask: "Replace with Button (variant ghost)?", home: "Button", ids: ["b1", "b2"], options: [{ label: "Button · variant ghost", decision: ghost }], auto: ghost, fit: null, parts: null, context: null, note: null },
        { key: "q3", kind: "group", title: "Row actions", ask: "Replace with Button (variant ghost)?", home: "Button", ids: ["k1", "k2"], options: [{ label: "Button · variant ghost", decision: ghost }], auto: ghost, fit: null, parts: null, context: null, note: null },
        { key: "q4", kind: "group", title: "Menu rows", ask: "Replace with MenuItem?", home: "MenuItem", ids: ["m1"], options: [{ label: "MenuItem", decision: { verdict: "replace", role: "button", use: "MenuItem", props: {} } }], auto: { verdict: "replace", role: "button", use: "MenuItem", props: {} }, fit: null, parts: null, context: null, note: null },
        { key: "q2", kind: "group", title: "Filter toggles", ask: "Replace with Toggle?", home: "Toggle", ids: ["t1"], options: [{ label: "Toggle", decision: { verdict: "replace", role: "button", use: "Toggle", props: {} } }], auto: { verdict: "replace", role: "button", use: "Toggle", props: {} }, fit: null, parts: null, context: null, note: null },
      ],
      proposals: {
        "Button|variant=ghost": { use: "Button", props: { variant: "ghost" }, check: "exact", url: "rendered/ghost.png", content: null },
        Toggle: { use: "Toggle", props: {}, check: "none", url: null, note: "No Toggle story." },
        "Button|variant=ghost#own123": { use: "Button", props: { variant: "ghost" }, check: "exact", url: "rendered/own.png", content: null, own: true },
        MenuItem: { use: "MenuItem", props: {}, check: "none", url: null, note: "MenuItem doesn't show in its stories: it may only appear inside something closed, like a menu or a dialog, and opening it didn't show it. Its story as written is shown instead.", fallback: "rendered/fallback-menu.png" },
      },
      sources: {},
    },
  }
  data.textContent = JSON.stringify(payload)
  document.head.append(data)
  m = { Elements: (await import("@/views/elements/Elements")).Elements, app: await import("@/lib/app"), probe: await import("../../src/card-dom"), trust: await import("../../src/trust") }
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
  expect(panes).toEqual(["Live app screenshotledgersrc/Toolbar.tsx:4match 100%", "Live app screenshotatlassrc/Bar.tsx:4match 100%"])
})

test("the proposal is labelled with its component and props", async () => {
  await mount()
  const p = card("Ghost buttons").querySelector('[data-pane="proposed"]')!
  expect(p.textContent).toContain("Proposed")
  expect(p.textContent).toContain("Buttonvariant ghost")
  expect(p.querySelector("img")!.getAttribute("src")).toBe("rendered/ghost.png")
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
})

test("the place opens the code", async () => {
  await mount()
  await click(button(card("Ghost buttons").querySelector('[data-pane="app"]')!, /Toolbar\.tsx:4/))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Toolbar.tsx")
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
})

test("no exact render: the closest variant stands in, said as such, with why", async () => {
  await mount()
  const p = card("Filter toggles").querySelector('[data-pane="proposed"]')!
  expect(p.textContent).toContain("Closest variant")
  expect(p.textContent).toContain("No Toggle story.")
  expect(p.querySelector("img")!.getAttribute("src")).toBe("rendered/closest.png")
})

test("the zoom view says how the element was revealed once, and proposes what the card proposes", async () => {
  await mount()
  await click(card("Ghost buttons").querySelector('[data-pane="app"] button')!)
  const d = document.querySelector('[role="dialog"]')!
  expect(d.textContent).toContain("Live app screenshot · ledger · match 100% · after opening “Filters”")
  expect(d.textContent).not.toContain("opening “opening")
  expect(d.textContent).toContain("Proposed · Acme Button · variant ghost")
  expect([...d.querySelectorAll("img")].map(i => i.getAttribute("src"))).toEqual(["shots/b1.png", "rendered/ghost.png"])
})

test("one app chosen: its evidence only, and the answer says what else it covers", async () => {
  m.app.setApp("ledger")
  await mount()
  const c = card("Ghost buttons")
  expect([...c.querySelectorAll('[data-pane="app"]')].map(p => p.textContent)).toEqual(["Live app screenshotledgersrc/Toolbar.tsx:4match 100%"])
  expect(c.textContent).toContain("That includes 1 in atlas, not shown here.")
  // A question is the app's when any of its elements is, not only its first.
  m.app.setApp("atlas")
  await act(async () => root.render(<m.Elements key="atlas" />))
  expect(card("Ghost buttons")).toBeTruthy()
  expect(card("Ghost buttons").textContent).toContain("That includes 1 in ledger, not shown here.")
})

test("a photo with nothing drawn in it isn't shown as evidence: the card says it was captured but blank", async () => {
  await mount()
  const c = card("Row actions")
  expect(c.textContent).toContain("Captured but blank.")
  expect([...c.querySelectorAll("img")].map(i => i.getAttribute("src"))).not.toContain("shots/k1.png")
})

test("a proposal drawn with the element's own content is the one shown, and says so", async () => {
  await mount()
  const p = card("Row actions").querySelector('[data-pane="proposed"]')!
  expect(p.querySelector("img")!.getAttribute("src")).toBe("rendered/own.png")
  expect(p.textContent).toContain("with this element's own content")
})

test("a tie among identical elements is shown, and labelled as one of them", async () => {
  await mount()
  const a = card("Row actions").querySelector('[data-pane="app"]')!
  expect(a.textContent).toContain("match 95%")
  expect(a.textContent).toContain("one of 3 alike on the page")
})

test("no render with these props: the story as written stands in, with the reason in plain words", async () => {
  await mount()
  const p = card("Menu rows").querySelector('[data-pane="proposed"]')!
  expect(p.textContent).toContain("Its story as written")
  expect(p.textContent).toContain("it may only appear inside something closed")
  expect(p.querySelector("img")!.getAttribute("src")).toBe("rendered/fallback-menu.png")
})

test("a recommendation the scanner was sure of, but no one can see yet, is held under the bar and says why", async () => {
  await mount()
  const held = card("Menu rows").querySelector('[data-slot="held-back"]')!
  expect(held.textContent).toBe("Held under 90% (the scanner said 96%): there is no photo of it in the app; the proposal (MenuItem) isn't drawn exactly yet.")
  expect(document.body.textContent).toContain("1 element the scanner was sure of is held under 90% until a person can see it")
  expect(card("Ghost buttons").querySelector('[data-slot="held-back"]')).toBeNull()
})

test("the rubric's card checks are read from this card: labels, the code opener, both panes at one scale", async () => {
  await mount()
  const cards = await m.probe.probeCards(document, { click: true })
  const b1 = cards.find(c => c.id === "b1")!
  expect(b1).toMatchObject({ target: "ledger", place: "src/Toolbar.tsx:4", thumb: false, photoLabel: true, opensCode: true, proposalLabel: true, sameScale: true })
  // The code viewer was closed again after each check.
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  // A blank photo isn't shown, so it has no tile; the closest variant stands in with its label.
  expect(cards.find(c => c.id === "k1")).toBeUndefined()
  expect(cards.find(c => c.id === "t1")).toMatchObject({ proposalLabel: true, sameScale: true })
  const s = m.trust.trustRubric(payload, { cards })
  const outcomes = (id: string) => s.rows.find(r => r.id === id)!.outcomes
  for (const k of ["photoLabel", "opensCode", "proposalLabel", "sameScale"] as const) expect(outcomes("b1")[k]).toBe("pass")
  expect(s.untested).toEqual([])
})

test("a card that leaves out a label or the code opener fails those checks", async () => {
  const host = await mount()
  const pane = host.querySelector('figure[data-element-id="b1"] [data-pane="app"]')!
  pane.querySelector('[title="The app this element is in"]')!.remove()
  pane.querySelector<HTMLButtonElement>('button[title="Open the code"]')!.disabled = true
  const b1 = (await m.probe.probeCards(document)).find(c => c.id === "b1")!
  expect([b1.photoLabel, b1.opensCode, b1.sameScale]).toEqual([false, false, true])
})
