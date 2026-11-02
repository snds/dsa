// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// One page for every role: no "View as" picker, highlights first, and the same disclosure control
// for details and technical details everywhere, keyboard- and screen-reader-friendly and linkable.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let bits: typeof import("@/components/bits")
let system: typeof import("@/views/System")
let root: Root

beforeAll(async () => {
  // Node 25's own localStorage (methodless without --localstorage-file) can shadow the DOM's: use a plain one.
  const m = new Map<string, string>()
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } })
  localStorage.setItem("dsa.role", "engineer")
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({
    libraries: [{ name: "Core" }],
    components: [{ component: "Button", instances: 10, overridden_pct: 20, lookalikes: 2 }],
    model: {
      counts: { components: 1, parts: 0, icons: 0 },
      components: [{ key: "core:Button", name: "Button", library: "Core", kind: { kind: "button", confidence: 0.92 }, axes: [{ name: "variant", values: ["solid", "outline"] }], parts: ["ButtonIcon"], tokens: 4,
        uses: { consumer: 10, files: 3 }, evidence: { tier: "declaration", file: "src/button/Button.tsx", line: 12, extractor: "tsx" } }],
    },
  })
  document.head.append(data)
  bits = await import("@/components/bits")
  await import("@/lib/insight")
  system = await import("@/views/System")
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  document.body.innerHTML = ""
  history.replaceState(null, "", "#")
})

async function mount(node: React.ReactNode) {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(node))
}
const button = (name: RegExp) => [...document.querySelectorAll("button")].find(b => name.test(b.textContent ?? ""))!
const click = (el: Element) => act(async () => { (el as HTMLElement).click() })

test("the old 'View as' choice is forgotten", () => {
  expect(localStorage.getItem("dsa.role")).toBeNull()
})

test("a disclosure is a button with aria-expanded that opens a labelled region", async () => {
  await mount(<bits.Disclosure label="Technical details" hint="paths"><p>src/a.tsx:3</p></bits.Disclosure>)
  const t = button(/Technical details/)
  expect(t.getAttribute("aria-expanded")).toBe("false")
  expect(document.body.textContent).not.toContain("src/a.tsx:3")
  await click(t)
  expect(t.getAttribute("aria-expanded")).toBe("true")
  const region = document.querySelector('[role="region"]')!
  expect(region.getAttribute("aria-labelledby")).toBe(t.id)
  expect(region.textContent).toContain("src/a.tsx:3")
})

test("a disclosure with a hash is linkable: opening writes it, and a link opens it", async () => {
  await mount(<bits.Disclosure label="Technical details" hash="queue/f1/details" closedHash="queue/f1"><p>evidence</p></bits.Disclosure>)
  await click(button(/Technical details/))
  expect(location.hash).toBe("#queue/f1/details")
  await click(button(/Technical details/))
  expect(location.hash).toBe("#queue/f1")
  await act(async () => root.unmount())
  history.replaceState(null, "", "#queue/f1/details")
  await mount(<bits.Disclosure label="Technical details" hash="queue/f1/details"><p>evidence</p></bits.Disclosure>)
  expect(button(/Technical details/).getAttribute("aria-expanded")).toBe("true")
})

test("System shows the highlights first; variants, parts, tokens and the file open per component", async () => {
  history.replaceState(null, "", "#system/all")
  await mount(<system.System />)
  const heads = [...document.querySelectorAll("th")].map(th => th.textContent)
  expect(heads).toEqual(["Component", "Kind", "App uses", "Used as intended", "Look-alikes", "Found by"])
  expect(document.body.textContent).not.toContain("src/button/Button.tsx")
  const row = button(/^Button/)
  expect(row.getAttribute("aria-expanded")).toBe("false")
  await click(row)
  expect(row.getAttribute("aria-expanded")).toBe("true")
  const region = document.getElementById(row.getAttribute("aria-controls")!)!
  expect(region.getAttribute("role")).toBe("region")
  expect(region.textContent).toContain("variant: solid, outline")
  expect(region.textContent).toContain("src/button/Button.tsx:12")
  expect(location.hash).toBe("#system/all/core%3AButton")
})

test("a link to a component opens its details", async () => {
  history.replaceState(null, "", "#system/all/core%3AButton")
  await mount(<system.System />)
  expect(button(/^Button/).getAttribute("aria-expanded")).toBe("true")
})
