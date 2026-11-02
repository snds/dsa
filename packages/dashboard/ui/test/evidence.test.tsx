// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// An action's evidence: its sentence and "N places" folded; open, one row per place with the checkout
// folder stripped and vendored code marked; each row opens a code reader that steps through them.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let cr: typeof import("@/components/code-reader")
let root: Root
const SHA = "0123456789abcdef0123456789abcdef01234567"
const lines = (n: number, mark: number) => Array.from({ length: n }, (_, i) => (i + 1 === mark ? `  <Separator className="mx-2" />` : `const v${i + 1} = "x" // ${i + 1}`))
const places = [
  { target: "ledger", file: "ledger-main/app/ToolbarDivider.tsx", line: 8, kind: "className" },
  { target: "ledger", file: "ledger-main/app/Filters.tsx", line: 30, kind: "className, style" },
  { target: "ledger", file: "vendor/acme-ui/src/filters/Body.tsx", line: 91, kind: "className", vendored: true },
]

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({
    serve: false,
    evidenceSources: {
      "ledger-main/app/ToolbarDivider.tsx": { repo: "acme/ledger", ref: SHA, rel: "app/ToolbarDivider.tsx", chunks: [{ start: 1, lines: lines(20, 8) }] },
      "ledger-main/app/Filters.tsx": { repo: "acme/ledger", ref: "main", rel: "app/Filters.tsx", chunks: [{ start: 18, lines: lines(25, 13) }] },
    },
  })
  document.head.append(data)
  cr = await import("@/components/code-reader")
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
const button = (name: RegExp) => [...document.querySelectorAll("button")].find(b => name.test(b.textContent ?? ""))!
const click = (el: Element) => act(async () => { (el as HTMLElement).click() })
const title = () => document.querySelector('[role="dialog"] h2')?.textContent

test("the checkout folder is stripped from paths; other first folders stay", () => {
  expect(cr.shortPath("ledger-main/app/ToolbarDivider.tsx")).toBe("app/ToolbarDivider.tsx")
  expect(cr.shortPath("ledger-master/src/a.tsx")).toBe("src/a.tsx")
  expect(cr.shortPath("vendor/acme-ui/src/Body.tsx")).toBe("vendor/acme-ui/src/Body.tsx")
})

test("collapsed: the sentence and the count; open: one row per place, vendored marked", async () => {
  await mount(<cr.Evidence text="ignored" summary="5 of 17 instances overridden (5 className)." places={places} />)
  expect(document.body.textContent).toContain("5 of 17 instances overridden (5 className).")
  const toggle = button(/3 places/)
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  expect(toggle.textContent).toContain("1 vendored")
  expect(document.body.textContent).not.toContain("ToolbarDivider")
  await click(toggle)
  const rows = [...document.querySelectorAll('[aria-label="Places"] li')].map(li => li.textContent)
  expect(rows).toEqual(["app/ToolbarDivider.tsx:8className", "app/Filters.tsx:30className, style", "vendor/acme-ui/src/filters/Body.tsx:91classNameVendored"])
})

test("older reports without places keep their text", async () => {
  const host = await mount(<cr.Evidence text="Pinned abc; latest def." />)
  expect(host.textContent).toBe("Pinned abc; latest def.")
})

test("a row opens the code reader: path in the title, the line marked, highlighted, linked to the commit", async () => {
  await mount(<cr.Evidence text="" summary="s" places={places} />)
  await click(button(/3 places/))
  await click(button(/ToolbarDivider/))
  const d = document.querySelector('[role="dialog"]')!
  expect(title()).toBe("app/ToolbarDivider.tsx:8")
  expect(d.textContent).toContain("Place 1 of 3")
  const marked = d.querySelector('[aria-current="true"]')!
  expect(marked.getAttribute("data-line")).toBe("8")
  expect(marked.querySelector("code span")).toBeTruthy()
  expect(d.querySelectorAll("[data-line]").length).toBe(20)
  const open = [...d.querySelectorAll("a")].find(a => /Open on GitHub/.test(a.textContent ?? ""))!
  expect(open.getAttribute("href")).toBe(`https://github.com/acme/ledger/blob/${SHA}/app/ToolbarDivider.tsx#L8`)
  expect(button(/Copy path:line/)).toBeTruthy()
})

test("prev and next step through the places, by button and by arrows or J/K", async () => {
  await mount(<cr.Evidence text="" summary="s" places={places} />)
  await click(button(/3 places/))
  await click(button(/ToolbarDivider/))
  await click(button(/^Next/))
  expect(title()).toBe("app/Filters.tsx:30")
  // A moving branch is not a commit: no "Open on GitHub".
  expect([...document.querySelectorAll('[role="dialog"] a')].some(a => /Open on GitHub/.test(a.textContent ?? ""))).toBe(false)
  const key = (k: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })) })
  await key("ArrowRight")
  expect(title()).toBe("vendor/acme-ui/src/filters/Body.tsx:91")
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Vendored: not this team's code")
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("aren't in this page")
  await key("j")
  expect(title()).toBe("app/ToolbarDivider.tsx:8")
  await key("k")
  expect(title()).toBe("vendor/acme-ui/src/filters/Body.tsx:91")
  await click(button(/^Previous/))
  expect(title()).toBe("app/Filters.tsx:30")
})

test("the highlighter marks comments, strings and keywords", async () => {
  const host = await mount(<code>{cr.highlight(`const a = "b" // c`)}</code>)
  expect([...host.querySelectorAll("span")].map(s => s.textContent)).toEqual(["const", '"b"', "// c"])
})
