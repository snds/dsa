// @vitest-environment happy-dom
import { beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"

// A report published before measures were split by app: choosing an app filters what can be split
// (actions, the Apps table) and says, where a number covers every app, that it isn't split yet.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const NOTE = "isn't split by app yet"
let m: { app: typeof import("@/lib/app"); Trends: any; System: any; Overview: any }

beforeAll(async () => {
  history.replaceState(null, "", "#overview?app=ledger")
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  const run = (id: string) => ({ run_id: id, taken_at: "2026-10-06T12:00:00Z", consumers: 2, current_consumers: 1, correct_use: 75, token_compliance: 90, lookalikes: 4, instances: 8 })
  data.textContent = JSON.stringify({
    run: { id: "r2" }, runs: [run("r1"), run("r2")], thresholds: [], libraries: [],
    targets: [{ name: "atlas", role: "consumer", correctUse: 100, worstMajors: 0, lookalikes: 1 }, { name: "ledger", role: "consumer", correctUse: 50, worstMajors: 2, lookalikes: 3 }],
    components: [{ component: "Button", library: "Core", instances: 8, consumers: 2, overridden_pct: 37.5, lookalikes: 4 }],
    model: { sources: { how: "pinned", read: [] }, counts: { components: 1, parts: 0, icons: 0 },
      components: [{ key: "button", name: "Button", axes: [], parts: [], tokens: 0, evidence: { tier: "export", extractor: "ts", file: "x.tsx" }, inferred: false, uses: { consumer: 8, internal: 0, files: 3 } }] },
  })
  document.head.append(data)
  m = { app: await import("@/lib/app"), Trends: (await import("@/views/Trends")).Trends, System: (await import("@/views/System")).System, Overview: (await import("@/views/Overview")).Overview }
})

async function render(node: React.ReactNode) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(node))
  const t = host.textContent ?? ""
  await act(async () => root.unmount())
  return t
}

test("a link with an app opens on it", () => {
  expect(m.app.APPS).toEqual(["atlas", "ledger"])
  expect(m.app.hashFor("system")).toBe("#system?app=ledger")
})

test("Trends and System keep the all-apps numbers and say they aren't split", async () => {
  const trends = await render(<m.Trends />)
  expect(trends).toContain("this report doesn't keep trends per app yet")
  expect(trends).toContain("Used as intended (avg)")
  expect(trends).not.toContain("· ledger")
  const system = await render(<m.System />)
  expect(system).toContain("this report doesn't split them by app yet")
  expect(system).toContain("App uses")
  expect(system).not.toContain("Uses in ledger")
})

test("Overview falls back to the Apps table's numbers for this run, with no change to show", async () => {
  const o = await render(<m.Overview go={() => {}} />)
  expect(o).toContain("Majors behind")
  expect(o).toContain("50%")
  expect(o).toContain("First measurement")
  expect(o).not.toContain(NOTE)
})

test("nothing says so on all apps", async () => {
  m.app.setApp(null)
  expect(await render(<m.Trends />)).not.toContain("per app")
})
