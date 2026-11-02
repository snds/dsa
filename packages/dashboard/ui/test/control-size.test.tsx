// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import fs from "node:fs"
import path from "node:path"

// One size scale for every control: a row sets it once and every button, split button, field and
// toggle in it matches. And no one-off heights, paddings or font sizes on controls in the views.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let ui: { Button: any; Input: any; NativeSelect: any; ControlSize: any; ToggleGroup: any; ToggleGroupItem: any; AskAgent: any; AgentProvider: any }
let root: Root

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ serve: false })
  document.head.append(data)
  ui = {
    ...(await import("@/components/ui/button")),
    ...(await import("@/components/ui/input")),
    ...(await import("@/components/ui/native-select")),
    ...(await import("@/components/ui/control-size")),
    ...(await import("@/components/ui/toggle-group")),
    ...(await import("@/agent/AskAgent")),
    ...(await import("@/agent/store")),
  } as any
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
const HEIGHT = /\b(?:h|size)-control(?:-sm|-lg)?\b/
// Buttons carry their size's class; fields switch on data-size (data-[size=sm]:h-control-sm).
const heightOf = (el: Element) => {
  const ds = el.getAttribute("data-size")
  if (ds && ds !== "default" && el.className.includes(`data-[size=${ds}]:h-control-${ds}`)) return `h-control-${ds}`
  return el.className.match(HEIGHT)?.[0]?.replace(/^size-/, "h-") ?? null
}

test("each size maps to one token height, for buttons and icon buttons alike", async () => {
  const { Button } = ui
  const host = await mount(<>
    <Button>Default</Button><Button size="icon" aria-label="i" />
    <Button size="sm">Small</Button><Button size="icon-sm" aria-label="i" />
    <Button size="lg">Large</Button><Button size="icon-lg" aria-label="i" />
  </>)
  expect([...host.querySelectorAll("button")].map(heightOf)).toEqual(["h-control", "h-control", "h-control-sm", "h-control-sm", "h-control-lg", "h-control-lg"])
})

test("a row's size reaches every control in it: buttons, the split button's halves, fields and toggles", async () => {
  const { Button, Input, NativeSelect, ControlSize, ToggleGroup, ToggleGroupItem, AskAgent, AgentProvider } = ui
  for (const size of ["sm", "default", "lg"] as const) {
    const host = await mount(
      <AgentProvider>
        <ControlSize size={size}>
          <div data-row>
            <Button>Create Issue</Button>
            <Button variant="outline">Copy Issue</Button>
            <AskAgent subject={{ kind: "queue", id: "F-1" }} label="Work on this with the agent" />
            <Input aria-label="Note" />
            <NativeSelect aria-label="Pick"><option>One</option></NativeSelect>
            <ToggleGroup><ToggleGroupItem value="a">A</ToggleGroupItem></ToggleGroup>
          </div>
        </ControlSize>
      </AgentProvider>,
    )
    const want = size === "default" ? "h-control" : `h-control-${size}`
    const controls = host.querySelectorAll('[data-row] button, [data-row] input, [data-row] select')
    expect(controls.length).toBe(7)
    for (const c of controls) expect([c.textContent || c.getAttribute("aria-label"), heightOf(c)]).toEqual([c.textContent || c.getAttribute("aria-label"), want])
    await act(async () => root.unmount())
  }
})

test("the split button's halves sit flush: one group, the reason for disabling on the group", async () => {
  const { AskAgent, AgentProvider } = ui
  const host = await mount(<AgentProvider><AskAgent subject={{ kind: "queue", id: "F-1" }} /></AgentProvider>)
  const group = host.querySelector('[data-slot="button-group"]')!
  const halves = [...group.children]
  expect(halves.map(h => h.tagName)).toEqual(["BUTTON", "BUTTON"])
  expect(halves.every(h => h.hasAttribute("data-slot"))).toBe(true)
  // The group squares and joins its direct [data-slot] children, so both halves must be direct children.
  expect(group.className).toContain("[&>[data-slot]~[data-slot]]:rounded-l-none")
  expect(group.className).toContain("[&>[data-slot]~[data-slot]]:border-l-0")
  // Not served: both disabled, still readable, and the tooltip trigger wraps the whole group.
  expect(halves.every(h => (h as HTMLButtonElement).disabled)).toBe(true)
  expect(group.parentElement!.getAttribute("tabindex")).toBe("0")
})

test("views don't override a control's height, padding or font size", () => {
  const src = path.resolve(import.meta.dirname, "../src")
  const files = fs.readdirSync(src, { recursive: true }).map(String).filter(f => f.endsWith(".tsx") && !f.startsWith(`components${path.sep}ui`))
  // Suggestion chips in the agent panel wrap their text on purpose; they aren't a control row.
  const allowed = new Set(["agent/AgentPanel.tsx:h-auto", "agent/AgentPanel.tsx:py-1"])
  const bad: string[] = []
  for (const f of files) {
    const text = fs.readFileSync(path.join(src, f), "utf8")
    for (const m of text.matchAll(/<(Button|Input|NativeSelect|SelectTrigger|ToggleGroupItem|Toggle)\b[^>]*?className="([^"]*)"/g)) {
      for (const cls of m[2]!.split(/\s+/)) {
        if (/^(h-(?!full|auto)\d|h-auto|py-\d|text-(xs|sm|base|lg|\[))/.test(cls) && !allowed.has(`${f.split(path.sep).join("/")}:${cls}`)) bad.push(`${f}: <${m[1]} className="…${cls}…">`)
      }
    }
  }
  expect(bad).toEqual([])
})
