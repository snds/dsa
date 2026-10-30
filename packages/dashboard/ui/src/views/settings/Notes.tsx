import * as React from "react"
import { cn } from "cn"
import { WarningCircleIcon, InfoIcon, PencilSimpleIcon, XCircleIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Code } from "@/components/bits"
import { D, api, fmtDT, say, T } from "@/lib/dsa"

type Kind = "error" | "warning" | "scan" | "change"
interface Item { at: any; kind: Kind; title: string; body?: React.ReactNode; source?: string }

/**
 * Everything worth a note, newest first: errors from the suite itself (a failed scan, skipped
 * screenshots), the latest scan's notes, and every rule or setting change.
 */
function items(): Item[] {
  const out: Item[] = []
  for (const e of D.events ?? []) out.push({ at: e.at, kind: e.level === "error" ? "error" : e.level === "warning" ? "warning" : "scan", title: e.message, source: e.source, body: e.detail })
  for (const n of D.run?.sources?.notes ?? []) out.push({ at: D.run.takenAt, kind: /fail|error|could not|couldn't|skipped|unavailable/i.test(n) ? "warning" : "scan", title: n, source: "Latest scan" })
  for (const l of D.settingsLog ?? []) out.push({ at: l.at, kind: "change", title: `${l.key} changed`, body: <span><Code>{String(l.old_value)}</Code> → <Code>{String(l.new_value)}</Code>{l.note ? ` · ${l.note}` : ""}</span>, source: "Rules and settings" })
  return out.sort((a, b) => T(b.at).getTime() - T(a.at).getTime())
}
export const noteCount = () => items().filter(i => i.kind === "error" || i.kind === "warning").length

const ICON = { error: XCircleIcon, warning: WarningCircleIcon, scan: InfoIcon, change: PencilSimpleIcon }
const TONE = { error: "text-destructive", warning: "text-warning-soft-foreground", scan: "text-muted-foreground", change: "text-primary" }

export function Notes() {
  const all = React.useMemo(items, [])
  const [filter, setFilter] = React.useState<string>("all")
  const list = all.filter(i => filter === "all" || (filter === "problems" ? i.kind === "error" || i.kind === "warning" : i.kind === filter))
  async function clear() {
    try { await api("/api/notes/clear", {}); say("Errors and warnings cleared"); setTimeout(() => location.reload(), 500) } catch (e: any) { say(e.message, true) }
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup value={[filter]} onValueChange={(v: any) => setFilter(v[0] ?? "all")} variant="outline" size="sm">
          <ToggleGroupItem value="all">All {all.length}</ToggleGroupItem>
          <ToggleGroupItem value="problems">Errors and warnings {all.filter(i => i.kind === "error" || i.kind === "warning").length}</ToggleGroupItem>
          <ToggleGroupItem value="scan">Scan notes {all.filter(i => i.kind === "scan").length}</ToggleGroupItem>
          <ToggleGroupItem value="change">Changes {all.filter(i => i.kind === "change").length}</ToggleGroupItem>
        </ToggleGroup>
        {D.serve && (D.events?.length ?? 0) > 0 && <Button variant="outline" size="sm" onClick={clear}>Clear errors and warnings</Button>}
      </div>
      {list.length ? (
        <ul className="divide-y rounded-lg border">
          {list.map((i, n) => { const Icon = ICON[i.kind]; return (
            <li key={n} className="flex gap-3 px-4 py-3">
              <Icon className={cn("mt-0.5 size-4 shrink-0", TONE[i.kind])} weight="fill" />
              <div className="min-w-0 flex-1">
                <p className="text-sm">{i.title}</p>
                {i.body && <div className="mt-1 text-xs text-muted-foreground">{i.body}</div>}
                <p className="mt-1 text-xs text-muted-foreground">{fmtDT(i.at)}{i.source ? ` · ${i.source}` : ""}</p>
              </div>
            </li>) })}
        </ul>
      ) : (
        <Empty className="border"><EmptyHeader><EmptyTitle>Nothing here</EmptyTitle><EmptyDescription>No notes of this kind.</EmptyDescription></EmptyHeader></Empty>
      )}
    </div>
  )
}
