import { CheckCircleIcon, CircleNotchIcon, ClockIcon, FlaskIcon, GitBranchIcon, GitPullRequestIcon, ArrowsClockwiseIcon } from "@phosphor-icons/react"
import { cn } from "cn"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { anchorKeyOf, canChat, useAgent, type Subject, type ThreadState } from "./store"

/** Each thread state: its word, glyph, colour (the Figma "Thread State" chips) and what it means. */
export const THREAD_STATE: Record<ThreadState, { label: string; icon: typeof ClockIcon; tone: string; hint: string }> = {
  working: { label: "Working", icon: CircleNotchIcon, tone: "bg-primary/10 text-primary", hint: "The agent is answering." },
  "waiting-on-you": { label: "Waiting on you", icon: ClockIcon, tone: "border-warning-soft-border bg-warning-soft text-warning-soft-foreground", hint: "The agent answered or proposed something. Your turn." },
  "changes-ready": { label: "Changes ready", icon: FlaskIcon, tone: "bg-primary/10 text-primary", hint: "The agent changed files in its sandbox. Keep them or throw them away." },
  "on-a-branch": { label: "On a branch", icon: GitBranchIcon, tone: "bg-secondary text-secondary-foreground", hint: "The change is kept on a local branch. Nothing was pushed." },
  "in-pr": { label: "In PR", icon: GitPullRequestIcon, tone: "border-success-soft-border bg-success/10 text-success-soft-foreground", hint: "A draft pull request is open for review." },
  settled: { label: "Settled", icon: CheckCircleIcon, tone: "bg-muted text-muted-foreground", hint: "Every proposal is answered." },
  "out-of-date": { label: "Out of date", icon: ArrowsClockwiseIcon, tone: "border-warning-soft-border text-caution", hint: "A newer scan changed the evidence this thread used." },
}

/**
 * The state of the thread pinned to this subject, on the row or card it belongs to. Nothing when the
 * subject has no thread yet, or when the page can't reach an agent. Opens the thread on click.
 */
export function ThreadBadge({ subject, className, interactive = true }: { subject: Subject; className?: string; interactive?: boolean }) {
  const a = useAgent()
  if (!canChat()) return null
  const t = a.threads[anchorKeyOf(subject)]
  // A thread opened but not used yet has nothing to say.
  if (!t || !t.turns) return null
  const st = THREAD_STATE[t.state]
  const Icon = st.icon
  const waiting = t.openProposals > 0 ? `${t.openProposals} proposal${t.openProposals === 1 ? "" : "s"} waiting` : null
  // Inside a row that is itself a button: a label only (no nested button); the row opens the item.
  if (!interactive) return <Badge variant="outline" className={cn(st.tone, className)} aria-label={`Thread: ${st.label}${waiting ? `, ${waiting}` : ""}`}><Icon className={cn(t.state === "working" && "motion-safe:animate-spin")} />{st.label}{waiting ? ` · ${t.openProposals}` : ""}</Badge>
  return (
    <Tooltip>
      <TooltipTrigger render={
        <button type="button" onClick={e => { e.stopPropagation(); a.resume(t.session) }} aria-label={`Thread: ${st.label}${waiting ? `, ${waiting}` : ""}. Open it.`}
          className={cn("inline-flex shrink-0 rounded-4xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none", className)} />
      }>
        <Badge variant="outline" className={cn("cursor-pointer", st.tone)}>
          <Icon className={cn(t.state === "working" && "motion-safe:animate-spin")} />{st.label}{waiting ? ` · ${t.openProposals}` : ""}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{st.hint}{waiting ? ` ${waiting}.` : ""} Click to open the thread.</TooltipContent>
    </Tooltip>
  )
}

/** How many threads are waiting on the person, for the header. */
export function WaitingOnYou() {
  const a = useAgent()
  if (!canChat()) return null
  const waiting = Object.values(a.threads).filter(t => t.turns > 0 && (t.state === "waiting-on-you" || t.state === "changes-ready"))
  if (!waiting.length) return null
  const newest = [...waiting].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0]!
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" onClick={() => a.resume(newest.session)} aria-label={`${waiting.length} thread${waiting.length === 1 ? "" : "s"} waiting on you. Open the newest.`} className="inline-flex rounded-4xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none" />}>
        <Badge variant="outline" className={cn("cursor-pointer", THREAD_STATE["waiting-on-you"].tone)}><ClockIcon />{waiting.length} waiting on you</Badge>
      </TooltipTrigger>
      <TooltipContent>Agent threads where it's your turn. Click to open the newest: {newest.title}.</TooltipContent>
    </Tooltip>
  )
}
