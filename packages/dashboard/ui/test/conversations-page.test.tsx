// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// The Conversations tab: every conversation that has messages, filtered by state or star, found by issue
// or app, and opened again where it belongs.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let m: { Conversations: any; AgentProvider: any; inboxHandoff: any }
let root: Root
const conv = (id: string, subject: any, o: object = {}) => ({ id, title: `Title ${id}`, subject, anchor: "", provider: "claude-code", turns: 2, asked: "What now?", updatedAt: "2026-11-18T00:00:00Z", createdAt: "x", state: "settled", openProposals: 0, running: false, ...o })
const LIST = [
  conv("S-1", { kind: "set", items: [{ key: "F-1", title: "Select overrides", app: "app-a" }, { key: "F-2", title: "DataTable className", app: "app-b" }] }, { state: "waiting-on-you", starred: true }),
  conv("S-2", { kind: "issue", key: "F-3", title: "Title S-2" }),
  conv("S-3", { kind: "scan" }, { turns: 0 }),
]

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ serve: true, title: "Sample", label: "Sample", run: { id: "r1", takenAt: "x", sources: {} }, targets: [], issues: [] })
  document.head.append(data)
  vi.stubGlobal("fetch", vi.fn(async (u: string) => ({ ok: true, json: async () => (String(u).includes("/api/agent/sessions") ? { sessions: LIST }
    : String(u).includes("/api/agent/threads") ? { threads: { [`set:${(await import("@/agent/store")).setKey(["F-1", "F-2"])}`]: { session: "S-1" } } } : {}) })))
  m = { Conversations: (await import("@/views/Conversations")).Conversations, AgentProvider: (await import("@/agent/store")).AgentProvider, inboxHandoff: (await import("@/views/Inbox")).inboxHandoff }
})
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = "" })

const rows = () => [...document.querySelectorAll('ul[aria-label="Conversations"] > li')]
async function mount() {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<m.AgentProvider><m.Conversations /></m.AgentProvider>))
  await act(async () => { await new Promise(r => setTimeout(r, 30)) })
}
const button = (t: RegExp) => [...document.querySelectorAll("button")].find(b => t.test(b.textContent ?? ""))!

test("lists conversations that have messages, with their chips; filters and find narrow them", async () => {
  await mount()
  expect(rows().length).toBe(2)
  expect(rows()[0]!.textContent).toContain("Select overrides · app-a")
  expect(rows()[1]!.querySelectorAll(".rounded-full.border").length, "one issue named like the conversation needs no chip").toBe(0)
  await act(async () => { button(/^Waiting on you/).click() })
  expect(rows().map(r => r.textContent)).toEqual([expect.stringContaining("Title S-1")])
  await act(async () => { button(/^All/).click() })
  const find = document.querySelector('input[aria-label="Find a conversation"]') as HTMLInputElement
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(find, "app-b"); find.dispatchEvent(new Event("input", { bubbles: true })) })
  expect(rows().length).toBe(1)
})

test("opening a conversation about issues goes back to the Inbox with them ticked", async () => {
  await mount()
  await act(async () => { [...rows()[0]!.querySelectorAll("button")].find(b => b.textContent === "Open")!.click() })
  expect(location.hash).toBe("#inbox/F-1")
  expect(m.inboxHandoff.ticks).toEqual(["F-1", "F-2"])
})
