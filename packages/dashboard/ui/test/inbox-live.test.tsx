// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// From the nine-way review (UX A, B, C): answering, confirming or dismissing didn't move an issue until a
// full reload. With dsa serve, the Inbox now refreshes its issues after any change, and moves on.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let m: { Inbox: any; AgentProvider: any }
const issue = (key: string, title: string, status = "open") => ({ key, kind: "component-check", rule: "component", title, certainty: "needs-person", component: title.split(" ")[1], apps: [], owner: null, status, source: { type: "component", name: title.split(" ")[1] } })
let served: any[] = [issue("C-1", "Confirm Banner"), issue("C-2", "Confirm Card")]

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ serve: true, label: "Sample", run: { id: "r1", takenAt: "2026-11-16T12:00:00Z", sources: {} }, targets: [], runs: [], thresholds: [], libraries: [], elements: { questions: [], evals: [] }, issues: served })
  document.head.append(data)
  vi.stubGlobal("fetch", vi.fn(async (u: string) => ({ ok: true, json: async () => (String(u).includes("/api/issues") ? { issues: served } : {}) })))
  m = { Inbox: (await import("@/views/Inbox")).Inbox, AgentProvider: (await import("@/agent/store")).AgentProvider }
})
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = "" })

test("after a change, the Inbox refreshes: a confirmed issue leaves the open list and the next one is shown", async () => {
  history.replaceState(null, "", "#inbox/C-1")
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<m.AgentProvider><m.Inbox /></m.AgentProvider>))
  const count = (label: string) => [...document.querySelectorAll('[aria-label="Show"] button')].find(b => b.textContent?.startsWith(label))?.textContent
  expect(count("All open")).toContain("2")
  served = [issue("C-1", "Confirm Banner", "done"), issue("C-2", "Confirm Card")]
  await act(async () => { window.dispatchEvent(new CustomEvent("dsa:changed")); await new Promise(r => setTimeout(r, 400)) })
  expect(count("All open")).toContain("1")
  expect(count("Done")).toContain("1")
  expect(location.hash).toBe("#inbox/C-2")
})
