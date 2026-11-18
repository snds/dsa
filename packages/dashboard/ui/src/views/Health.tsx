import * as React from "react"
import { D } from "@/lib/dsa"
import { Overview } from "@/views/Overview"
import { Trends } from "@/views/Trends"
import { Readiness } from "@/views/Readiness"

/**
 * Health (redesign stage 8): are we getting better, and how sure is this scan? The measures and the
 * scan's confidence (once Overview), their lines over time (once Trends), and agent readiness and bench
 * runs (once Agents & Benchmarks), on one page. Old links (#overview, #trends, #readiness) land on
 * their section here.
 */
export const HEALTH_SECTIONS = [
  { id: "measures", label: "Measures", from: "overview" },
  { id: "trends", label: "Over time", from: "trends" },
  { id: "readiness", label: "Agent readiness", from: "readiness" },
] as const

export function Health({ go, section }: { go: (view: string) => void; section?: string }) {
  const readiness = Boolean(D.readiness?.length || D.bench?.length)
  const sections = HEALTH_SECTIONS
  React.useEffect(() => {
    const s = HEALTH_SECTIONS.find(x => x.from === section || x.id === section)
    if (s && s.id !== "measures") document.getElementById(`health-${s.id}`)?.scrollIntoView({ block: "start" })
  }, [section])
  return (
    <div className="flex flex-col gap-10">
      <nav aria-label="On this page" className="flex flex-wrap gap-3 text-sm">
        {sections.map(s => <a key={s.id} href={`#health-${s.id}`} onClick={e => { e.preventDefault(); document.getElementById(`health-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }) }} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">{s.label}</a>)}
      </nav>
      <section id="health-measures" aria-label="Measures" className="scroll-mt-40"><Overview go={go} health /></section>
      <section id="health-trends" aria-labelledby="h-trends" className="flex scroll-mt-40 flex-col gap-4">
        <h2 id="h-trends" className="font-heading text-lg font-semibold">Over time</h2>
        <Trends />
      </section>
      <section id="health-readiness" aria-labelledby="h-readiness" className="flex scroll-mt-40 flex-col gap-4">
        <h2 id="h-readiness" className="font-heading text-lg font-semibold">Agent readiness and bench runs</h2>
        {/* Say why it's empty rather than hide it (UX review B U-21). */}
        {readiness ? <Readiness /> : <p className="max-w-prose text-sm text-muted-foreground">Not measured in this run. A scan measures it when the profile names a readiness provider; <code>dsa run --no-readiness</code> skips it.</p>}
      </section>
    </div>
  )
}
