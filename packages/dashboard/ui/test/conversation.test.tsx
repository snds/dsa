// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// The agentic Inbox's right column: a conversation about the ticked issues, or the open one. Before the
// first message it follows the selection; after it, a change of ticks asks: Add to this, or Start new.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let m: { Conversation: any; AgentProvider: any }
let root: Root
const issue = (key: string) => ({ key, title: `Issue ${key}`, source: { type: "queue", id: key }, apps: ["app-a"] })
const one = (i: any) => ({ kind: "issue", key: i.key, title: i.title, source: i.source })
let posted: any[] = []
// F-1 has a conversation with a message already; everything else has none.
const session = (subject: any, messages: any[]) => ({ id: "S-1", title: "t", subject, provider: "claude-code", mode: "advise", repo: { name: "core", dir: "/x" }, sandbox: null, brief: "", starters: [], messages })

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ serve: true, title: "Sample", label: "Sample", run: { id: "r1", takenAt: "2026-11-18T00:00:00Z", sources: {} }, targets: [], issues: [] })
  document.head.append(data)
  vi.stubGlobal("fetch", vi.fn(async (u: string, o?: any) => {
    const body = o?.body ? JSON.parse(o.body) : null
    if (body) posted.push({ url: String(u), body })
    const json = String(u).includes("/api/agent/threads") ? { threads: { "issue:F-1": { anchor: "issue:F-1", session: "S-1", title: "t", state: "waiting-on-you", updatedAt: "x", openProposals: 0, turns: 1, pr: null, previous: [] } } }
      : String(u).includes("/api/agent/session?id=") ? { session: session(one(issue("F-1")), [{ role: "user", text: "hi", at: "x" }]), proposals: [] }
      : String(u).includes("/api/agent/scope") ? { session: session(body.subject, [{ role: "user", text: "hi", at: "x" }]) }
      : {}
    return { ok: true, json: async () => json }
  }))
  m = { Conversation: (await import("@/agent/Conversation")).Conversation, AgentProvider: (await import("@/agent/store")).AgentProvider }
})
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; posted = [] })

async function mount(scope: any[], fromTicks: boolean) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host)
  const render = async (s: any[], t: boolean) => act(async () => root.render(<m.AgentProvider><m.Conversation scope={s} fromTicks={t} one={one} appOf={() => "app-a"} onUntick={() => {}} /></m.AgentProvider>))
  await render(scope, fromTicks)
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  return render
}
const chips = () => [...document.querySelectorAll("section .rounded-full.border")].map(c => c.textContent)

test("with a conversation going, ticking more asks first; Add to this widens the same conversation", async () => {
  const render = await mount([issue("F-1")], false)
  expect(chips()).toEqual(["Issue F-1· app-a"])
  await render([issue("F-1"), issue("F-2")], true)
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  expect(document.body.textContent).toContain("Selection changed: 2 ticked.")
  expect(chips()).toEqual(["Issue F-1· app-a"])
  const add = [...document.querySelectorAll("button")].find(b => b.textContent === "Add to this")!
  await act(async () => { add.click(); await new Promise(r => setTimeout(r, 20)) })
  const scope = posted.find(p => p.url.includes("/api/agent/scope"))!
  expect(scope.body).toMatchObject({ id: "S-1", subject: { kind: "set", items: [{ key: "F-1" }, { key: "F-2" }] } })
  expect(chips().length).toBe(2)
})

test("Start new leaves the conversation and follows the ticks", async () => {
  const render = await mount([issue("F-1")], false)
  await render([issue("F-3"), issue("F-4")], true)
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  const fresh = [...document.querySelectorAll("button")].find(b => b.textContent === "Start new")!
  await act(async () => { fresh.click(); await new Promise(r => setTimeout(r, 20)) })
  expect(chips().map(c => c?.replace(/·.*/, ""))).toEqual(["Issue F-3", "Issue F-4"])
  expect(posted.some(p => p.url.includes("/api/agent/scope"))).toBe(false)
})

test("before anything is said, the chips simply follow the selection", async () => {
  const render = await mount([issue("F-7")], false)
  await render([issue("F-7"), issue("F-8")], true)
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  expect(document.body.textContent).not.toContain("Selection changed")
  expect(chips().length).toBe(2)
  expect(document.body.textContent).toContain("From the 2 ticked issues.")
})
