import * as React from "react"
import { cn } from "cn"
import { ClockCounterClockwiseIcon, NoteIcon, ScalesIcon, SlidersHorizontalIcon, SparkleIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { D } from "@/lib/dsa"
import { General } from "./General"
import { Notes, noteCount } from "./Notes"
import { Rules } from "./Rules"
import { History } from "./History"
import { Agents } from "./Agents"

export type SectionId = "general" | "agents" | "notes" | "rules" | "history"
export const SECTIONS: { id: SectionId; label: string; icon: React.ElementType; hint: string }[] = [
  { id: "general", label: "Settings", icon: SlidersHorizontalIcon, hint: "Sources, tokens, measures, modules" },
  { id: "agents", label: "Agents", icon: SparkleIcon, hint: "Connect Claude Code or Cursor; proposals and scanner hints" },
  { id: "notes", label: "Notes", icon: NoteIcon, hint: "Scan notes, errors, and the change log" },
  { id: "rules", label: "Rules", icon: ScalesIcon, hint: "Rule settings and metric thresholds" },
  { id: "history", label: "History", icon: ClockCounterClockwiseIcon, hint: "Every run" },
]

/** Settings has its own side nav: each item swaps the content on the right (not a table of contents). */
export function SettingsPage({ section, onSection, onTitle }: { section: SectionId; onSection: (s: SectionId) => void; onTitle: (t: string) => void }) {
  const counts: Partial<Record<SectionId, number>> = { notes: noteCount(), history: D.runs.length }
  const cur = SECTIONS.find(s => s.id === section)!
  return (
    <div className="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
      <nav aria-label="Settings sections" className="md:sticky md:top-36 md:self-start">
        <ul className="flex gap-1 overflow-x-auto md:flex-col">
          {SECTIONS.map(s => (
            <li key={s.id}>
              <button type="button" onClick={() => onSection(s.id)} aria-current={section === s.id ? "page" : undefined}
                className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm whitespace-nowrap transition-colors hover:bg-muted", section === s.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground")}>
                <s.icon className="size-4" weight={section === s.id ? "fill" : "regular"} />
                <span className="flex-1">{s.label}</span>
                {counts[s.id] ? <Badge variant="secondary" className="tabular-nums">{counts[s.id]}</Badge> : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <section className="min-w-0">
        <div className="mb-5">
          <h2 className="font-heading text-lg font-semibold">{cur.label}</h2>
          <p className="text-sm text-muted-foreground">{cur.hint}</p>
        </div>
        {section === "general" ? <General onTitle={onTitle} /> : section === "agents" ? <Agents /> : section === "notes" ? <Notes /> : section === "rules" ? <Rules /> : <History />}
      </section>
    </div>
  )
}
