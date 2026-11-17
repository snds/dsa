import * as React from "react"
import { ChatCircleIcon, SparkleIcon, SidebarSimpleIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ThreadBody } from "./AgentPanel"
import { ThreadBadge } from "./ThreadBadge"
import { anchorKeyOf, canChat, useAgent, type Subject } from "./store"

/**
 * The thread pinned to what's open (redesign stage 5): docked beside the issue, not a global panel.
 * Follows the issue as J / K moves; shows the anchor's thread, or "No thread yet" with a live box that
 * starts one. While the side panel is open it holds the conversation, and this says so.
 */
export function PinnedThread({ subject, className }: { subject: Subject; className?: string }) {
  const a = useAgent()
  const key = anchorKeyOf(subject)
  const has = Boolean(a.threads[key])
  // Re-pin when the issue changes, when its thread appears in the index, or when the side panel closes.
  React.useEffect(() => { if (canChat() && !a.open) a.pin(subject) }, [key, has, a.open])
  if (!canChat()) return null
  const here = !a.open && (a.pending ? anchorKeyOf(a.pending) === key : a.session ? anchorKeyOf(a.session.subject) === key || a.session.id === a.threads[key]?.session : false)
  return (
    <section aria-label="Thread for this issue" className={`flex min-h-[28rem] flex-col overflow-hidden rounded-lg border bg-background ${className ?? ""}`}>
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <ChatCircleIcon className="size-4" />
        <h3 className="text-sm font-semibold">Thread</h3>
        <ThreadBadge subject={subject} />
        <span className="ml-auto" />
        {a.session && here && (
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="sm" onClick={() => a.start(subject, { fresh: true, panel: false })} disabled={a.busy || a.starting} />}><SparkleIcon data-icon="inline-start" />New thread</TooltipTrigger>
            <TooltipContent>Start over on this issue. This thread is kept under Earlier sessions.</TooltipContent>
          </Tooltip>
        )}
      </header>
      {a.open ? (
        <div className="flex flex-1 flex-col items-start gap-2 p-4 text-sm text-muted-foreground">
          <p>The side panel is open on another conversation.</p>
          <Button size="sm" variant="outline" onClick={a.close}><SidebarSimpleIcon data-icon="inline-start" />Close it and show this issue's thread</Button>
        </div>
      ) : here ? <ThreadBody /> : <p className="p-4 text-sm text-muted-foreground">Opening the thread…</p>}
    </section>
  )
}
