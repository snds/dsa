// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { byComponent, neighboursOf, statusOf, withApart } from "@/views/elements/structure"

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
  el("tb1", { styleKey: "TOOLBAR_ACTION", alternatives: [{ verdict: "replace", use: "Toggle", props: {}, confidence: 0.3 }] }),
  el("tb2", { styleKey: "TOOLBAR_ACTION", alternatives: [{ verdict: "replace", use: "Toggle", props: {}, confidence: 0.3 }] }),
  el("tb3", { styleKey: "TOOLBAR_ACTION", confidence: 0.4, alternatives: [{ verdict: "replace", use: "Toggle", props: {}, confidence: 0.2 }, { verdict: "replace", use: "Button", props: { variant: "outline" }, confidence: 0.2 }, { verdict: "keep", role: "button", confidence: 0.1 }] }),
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

test("a batch's related components: its own pick first, then the alternatives weighed for the most places", () => {
  const button = byComponent(evals, NAMES, now)[0]!.batches[0]!
  expect(neighboursOf(button).map(n => [n.pick.use, n.pick.props, n.mine, n.places])).toEqual([
    ["Button", { variant: "ghost" }, true, 6],
    ["Toggle", {}, false, 3],
    ["Button", { variant: "outline" }, false, 1],
  ])
})

test("places set apart leave their look group and form their own, listed first", () => {
  const looks = byComponent(evals, NAMES, now)[0]!.batches[0]!.looks
  const split = withApart(looks, new Set(["tb2", "solo"]), now)
  expect(split.map(l => [l.kind, l.items.map(e => e.id)])).toEqual([
    ["apart", ["tb2", "solo"]],
    ["shared", ["tb3", "tb1"]],
    ["one-off", ["wait", "sure"]],
  ])
  expect(withApart(looks, new Set(), now)).toBe(looks)
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
  // "sure" was drawn as a spot check: answered on its own, never ticked for a batch.
  data.textContent = JSON.stringify({ serve: true, label: "Acme", targets: [{ name: "ledger", role: "consumer" }], elements: { threshold: 0.9, patterns: [], shotsTaken: null, rendered: null, sources: {}, evals, questions: [], proposals: { Toggle: { use: "Toggle", props: {}, check: "exact", url: "rendered/toggle.png", own: false } }, review: { items: [{ id: "sure", why: "audit" }, { id: "small", why: "decide", pick: { verdict: "replace", role: "button", use: "Button", props: { variant: "ghost", size: "sm" } }, about: null, label: { app: "ledger", file: "ledger/src/small.tsx", line: 4, sourceRef: "worktree", elementHash: "h-small" }, examples: [], labExamples: [], altExamples: [], usesCount: 0, nearest: null, noPhoto: null, systemExample: null, searched: true }] } } })
  document.head.append(data)
  Elements = (await import("@/views/elements/Elements")).Elements
})
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ""; mem.delete("dsa.elements.component") })

async function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<Elements />))
  return host
}
const label = (host: Element, text: string) => [...host.querySelectorAll("label")].find(l => l.textContent === text)!.querySelector("input") as HTMLInputElement
const button = (host: Element, text: string) => [...host.querySelectorAll("button")].find(b => b.textContent === text) as HTMLButtonElement
const type = async (input: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  await act(async () => { set.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })) })
}

