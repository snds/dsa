import * as React from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Note } from "@/components/bits"
import { D, api, reviewerName, say } from "@/lib/dsa"
import { relayWho } from "@/lib/useScan"
import { ReviewItem } from "@/views/review/LabelReview"
import { nameOf, useEl } from "./shared"
import { typingIn } from "./keys"

/**
 * One place at a time, inside Element Review: what Label Review was. The element beside the proposal
 * at real size, where it is, why dsa thinks so, and Right, Wrong (then the right answer) or Not sure.
 * An answer is saved once and counts twice (the decision and the label), then the next place opens.
 * Previous and Next step through the places the view is showing.
 */

const REVIEWER = "dsa.reviewer"

export function Focus({ ids, start, onClose, onSaved }: {
  ids: string[]; start: number; onClose: () => void
  /** Told each saved answer, so the view can keep it in sight and offer undo. */
  onSaved: (id: string, labelsAt: string, text: string) => void
}) {
  const { byId, applyLocal, refresh, openCode, openPicker } = useEl()
  const [i, setI] = React.useState(Math.max(0, Math.min(start, ids.length - 1)))
  const [answers, setAnswers] = React.useState<Record<string, any>>({})
  const [name, setName] = React.useState(() => reviewerName() ?? "")
  const [signedIn, setSignedIn] = React.useState<string | null>(null)
  React.useEffect(() => { relayWho().then(w => { if (w?.signedIn && w.login) setSignedIn(w.login) }) }, [])
  const items = React.useMemo(() => new Map<string, any>((D.elements?.review?.items ?? []).map((x: any) => [x.id, x])), [])
  const id = ids[i]!
  const e = byId.get(id)
  const item = items.get(id)
  const labeler = signedIn ?? name.trim()
  const next = () => setI(x => Math.min(ids.length - 1, x + 1))
  // J and K step through the places here too (not while typing a name or a comment).
  React.useEffect(() => {
    const f = (ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || typingIn(ev.target)) return
      const k = ev.key.toLowerCase()
      if (k === "j") { setI(x => Math.min(ids.length - 1, x + 1)); ev.preventDefault() }
      else if (k === "k") { setI(x => Math.max(0, x - 1)); ev.preventDefault() }
    }
    window.addEventListener("keydown", f)
    return () => window.removeEventListener("keydown", f)
  }, [ids.length])

  async function answer(row: any) {
    setAnswers(a => ({ ...a, [row.id]: row }))
    if (!row.label) { say("Marked not sure."); next(); return }
    try {
      const r = await api("/api/labels", { labels: [row.label] })
      const decided = r?.decided?.find((d: any) => d.id === row.id)?.decided
      if (decided) { applyLocal([row.id], decided); onSaved(row.id, row.label.at, `Answered ${nameOf(e)}`) }
      say(decided ? "Saved as the decision and as a label." : "Saved as a label. This place isn't in the latest scan, so no decision was recorded.")
      refresh(); next()
    } catch (x: any) { say(x.message, true) }
  }

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="flex max-h-[92vh] w-[96vw] max-w-[1100px] flex-col overflow-y-auto sm:max-w-[1100px]" data-slot="focus">
        <DialogHeader className="flex-row flex-wrap items-center justify-between gap-3 pr-10">
          <div className="flex min-w-0 flex-col gap-0.5">
            <DialogTitle className="text-base">{e ? nameOf(e) : id}</DialogTitle>
            <DialogDescription>Place {i + 1} of {ids.length}{item?.why === "audit" ? " · a spot check of an answer dsa was sure of" : ""} · J and K move</DialogDescription>
          </div>
          <span className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setI(x => Math.max(0, x - 1))} disabled={i === 0}>Previous</Button>
            <Button variant="outline" size="sm" onClick={next} disabled={i >= ids.length - 1}>Next</Button>
          </span>
        </DialogHeader>
        {!signedIn && (
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span>Your name, saved with each answer</span>
            <input id="focus-reviewer" className="h-8 rounded-md border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring" value={name}
              onChange={ev => { setName(ev.target.value); try { window.localStorage.setItem(REVIEWER, JSON.stringify(ev.target.value)) } catch { /* kept for this visit */ } }} />
          </label>
        )}
        {!e ? <Note>This place isn't in the latest scan.</Note>
          : item ? <ReviewItem key={id} item={item} e={e} labeler={labeler} onAnswer={answer} answered={answers[id] ?? null} onCode={() => openCode(id)} />
          : (
            <div className="flex flex-col items-start gap-2">
              <Note>dsa has no photo of this place or no drawing of the proposal yet, so it can't be shown side by side. It can still be answered in the full dialog.</Note>
              {D.serve && <Button variant="outline" size="sm" onClick={() => { onClose(); openPicker({ ids: [id] }) }}>Open dialog</Button>}
            </div>
          )}
      </DialogContent>
    </Dialog>
  )
}
