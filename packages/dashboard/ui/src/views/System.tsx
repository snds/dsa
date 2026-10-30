import * as React from "react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Note, Panel, StatusDot } from "@/components/bits"
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
  const initial = (location.hash.split("/")[1] as Filter) || "all"
  const [filter, setFilter] = React.useState<Filter>(FILTERS.some((f) => f.id === initial) ? initial : "all")
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
        <ToggleGroup value={[filter]} onValueChange={(v: any) => { const f = (Array.isArray(v) ? v[0] : v) as Filter; if (f) { setFilter(f); try { history.replaceState(null, "", `#system/${f}`) } catch { /* file:// */ } } }} variant="outline" size="sm">
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
            <TableHead className="text-right">Variants</TableHead>
            <TableHead className="text-right">Parts</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">App uses</TableHead>
            <TableHead className="text-right">Used as intended</TableHead>
            <TableHead className="text-right">Look-alikes</TableHead>
            <TableHead className="pr-4">Found by</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {!rows.length && <TableRow><TableCell colSpan={9} className="pl-4 text-muted-foreground">Nothing matches.</TableCell></TableRow>}
            {rows.map((c) => {
              const found = c.inferred ? { label: "Only in app code", trust: "low" } : FOUND_BY[c.evidence.tier] ?? { label: c.evidence.tier, trust: "medium" }
              const used = c.u?.instances ? 100 - c.u.overridden_pct : null
              return (
                <TableRow key={c.key}>
                  <TableCell className="pl-4">
                    <span className="font-medium">{c.name}</span>
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
                  <TableCell className="text-right tabular-nums"><List items={c.axes.map((a: any) => `${a.name}: ${a.values.join(", ")}`)} n={c.axes.length} /></TableCell>
                  <TableCell className="text-right tabular-nums"><List items={c.parts} n={c.parts.length} /></TableCell>
                  <TableCell className="text-right tabular-nums">{c.tokens ? fmt(c.tokens) : <span className="text-muted-foreground">0</span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(c.uses.consumer)}{c.uses.files ? <span className="ml-1 text-xs text-muted-foreground">in {fmt(c.uses.files)} file{c.uses.files === 1 ? "" : "s"}</span> : null}</TableCell>
                  <TableCell className="text-right tabular-nums">{used == null ? "—" : <span className="inline-flex items-center gap-2">{pct(used)}<StatusDot band={band(used, cu?.watch ?? 90, cu?.act ?? 75)} /></span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(c.u?.lookalikes ?? 0)}</TableCell>
                  <TableCell className="pr-4">
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex cursor-default items-center gap-1.5 text-sm" />}>
                        <StatusDot band={found.trust === "high" ? "good" : found.trust === "medium" ? "warn" : "crit"} />{found.label}
                      </TooltipTrigger>
                      <TooltipContent><span className="font-mono text-xs">{c.evidence.file}{c.evidence.line ? `:${c.evidence.line}` : ""}</span> ({c.evidence.extractor})</TooltipContent>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <Note className="mt-3 px-4">"Found by" is how {SYS}'s source declares each component: a circle is reliable (declared or exported), a diamond is a stylesheet class, a square is naming alone or app code alone and should be confirmed. Kind is the component type the scan recognises (button, dialog, tabs…); a question mark means it was close to another kind.</Note>
      </Panel>
    </div>
  )
}

function List({ items, n }: { items: string[]; n: number }) {
  if (!n) return <span className="text-muted-foreground">0</span>
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-default underline decoration-dotted underline-offset-4" />}>{fmt(n)}</TooltipTrigger>
      <TooltipContent className="max-w-sm"><ul className="text-xs">{items.slice(0, 12).map((x) => <li key={x}>{x}</li>)}{items.length > 12 && <li>and {items.length - 12} more</li>}</ul></TooltipContent>
    </Tooltip>
  )
}