test("in dsa serve, Element Review opens by component, with tick boxes for a look group and a batch", async () => {
  const host = await mount()
  const nav = host.querySelector('nav[aria-label="Where places go"]')!
  expect([...nav.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Button6 / 7", "DropdownMenuItem1 / 1", "Toggle1", "No Acme home yet1 / 1"])
  expect(host.querySelector("h2")!.textContent).toMatch(/Button$/)
  const batch = host.querySelector('[data-slot="batch"]')!
  // Only places a person can see can be ticked: "wait" has no evidence yet, and "sure" is a spot check.
  expect(batch.textContent).toContain("Select all 4")
  expect(batch.textContent).toContain("Shared style TOOLBAR_ACTION")
  expect(batch.textContent).toContain("Select these 3")
  // The "To decide" filter shows only places a person can decide now.
  expect([...host.querySelectorAll('[data-slot="place"]')].map(p => p.getAttribute("data-status"))).toEqual(["todo", "todo", "todo", "todo", "todo"])
  // Choosing another component shows its places and is remembered.
  await act(async () => (nav.querySelectorAll("button")[2] as HTMLButtonElement).click())
  expect(host.querySelector("h2")!.textContent).toMatch(/Toggle$/)
  expect(mem.get("dsa.elements.component")).toBe("c:Toggle")
})

test("tick a look group, give one place its own note, confirm them together, then undo", async () => {
  const calls: { url: string; body: any }[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: String(url), body })
    const json = String(url).includes("/api/undecide") ? { ids: body.ids, removed: body.ids.length, unlabeled: body.ids.length }
      : { recorded: body.ids.length, decided: { by: "human", decision: body.decision, note: body.note }, labelsAt: "2026-11-09T12:00:00.000Z" }
    return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } })
  }) as any
  try {
    const host = await mount()
    await act(async () => label(host, "Select these 3").click())
    const bar = host.querySelector('[data-slot="action-bar"]')!
    expect(bar.textContent).toContain("3 selected")
    // The spot check can't be ticked, and says why.
    const sure = host.querySelector('input[aria-label="Select sure"]') as HTMLInputElement | null
    if (sure) expect(sure.disabled).toBe(true)
    await type(host.querySelector("#note-tb1") as HTMLInputElement, "opens a menu")
    await type(host.querySelector("#bc-batch-note") as HTMLInputElement, "toolbar actions")
    await act(async () => button(host, "Confirm").click())
    const decide = calls.find(c => c.url.includes("/api/decide"))!
    expect(decide.body.ids.sort()).toEqual(["tb1", "tb2", "tb3"])
    expect(decide.body.decision).toMatchObject({ verdict: "replace", use: "Button", props: { variant: "ghost" } })
    expect(decide.body.note).toBe("toolbar actions")
    expect(decide.body.notes).toEqual({ tb1: "opens a menu" })
    expect(host.querySelector('[data-slot="action-bar"]')).toBeNull()
    expect(host.textContent).toContain("Confirmed: 3 places.")
    expect(host.textContent).toContain("Note: opens a menu")
    // Undo takes back the decisions and the labels written at that moment.
    await act(async () => button(host, "Undo").click())
    const undo = calls.find(c => c.url.includes("/api/undecide"))!
    expect(undo.body).toEqual({ ids: ["tb3", "tb1", "tb2"], labelsAt: "2026-11-09T12:00:00.000Z" })
    expect(host.textContent).not.toContain("Confirmed: 3 places.")
  } finally { globalThis.fetch = realFetch }
})

const tick = async (host: Element, id: string) => act(async () => (host.querySelector(`input[aria-label="Select “${id}”"]`) as HTMLInputElement).click())

test("the related-components strip answers ticked places with another component", async () => {
  const calls: any[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: String(url), body })
    return new Response(JSON.stringify({ recorded: body.ids.length, decided: { by: "human", decision: body.decision }, labelsAt: "2026-11-09T13:00:00.000Z" }), { status: 200, headers: { "Content-Type": "application/json" } })
  }) as any
  try {
    const host = await mount()
    const strip = host.querySelector('[data-slot="neighbours"]')!
    expect([...strip.querySelectorAll("figcaption")].map(f => f.textContent)).toEqual([
      "Button · variant ghostdsa's pick for this batch", "Toggleweighed for 3 placesexample content, not this place's", "Button · variant outlineweighed for 1 place",
    ])
    expect(button(host, "Tick places to use").disabled).toBe(true)
    await tick(host, "tb1")
    await tick(host, "tb2")
    const use = [...strip.querySelectorAll("figure")][1]!.querySelector("button")!
    expect(use.textContent).toBe("Use for 2 ticked")
    await act(async () => use.click())
    const decide = calls.find(c => c.url.includes("/api/decide"))!
    expect(decide.body.ids.sort()).toEqual(["tb1", "tb2"])
    expect(decide.body.decision).toEqual({ verdict: "replace", role: "button", use: "Toggle", props: {} })
    expect(host.textContent).toContain("Changed to Toggle: 2 places.")
  } finally { globalThis.fetch = realFetch }
})

