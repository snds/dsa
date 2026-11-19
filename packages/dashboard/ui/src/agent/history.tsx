import * as React from "react"
import { ChatCircleDotsIcon, ClockCounterClockwiseIcon, ListIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ago, api } from "@/lib/dsa"
import { openRoute } from "@/lib/app"
import { anchorKeyOf, useAgent, type Subject, type ThreadState } from "./store"

/** A conversation as the list returns it (GET /api/agent/sessions). */
export interface ConvSummary {
  id: string; title: string; name?: string | null; starred?: boolean; subject: Subject; anchor: string; provider: string
  turns: number; asked: string | null; updatedAt: string; createdAt: string; state: ThreadState; openProposals: number; running: boolean
}

/** What a conversation is about, as chip labels. */
export function aboutOf(s: Subject): { key?: string; label: string; app?: string }[] {
  switch (s.kind) {
    case "set": return s.items.map(i => ({ key: i.key, label: i.title ?? i.key, app: i.app }))
    case "issue": return [{ key: s.key, label: s.title ?? s.key }]
    case "queue": return [{ key: s.id, label: s.id }]
    case "review": return [{ label: s.title ?? `${s.ids.length} element${s.ids.length === 1 ? "" : "s"}` }]
    case "component": return [{ label: `Component: ${s.name}` }]
    case "group": return [{ label: s.by === "component" ? `Everything about ${s.value}` : `Everything in ${s.value}` }]
    case "readiness": return [{ label: `Readiness: ${s.subject}` }]
    default: return [{ label: "The whole scan" }]
  }
}

/** The issue keys a conversation is about. */
export const keysOf = (s: Subject): string[] => aboutOf(s).flatMap(x => (x.key ? [x.key] : []))

export const nameOf = (c: ConvSummary) => c.name || c.title

export async function listConversations(): Promise<ConvSummary[]> {
  return (await api("/api/agent/sessions")).sessions ?? []
}

/**
 * History (replaces "Earlier sessions"): conversations about the issues in view, or all of them, with a
 * way to start one about the whole scan and a link to the Conversations tab.
 */
export function History({ keys, anchor }: { keys?: string[]; anchor?: string }) {
  const a = useAgent()
  const [list, setList] = React.useState<ConvSummary[]>([])
  const mine = keys ? list.filter(c => keysOf(c.subject).some(k => keys.includes(k))) : list
  return (
    <DropdownMenu onOpenChange={(o: boolean) => { if (o) listConversations().then(setList).catch(() => {}) }}>
      <Tooltip>
        <TooltipTrigger render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="History" />} />}><ClockCounterClockwiseIcon /></TooltipTrigger>
        <TooltipContent>{keys ? "Conversations about these issues" : "Conversations"}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-80">
        {/* A group label must sit inside a group (Base UI throws, and the whole page goes blank, otherwise). */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{keys ? "About these issues" : "Recent conversations"}</DropdownMenuLabel>
          {!keys && <DropdownMenuItem onClick={() => a.start({ kind: "scan" })}><ChatCircleDotsIcon />New: talk about the whole scan</DropdownMenuItem>}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {mine.length ? mine.slice(0, 12).map(c => (
          // The same anchor opens in place; anything else opens in the side panel.
          <DropdownMenuItem key={c.id} onClick={() => a.resume(c.id, { panel: !(anchor && anchorKeyOf(c.subject) === anchor) })} className="flex-col items-start gap-0">
            <span className="w-full truncate">{c.starred ? "★ " : ""}{nameOf(c)}</span>
            <span className="text-xs text-muted-foreground">{c.turns} message{c.turns === 1 ? "" : "s"} · {ago(c.updatedAt)}</span>
          </DropdownMenuItem>
        )) : <p className="px-2 py-1.5 text-xs text-muted-foreground">None yet.</p>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openRoute("conversations")}><ListIcon />All conversations</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
