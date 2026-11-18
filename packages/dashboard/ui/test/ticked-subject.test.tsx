// @vitest-environment happy-dom
import { beforeAll, expect, test } from "vitest"

// Ticked issues share one thread: their component when they all have one, else the whole scan
// (UX review A U-14, C U-18: it used the first ticked issue's subject).

let tickedSubject: (list: any[]) => any
beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ title: "Sample", label: "Sample", run: { id: "r1", takenAt: "2026-11-16T12:00:00Z", sources: {} }, targets: [], issues: [] })
  document.head.append(data)
  ;({ tickedSubject } = await import("@/views/Inbox"))
})

const issue = (key: string, component: string | null) => ({ key, component, apps: [], kind: "finding", title: key })

test("all about one component: a thread about that component", () => {
  expect(tickedSubject([issue("F-1", "Select"), issue("F-2", "Select")])).toMatchObject({ kind: "group", by: "component", value: "Select" })
})

test("mixed components, or none: one thread about the scan", () => {
  expect(tickedSubject([issue("F-1", "Select"), issue("F-2", "Button")])).toEqual({ kind: "scan" })
  expect(tickedSubject([issue("F-1", null), issue("F-2", null)])).toEqual({ kind: "scan" })
})
