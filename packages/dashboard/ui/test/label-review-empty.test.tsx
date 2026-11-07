// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// Nothing near-empty goes up for review: nobody can decide in a vacuum. A card with no clear answer shows
// its closest candidates with the element's own words; a gap says the system has no such component.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mem = new Map<string, string>()
Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) } })
let root: Root
let LabelReview: any
let payload: any

const box = { x: 20, y: 30, w: 64, h: 32, cw: 240, ch: 120 }
const shot = (id: string) => ({ url: `shots/${id}.png`, match: 1, tagged: true, page: "http://127.0.0.1:5173/#/orders", box, content: { text: "Export", inner: null } })
const el = (id: string, o: object) => ({
  id, target: "ledger", file: `ledger/src/${id}.tsx`, line: 4, element: "button", role: "button", use: null, props: null, confidence: 0.5, needsHuman: true, decided: null, exception: null,
  label: "Export", ownHash: "own1", title: "Buttons", a11y: [], snippet: "<button>Export</button>", styleSig: "s1", span: 1, reasons: [], shot: shot(id), rendered: null, systemPreview: null, ...o,
})
const candidate = { verdict: "replace", use: "Button", props: { variant: "ghost" } }

beforeAll(async () => {
  const { withReview } = await import("../../src/review")
  payload = withReview({
    serve: false, label: "Acme", targets: [{ name: "ledger", role: "consumer" }],
    elements: {
      threshold: 0.9, patterns: [], questions: [], shotsTaken: null, rendered: null, sources: {},
      evals: [
        el("vague", { verdict: "unclear", alternatives: [candidate] }),
        el("alone", { verdict: "unclear", alternatives: [] }),
        el("hole", { verdict: "gap", alternatives: [candidate] }),
        el("bare", { verdict: "gap", alternatives: [] }),
      ],
      proposals: { "Button|variant=ghost#own1": { use: "Button", props: { variant: "ghost" }, check: "exact", url: "rendered/ghost.png", own: true, text: "Export" } },
    },
  }, { audit: 1, system: [{ component: "Button", axes: { variant: ["ghost"] }, defaults: {} }], precedents: [] })
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify(payload)
  document.head.append(data)
  LabelReview = (await import("@/views/review/LabelReview")).LabelReview
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  document.body.innerHTML = ""
})

async function card(id: string) {
  const host = document.createElement("main")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<LabelReview />))
  for (let i = 0; i < 8; i++) {
    const item = host.querySelector('[data-slot="review-item"]')!
    if (item.getAttribute("data-element-id") === id) return item
    const next = [...host.querySelectorAll("button")].find(b => /^Next/.test(b.textContent ?? ""))
    if (!next) break
    await act(async () => (next as HTMLElement).click())
  }
  throw new Error(`${id} not shown`)
}

test("no clear answer and no candidate: held out, and it says why", () => {
  const ids = payload.elements.review.items.map((x: any) => x.id)
  expect(ids).not.toContain("alone")
  expect(payload.elements.evals.find((e: any) => e.id === "alone").review.missing[0].kind).toBe("no-candidates")
  expect(ids).toEqual(expect.arrayContaining(["vague", "hole", "bare"]))
})

test("no clear answer: the heading says so, its candidates are drawn, and there's no proposal to call right", async () => {
  const item = await card("vague")
  expect(item.querySelector("h3")?.textContent).toMatch(/→ no clear match in \S+/)
  expect(item.textContent).not.toContain("nothing to draw")
  expect(item.querySelector('[data-slot="candidate"] img')?.getAttribute("src")).toBe("rendered/ghost.png")
  const answers = [...item.querySelectorAll('[data-slot="verdict"] [role="radio"]')].map(b => b.textContent)
  expect(answers).toEqual(["Choose", "Not sure"])
})

test("a gap says the system has no such component, with its stand-in where there is one", async () => {
  const hole = await card("hole")
  expect(hole.querySelector("h3")?.textContent).toMatch(/→ no \S+ component fits/)
  expect(hole.querySelector('[data-pane="proposed"]')?.textContent).toMatch(/has no such component\./)
  expect(hole.querySelector('[data-slot="candidate"]')?.textContent).toContain("Suggested stand-in")
  expect(hole.querySelector('[data-slot="candidate"] img')?.getAttribute("src")).toBe("rendered/ghost.png")
  expect(hole.textContent).not.toContain("nothing to draw")
})
test("a gap with no stand-in still says it plainly", async () => {
  const bare = await card("bare")
  expect(bare.querySelector('[data-pane="proposed"]')?.textContent).toMatch(/has no such component\./)
  expect(bare.querySelector('[data-slot="candidate"]')).toBeNull()
})
