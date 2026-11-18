// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

// Design review: every keyboard shortcut in one dialog, from the header or the ? key, grouped by where it works.

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let Shortcuts: any
let root: Root
beforeAll(async () => {
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ serve: true, title: "Sample", label: "Sample" })
  document.head.append(data)
  ;({ Shortcuts } = await import("@/components/shortcuts"))
})
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = "" })

test("? opens the shortcuts, grouped, with Element Review's keys among them; not while typing", async () => {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<><input aria-label="note" /><Shortcuts /></>))
  const input = host.querySelector("input")!
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true })) })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" })) })
  const dlg = document.querySelector('[role="dialog"]')!
  expect([...dlg.querySelectorAll("h3")].map(h => h.textContent)).toEqual(["Anywhere", "Inbox", "Reviewing places", "Photo viewer", "Agent"])
  expect(dlg.textContent).toContain("Next place")
  expect(dlg.textContent).toContain("Clear the ticks")
})
