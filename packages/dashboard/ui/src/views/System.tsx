import * as React from "react"
import { CaretRightIcon } from "@phosphor-icons/react"
import { cn } from "cn"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Code, Facts, Note, Panel, StatusDot } from "@/components/bits"
import { D, SYS, band, fmt, pct, threshold } from "@/lib/dsa"
import { FOUND_BY } from "@/lib/insight"
import { Components } from "@/views/Components"

type Filter = "all" | "check" | "unused" | "deprecated"
const FILTERS: { id: Filter; label: string; hint: string }[] = [
  { id: "all", label: "All", hint: "Every component the scan found" },
  { id: "check", label: "Needs a check", hint: "Found only by naming, known only from app code, or of an unclear kind" },
  { id: "unused", label: "Not used by apps", hint: "No app uses it: promote, document, or retire" },
  { id: "deprecated", label: "Deprecated", hint: "Marked deprecated in the config" },
]

/**
 * What the scan believes the system is: each component with its kind, variants, parts and tokens, how much
 * apps use it and how faithfully, and how it was found. "Needs a check" is the list to confirm by hand.
 */
export function System() {
  const m = D.model
  const [, initial, linked] = location.hash.slice(1).split("/") as [string, Filter | undefined, string | undefined]
  const [filter, setFilter] = React.useState<Filter>(FILTERS.some((f) => f.id === initial) ? initial! : "all")
  // One component open at a time, in the address bar (#system/<filter>/<key>) so a link opens it.
  const [opened, setOpened] = React.useState<string | null>(linked ? decodeURIComponent(linked) : null)
  const openRow = (key: string | null) => { setOpened(key); try { history.replaceState(null, "", `#system/${filter}${key ? `/${encodeURIComponent(key)}` : ""}`) } catch { /* file:// */ } }
  const [q, setQ] = React.useState("")
  if (!m) return <Components />

  const usage = new Map<string, any>((D.components ?? []).map((c: any) => [String(c.component).toLowerCase(), c]))
  const cu = threshold("correct_use_rate")
  // The same test as the Overview: found by naming alone, known only from app code, or of an unclear kind.
  // A component with no recognised kind is not suspect: the archetypes cover the common kinds only.
  const needsCheck = (c: any) => c.inferred || c.evidence.tier === "convention" || c.kind?.ambiguous
  const rows = (m.components as any[]).map((c) => ({ ...c, u: usage.get(c.name.toLowerCase()) }))
    .filter((c) => filter === "all" || (filter === "check" && needsCheck(c)) || (filter === "unused" && !c.uses.consumer) || (filter === "deprecated" && c.u?.deprecated))
    .filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.kind?.kind?.includes(q.toLowerCase()))
  const count = (f: Filter) => (m.components as any[]).filter((c) => f === "all" || (f === "check" && needsCheck(c)) || (f === "unused" && !c.uses.consumer) || (f === "deprecated" && usage.get(c.name.toLowerCase())?.deprecated)).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup value={[filter]} onValueChange={(v: any) => { const f = (Array.isArray(v) ? v[0] : v) as Filter; if (f) { setFilter(f); setOpened(null); try { history.replaceState(null, "", `#system/${f}`) } catch { /* file:// */ } } }} variant="outline" size="sm">
          {FILTERS.map((f) => (
            <Tooltip key={f.id}>
              <TooltipTrigger render={<ToggleGroupItem value={f.id} aria-label={f.label} />}>{f.label} <span className="ml-1 tabular-nums text-muted-foreground">{fmt(count(f.id))}</span></TooltipTrigger>
              <TooltipContent>{f.hint}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or kind" className="w-full sm:w-64" aria-label="Filter components" />
      </div>

      <Panel title={`${fmt(rows.length)} of ${fmt(m.counts.components)} components`} description={`${fmt(m.counts.parts)} parts and ${fmt(m.counts.icons)} icons are counted with their components, not listed here`} contentClassName="px-0">
        <Table>
          <TableHeader><TableRow>
            <TableHead className="pl-4">Component</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead className="text-right">App uses</TableHead>
            <TableHead className="text-right">Used as intended</TableHead>
            <TableHead className="text-right">Look-alikes</TableHead>
            <TableHead className="pr-4">Found by</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {!rows.length && <TableRow><TableCell colSpan={6} className="pl-4 text-muted-foreground">Nothing matches.</TableCell></TableRow>}
            {rows.map((c) => {
              const found = c.inferred ? { label: "Only in app code", trust: "low" } : FOUND_BY[c.evidence.tier] ?? { label: c.evidence.tier, trust: "medium" }
              const used = c.u?.instances ? 100 - c.u.overridden_pct : null
              const isOpen = opened === c.key
              const panel = `sys-${c.key.replace(/[^\w-]/g, "_")}`
              return (
                <React.Fragment key={c.key}>
                <TableRow data-state={isOpen ? "open" : undefined}>
                  <TableCell className="pl-4">
                    <button type="button" aria-expanded={isOpen} aria-controls={panel} onClick={() => openRow(isOpen ? null : c.key)} className="inline-flex items-center gap-1.5 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                      <CaretRightIcon aria-hidden className={cn("size-3 text-muted-foreground transition-transform motion-reduce:transition-none", isOpen && "rotate-90")} />{c.name}
                      <span className="sr-only">: technical details</span>
                    </button>
                    {c.library && c.library !== D.libraries?.[0]?.name && <span className="ml-2 text-xs text-muted-foreground">{c.library}</span>}
                    {c.u?.deprecated && <Badge variant="outline" className="ml-2">Deprecated{c.u.replacement ? ` → ${c.u.replacement}` : ""}</Badge>}
                  </TableCell>
                  <TableCell>
                    {c.kind ? (
                      <Tooltip>
                        <TooltipTrigger render={<span className="cursor-default" />}>
                          <Badge variant={c.kind.ambiguous || c.kind.confidence < 0.6 ? "outline" : "secondary"}>{c.kind.kind}{c.kind.ambiguous ? "?" : ""}</Badge>
                        </TooltipTrigger>
                        <TooltipContent>{Math.round(c.kind.confidence * 100)}% sure{c.kind.ambiguous ? ", and close to another kind" : ""}</TooltipContent>
                      </Tooltip>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(c.uses.consumer)}{c.uses.files ? <span className="ml-1 text-xs text-muted-foreground">in {fmt(c.uses.files)} file{c.uses.files === 1 ? "" : "s"}</span> : null}</TableCell>
                  <TableCell className="text-right tabular-nums">{used == null ? "—" : <span className="inline-flex items-center gap-2">{pct(used)}<StatusDot band={band(used, cu?.watch ?? 90, cu?.act ?? 75)} /></span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(c.u?.lookalikes ?? 0)}</TableCell>
                  <TableCell className="pr-4">
                    <span className="inline-flex items-center gap-1.5 text-sm"><StatusDot band={found.trust === "high" ? "good" : found.trust === "medium" ? "warn" : "crit"} />{found.label}</span>
                  </TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={6} className="px-4 py-3 whitespace-normal">
                      <div id={panel} role="region" aria-label={`${c.name}: technical details`} className="flex flex-col gap-2">
                        <p className="text-xs font-medium text-muted-foreground">Technical details</p>
                        <Facts rows={[
                          ["Variants", c.axes.length ? c.axes.map((a: any) => `${a.name}: ${a.values.join(", ")}`).join(" · ") : "None"],
                          ["Parts", c.parts.length ? c.parts.join(", ") : "None"],
                          ["Tokens", c.tokens ? fmt(c.tokens) : "None"],
                          ["Kind", c.kind ? `${c.kind.kind}, ${Math.round(c.kind.confidence * 100)}% sure${c.kind.ambiguous ? ", close to another kind" : ""}` : "Not recognised"],
                          ["Declared in", <><Code>{c.evidence.file}{c.evidence.line ? `:${c.evidence.line}` : ""}</Code> <span className="text-muted-foreground">({c.evidence.extractor})</span></>],
                        ]} />
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                </React.Fragment>
              )
            })}
          </TableBody>
        </Table>
        <Note className="mt-3 px-4">Open a component for its variants, parts, tokens and where it is declared. "Found by" is how {SYS}'s source declares each component: a circle is reliable (declared or exported), a diamond is a stylesheet class, a square is naming alone or app code alone and should be confirmed. Kind is the component type the scan recognises (button, dialog, tabs…); a question mark means it was close to another kind.</Note>
      </Panel>
    </div>
  )
}

