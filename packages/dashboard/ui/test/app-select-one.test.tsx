// @vitest-environment happy-dom
import { beforeAll, expect, test } from "vitest"
import { act } from "react"
import { createRoot } from "react-dom/client"

// A scan of one app has nothing to choose: no selector, and a link naming an app opens on that one
// app's page as it always did (all of it).

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let app: typeof import("@/lib/app"), sel: typeof import("@/components/app-select")

beforeAll(async () => {
  history.replaceState(null, "", "#overview?app=ledger")
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ run: { id: "r1" }, runs: [], targets: [{ name: "Core", role: "core" }, { name: "ledger", role: "consumer" }] })
  document.head.append(data)
  app = await import("@/lib/app")
  sel = await import("@/components/app-select")
})

test("one app: the selector is hidden and nothing is filtered", async () => {
  expect(app.APPS).toEqual(["ledger"])
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<><sel.AppSelect /><sel.AllAppsNote /></>))
  expect(host.innerHTML).toBe("")
  expect(app.routePath()).toBe("overview")
  await act(async () => root.unmount())
})
