// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// A photo from a lab page says so: it doesn't read as how the product uses the component.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mem = new Map<string, string>()
Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) } })
let root: Root
let LabelReview: any

const box = { x: 20, y: 30, w: 64, h: 32, cw: 240, ch: 120 }
const el = (id: string) => ({
  id, target: "ledger", file: `ledger/src/${id}.tsx`, line: 4, element: "button", role: "button", verdict: "replace", use: "Button", props: {}, confidence: 0.5, needsHuman: true, decided: null, exception: null,
  label: "Export", ownHash: "own1", title: "Buttons", a11y: [], snippet: "<button>Export</button>", styleSig: "s1", span: 1, reasons: [], alternatives: [], rendered: null, systemPreview: null,
  shot: { url: `shots/${id}.png`, match: 1, tagged: true, page: "http://127.0.0.1:5173/#/orders", box, content: { text: "Export", inner: null } },
})

beforeAll(async () => {
  const { withReview } = await import("../../src/review")
  const use = (line: number) => ({ app: "ledger", file: `ledger/src/U${line}.tsx`, line, component: "Button", props: {}, lab: true, shot: { url: `shots/u${line}.png`, box, page: "http://127.0.0.1:5173/labs/kit.html#gallery", pageName: "Labs › Kit.html › Gallery" } })
  const payload = withReview({
    serve: false, label: "Acme", targets: [{ name: "ledger", role: "consumer" }],
    elements: {
      threshold: 0.9, patterns: [], questions: [], shotsTaken: null, rendered: null, sources: {}, evals: [el("a")],
      proposals: { "Button#own1": { use: "Button", props: {}, check: "exact", url: "rendered/own.png", own: true, text: "Export" }, Button: { use: "Button", props: {}, check: "exact", url: "rendered/plain.png" } },
    },
  }, { audit: 1, system: [{ component: "Button", axes: {}, defaults: {} }], precedents: [use(1), use(2)] })
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

test("the look only on a lab page: it says so, in the caption and above it", async () => {
  const host = document.createElement("main")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<LabelReview />))
  const lab = host.querySelector('[data-slot="lab-examples"]')!
  expect(lab.textContent).toContain("dsa only has this look on a lab page, not in the product.")
  expect(lab.querySelectorAll('[data-slot="example"]').length).toBe(1)
  expect(lab.textContent).toContain("From a lab page, not the product (Labs › Kit.html › Gallery)")
  expect(lab.textContent).not.toContain("Photo, on")
})
