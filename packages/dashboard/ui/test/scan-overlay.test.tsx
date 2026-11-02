// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// The scan overlay against dsa serve's API, with a fake fetch: it opens with the scan, holds focus,
// shuts the page behind it, goes to the background and back, and ends on success or on the reason.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let reply: (url: string, init?: RequestInit) => unknown = () => ({})
let scan: typeof import("@/components/scan")
let store: typeof import("@/lib/useScan")
let root: Root
const started = new Date(Date.now() - 30_000).toISOString()
const running = (done: number, current: string) => ({ id: "s1", status: "running", startedAt: started, url: "http://localhost/runs/s1", steps: { done, total: 4, current } })

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ serve: true, run: { id: "r1", takenAt: started }, actions: { rescan: { estimateSeconds: 90 } } })
  document.head.append(data)
  globalThis.fetch = vi.fn(async (url: any, init?: any) => new Response(JSON.stringify(reply(String(url), init)), { status: 200 })) as any
  scan = await import("@/components/scan")
  store = await import("@/lib/useScan")
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => { store.dismiss() })
  await act(async () => root.unmount())
  document.body.innerHTML = ""
})

async function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(
    <>
      <header><scan.ScanButton /></header>
      <main data-testid="page"><button>Something on the page</button></main>
      <scan.ScanOverlay />
    </>,
  ))
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (name: RegExp) => [...document.querySelectorAll("button")].find(b => name.test(b.textContent ?? ""))!
const click = async (el: Element) => act(async () => { (el as HTMLElement).click() })
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

test("a scan takes over the page: modal, labelled, focus inside, the page behind inert", async () => {
  reply = () => running(1, "Scan sources")
  await mount()
  await click(button(/Re-run Scan/))
  await settle()
  const d = dialog()!
  expect(d).toBeTruthy()
  expect(d.getAttribute("aria-modal")).toBe("true")
  const title = document.getElementById(d.getAttribute("aria-labelledby")!)!
  expect(title.textContent).toBe("Scanning")
  expect(d.textContent).toContain("This usually takes about 2 minutes.")
  expect(d.textContent).toMatch(/Elapsed 0:[23]\d/)
  // Focus moves in, onto the way out.
  expect(document.activeElement?.textContent).toBe("Keep working in the background")
  // The page behind can't be reached: inert or hidden from assistive tech.
  const page = document.querySelector('[data-testid="page"]')!
  const shut = (el: Element | null): boolean => !!el && el !== document.body && (el.hasAttribute("inert") || el.getAttribute("aria-hidden") === "true" || shut(el.parentElement))
  expect(shut(page)).toBe(true)
  // Steps known: a filling bar and the step list, announced politely.
  expect(d.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("25")
  expect(d.querySelector('[aria-current="step"]')!.textContent).toBe("Scan sources")
  expect(d.querySelector('[aria-live="polite"]')!.textContent).toContain("Step 2 of 4: Scan sources.")
  // No banner beside it: the overlay is the one surface.
  expect(document.querySelectorAll('[role="status"], [role="alert"]').length).toBe(0)
})

test("unknown progress shows a sliding bar with no value, which sits still for reduced motion", async () => {
  reply = () => ({ id: "s2", status: "running", startedAt: started })
  await mount()
  await click(button(/Re-run Scan/))
  await settle()
  const bar = dialog()!.querySelector('[role="progressbar"]')!
  expect(bar.hasAttribute("aria-valuenow")).toBe(false)
  expect(bar.firstElementChild!.className).toContain("motion-safe:animate-")
  expect(bar.firstElementChild!.className).toContain("motion-reduce:")
  expect(dialog()!.querySelector(".motion-safe\\:animate-spin")).toBeTruthy()
  expect(dialog()!.querySelector('[aria-current="step"]')).toBeNull()
})

test("Keep working in the background leaves a pill in the header that reopens it", async () => {
  reply = () => running(2, "Build site")
  await mount()
  await click(button(/Re-run Scan/))
  await settle()
  await click(button(/Keep working in the background/))
  await settle()
  expect(dialog()).toBeNull()
  const pill = button(/^Scanning · \d+:\d\d$/)
  expect(pill.getAttribute("aria-haspopup")).toBe("dialog")
  expect(document.querySelector('[data-testid="page"]')!.closest("[inert],[aria-hidden='true']")).toBeNull()
  await click(pill)
  await settle()
  expect(dialog()).toBeTruthy()
})

test("a failure reopens the overlay with the reason and Try again, and never closes by itself", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  let calls = 0
  reply = url => (url.includes("status") ? { id: "s1", status: "failed", error: "The scan ran out of memory.", url: "http://localhost/runs/s1" } : (calls++, running(1, "Scan sources")))
  await mount()
  await click(button(/Re-run Scan/))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  await click(button(/Keep working in the background/))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  const d = dialog()!
  expect(d).toBeTruthy()
  expect(document.getElementById(d.getAttribute("aria-labelledby")!)!.textContent).toBe("The scan didn't complete")
  expect(d.textContent).toContain("The scan ran out of memory.")
  expect(d.querySelector('a[href="http://localhost/runs/s1"]')).toBeTruthy()
  expect(document.activeElement?.textContent).toBe("Try again")
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(dialog()).toBeTruthy()
  await click(button(/Try again/))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(calls).toBe(2)
  expect(document.getElementById(dialog()!.getAttribute("aria-labelledby")!)!.textContent).toBe("Scanning")
})

test("Escape on a running scan sends it to the background; on a failure, Close ends it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  reply = url => (url.includes("status") ? { id: "s1", status: "failed", error: "Nope." } : running(0, "Set up"))
  await mount()
  await click(button(/Re-run Scan/))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(dialog()).toBeNull()
  expect(button(/^Scanning ·/)).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(dialog()).toBeTruthy()
  await click(button(/^Close$/))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(dialog()).toBeNull()
  expect(button(/Re-run Scan/)).toBeTruthy()
})

test("a finished scan shows success, then loads the new report", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const reload = vi.fn()
  const real = window.location
  Object.defineProperty(window, "location", { configurable: true, value: { ...real, href: real.href, reload } })
  try {
    reply = url => (url.includes("status") ? { id: "s1", status: "done", startedAt: started } : running(3, "Publish"))
    await mount()
    await click(button(/Re-run Scan/))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(document.getElementById(dialog()!.getAttribute("aria-labelledby")!)!.textContent).toBe("The new report is ready")
    expect(reload).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(reload).toHaveBeenCalledOnce()
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: real })
  }
})
