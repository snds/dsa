// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// Element Review by component on a published copy: the same screen as dsa serve, but answers wait in
// this browser and go out from the bar at the bottom (as an issue the repo's workflow applies).

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

let root: Root
let Elements: any
let staged: typeof import("@/lib/staged")

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ published: true, label: "Acme", targets: [{ name: "ledger", role: "consumer" }], actions: { host: "github", rescan: { kind: "issue", url: "https://github.test/acme/site/issues/new", label: "Re-scan", title: "Re-scan the dsa dashboard", labels: ["dsa-rescan"], help: "Opens a filled-in issue." }, decisions: { kind: "issue", url: "https://github.test/acme/site/issues/new", label: "File decisions on GitHub", title: "Review decisions from the dashboard", labels: ["dsa-decisions"], help: "Opens an issue.", apply: "dsa apply-decisions --issue <number>" } }, elements: { threshold: 0.9, patterns: [], shotsTaken: null, rendered: null, sources: {}, evals, questions: [], proposals: {}, review: { items: [{ id: "sure", why: "audit" }] } } })
  document.head.append(data)
  Elements = (await import("@/views/elements/Elements")).Elements
  staged = await import("@/lib/staged")
})
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ""; staged.clearStaged() })

async function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<Elements />))
  return host
}
const button = (host: Element, text: string) => [...host.querySelectorAll("button")].find(b => b.textContent === text) as HTMLButtonElement
const type = async (input: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  await act(async () => { set.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })) })
}

test("a published copy opens the same by-component screen, with tick boxes and notes", async () => {
  const host = await mount()
  expect(host.querySelector('[data-slot="by-component"]')).not.toBeNull()
  expect(host.textContent).not.toContain("By question")
  expect(host.querySelector('[role="checkbox"][aria-label="Select these 3"]')).not.toBeNull()
  expect(host.querySelector("#note-tb1")).not.toBeNull()
})

test("answers stage in this browser, with each place's note, show as staged, and undo takes them back", async () => {
  const realFetch = globalThis.fetch
  let fetched = 0
  globalThis.fetch = (async () => { fetched++; return new Response("{}") }) as any
  try {
    const host = await mount()
    await act(async () => (host.querySelector('[role="checkbox"][aria-label="Select these 3"]') as HTMLElement).click())
    await type(host.querySelector("#note-tb1") as HTMLInputElement, "opens a menu")
    await act(async () => button(host, "Confirm").click())
    expect(fetched).toBe(0)
    const list = staged.readStaged()
    expect(list).toHaveLength(1)
    expect(list[0]!.ids.sort()).toEqual(["tb1", "tb2", "tb3"])
    expect(list[0]!.decision).toMatchObject({ verdict: "replace", use: "Button" })
    expect(list[0]!.notes).toEqual({ tb1: "opens a menu" })
    // The file the workflow applies carries the notes, so they become the decisions' and labels' notes.
    expect(staged.decisionsFile(list).decisions[0]).toMatchObject({ ids: expect.any(Array), notes: { tb1: "opens a menu" } })
    expect(host.textContent).toContain("Confirmed: 3 places, staged to send.")
    expect(host.textContent).toContain("1 decision staged in this browser")
    await act(async () => button(host, "Undo").click())
    expect(staged.readStaged()).toHaveLength(0)
  } finally { globalThis.fetch = realFetch }
})

test("Re-scan opens a filled-in issue that carries the photo setting", async () => {
  const { rescanIssueUrl } = await import("@/lib/host")
  const url = new URL(rescanIssueUrl({ url: "https://github.test/acme/site/issues/new", title: "Re-scan the dsa dashboard", labels: ["dsa-rescan"] }, "fresh"))
  expect(url.origin + url.pathname).toBe("https://github.test/acme/site/issues/new")
  expect(url.searchParams.get("labels")).toBe("dsa-rescan")
  expect(url.searchParams.get("title")).toBe("Re-scan the dsa dashboard")
  expect(url.searchParams.get("body")).toContain('{"dsa":"rescan","shots":"fresh"}')
})
