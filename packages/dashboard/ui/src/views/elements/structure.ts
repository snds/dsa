/**
 * Element Review by component: every place in the app that needs a component, grouped the way a designer
 * thinks about them. First the component it goes to (Button, Menu item…, or No fit yet, Keep as is),
 * then the settings it gets (Button · ghost · small: a batch), then places that already share a style (a
 * look group), which nearly always get the same answer. A place's answer moves it: decide it as another
 * component and it is listed under that one.
 *
 * Pure: the caller passes the names and the "can decide now" rule, so this is tested without a page.
 */

export type PlaceStatus = "todo" | "evidence" | "proposed" | "decided"
export interface Counts { todo: number; evidence: number; proposed: number; decided: number; total: number }
export interface LookGroup { key: string; kind: "shared" | "same-classes" | "one-off"; name: string | null; items: any[]; counts: Counts }
export interface Batch { key: string; pick: any; items: any[]; looks: LookGroup[]; counts: Counts }
export interface ComponentGroup { key: string; name: string; kind: "component" | "gap" | "keep" | "ignored" | "unclear"; batches: Batch[]; counts: Counts }

export interface Names { noHome: string; keep: string; ignored: string; unclear: string }

/** The answer a place has now: its decision once decided, else dsa's pick. */
export const pickOf = (e: any) => (e.decided ? e.decided.decision : e)

/** Where a place stands: decided; dsa sure of it (proposed); a person can decide it now; or it waits for evidence. */
export function statusOf(e: any, decideNow: (e: any) => boolean): PlaceStatus {
  if (e.decided) return "decided"
  if (!e.needsHuman) return "proposed"
  return decideNow(e) ? "todo" : "evidence"
}

const zero = (): Counts => ({ todo: 0, evidence: 0, proposed: 0, decided: 0, total: 0 })
function count(items: any[], decideNow: (e: any) => boolean): Counts {
  const c = zero()
  for (const e of items) { c[statusOf(e, decideNow)]++; c.total++ }
  return c
}

const propsKey = (p?: Record<string, unknown> | null) => Object.entries(p ?? {}).map(([k, v]) => `${k}=${v}`).sort().join(",")

function componentOf(r: any, n: Names): { key: string; name: string; kind: ComponentGroup["kind"] } {
  if (r.verdict === "replace" && r.use) return { key: `c:${r.use}`, name: r.use, kind: "component" }
  if (r.verdict === "gap") return { key: "gap", name: n.noHome, kind: "gap" }
  if (r.verdict === "keep") return { key: "keep", name: n.keep, kind: "keep" }
  if (r.verdict === "ignore") return { key: "ignored", name: n.ignored, kind: "ignored" }
  return { key: "unclear", name: n.unclear, kind: "unclear" }
}

/** One batch per answer: the component and its settings; for a gap, what is missing; otherwise the kind of element. */
function batchOf(r: any, e: any): string {
  if (r.verdict === "replace" && r.use) return `${r.use}|${propsKey(r.props)}`
  if (r.verdict === "gap") return `gap|${r.gap ?? e.role}`
  return `${r.verdict}|${e.role ?? e.element}`
}

/** A shared style's name when it is a named constant (CRUMB_LINK); identical-class hashes have none. */
const named = (k?: string | null) => (k && !/^[0-9a-f]{8}$/.test(k) ? k : null)

function looksOf(items: any[], decideNow: (e: any) => boolean): LookGroup[] {
  const by = new Map<string, any[]>()
  for (const e of items) {
    const k = e.styleKey ?? (e.styleSig ? `#${e.styleSig}` : null)
    if (k) by.set(k, [...(by.get(k) ?? []), e])
  }
  const looks: LookGroup[] = []
  const alone: any[] = []
  for (const [k, list] of by) {
    if (list.length < 2) { alone.push(...list); continue }
    const name = k.startsWith("#") ? null : named(k)
    looks.push({ key: k, kind: name ? "shared" : "same-classes", name, items: list, counts: count(list, decideNow) })
  }
  for (const e of items) if (!e.styleKey && !e.styleSig) alone.push(e)
  looks.sort((a, b) => b.counts.todo - a.counts.todo || b.items.length - a.items.length)
  if (alone.length) looks.push({ key: "one-off", kind: "one-off", name: null, items: alone, counts: count(alone, decideNow) })
  for (const l of looks) l.items.sort((a, b) => rank(a, decideNow) - rank(b, decideNow) || a.confidence - b.confidence || String(a.id).localeCompare(String(b.id)))
  return looks
}

const ORDER: Record<PlaceStatus, number> = { todo: 0, evidence: 1, proposed: 2, decided: 3 }
const rank = (e: any, decideNow: (e: any) => boolean) => ORDER[statusOf(e, decideNow)]
const LAST: ComponentGroup["kind"][] = ["gap", "keep", "unclear", "ignored"]

/** Places (active elements) grouped by component, then batch, then look. Components with the most to decide first. */
export function byComponent(evals: any[], names: Names, decideNow: (e: any) => boolean): ComponentGroup[] {
  const comps = new Map<string, { key: string; name: string; kind: ComponentGroup["kind"]; batches: Map<string, any[]> }>()
  for (const e of evals) {
    if (e.exception) continue
    const r = pickOf(e)
    const c = componentOf(r, names)
    const g = comps.get(c.key) ?? { ...c, batches: new Map<string, any[]>() }
    const b = batchOf(r, e)
    g.batches.set(b, [...(g.batches.get(b) ?? []), e])
    comps.set(c.key, g)
  }
  const out: ComponentGroup[] = [...comps.values()].map(g => {
    const batches: Batch[] = [...g.batches].map(([key, items]) => ({ key, pick: pickOf(items[0]), items, looks: looksOf(items, decideNow), counts: count(items, decideNow) }))
    batches.sort((a, b) => b.counts.todo - a.counts.todo || b.items.length - a.items.length)
    return { key: g.key, name: g.name, kind: g.kind, batches, counts: count(batches.flatMap(b => b.items), decideNow) }
  })
  return out.sort((a, b) => LAST.indexOf(a.kind) - LAST.indexOf(b.kind) || b.counts.todo - a.counts.todo || b.counts.total - a.counts.total || a.name.localeCompare(b.name))
}

/** The places a filter shows. */
export const shows = (e: any, show: PlaceStatus | "all", decideNow: (e: any) => boolean) => show === "all" || statusOf(e, decideNow) === show