test("set apart pulls ticked places into their own group, remembered in this browser, and puts them back", async () => {
  mem.delete("dsa.elements.apart")
  const host = await mount()
  await tick(host, "tb3")
  await act(async () => button(host, "Set apart").click())
  const looks = () => [...host.querySelectorAll('[data-slot="look"]')].map(l => [l.querySelector("span")?.textContent, [...l.querySelectorAll('[data-slot="place"]')].length])
  expect(looks()[0]).toEqual(["Set apart", 1])
  expect(JSON.parse(mem.get("dsa.elements.apart")!)).toEqual(["tb3"])
  await tick(host, "tb3")
  await act(async () => button(host, "Put back").click())
  expect(looks().some(([t]) => t === "Set apart")).toBe(false)
  expect(JSON.parse(mem.get("dsa.elements.apart")!)).toEqual([])
})

test("a place opens on its own in Element Review; Right saves it as the decision and the label", async () => {
  mem.set("dsa.reviewer", JSON.stringify("Sean"))
  const calls: any[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: String(url), body })
    if (String(url).includes("/api/labels")) {
      const l = body.labels[0]
      return new Response(JSON.stringify({ saved: 1, errors: [], decided: [{ id: l.id, decided: { by: "human", decision: { verdict: "replace", role: "button", use: l.truth.use, props: l.truth.props }, who: l.labeler } }], notDecided: [] }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
  }) as any
  try {
    const host = await mount()
    const name = [...host.querySelectorAll("button")].find(b => b.textContent === "“small”" && b.title === "Look at this place on its own")!
    await act(async () => name.click())
    const panel = document.querySelector('[data-slot="focus"]')!
    expect(panel.textContent).toMatch(/Place \d+ of \d+/)
    expect(panel.textContent).toContain("Is Button · variant ghost · size sm the right answer?")
    await act(async () => ([...panel.querySelectorAll("button")].find(b => b.textContent?.startsWith("Right")) as HTMLButtonElement).click())
    await act(async () => ([...panel.querySelectorAll("button")].find(b => b.textContent === "Save answer") as HTMLButtonElement).click())
    const sent = calls.find(c => c.url.includes("/api/labels"))!.body.labels[0]
    expect([sent.id, sent.how, sent.labeler, sent.truth.use]).toEqual(["small", "alone", "Sean", "Button"])
    expect(document.body.textContent).toContain("Answered “small”.")
  } finally { globalThis.fetch = realFetch }
})

test("the key map: one key per action, never while typing, in a dialog, or with Ctrl, Cmd or Alt", async () => {
  const { keyAction } = await import("@/views/elements/keys")
  const body = document.body, input = document.createElement("input")
  expect(["j", "K", "x", "c", "e", "n", "o", "u", "Escape", "q"].map(key => keyAction({ key, target: body }))).toEqual(["next", "prev", "tick", "confirm", "change", "note", "open", "undo", "clear", null])
  expect(keyAction({ key: "j", target: input })).toBeNull()
  expect(keyAction({ key: "c", target: body, metaKey: true })).toBeNull()
  expect(keyAction({ key: "j", target: body }, true)).toBeNull()
})

test("J moves through the places on screen, X ticks, C confirms what's ticked; keys in a note box stay there", async () => {
  const calls: any[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: String(url), body })
    return new Response(JSON.stringify({ recorded: body.ids.length, decided: { by: "human", decision: body.decision }, labelsAt: "2026-11-09T14:00:00.000Z" }), { status: 200, headers: { "Content-Type": "application/json" } })
  }) as any
  const key = (k: string, target: EventTarget = window) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })) })
  try {
    const host = await mount()
    expect(host.querySelector('[data-slot="keys"]')!.textContent).toContain("J next place")
    const cur = () => host.querySelector('[data-slot="place"][aria-current="true"]')?.getAttribute("data-place")
    const order = [...host.querySelectorAll('[data-slot="place"]')].map(p => p.getAttribute("data-place"))
    await key("j")
    expect(cur()).toBe(order[0])
    await key("j")
    expect(cur()).toBe(order[1])
    await key("k")
    expect(cur()).toBe(order[0])
    // Typing a note doesn't move the cursor.
    const note = host.querySelector(`#note-${order[0]}`) as HTMLInputElement
    await key("j", note)
    expect(cur()).toBe(order[0])
    await key("x")
    expect(host.querySelector('[data-slot="action-bar"]')!.textContent).toContain("1 selected")
    await key("c")
    const decide = calls.find(c => c.url.includes("/api/decide"))!
    expect(decide.body.ids).toEqual([order[0]])
    expect(host.textContent).toContain("Confirmed: 1 place.")
  } finally { globalThis.fetch = realFetch }
})
