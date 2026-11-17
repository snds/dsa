// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// The Inbox (redesign stage 4): every issue in one list, grouped by component, filtered by what needs
// whom, each with one certainty word; J / K move, X ticks; the app selector applies.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let m: { Inbox: any; AgentProvider: any; sel: typeof import("@/components/app-select"); app: typeof import("@/lib/app") }

const issue = (key: string, kind: string, title: string, certainty: string, component: string | null, apps: string[], status = "open", source: any = { type: "queue", id: key }) =>
  ({ key, kind, rule: kind, title, certainty, component, apps, owner: null, status, source })
const finding = (id: string, title: string, app: string) => ({ id, kind: "finding", status: "open", rule: "lookalike", scope: "consumer", title, owner: app, affected: [app], score: 5, why: "why", evidence: "", fix: "", exit: "", issue: { title, body: "" }, history: [] })

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({
    serve: false, label: "Sample", run: { id: "r1", takenAt: "2026-11-16T12:00:00Z", sources: {} },
    targets: [{ name: "app-a", role: "consumer" }, { name: "app-b", role: "consumer" }], runs: [], thresholds: [], libraries: [{ name: "Core", packages: [] }],
    queue: { items: [finding("F-1", "Overrides on Select", "app-a"), finding("F-2", "Raw buttons", "app-b")], prompt: "", github: { token: false, defaultRepo: null }, syncedAt: null },
    elements: { threshold: 0.9, evals: [], questions: [{ key: "q1", ids: ["e1"], title: "Is this a Select?" }], patterns: [], proposals: {} },
    issues: [
      issue("F-1", "finding", "Overrides on Select", "inferred", "Select", ["app-a"]),
      issue("F-2", "finding", "Raw buttons", "measured", "Button", ["app-b"]),
      issue("Q-1", "question", "Is this a Select?", "needs-person", "Select", ["app-a"], "open", { type: "question", key: "q1" }),
      issue("C-1", "component-unused", "Tabs is not used by any app", "measured", "Tabs", []),
      issue("F-9", "finding", "Old one", "measured", "Button", ["app-b"], "done"),
    ],
  })
  document.head.append(data)
  m = { Inbox: (await import("@/views/Inbox")).Inbox, AgentProvider: (await import("@/agent/store")).AgentProvider, sel: await import("@/components/app-select"), app: await import("@/lib/app") }
})

afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ""; m.app.setApp(null) })

async function mount() {
  history.replaceState(null, "", "#inbox")
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<m.AgentProvider><m.sel.AppSelect /><m.Inbox /></m.AgentProvider>))
  return host
}
const text = () => document.body.textContent ?? ""
const groups = () => [...document.querySelectorAll('[aria-label="Issues"] section')].map(s => s.getAttribute("aria-label"))
const filter = (label: string) => [...document.querySelectorAll('[aria-label="Show"] button')].find(b => b.textContent?.startsWith(label)) as HTMLButtonElement
const key = (k: string, shift = false) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true })) })

test("one row per issue, grouped by component, each with one certainty word", async () => {
  await mount()
  expect(groups()).toEqual(["Select", "Button", "Tabs"])
  for (const w of ["Measured", "Inferred", "Needs a person"]) expect(text()).toContain(w)
  expect(text()).not.toContain("Old one")
  expect(text()).toContain("4 open issues. 1 need a person.")
})

test("filters count what they show; Done shows only done ones", async () => {
  await mount()
  expect(filter("Needs a person").textContent).toContain("1")
  await act(async () => filter("Measured").click())
  expect(text()).toContain("Raw buttons")
  expect(text()).not.toContain("Overrides on Select")
  await act(async () => filter("Done").click())
  expect(text()).toContain("Old one")
  expect(text()).not.toContain("Raw buttons")
})

test("the app selector narrows the Inbox to that app's issues", async () => {
  await mount()
  await act(async () => { const s = document.querySelector<HTMLSelectElement>('select[aria-label="App"]')!; s.value = "app-b"; s.dispatchEvent(new Event("change", { bubbles: true })) })
  expect(groups()).toEqual(["Button"])
  expect(text()).toContain("in app-b")
})

test("J moves the selection and the address, X ticks, Esc clears", async () => {
  await mount()
  // The first issue opens with its detail (the Actions panel for a finding).
  expect(text()).toContain("Why them")
  await key("j")
  expect(location.hash).toContain("inbox/Q-1")
  await key("x")
  expect(text()).toContain("1 ticked")
  await key("Escape")
  expect(text()).not.toContain("1 ticked")
})

test("group by app and by kind", async () => {
  await mount()
  await act(async () => ([...document.querySelectorAll('[aria-label="Group by"] button')].find(b => b.textContent === "Kind") as HTMLButtonElement).click())
  expect(groups()).toEqual(["Finding", "Unused component", "Question"])
  await act(async () => ([...document.querySelectorAll('[aria-label="Group by"] button')].find(b => b.textContent === "App") as HTMLButtonElement).click())
  expect(groups()).toEqual(["app-a", "app-b", "Every app"])
})
