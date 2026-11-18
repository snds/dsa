// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// design review: the line under the title listed every source and note. It's now a short timestamp, and
// the rest opens in a flyout on hover, focus or tap.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let App: typeof import("@/App")
let root: Root
const hour = new Date(Date.now() - 3600_000).toISOString()

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ published: true, generatedAt: hour, runs: [], run: { id: "r1", takenAt: hour }, elements: { shotsTaken: hour, drawingsTaken: hour, evals: [], questions: [] },
    live: { state: "unchecked", head: "3de9588abc", label: "Scanned the checkout as it is." },
    actions: { host: "github", decisions: { kind: "issue" }, rescan: { kind: "issue", label: "Re-scan", help: "Opens an issue.", url: "https://github.test/acme/site/issues/new" } } })
  document.head.append(data)
  App = await import("@/App")
})
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = "" })

test("the line is a short timestamp; focus opens the details, with each source and what Re-scan does", async () => {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<App.ScanInfo figma={null} />))
  const trigger = host.querySelector("button")!
  expect(trigger.textContent).toBe("Scanned 1 hour ago · snapshot")
  expect(document.body.textContent).not.toContain("Photos")
  await act(async () => { trigger.focus() })
  const details = document.querySelector('[data-slot="popover-content"]')!
  expect(details.textContent).toContain("Scan details")
  for (const s of ["run r1", "Photos", "Drawings", "Checkout 3de9588", "A static copy", "Re-scan opens a filled-in GitHub issue"]) expect(details.textContent).toContain(s)
})
