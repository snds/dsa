// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// Below xl the agent panel covers the page, so it acts like a sheet: a scrim behind it, and Esc or a
// click on the scrim closes it (visual review B V-17). happy-dom has no xl media query match.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let m: { AgentPanel: any; AgentProvider: any; useAgent: any }

beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ serve: true, label: "Sample", run: { id: "r1", takenAt: "2026-11-16T12:00:00Z", sources: {} }, targets: [], runs: [], thresholds: [], libraries: [], issues: [] })
  document.head.append(data)
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })))
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }))
  const store = await import("@/agent/store")
  m = { AgentPanel: (await import("@/agent/AgentPanel")).AgentPanel, AgentProvider: store.AgentProvider, useAgent: store.useAgent }
})
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = "" })

function Open() { const a = m.useAgent(); React.useEffect(() => { a.setOpen(true) }, []); return null }

test("the narrow panel has a scrim, takes focus, and Esc closes it", async () => {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<m.AgentProvider><Open /><m.AgentPanel /></m.AgentProvider>))
  expect(document.querySelector('aside[aria-label="Agent"]')).not.toBeNull()
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Agent")
  const scrim = () => document.querySelector('aside[aria-label="Agent"]')?.previousElementSibling as HTMLElement | null
  expect(scrim()?.className).toMatch(/bg-black\/30/)
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })) })
  expect(document.querySelector('aside[aria-label="Agent"]')).toBeNull()
})

test("a click on the scrim closes it", async () => {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<m.AgentProvider><Open /><m.AgentPanel /></m.AgentProvider>))
  await act(async () => { (document.querySelector('aside[aria-label="Agent"]')!.previousElementSibling as HTMLElement).click() })
  expect(document.querySelector('aside[aria-label="Agent"]')).toBeNull()
})
