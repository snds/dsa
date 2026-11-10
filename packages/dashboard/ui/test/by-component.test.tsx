// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { byComponent, statusOf } from "@/views/elements/structure"

// Element Review by component: places grouped by the component they go to, then the settings they get
// (a batch), then shared styles (a look group). An answer moves a place to where it now goes.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mem = new Map<string, string>()
Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear() } })

const box = { x: 20, y: 30, w: 64, h: 32, cw: 240, ch: 120 }
const el = (id: string, o: object = {}) => ({
  id, target: "ledger", file: `ledger/src/${id}.tsx`, line: 4, element: "button", role: "button", verdict: "replace", use: "Button", props: { variant: "ghost" },
  confidence: 0.6, needsHuman: true, decided: null, exception: null, label: id, ownHash: null, title: "Row actions", family: "button",
  alternatives: [], a11y: [], snippet: `<button>${id}</button>`, styleKey: null, styleSig: null, reasons: [],
  shot: { url: `shots/${id}.png`, match: 1, tagged: true, page: "http://127.0.0.1:5173/#/orders/table", box }, rendered: null, review: { ready: true, decideNow: true, pageName: "Orders › Table" }, ...o,
})
const NAMES = { noHome: "No fit yet", keep: "Keep as is", ignored: "Set aside", unclear: "Unclear" }
const now = (e: any) => Boolean(e.review?.decideNow) && !e.decided

const evals = [
  el("tb1", { styleKey: "TOOLBAR_ACTION" }), el("tb2", { styleKey: "TOOLBAR_ACTION" }), el("tb3", { styleKey: "TOOLBAR_ACTION", confidence: 0.4 }),
  el("solo", { styleSig: "a1b2c3d4" }),
  el("small", { props: { variant: "ghost", size: "sm" } }),
  el("sure", { needsHuman: false, confidence: 0.95 }),
  el("wait", { review: { ready: false, decideNow: false } }),
  el("menu", { use: "DropdownMenuItem", props: {}, role: "menu-item" }),
  el("swatch", { verdict: "gap", use: undefined, props: undefined, gap: "no color input", role: "color-input" }),
  // Decided as a Toggle, though dsa proposed Button: it is listed under Toggle.
  el("moved", { decided: { by: "human", decision: { verdict: "replace", role: "button", use: "Toggle", props: {} } } }),
  el("lab", { exception: "lab" }),
]

test("places group by component, then settings, then shared style; components with the most to decide first", () => {
  const g = byComponent(evals, NAMES, now)
  expect(g.map(x => x.name)).toEqual(["Button", "DropdownMenuItem", "Toggle", "No fit yet"])
  const button = g[0]!
  expect(button.counts).toEqual({ todo: 5, evidence: 1, proposed: 1, decided: 0, total: 7 })
  expect(button.batches.map(b => b.key)).toEqual(["Button|variant=ghost", "Button|size=sm,variant=ghost"])
  const looks = button.batches[0]!.looks
  expect(looks.map(l => [l.kind, l.name, l.items.map(e => e.id)])).toEqual([
    ["shared", "TOOLBAR_ACTION", ["tb3", "tb1", "tb2"]],
    ["one-off", null, ["solo", "wait", "sure"]],
  ])
  expect(g.find(x => x.name === "Toggle")!.batches[0]!.items.map(e => e.id)).toEqual(["moved"])
  expect(g.flatMap(x => x.batches.flatMap(b => b.items)).some(e => e.id === "lab")).toBe(false)
})

test("a place is to decide, waiting on evidence, proposed (dsa is sure), or decided", () => {
  const by = Object.fromEntries(evals.map(e => [e.id, statusOf(e, now)]))
  expect([by.tb1, by.wait, by.sure, by.moved]).toEqual(["todo", "evidence", "proposed", "decided"])
})

let root: Root
let Elements: any
beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ serve: true, label: "Acme", targets: [{ name: "ledger", role: "consumer" }], elements: { threshold: 0.9, patterns: [], shotsTaken: null, rendered: null, sources: {}, evals, questions: [], proposals: {} } })
  document.head.append(data)
  Elements = (await import("@/views/elements/Elements")).Elements
})
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = "" })

test("in dsa serve, Element Review opens by component, with answers for a place, a look group and a batch", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<Elements />))
  const nav = host.querySelector('nav[aria-label="Where places go"]')!
  expect([...nav.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Button6 / 7", "DropdownMenuItem1 / 1", "Toggle1", "No Acme home yet1 / 1"])
  expect(host.querySelector("h2")!.textContent).toMatch(/Button$/)
  const batch = host.querySelector('[data-slot="batch"]')!
  // A batch answer covers only places a person can see: "wait" has no evidence yet, so it isn't included.
  expect(batch.textContent).toContain("Answer all 5…")
  expect(batch.textContent).toContain("Shared style TOOLBAR_ACTION")
  expect(batch.textContent).toContain("Answer these 3…")
  // The "To decide" filter shows only places a person can decide now.
  expect([...host.querySelectorAll('[data-slot="place"]')].map(p => p.getAttribute("data-status"))).toEqual(["todo", "todo", "todo", "todo", "todo"])
  // Choosing another component shows its places and is remembered.
  await act(async () => (nav.querySelectorAll("button")[2] as HTMLButtonElement).click())
  expect(host.querySelector("h2")!.textContent).toMatch(/Toggle$/)
  expect(mem.get("dsa.elements.component")).toBe("c:Toggle")
})
