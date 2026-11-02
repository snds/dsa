// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// One app selector for the whole page: in the header, it filters every view to one app; the choice
// rides in the address bar after the route, so links and reloads keep it and old links open on all
// apps; and a number the report doesn't split by app says so instead of passing for that app's.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let m: {
  app: typeof import("@/lib/app"); sel: typeof import("@/components/app-select")
  Overview: any; Queue: any; Federation: any; System: any; Trends: any; Readiness: any; Elements: any; AgentProvider: any
}

const target = (name: string, o: object) => ({ name, role: "consumer", versions: [], measures: {}, deprecated: 0, ...o })
const run = (id: string, at: string, ledger: object, atlas: object) => ({
  run_id: id, taken_at: at, consumers: 2, current_consumers: 1, correct_use: 75, token_compliance: 90, lookalikes: 4, instances: 8,
  byTarget: { ledger: { correct_use: 50, token_compliance: 80, majors: 2, lookalikes: 3, instances: 4, ...ledger }, atlas: { correct_use: 100, token_compliance: 100, majors: 0, lookalikes: 1, instances: 4, ...atlas } },
})
const finding = (id: string, title: string, app: string, rule = "version-currency") => ({ id, kind: "finding", status: "open", rule, scope: "consumer", title, owner: app, affected: [app], score: 5, why: "", evidence: "", fix: "", exit: "", issue: { title, body: "" }, history: [] })
const evalOf = (id: string, app: string) => ({ id, target: app, file: `${app}/src/Toolbar.tsx`, line: 3, element: "button", verdict: "replace", role: "button", use: "Button", props: {}, confidence: 0.97, needsHuman: false, decided: null, exception: null, family: "button", title: "Buttons", home: "Button", span: 1, shot: null, rendered: null, systemPreview: null, reasons: [], alternatives: [], signature: { variant: null, size: null } })

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({
    serve: false, label: "Acme", run: { id: "r2", takenAt: "2026-10-06T12:00:00Z", sources: {} },
    targets: [target("atlas", { worstMajors: 0, correctUse: 100, tokenCompliance: 100, instances: 4, lookalikes: 1, openFindings: 1 }), target("ledger", { worstMajors: 2, correctUse: 50, tokenCompliance: 80, instances: 4, lookalikes: 3, openFindings: 1 })],
    runs: [run("r1", "2026-09-29T12:00:00Z", { correct_use: 40 }, {}), run("r2", "2026-10-06T12:00:00Z", {}, {})],
    thresholds: [], libraries: [{ name: "Core", packages: [] }], budget: 10,
    queue: { items: [finding("F-1", "Upgrade ledger", "ledger"), finding("F-2", "Upgrade atlas", "atlas"), finding("F-3", "Replace raw buttons in ledger", "ledger", "lookalike")], prompt: "p", github: { token: false, defaultRepo: null }, syncedAt: null },
    components: [{ component: "Button", library: "Core", instances: 8, consumers: 2, overridden_pct: 37.5, lookalikes: 4, deprecated: false, replacement: null,
      byTarget: { ledger: { instances: 4, overridden_pct: 75, files: 1, lookalikes: 3 }, atlas: { instances: 4, overridden_pct: 0, files: 2, lookalikes: 1 } } }],
    model: { sources: { how: "pinned", read: ["core/src"] }, counts: { components: 2, parts: 0, icons: 0 },
      components: [
        { key: "button", name: "Button", axes: [], parts: [], tokens: 0, evidence: { tier: "export", extractor: "ts", file: "core/src/Button.tsx", line: 1 }, inferred: false, uses: { consumer: 8, internal: 0, files: 3, byTarget: { ledger: { consumer: 4, files: 1 }, atlas: { consumer: 4, files: 2 } } } },
        { key: "tabs", name: "Tabs", axes: [], parts: [], tokens: 0, evidence: { tier: "export", extractor: "ts", file: "core/src/Tabs.tsx", line: 1 }, inferred: false, uses: { consumer: 2, internal: 0, files: 1, byTarget: { atlas: { consumer: 2, files: 1 } } } },
      ] },
    readiness: [{ subject: "ledger", score: 40, tier: "Emerging", checks: [], trend: [] }, { subject: "atlas", score: 80, tier: "Invested", checks: [], trend: [] }],
    elements: { threshold: 0.9, evals: [evalOf("e1", "ledger"), evalOf("e2", "ledger"), evalOf("e3", "atlas")], questions: [], patterns: [], shotsTaken: null, rendered: null, proposals: {} },
  })
  document.head.append(data)
  m = {
    app: await import("@/lib/app"), sel: await import("@/components/app-select"),
    Overview: (await import("@/views/Overview")).Overview, Queue: (await import("@/views/Queue")).Queue, Federation: (await import("@/views/Federation")).Federation,
    System: (await import("@/views/System")).System, Trends: (await import("@/views/Trends")).Trends, Readiness: (await import("@/views/Readiness")).Readiness,
    Elements: (await import("@/views/elements/Elements")).Elements, AgentProvider: (await import("@/agent/store")).AgentProvider,
  }
})

beforeEach(() => { history.replaceState(null, "", "#overview"); m.app.setApp(null) })
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  document.body.innerHTML = ""
})

async function mount(node: React.ReactNode) {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(node))
  return host
}
const select = () => document.querySelector<HTMLSelectElement>('select[aria-label="App"]')!
async function choose(app: string) {
  await act(async () => { const s = select(); s.value = app; s.dispatchEvent(new Event("change", { bubbles: true })) })
}
const text = () => document.body.textContent ?? ""

