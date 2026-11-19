// @vitest-environment happy-dom
import { beforeAll, expect, test } from "vitest"

// Ticked issues are one conversation about exactly those issues (agentic Inbox). Before, it was their
// component's thread or the whole scan (UX review A U-14, C U-18).

let tickedSubject: (list: any[]) => any
beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ title: "Sample", label: "Sample", run: { id: "r1", takenAt: "2026-11-16T12:00:00Z", sources: {} }, targets: [], issues: [] })
  document.head.append(data)
  ;({ tickedSubject } = await import("@/views/Inbox"))
})

const issue = (key: string, component: string | null, app = "app-a") => ({ key, component, apps: [app], kind: "finding", title: key, source: { type: "queue", id: key } })

test("several ticked issues: one set, each with its app", () => {
  expect(tickedSubject([issue("F-1", "Select"), issue("F-2", "Button", "app-b")])).toEqual({ kind: "set", items: [
    { key: "F-1", title: "F-1", source: { type: "queue", id: "F-1" }, app: "app-a" },
    { key: "F-2", title: "F-2", source: { type: "queue", id: "F-2" }, app: "app-b" },
  ] })
})

test("one ticked issue: that issue's own conversation", () => {
  expect(tickedSubject([issue("F-1", null)])).toMatchObject({ kind: "issue", key: "F-1" })
})
