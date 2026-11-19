// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// A published copy: conversations as of publishing, found by issue or app, shown in the Inbox, and
// carried on in GitHub. Issues discussed together are written out by their keys for the workflow.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let m: { PublishedConversations: any; PublishedThread: any; inboxHandoff: any }
let root: Root
beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ published: true, title: "Sample", label: "Sample", run: { id: "r1", takenAt: "x", sources: {} }, targets: [], issues: [],
    actions: { host: "github", thread: { url: "https://github.test/acme/ds/issues/new", search: "https://github.test/acme/ds/issues", label: "Discuss on GitHub", labels: ["dsa-thread"], help: "h" } },
    threads: { "set:S-1": { anchor: "set:S-1", title: "Two issues", state: "settled", updatedAt: "2026-11-18T00:00:00Z", turns: 2, openProposals: 0, pr: null, asked: "Same?", answer: "Yes.", proposals: [],
      about: [{ key: "F-2", label: "Second", app: "app-b" }, { key: "F-1", label: "First", app: "app-a" }] } } })
  document.head.append(data)
  m = { PublishedConversations: (await import("@/views/Conversations")).PublishedConversations, PublishedThread: (await import("@/agent/PublishedThread")).PublishedThread, inboxHandoff: (await import("@/views/Inbox")).inboxHandoff }
})
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = "" })
const mount = async (el: React.ReactNode) => { const host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(el)) }

test("lists the published conversations with their issues; On GitHub finds the set by its keys; Show in Inbox ticks them", async () => {
  await mount(<m.PublishedConversations />)
  const row = document.querySelector('ul[aria-label="Conversations"] > li')!
  expect(row.textContent).toContain("Second · app-b")
  const gh = [...row.querySelectorAll("a")].find(a => a.textContent === "On GitHub")!
  expect(new URL(gh.getAttribute("href")!).searchParams.get("q")).toContain('"dsa:thread set:F-1,F-2"')
  await act(async () => { [...row.querySelectorAll("button")].find(b => b.textContent === "Show in Inbox")!.click() })
  expect(m.inboxHandoff.ticks).toEqual(["F-2", "F-1"])
  expect(location.hash).toBe("#inbox/F-2")
})

test("Discuss on GitHub for ticked issues writes one issue whose marker lists them", async () => {
  await mount(<m.PublishedThread subject={{ kind: "set", items: [{ key: "F-2", title: "Second" }, { key: "F-1", title: "First" }] }} title="Two issues" />)
  const start = [...document.querySelectorAll("a")].find(a => /Start a new one|Discuss on GitHub/.test(a.textContent ?? ""))!
  expect(new URL(start.href).searchParams.get("body")).toContain("<!-- dsa:thread set:F-1,F-2 -->")
  expect(document.body.textContent).toContain("About:")
})
