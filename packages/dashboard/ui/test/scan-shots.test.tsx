// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// The split Re-scan: the menu's setting goes with the scan, stays set between visits, says so when
// it isn't the default, and is left out where nothing can receive it.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const posts: { url: string; body: unknown }[] = []
let scan: typeof import("@/components/scan")
let store: typeof import("@/lib/useScan")
let root: Root

beforeAll(async () => {
  const kept = new Map<string, string>()
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } })
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ serve: true, run: { id: "r1", takenAt: new Date().toISOString() }, actions: {} })
  document.head.append(data)
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    if (init?.method === "POST") posts.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null })
    return new Response(JSON.stringify({ id: "s1", status: "running", startedAt: new Date().toISOString(), steps: { done: 1, total: 3 } }), { status: 200 })
  }) as any
  scan = await import("@/components/scan")
  store = await import("@/lib/useScan")
})

afterEach(async () => {
  await act(async () => { store.dismiss(); store.setShots("normal") })
  await act(async () => root.unmount())
  document.body.innerHTML = ""
  posts.length = 0
})

async function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<scan.ScanButton />))
}
const named = (name: RegExp) => [...document.querySelectorAll("button")].find(b => name.test(b.textContent ?? "") || name.test(b.getAttribute("aria-label") ?? ""))!
const click = async (el: Element) => act(async () => { (el as HTMLElement).click(); await new Promise(r => setTimeout(r, 0)) })

test("Re-scan and its settings are two buttons in one group", async () => {
  await mount()
  const group = document.querySelector('[data-slot="button-group"]')!
  expect(group.contains(named(/Re-run scan/))).toBe(true)
  expect(group.contains(named(/Re-scan settings/))).toBe(true)
})

test("by default the scan asks for nothing and the page says nothing about photos", async () => {
  await mount()
  expect(document.body.textContent).not.toContain("Photos:")
  await click(named(/Re-run scan/))
  expect(posts).toEqual([{ url: expect.stringContaining("/api/run"), body: null }])
})

test("the menu's setting goes with the scan, shows under the button, and stays set", async () => {
  await mount()
  await click(named(/Re-scan settings/))
  const items = [...document.querySelectorAll('[role="menuitemradio"]')]
  expect(items.map(i => /^(Keep photos|Retake all|Retry missing)/.exec(i.textContent ?? "")?.[1])).toEqual(["Keep photos", "Retake all", "Retry missing"])
  expect(items[0]!.getAttribute("aria-checked")).toBe("true")
  await click(items[1]!)
  expect(document.body.textContent).toContain("Photos: retake all")
  expect(window.localStorage.getItem("dsa.scan-shots")).toBe("fresh")
  await click(named(/Re-run scan/))
  expect(posts[0]!.body).toEqual({ shots: "fresh" })
  // The next visit starts with the same setting.
  vi.resetModules()
  const again = await import("@/lib/useScan")
  let seen: string | undefined
  const Read = () => { seen = again.useScan().shots; return null }
  const other = createRoot(document.createElement("div"))
  await act(async () => other.render(<Read />))
  expect(seen).toBe("fresh")
  await act(async () => other.unmount())
})
