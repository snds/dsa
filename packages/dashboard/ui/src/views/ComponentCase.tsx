import * as React from "react"
import { ArrowRightIcon, CheckIcon, PencilSimpleIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Note } from "@/components/bits"
import { D } from "@/lib/dsa"
import { hashFor } from "@/lib/app"
import { answerCheck, doubtful, useChecks } from "@/lib/checks"
import { canChat } from "@/agent/store"
import { AskAgent } from "@/agent/AskAgent"
import { ThreadBadge } from "@/agent/ThreadBadge"
import { CertaintyWord } from "@/views/Inbox"

/**
 * A component's own case (redesign stage 8), under its technical details on Components: its open
 * issues, its thread for questions that span them, and Confirm / Correct when the scan doubts it.
 */
export function ComponentCase({ c }: { c: any }) {
  const checks = useChecks()
  // Its Confirm issue is answered the moment a person confirms or corrects, not at the next refresh.
  const issues: any[] = (D.issues ?? []).filter((i: any) => i.status === "open" && i.component === c.name && !(i.kind === "component-check" && checks[c.name]))
  const subject = { kind: "component" as const, name: c.name }
  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{issues.length ? `${issues.length} open issue${issues.length === 1 ? "" : "s"}` : "No open issues"}</p>
        {canChat() && <span className="flex items-center gap-1.5"><ThreadBadge subject={subject} /><AskAgent subject={subject} label={`Ask about ${c.name}`} size="xs" /></span>}
      </div>
      {issues.length > 0 && (
        <ul className="flex flex-col gap-1">
          {issues.slice(0, 8).map(i => (
            <li key={i.key} className="flex flex-wrap items-center gap-2 text-sm">
              <a href={hashFor(`inbox/${i.key}`)} className="min-w-0 flex-1 underline-offset-4 hover:underline">{i.title}</a>
              <CertaintyWord c={i.certainty} />
            </li>
          ))}
          {issues.length > 8 && <li><a href={hashFor("inbox")} className="inline-flex items-center gap-1 text-xs underline underline-offset-4">All {issues.length} in the Inbox<ArrowRightIcon /></a></li>}
        </ul>
      )}
      {doubtful(c) && <CheckAnswer name={c.name} />}
    </div>
  )
}

/** Confirm or Correct: the home for "Needs a check". A correction says what it really is. */
export function CheckAnswer({ name }: { name: string }) {
  const done = useChecks()[name]
  const [correcting, setCorrecting] = React.useState(false)
  const [note, setNote] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const act = async (v: "confirmed" | "corrected" | "undo") => {
    setBusy(true); setError(null)
    try { await answerCheck(name, v, v === "corrected" ? note : undefined); setCorrecting(false) } catch (e: any) { setError(e.message) }
    setBusy(false)
  }
  if (done) return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <CheckIcon className="text-success" />{done.verdict === "confirmed" ? "Confirmed" : `Corrected: ${done.note}`}{done.who ? ` by ${done.who}` : ""}, {done.date}.
      {canChat() && <Button variant="ghost" size="xs" onClick={() => act("undo")} disabled={busy}>Undo</Button>}
    </p>
  )
  if (!canChat()) return <Note>The scan isn't sure about {name}. Confirm or correct it from the served dashboard (dsa serve).</Note>
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">The scan isn't sure {name} is a system component of this kind. Is it?</p>
      {correcting ? (
        <div className="flex flex-col gap-2">
          <Textarea value={note} onChange={e => setNote(e.target.value)} placeholder={`What ${name} really is, e.g. "an app-only wrapper, not part of the system"`} aria-label={`What ${name} really is`} rows={2} />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => act("corrected")} disabled={busy || !note.trim()}>Save correction</Button>
            <Button size="sm" variant="ghost" onClick={() => setCorrecting(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => act("confirmed")} disabled={busy}><CheckIcon data-icon="inline-start" />Confirm</Button>
          <Button size="sm" variant="outline" onClick={() => setCorrecting(true)} disabled={busy}><PencilSimpleIcon data-icon="inline-start" />Correct</Button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
