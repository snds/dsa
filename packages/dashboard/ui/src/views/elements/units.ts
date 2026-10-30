import { D, SYS } from "@/lib/dsa"
import { stageKey } from "@/lib/staged"
import { desc, rec } from "./shared"

/**
 * The review page groups decisions by where they land: a system component, "No home yet", or
 * "Keep native". Status (needs you, ready, decided) is a filter over those groups, so nothing is
 * listed twice. A unit is one card: a question, a family of ready elements, or a recorded decision.
 */
export const NO_HOME = `No ${SYS} home yet`
export const KEEP = "Keep native"
const LAST = [NO_HOME, KEEP, "Ignored", "Unclear"]

export type Status = "open" | "staged" | "ready" | "decided"
export interface Unit { key: string; kind: "question" | "ready" | "gap" | "decided"; title: string; home: string; items: any[]; status: Status; q?: any; pattern?: string | null }
export interface Destination { home: string; units: Unit[]; elements: Record<Status, number>; cards: Record<Status, number> }

export const homeOf = (r: any): string => r.verdict === "replace" && r.use ? r.use : r.verdict === "gap" ? NO_HOME : r.verdict === "keep" ? KEEP : r.verdict === "ignore" ? "Ignored" : "Unclear"

/** A shared style's name when it is a named constant (CRUMB_LINK); identical-class hashes are never shown. */
export const styleName = (k?: string | null) => (k && !/^[0-9a-f]{8}$/.test(k) ? k : null)

export function unitsFor(evals: any[], questions: any[], byId: Map<string, any>, stagedKeys: Set<string>): Unit[] {
  const active = evals.filter(e => !e.exception)
  const out: Unit[] = []
  const inQuestion = new Set<string>()
  for (const q of questions) {
    const items = q.ids.map((id: string) => byId.get(id)).filter(Boolean)
    if (!items.length) continue
    q.ids.forEach((id: string) => inQuestion.add(id))
    const pattern = q.kind === "pattern" ? q.key : null
    const keys = q.parts ? q.parts.map((p: any) => stageKey(p.ids, null)) : [stageKey(q.ids, pattern)]
    const decided = items.every((e: any) => e.decided)
    const status: Status = !D.serve && keys.some((k: string) => stagedKeys.has(k)) ? "staged" : decided ? "decided" : "open"
    out.push({ key: `q:${q.key}`, kind: "question", title: q.title ?? q.ask, home: decided && !q.parts ? homeOf(rec(items[0])) : q.home ?? homeOf(q.auto), items, status, q, pattern })
  }
  // Sure elements, by design family: ready to migrate, or a sure gap to confirm.
  const sure = new Map<string, any[]>()
  for (const e of active) if (!inQuestion.has(e.id) && !e.decided && !e.needsHuman && (e.verdict === "replace" || e.verdict === "gap")) {
    const k = `${e.family ?? e.element}|${desc(e)}`
    sure.set(k, [...(sure.get(k) ?? []), e])
  }
  for (const [k, items] of sure) out.push({ key: `r:${k}`, kind: items[0].verdict === "gap" ? "gap" : "ready", title: items[0].title ?? `<${items[0].element}> → ${desc(items[0])}`, home: homeOf(items[0]), items, status: "ready" })
  // Recorded decisions outside the questions (agents, pattern policies, sure ones a person approved).
  const done = new Map<string, any[]>()
  for (const e of active) if (!inQuestion.has(e.id) && e.decided) {
    const k = e.decided.by === "policy" ? `pattern:${e.styleKey ?? e.styleSig}` : `d:${desc(e.decided.decision)}|${e.family ?? ""}`
    done.set(k, [...(done.get(k) ?? []), e])
  }
  for (const [k, items] of done) out.push({ key: k, kind: "decided", title: items[0].title ?? desc(items[0].decided.decision), home: homeOf(items[0].decided.decision), items, status: "decided", pattern: k.startsWith("pattern:") ? k.slice(8) : null })
  return out
}

/** Units grouped by destination: components with work waiting first, then no home yet and keep native. */
export function destinations(units: Unit[]): Destination[] {
  const m = new Map<string, Unit[]>()
  for (const u of units) m.set(u.home, [...(m.get(u.home) ?? []), u])
  const zero = (): Record<Status, number> => ({ open: 0, staged: 0, ready: 0, decided: 0 })
  return [...m].map(([home, list]) => {
    const elements = zero(), cards = zero()
    for (const u of list) { elements[u.status] += u.items.length; cards[u.status]++ }
    const order = { open: 0, staged: 1, ready: 2, decided: 3 }
    list.sort((a, b) => order[a.status] - order[b.status] || b.items.length - a.items.length)
    return { home, units: list, elements, cards }
  }).sort((a, b) => LAST.indexOf(a.home) - LAST.indexOf(b.home) || b.elements.open - a.elements.open || total(b) - total(a))
}
const total = (d: Destination) => d.elements.open + d.elements.staged + d.elements.ready + d.elements.decided

export const matches = (u: Unit, show: string) => show === "all" || u.status === show || (show === "decided" && u.status === "staged")
