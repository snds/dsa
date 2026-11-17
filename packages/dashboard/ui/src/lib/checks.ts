import * as React from "react"
import { D, api } from "@/lib/dsa"

// Components a person confirmed or corrected from "Needs a check" (redesign stage 8): what the report
// carried, plus answers given on this page since, so System, Health and the Inbox agree at once.
export interface Check { verdict: "confirmed" | "corrected"; note?: string; who?: string; date: string }

let checks: Record<string, Check> = { ...(D.componentChecks ?? {}) }
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())

export function useChecks(): Record<string, Check> {
  return React.useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f) }, () => checks, () => checks)
}

/** The scan's own reasons to doubt a component: found by naming alone, only in app code, or of an unclear kind. */
export const doubtful = (c: any) => Boolean(c?.inferred || c?.evidence?.tier === "convention" || c?.kind?.ambiguous)
/** Doubtful and not yet answered by a person. */
export const needsCheck = (c: any, all: Record<string, Check> = checks) => doubtful(c) && !all[c?.name]

export async function answerCheck(name: string, verdict: Check["verdict"] | "undo", note?: string) {
  let who = ""
  try { who = JSON.parse(localStorage.getItem("dsa.reviewer") ?? '""') } catch { /* no name saved */ }
  const r = await api("/api/agent/component-check", { name, verdict, note, who })
  const next = { ...checks }
  if (r.check) next[name] = r.check; else delete next[name]
  checks = next
  emit()
}
