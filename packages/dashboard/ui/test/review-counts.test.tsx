// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// Element Review and Label Review count by one rule (report review.ts canDecideNow): every element a
// person can decide now is offered in Label Review, "Need a decision" and the "Needs you" filter agree,
// and the rest are counted under "Needs evidence", with the plain reason first.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mem = new Map<string, string>()
Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear() } })
let root: Root
let m: { LabelReview: any; Elements: any }

const box = { x: 20, y: 30, w: 64, h: 32, cw: 240, ch: 120 }
const ghost = { verdict: "replace", role: "button", use: "Button", props: { variant: "ghost" } }
const el = (id: string, o: object = {}) => ({
  id, target: "ledger", file: `ledger/src/${id}.tsx`, line: 4, element: "button", role: "button", verdict: "replace", use: "Button", props: { variant: "ghost" },
  confidence: 0.6, needsHuman: true, decided: null, exception: null, label: "Open", ownHash: "own1", title: "Row actions", home: "Button", family: "button",
  alternatives: [], a11y: [], snippet: "<button>Open</button>", styleSig: "s1", span: 1, reasons: [],
  shot: { url: `shots/${id}.png`, match: 1, tagged: true, page: "http://127.0.0.1:5173/#/orders/table", box }, rendered: null, systemPreview: null, ...o,
})
const unreached = (id: string, label: string) => el(id, { shot: null, reach: { status: "gated", why: "Renders only when `open && mode === 'x'` in Sheet, opened by “Message on : Open request -” in Bell; 3 more conditions above it (main › App).", gates: [{ kind: "condition", test: "open" }], steps: [label] } })
const q = (key: string, title: string, ids: string[]) => ({ key, kind: "group", title, ask: "Replace with Button (variant ghost)?", home: "Button", ids, options: [{ label: "Button · variant ghost", decision: ghost }], auto: ghost, fit: null, parts: null, context: null, note: null })

beforeAll(async () => {
  const { withReview } = await import("../../src/review")
  const payload = withReview({
    serve: false, label: "Acme", targets: [{ name: "ledger", role: "consumer" }],
    elements: {
      threshold: 0.9, patterns: [], shotsTaken: null, rendered: null, sources: {},
      evals: [el("a1"), el("a2"), unreached("a3", "Message on : Open request -"), unreached("w1", "Message on : Open request -"), unreached("w2", "Edit")],
      questions: [q("q1", "Row actions", ["a1", "a2", "a3"]), q("q2", "Waiting rows", ["w1", "w2"])],
      proposals: { "Button|variant=ghost#own1": { use: "Button", props: { variant: "ghost" }, check: "exact", url: "rendered/own.png", own: true, text: "Open" } },
    },
  }, { audit: 0 })
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
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(node))
  return host
}
const face = (el: Element) => { const c = el.cloneNode(true) as Element; c.querySelectorAll("details").forEach(d => d.remove()); return c.textContent ?? "" }

test("Label Review offers every element Element Review counts as decidable now", async () => {
  const els = await mount(<m.Elements />)
  const leaf = [...els.querySelectorAll("*")].find(n => n.children.length === 0 && /you can decide now$/.test(n.textContent ?? ""))!
  const now = Number(leaf.textContent!.match(/^(\d+)/)![1])
  expect(now).toBe(2)
  await act(async () => root.unmount())
  const lr = await mount(<m.LabelReview />)
  expect(lr.textContent).toMatch(new RegExp(`Element 1 of ${now}\\b`))
  expect(lr.textContent).toContain("dsa isn't sure about this one, so a person decides.")
})

test("the Needs you filter and Need a decision are one number; the rest sit under Needs evidence", async () => {
  const host = await mount(<m.Elements />)
  const pill = (name: string) => Number([...host.querySelectorAll("button")].map(b => b.textContent ?? "").find(t => new RegExp(`^${name}\\s*\\d+$`).test(t))!.slice(name.length).trim())
  const stat = [...host.querySelectorAll("*")].find(n => n.children.length === 0 && n.textContent === "Need a decision")!.parentElement!
  expect(pill("Needs you")).toBe(1)
  expect(stat.textContent).toMatch(/^Need a decision\s*1/)
  expect(pill("Needs evidence")).toBe(1)
})

test("needs-evidence reasons are plain and grouped, with the code conditions behind Technical details", async () => {
  const host = await mount(<m.Elements />)
  const pill = [...host.querySelectorAll("button")].find(b => /^Needs evidence\s*\d+$/.test(b.textContent ?? ""))!
  await act(async () => { (pill as HTMLElement).click() })
  const box = [...host.querySelectorAll('[data-slot="needs-evidence"]')].find(n => /Waiting rows|2 aren't reached/.test(n.textContent ?? ""))!
  expect(face(box)).toContain("2 aren't reached yet: they only show after steps in a flow, such as opening “Message on …: Open request …”.")
  expect(face(box)).not.toMatch(/`|conditions above|›/)
  expect(box.querySelector('[data-slot="evidence-details"]')?.textContent).toMatch(/Renders only when/)
})