test("the selector offers all apps, then each app, labelled App", async () => {
  await mount(<m.sel.AppSelect />)
  expect([...select().options].map(o => o.textContent)).toEqual(["All apps", "atlas", "ledger"])
  expect(select().value).toBe("")
  expect(select().closest("label")!.textContent).toContain("App")
})

test("Overview: the cards, Do now / Decide and the open count follow the app", async () => {
  await mount(<><m.sel.AppSelect /><m.Overview go={() => {}} /></>)
  expect(text()).toContain("Apps on a current version")
  expect(text()).toContain("75%")
  expect(text()).toContain("Upgrade atlas")
  await choose("ledger")
  expect(text()).toContain("Majors behind")
  expect(text()).toContain("50%")
  expect(text()).toContain("+10 pts") // ledger's own change: 40% → 50%
  expect(text()).toContain("Upgrade ledger")
  expect(text()).not.toContain("Upgrade atlas")
  expect(text()).toContain("Open actions for ledger")
  // The scan's confidence is about the system: said, so it isn't read as ledger's.
  expect(text()).toContain("About the system itself, so it's the same for every app.")
})

test("Actions: the list, the scope tiles and the counts follow the app; the prompt says it isn't split", async () => {
  await mount(<><m.sel.AppSelect /><m.Queue /></>)
  const allOpen = () => document.querySelector("button")?.parentElement?.textContent
  expect(text()).toContain("Upgrade atlas")
  expect(allOpen()).toContain("3")
  await choose("atlas")
  expect(text()).toContain("Upgrade atlas")
  expect(text()).not.toContain("Upgrade ledger")
  expect(text()).not.toContain("Replace raw buttons")
  expect(text()).toContain("isn't split by app yet")
})

test("Apps, System, Trends and Readiness show only the chosen app's numbers", async () => {
  await mount(<><m.sel.AppSelect /><m.Federation /></>)
  expect([...document.querySelectorAll("tbody tr")].map(r => r.querySelector("td")?.textContent)).toEqual(["atlas", "ledger"])
  await choose("ledger")
  expect([...document.querySelectorAll("tbody tr")].map(r => r.querySelector("td")?.textContent)).toEqual(["ledger"])
  await act(async () => root.unmount())

  // The choice is the page's: it is still ledger in the next view.
  await mount(<><m.sel.AppSelect /><m.System /></>)
  const uses = () => Object.fromEntries([...document.querySelectorAll("tbody tr")].map(r => [r.querySelector("td button")?.textContent?.replace(": technical details", ""), r.querySelectorAll("td")[2]?.textContent]))
  expect(text()).toContain("Uses in ledger")
  expect(uses()).toEqual({ Button: "4in 1 file", Tabs: "0" })
  expect(text()).toContain("Not used by ledger")
  await choose("")
  expect(uses()).toEqual({ Button: "8in 3 files", Tabs: "2in 1 file" })
  await act(async () => root.unmount())

  await mount(<><m.sel.AppSelect /><m.Trends /></>)
  expect(text()).not.toContain("· ledger")
  await choose("ledger")
  expect(text()).toContain("Majors behind · ledger")
  expect(text()).toContain("Latest 50%")
  await act(async () => root.unmount())

  await mount(<m.AgentProvider><m.sel.AppSelect /><m.Readiness /></m.AgentProvider>)
  const view = () => text().replace(select().closest("label")!.textContent!, "")
  expect(view()).toContain("ledger")
  expect(view()).not.toContain("atlas")
  expect(text()).toContain("Bench runs below cover every checkout")
})

test("Element Review has no selector of its own; all apps lists every app's elements, one app its own", async () => {
  await mount(<><m.sel.AppSelect /><m.Elements key="all" /></>)
  expect(document.querySelectorAll('select[aria-label="App"]').length).toBe(1)
  const ready = () => [...document.querySelectorAll("button, div")].find(e => e.textContent?.startsWith("Ready to migrate"))?.textContent
  expect(ready()).toMatch(/^Ready to migrate3/)
  await choose("ledger")
  await act(async () => root.render(<><m.sel.AppSelect /><m.Elements key="ledger" /></>))
  expect(ready()).toMatch(/^Ready to migrate2/)
})

test("the app rides in the address bar after the route, and the route keeps working", async () => {
  history.replaceState(null, "", "#queue/F-1/details")
  m.app.setApp("ledger")
  expect(location.hash).toBe("#queue/F-1/details?app=ledger")
  expect(m.app.routePath()).toBe("queue/F-1/details")
  m.app.replaceRoute("system/unused")
  expect(location.hash).toBe("#system/unused?app=ledger")
  expect(m.app.hashFor("overview")).toBe("#overview?app=ledger")
  m.app.setApp(null)
  expect(location.hash).toBe("#system/unused")

  // A link carries it: opening one sets the app, and the Queue opens on the linked item.
  location.hash = "#queue/F-1?app=atlas"
  window.dispatchEvent(new HashChangeEvent("hashchange"))
  await mount(<><m.sel.AppSelect /><m.Queue /></>)
  expect(select().value).toBe("atlas")
  expect(m.app.routePath()).toBe("queue/F-1")
})

test("old links (no app) open on all apps; an unknown app is ignored", async () => {
  location.hash = "#queue/F-3"
  window.dispatchEvent(new HashChangeEvent("hashchange"))
  await mount(<><m.sel.AppSelect /><m.Queue /></>)
  expect(select().value).toBe("")
  expect(text()).toContain("Replace raw buttons in ledger")
  expect(text()).toContain("Upgrade atlas")
  location.hash = "#overview?app=nope"
  window.dispatchEvent(new HashChangeEvent("hashchange"))
  await act(async () => {})
  expect(select().value).toBe("")
})
