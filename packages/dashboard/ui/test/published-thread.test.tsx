// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// Redesign stage 9: on a published page each issue shows its thread as of publishing (summaries
// only), and Discuss on GitHub opens an issue carrying the thread's anchor for the workflow.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let m: { Inbox: any; AgentProvider: any; host: typeof import("@/lib/host") }

const finding = (id: string, title: string) => ({ id, kind: "finding", status: "open", rule: "lookalike", scope: "consumer", title, owner: "app-a", affected: ["app-a"], score: 5, why: "why", evidence: "", fix: "", exit: "", issue: { title, body: "" }, history: [] })

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({
    serve: false, published: true, label: "Sample", run: { id: "r1", takenAt: "2026-11-16T12:00:00Z", sources: {} },
    targets: [{ name: "app-a", role: "consumer" }], runs: [], thresholds: [], libraries: [{ name: "Core", packages: [] }],
    queue: { items: [finding("F-1", "Raw buttons in app-a"), finding("F-2", "Overrides on Select")], prompt: "", github: { token: false, defaultRepo: null }, syncedAt: null },
    issues: [
      { key: "F-1", kind: "finding", rule: "lookalike", title: "Raw buttons in app-a", certainty: "inferred", component: "Button", apps: ["app-a"], owner: null, status: "open", source: { type: "queue", id: "F-1" } },
      { key: "F-2", kind: "finding", rule: "lookalike", title: "Overrides on Select", certainty: "inferred", component: "Select", apps: ["app-a"], owner: null, status: "open", source: { type: "queue", id: "F-2" } },
    ],
    threads: { "issue:F-1": { anchor: "issue:F-1", title: "Raw buttons in app-a", state: "in-pr", updatedAt: "2026-11-16T10:00:00Z", turns: 4, openProposals: 0, pr: { url: "https://github.com/sample-org/app-a/pull/7", number: 7 }, asked: "Can these be Button?", answer: "Yes: Button variant=primary.", proposals: [{ id: "P-1", kind: "decision", title: "3 element(s) → Button", status: "accepted" }] } },
    actions: { host: "github", rescan: { kind: "none", label: "Re-scan", help: "" }, decisions: { kind: "issue", url: "https://github.com/sample-org/app-a/issues/new", label: "File", help: "", apply: "" },
      thread: { url: "https://github.com/sample-org/app-a/issues/new", search: "https://github.com/sample-org/app-a/issues", label: "Discuss on GitHub", labels: ["dsa-thread"], help: "The agent replies there." } },
  })
  document.head.append(data)
  m = { Inbox: (await import("@/views/Inbox")).Inbox, AgentProvider: (await import("@/agent/store")).AgentProvider, host: await import("@/lib/host") }
})
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = "" })

async function mount(hash: string) {
  history.replaceState(null, "", hash)
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<m.AgentProvider><m.Inbox /></m.AgentProvider>))
}
const thread = () => document.querySelector('[aria-label="Thread for this issue"]') as HTMLElement | null

test("an issue with a thread shows its summary, state and draft PR, as of publishing", async () => {
  await mount("#inbox/F-1")
  const t = thread()!
  expect(t.textContent).toContain("In PR")
  expect(t.textContent).toContain("Can these be Button?")
  expect(t.textContent).toContain("Yes: Button variant=primary.")
  expect(t.textContent).toContain("accepted3 element(s) → Button")
  expect(t.querySelector('a[href="https://github.com/sample-org/app-a/pull/7"]')).not.toBeNull()
  // The row says the state too, as a label (nothing to open on a static page).
  expect(document.querySelector('[aria-label="Thread: In PR, as of publishing"]')).not.toBeNull()
})

test("Discuss on GitHub opens a labelled issue with the anchor marker; an issue with no thread says so", async () => {
  await mount("#inbox/F-2")
  expect(thread()!.textContent).toContain("No thread on this yet.")
  const a = [...thread()!.querySelectorAll("a")].find(x => x.textContent === "Discuss on GitHub")!
  const u = new URL(a.getAttribute("href")!)
  expect(u.origin + u.pathname).toBe("https://github.com/sample-org/app-a/issues/new")
  expect(u.searchParams.get("labels")).toBe("dsa-thread")
  expect(u.searchParams.get("title")).toBe("dsa: Overrides on Select")
  expect(u.searchParams.get("body")).toContain("<!-- dsa:thread issue:F-2 -->")
  const find = new URL([...thread()!.querySelectorAll("a")].find(x => x.textContent === "Find the discussion")!.getAttribute("href")!)
  expect(find.searchParams.get("q")).toBe('is:issue label:dsa-thread "issue:F-2"')
})
