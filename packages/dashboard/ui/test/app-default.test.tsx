// @vitest-environment happy-dom
import { expect, test, vi } from "vitest"

// Design review: the App picker returns to the app last chosen, or to a default set in Settings; a link
// that names an app still wins.

async function load(hash: string, store: Record<string, string>) {
  vi.resetModules()
  document.head.innerHTML = ""
  const data = document.createElement("script")
  data.id = "dsa-data"; data.type = "application/json"
  data.textContent = JSON.stringify({ title: "Sample", targets: [{ name: "app-a", role: "consumer" }, { name: "app-b", role: "consumer" }] })
  document.head.append(data)
  const mem = new Map(Object.entries(store))
  vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) })
  history.replaceState(null, "", hash)
  return await import("@/lib/app")
}

test("with no app in the link, the page opens on the app chosen last", async () => {
  const m = await load("#inbox", { "dsa.app:Sample:last": "app-b" })
  void m; expect(location.hash).toBe("#inbox?app=app-b")
})

test("a default in Settings wins over the last app; a link naming an app wins over both", async () => {
  await load("#inbox", { "dsa.app:Sample:last": "app-b", "dsa.app:Sample:default": "app-a" })
  expect(location.hash).toBe("#inbox?app=app-a")
  await load("#inbox?app=app-b", { "dsa.app:Sample:default": "app-a" })
  expect(location.hash).toBe("#inbox?app=app-b")
  await load("#inbox", { "dsa.app:Sample:last": "app-b", "dsa.app:Sample:default": "" })
  expect(location.hash).toBe("#inbox")
})

test("choosing an app remembers it", async () => {
  const m = await load("#inbox", {})
  m.setApp("app-a")
  expect(localStorage.getItem("dsa.app:Sample:last")).toBe("app-a")
})
