import * as React from "react"
import { MinusCircleIcon, CaretDownIcon, CheckCircleIcon, WarningIcon, ArrowsClockwiseIcon, RobotIcon } from "@phosphor-icons/react"
import { cn } from "cn"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { api } from "@/lib/dsa"
import { anchorKeyOf, canChat, type Subject } from "./store"

type Source = { layer: "rules" | "system" | "evidence" | "memory" | "repo"; name: string; status: "included" | "missing" | "stale" | "none-yet"; detail: string }
const LAYER: Record<Source["layer"], string> = { rules: "Rules", system: "System", evidence: "Evidence", memory: "Memory", repo: "Repo" }
const ICON = { included: CheckCircleIcon, missing: WarningIcon, stale: ArrowsClockwiseIcon, "none-yet": MinusCircleIcon }
const TONE = { included: "text-success-soft-foreground", missing: "text-warning-soft-foreground", stale: "text-caution", "none-yet": "text-muted-foreground" }

/**
 * "What the agent knows" (redesign stage 6): every source the agent is given for this subject, by
 * layer, with what's missing or stale counted in the summary. A reviewer judges an answer by what it
 * rests on; a gap here is said, not hidden.
 */
export function Knows({ subject }: { subject: Subject }) {
  const [src, setSrc] = React.useState<Source[] | null>(null)
  const [open, setOpen] = React.useState(false)
  const key = anchorKeyOf(subject)
  React.useEffect(() => {
    if (!canChat()) return
    let live = true
    api("/api/agent/context", { subject }).then(r => { if (live) setSrc(r.sources) }).catch(() => { if (live) setSrc(null) })
    return () => { live = false }
  }, [key])
  if (!src) return null
  // Only real gaps count; "none yet" is a new system, not a problem.
  const gaps = src.filter(s => s.status === "missing" || s.status === "stale").length
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-4 rounded-lg bg-muted/60" data-slot="agent-knows">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold" aria-label={`What the agent knows: ${src.length} sources, ${gaps} missing or stale. ${open ? "Hide" : "Show"} them.`}>
        <RobotIcon className="size-4 text-muted-foreground" />What the agent knows
        <Badge variant="outline" className={cn("ml-auto", gaps ? "border-warning-soft-border bg-warning-soft text-warning-soft-foreground" : "")}>{gaps ? <WarningIcon /> : <CheckCircleIcon />}{src.length} sources{gaps ? ` · ${gaps} missing` : ""}</Badge>
        <CaretDownIcon className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-2 px-3 pb-3">
          {src.map((s, i) => {
            const Icon = ICON[s.status]
            return (
              <li key={i} className="flex gap-2 text-xs">
                <Icon className={cn("mt-0.5 size-3.5 shrink-0", TONE[s.status])} aria-label={s.status} />
                <span className="min-w-0">
                  <span className="font-medium">{LAYER[s.layer]} · {s.name}</span>
                  <span className="block text-muted-foreground">{s.detail}</span>
                </span>
              </li>
            )
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
