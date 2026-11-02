// The app the whole page is showing: one consumer app or child library, or all of them (null). Chosen in
// the header, read by every view, and kept in the address bar after the route ("#queue/F-1?app=billing")
// so a reload, Back and a shared link keep it. A link without it (every link from before) opens on all apps.
import * as React from "react"
import { D } from "@/lib/dsa"

/** Every app the scan measured: the Apps table's rows, then any app only Element Review saw. */
export const APPS: string[] = [...new Set<string>([
  ...(D.targets ?? []).filter((t: any) => t.role !== "core").map((t: any) => String(t.name)),
  ...(D.elements?.evals ?? []).map((e: any) => String(e.target)),
])].filter(Boolean)

/** The route without the app: "queue/F-1/details". */
export function routePath(hash = location.hash): string {
  return hash.replace(/^#/, "").split("?")[0]!
}

function appFrom(hash: string): string | null {
  const q = hash.split("?")[1]
  const a = q ? new URLSearchParams(q).get("app") : null
  return a && APPS.includes(a) && APPS.length > 1 ? a : null
}

let current: string | null = typeof location === "undefined" ? null : appFrom(location.hash)
const subs = new Set<() => void>()
const emit = () => { for (const f of subs) f() }

/** "#queue/F-1?app=billing": a route with the app the page is on. */
export function hashFor(path: string, app = current): string {
  return `#${path}${app ? `?app=${encodeURIComponent(app)}` : ""}`
}

/** Rewrites the address bar's route, keeping the app (no history entry, no hashchange). */
export function replaceRoute(path: string) {
  try { history.replaceState(null, "", hashFor(path)) } catch { /* file:// in some browsers */ }
}

/** Opens a route, keeping the app (fires hashchange, like setting location.hash). */
export function openRoute(path: string) {
  location.hash = hashFor(path).slice(1)
}

export function setApp(app: string | null) {
  const next = app && APPS.includes(app) ? app : null
  if (next === current) return
  current = next
  replaceRoute(routePath())
  emit()
}

// Back, Forward, or an edited address: the hash says which app.
if (typeof window !== "undefined") addEventListener("hashchange", () => { const a = appFrom(location.hash); if (a !== current) { current = a; emit() } })

export function useApp(): string | null {
  return React.useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f) }, () => current, () => current)
}

/** An action or finding in this app: one it affects or targets. */
export const inApp = (app: string | null) => (i: any) => !app || i.target === app || (i.affected ?? []).includes(app)
