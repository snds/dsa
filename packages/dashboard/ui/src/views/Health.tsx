import * as React from "react"
import { cn } from "cn"
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
  // The section in view, for the nav's current mark.
  const [at, setAt] = React.useState<string>("measures")
  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return
    const io = new IntersectionObserver(es => { const top = es.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (top) setAt(top.target.id.replace(/^health-/, "")) }, { rootMargin: "-20% 0px -60% 0px" })
    for (const s of sections) { const el = document.getElementById(`health-${s.id}`); if (el) io.observe(el) }
    return () => io.disconnect()
  }, [sections.length])
  React.useEffect(() => {
    const s = HEALTH_SECTIONS.find(x => x.from === section || x.id === section)
    if (s && s.id !== "measures") document.getElementById(`health-${s.id}`)?.scrollIntoView({ block: "start" })
  }, [section])
  return (
    <div className="flex flex-col gap-10">
      {/* The same pills as Components' parts, with the section in view marked (visual A V-16, C V-12; B V-20). */}
      <nav aria-label="On this page" className="sticky top-28 z-10 -mb-6 flex flex-wrap gap-1 bg-background/95 py-1 text-sm backdrop-blur">
        {sections.map(s => <a key={s.id} href={`#health-${s.id}`} aria-current={at === s.id ? "location" : undefined}
          onClick={e => { e.preventDefault(); setAt(s.id); document.getElementById(`health-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }) }}
          className={cn("rounded-md px-2.5 py-1", at === s.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>{s.label}</a>)}
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
