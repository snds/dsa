// One answer, wherever the dashboard runs. In `dsa serve` it is saved to the repo straight away (as the
// decision and as a label). On a published copy it is staged in this browser (lib/staged) and sent from
// the bar at the bottom, where `dsa apply-decisions` records it exactly as `dsa serve` would.
import { D, api, reviewerName } from "@/lib/dsa"
import { stage, stageKey, unstage } from "@/lib/staged"

export interface Answer {
  ids: string[]
  pattern?: string | null
  decision: any
  note?: string | undefined
  notes?: Record<string, string> | undefined
  /** The staged list's line for it: `<button> ×12`. */
  label: string
  target?: string
}

/** What was saved: the decided record per id (as the server returns it), and how to take it back. */
export interface Saved {
  ids: string[]
  decided: any
  recorded: number
  labelsAt?: string
  /** Published copy: the staged entry, removed on undo. */
  staged?: string
}

export async function saveAnswer(a: Answer): Promise<Saved> {
  const where = a.pattern ? { pattern: a.pattern } : { ids: a.ids }
  if (D.serve) {
    const r = await api("/api/decide", { ...where, decision: a.decision, note: a.note || undefined, ...(a.notes ? { notes: a.notes } : {}), who: reviewerName() })
    return { ids: a.ids, decided: r.decided, recorded: r.recorded ?? a.ids.length, labelsAt: r.labelsAt }
  }
  const key = stageKey(a.ids, a.pattern)
  stage({ key, target: a.target ?? "", ids: a.ids, pattern: a.pattern ?? null, decision: a.decision, ...(a.note ? { note: a.note } : {}), ...(a.notes ? { notes: a.notes } : {}), ...(reviewerName() ? { who: reviewerName()! } : {}), label: a.label })
  return { ids: a.ids, decided: stagedDecided(a.decision, a.note), recorded: a.ids.length, staged: key }
}

/** Take back one saved answer. */
export async function takeBack(s: { ids: string[]; labelsAt?: string | undefined; staged?: string | undefined }): Promise<string[]> {
  if (s.staged) { unstage(s.staged); return s.ids }
  const r = await api("/api/undecide", { ids: s.ids, ...(s.labelsAt ? { labelsAt: s.labelsAt } : {}) })
  return r.ids
}

/** How a staged answer shows on a place until the next published scan holds it. */
export const stagedDecided = (decision: any, note?: string) => ({ decision, ...(note ? { note } : {}), by: "human", staged: true })
