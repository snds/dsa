// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// Redesign stage 8: five pages. Old links land where their content went; Health holds the measures,
// trends and readiness; Components holds Confirm / Correct for "Needs a check".

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let m: { App: any; Health: any; System: any; AgentProvider: any }

const comp = (name: string, o: object = {}) => ({ key: name.toLowerCase(), name, axes: [], parts: [], tokens: 0, evidence: { tier: "export", extractor: "ts", file: `core/src/${name}.tsx`, line: 1 }, inferred: false, uses: { consumer: 2, internal: 0, files: 1 }, ...o })

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({
    serve: true, label: "Sample", title: "Sample", run: { id: "r2", takenAt: "2026-11-16T12:00:00Z", sources: {} },
    targets: [{ name: "app-a", role: "consumer", versions: [], measures: {} }], thresholds: [], libraries: [{ name: "Core", packages: [] }], budget: 10,
    runs: [{ run_id: "r1", taken_at: "2026-11-09T12:00:00Z", consumers: 1, current_consumers: 1, correct_use: 70, token_compliance: 90, lookalikes: 3, instances: 8 }, { run_id: "r2", taken_at: "2026-11-16T12:00:00Z", consumers: 1, current_consumers: 1, correct_use: 80, token_compliance: 92, lookalikes: 2, instances: 8 }],
    queue: { items: [], prompt: "", github: { token: false, defaultRepo: null }, syncedAt: null },
    components: [], readiness: [{ subject: "app-a", score: 40, tier: "Emerging", checks: [], trend: [] }],
    model: { sources: { how: "pinned", read: ["core/src"] }, counts: { components: 2, parts: 0, icons: 0 },
      components: [comp("Button"), comp("Chip", { evidence: { tier: "convention", extractor: "name", file: "app/src/Chip.tsx", line: 1 } })] },
    componentChecks: {},
    issues: [{ key: "C-1", kind: "component-check", rule: "component", title: "Confirm Chip is a system component", certainty: "needs-person", component: "Chip", apps: [], owner: null, status: "open", source: { type: "component", name: "Chip" } }],
  })
  document.head.append(data)
  m = { App: (await import("@/App")).App, Health: (await import("@/views/Health")).Health, System: (await import("@/views/System")).System, AgentProvider: (await import("@/agent/store")).AgentProvider }
})

afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals() })

async function mount(node: React.ReactNode) {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(node))
  return host
}
const text = () => document.body.textContent ?? ""
// A tab's name without the Inbox's open count.
const tabs = () => [...document.querySelectorAll('[role="tab"]')].map(t => (t.textContent || t.getAttribute("aria-label") || "").replace(/\d+$/, ""))
const selected = () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.replace(/\d+$/, "")

test("the pages: Settings, Inbox, Conversations (live view), Components, Apps, Health", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ threads: {} }))))
  history.replaceState(null, "", "#inbox")
  await mount(<m.App />)
  // Conversations with the agent: a tab of their own under dsa serve (agentic Inbox).
  expect(tabs()).toEqual(["Settings", "Inbox", "Conversations", "Components", "Apps", "Health"])
  // Settings is named on screen, and the Inbox tab carries its open count (visual A, UX B).
  expect([...document.querySelectorAll('[role="tab"]')].map(t => t.textContent)).toContain("Inbox1")
})

test("old links open where their content went", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ threads: {} }))))
  for (const [hash, tab] of [["#overview", "Health"], ["#trends", "Health"], ["#readiness", "Health"], ["#system/check", "Components"], ["#components", "Components"], ["#queue", "Inbox"], ["#apps", "Apps"]] as const) {
    history.replaceState(null, "", hash)
    await mount(<m.App />)
    expect(selected(), hash).toBe(tab)
    await act(async () => root.unmount())
  }
})

test("Health: the measures, how sure the scan is, the lines over time and readiness; no to-do list", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ threads: {} }))))
  await mount(<m.AgentProvider><m.Health go={() => {}} /></m.AgentProvider>)
  expect(text()).toContain("Used as intended")
  expect(text()).toContain("How sure is this scan")
  expect(text()).toContain("Over time")
  expect(text()).toContain("Agent readiness and bench runs")
  expect(text()).not.toContain("What to do next")
  // One count and one certainty scale (UX A, B, C): Health counts issues as the Inbox does, in its words.
  expect(text()).toContain("Open issues1")
  expect(text()).toContain("0 measured · 0 inferred · 1 need a person")
  for (const old of ["Open actions", "definite", "to decide", "Estimated", "Custom look-alikes"]) expect(text()).not.toContain(old)
})

test("Components: a doubted component can be confirmed, and it leaves Needs a check", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ check: { verdict: "confirmed", who: "sample-user", date: "2026-11-16" } })))
  vi.stubGlobal("fetch", fetch)
  history.replaceState(null, "", "#system/check/chip")
  await mount(<m.AgentProvider><m.System /></m.AgentProvider>)
  const needs = () => [...document.querySelectorAll('[aria-label="Needs a check"]')].map(b => b.textContent)[0]
  expect(needs()).toContain("1")
  expect(text()).toContain("The scan isn't sure Chip")
  expect(text()).toContain("Confirm Chip is a system component")
  await act(async () => ([...document.querySelectorAll("button")].find(b => b.textContent === "Confirm") as HTMLButtonElement).click())
  expect(JSON.parse((fetch.mock.calls.at(-1) as any)[1].body)).toMatchObject({ name: "Chip", verdict: "confirmed" })
  expect(text()).toContain("Confirmed by sample-user")
  expect(needs()).toContain("0")
})
