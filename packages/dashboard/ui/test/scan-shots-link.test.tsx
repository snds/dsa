// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// A published page with no relay can only open GitHub's Run workflow form, not fill it in. So the
// split Re-scan keeps the setting and says what to pick on the form.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let App: typeof import("@/App")
let store: typeof import("@/lib/useScan")
let root: Root

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ published: true, runs: [], run: { id: "r1", takenAt: new Date().toISOString() }, actions: { host: "github", rescan: { kind: "link", url: "https://github.test/acme/site/actions/workflows/pages.yml", label: "Re-scan", help: "Opens the workflow.", shots: true } } })
  document.head.append(data)
  App = await import("@/App")
  store = await import("@/lib/useScan")
})

afterEach(async () => {
  await act(async () => store.setShots("normal"))
  await act(async () => root.unmount())
  document.body.innerHTML = ""
})

async function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<App.StaticRescan onPost={() => {}} />))
}

test("the link and its settings form one group, with no instruction by default", async () => {
  await mount()
  const group = document.querySelector('[data-slot="button-group"]')!
  expect(group.querySelector("a")!.getAttribute("href")).toContain("/actions/workflows/pages.yml")
  expect(group.querySelector('[aria-label="Re-scan settings"]')).toBeTruthy()
  expect(document.body.textContent).not.toContain("under Photos")
})

test("a chosen setting says what to pick on GitHub's form", async () => {
  await mount()
  await act(async () => store.setShots("fresh"))
  expect(document.body.textContent).toContain("There, choose fresh under Photos, then run the workflow.")
  expect(document.body.textContent).toContain("Photos: retake all")
})
