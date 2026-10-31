// Decisions made on the published (read-only) dashboard. A static page can't write to the repos,
// so a decision is staged in this browser and exported as a decisions file that
// `dsa decide --file` applies exactly as `dsa serve` would. In `dsa serve` none of this is used:
// decisions save straight away.
import * as React from "react"

export interface Staged {
  /** One per review card: the shared style it covers, or its element ids. */
  key: string
  target: string
  ids: string[]
  pattern?: string | null
  decision: any
  note?: string
  /** Which card it came from, for the export list: `<button> ×12 (btnGhost)`. */
  label: string
  at: string
}

const STORE = "dsa.staged-decisions.v1"
const listeners = new Set<() => void>()
let cache: Staged[] | null = null

// Storage can be missing or throw (private windows, blocked site data): fall back to memory.
function read(): Staged[] {
  if (cache) return cache
  try { cache = JSON.parse(localStorage.getItem(STORE) || "[]") } catch { cache = [] }
  if (!Array.isArray(cache)) cache = []
  return cache
}
function write(next: Staged[]) {
  cache = next
  try { localStorage.setItem(STORE, JSON.stringify(next)) } catch { /* kept in memory for this visit */ }
  listeners.forEach(f => f())
}
function subscribe(f: () => void) {
  listeners.add(f)
  return () => { listeners.delete(f) }
}

export const stageKey = (ids: string[], pattern?: string | null) => (pattern ? `p:${pattern}` : `i:${[...ids].sort().join(",")}`)
export const stage = (s: Omit<Staged, "at">) => write([...read().filter(x => x.key !== s.key), { ...s, at: new Date().toISOString() }])
export const unstage = (key: string) => write(read().filter(x => x.key !== key))
export const clearStaged = () => write([])
export const setStagedNote = (key: string, note: string) => write(read().map(x => (x.key === key ? { ...x, note: note || undefined } : x)))
export const useStaged = () => React.useSyncExternalStore(subscribe, read, read)

/** The file `dsa decide --file` reads. */
export function decisionsFile(list: Staged[]) {
  return {
    dsa: "decisions",
    version: 1,
    exportedAt: new Date().toISOString(),
    decisions: list.map(s => ({ ...(s.pattern ? { pattern: s.pattern } : { ids: s.ids }), decision: s.decision, ...(s.note ? { note: s.note } : {}), label: s.label })),
  }
}

export const FILE_NAME = "dsa-decisions.json"
/** Run from the repo root, where `dsa publish` runs too. */
export const APPLY_COMMAND = `npm run dsa -- apply-decisions --file ~/Downloads/${FILE_NAME}`

export function downloadDecisions(list: Staged[]) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(decisionsFile(list), null, 2)}\n`], { type: "application/json" }))
  const a = Object.assign(document.createElement("a"), { href: url, download: FILE_NAME })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
