import * as React from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Note, SectionTitle, Stat } from "@/components/bits"
import { D, fmtDT, short, SYS } from "@/lib/dsa"
import { unstage, useStaged } from "@/lib/staged"
import { ElCtx, ElementRow, sameDecision } from "./shared"
import { StagedBar } from "./StagedBar"
import { Picker } from "./Picker"
import { Lightbox } from "./Lightbox"
import { CodeViewer } from "./CodeViewer"
import { Destination } from "./Destination"
import { NO_HOME, destinations, matches, styleName, unitsFor } from "./units"

/** Below this, the crawler's best on-page match may be a different element (shared classes, no shared label). */
export const SHOT_MIN = 0.8

// Once per page: a screenshot that may show another element is not evidence. Keep it aside, with its score, for the "why".
for (const e of D.elements?.evals ?? []) if (e.shot && e.shot.match < SHOT_MIN) { e.weakShot = e.shot; e.shot = null }

/**
 * Element review, grouped by where each decision lands: a system component (Button, Item…),
 * "No home yet", or "Keep native". Status is a filter over those groups (needs you, ready,
 * decided), so every card is listed once. A card names a design pattern and the decision it needs.
 */
export function Elements() {
  const E = D.elements, th = E.threshold
  const [, bump] = React.useState(0)
  const refresh = () => bump(x => x + 1)
  const byId = React.useMemo(() => new Map<string, any>(E.evals.map((e: any) => [e.id, e])), [E])
  const targets = [...new Set<string>(E.evals.map((e: any) => e.target))]
  // Open on the app with the most questions for a human (an app whose only open elements sit in unused files has none).
  const [target, setTarget] = React.useState<string>(() => {
    const asks = (t: string) => E.questions.filter((q: any) => E.evals.find((e: any) => e.id === q.ids[0])?.target === t).length
    return [...targets].sort((a, b) => asks(b) - asks(a))[0] ?? targets[0]
  })
  const [picker, setPicker] = React.useState<{ ids: string[]; pattern?: string | null } | null>(null)
  const [lb, setLb] = React.useState<{ ids: string[]; i: number } | null>(null)
  const [code, setCode] = React.useState<string | null>(null)
  const applyLocal = (ids: string[], decided: any) => { for (const id of ids) { const e = byId.get(id); if (!e) continue; if (decided) e.decided = decided; else delete e.decided; e.needsHuman = !e.decided && e.confidence < th } }
  const ctx = { th, byId, applyLocal, refresh, openPicker: setPicker, openLightbox: (ids: string[], i: number) => setLb({ ids, i }), openCode: setCode }

  const mine = E.evals.filter((e: any) => e.target === target)
  const unused = mine.filter((e: any) => e.exception === "unused")
  const deferred = mine.filter((e: any) => e.exception && e.exception !== "unused" && e.exception !== "lab").length
  const lab = mine.filter((e: any) => e.exception === "lab").length
  const qs = E.questions.filter((q: any) => byId.get(q.ids[0])?.target === target)

  const staged = useStaged()
  const stagedKeys = new Set(staged.map(x => x.key))
  // A staged decision that the repo now holds (applied with dsa decide --file, then republished) is done.
  React.useEffect(() => {
    if (D.serve) return
    for (const x of staged) {
      const ids = x.pattern ? E.evals.filter((e: any) => e.styleKey === x.pattern || e.styleSig === x.pattern).map((e: any) => e.id) : x.ids
      if (ids.length && ids.every((id: string) => sameDecision(byId.get(id)?.decided?.decision, x.decision))) unstage(x.key)
    }
  }, [staged, E, byId])

  const units = unitsFor(mine, qs, byId, stagedKeys)
  const count = (show: string) => units.filter(u => matches(u, show)).length
  const elementsIn = (show: string) => units.filter(u => matches(u, show)).reduce((a, u) => a + u.items.length, 0)
  const [show, setShow] = React.useState(() => (count("open") ? "open" : "all"))
  // A card stays where it was when the filter was set, so answering one under "Needs you" doesn't
  // make it vanish mid-review. Changing the filter re-sorts.
  const [kept, setKept] = React.useState<Set<string>>(() => new Set(units.filter(u => matches(u, show)).map(u => u.key)))
  const pick = (v: string[]) => { if (!v[0]) return; setShow(v[0]); setKept(new Set(units.filter(u => matches(u, v[0])).map(u => u.key))) }
  const shown = units.filter(u => kept.has(u.key) || matches(u, show))
  const dests = destinations(units).map(d => ({ d, units: d.units.filter(u => shown.includes(u)) })).filter(x => x.units.length)
  const [closed, setClosed] = React.useState<Set<string>>(new Set())
  const setOpen = (home: string, open: boolean) => setClosed(c => { const n = new Set(c); if (open) n.delete(home); else n.add(home); return n })
  const gaps = units.filter(u => u.home === NO_HOME && u.status !== "decided")
  const filters = [["open", "Needs you"], ...(!D.serve && count("staged") ? [["staged", "Staged"]] : []), ["ready", "Ready"], ["decided", "Decided"], ["all", "All"]] as [string, string][]

  return (
    <ElCtx.Provider value={ctx}>
      <div className="flex flex-col">
        {targets.length > 1 && (
          <div className="mb-4">
            <NativeSelect aria-label="App" value={target} onChange={e => setTarget(e.target.value)}>
              {targets.map(t => <NativeSelectOption key={t} value={t}>{t}</NativeSelectOption>)}
            </NativeSelect>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Need a decision" value={count("open")} detail={`${elementsIn("open")} elements`} active={show === "open"} onClick={() => pick(["open"])} />
          <Stat label="Ready to migrate" value={elementsIn("ready")} detail={`At or above ${Math.round(th * 100)}%, in ${count("ready")} groups`} active={show === "ready"} onClick={() => pick(["ready"])} />
          <Stat label="Decided" value={elementsIn("decided")} detail={staged.length && !D.serve ? `${staged.length} staged in this browser` : `${count("decided")} decisions`} active={show === "decided"} onClick={() => pick(["decided"])} />
          <Stat label={`No ${SYS} home yet`} value={gaps.reduce((a, u) => a + u.items.length, 0)} detail={`${gaps.length} pattern${gaps.length === 1 ? "" : "s"} to propose or map`} />
        </div>

        {/* The filter stays in reach while the groups scroll. */}
        <div className="sticky top-0 z-10 -mx-1 mt-6 mb-4 flex flex-wrap items-center gap-2 bg-background/95 px-1 py-2 backdrop-blur">
          <ToggleGroup aria-label="Show" value={[show]} onValueChange={pick} variant="outline" size="sm">
            {filters.map(([v, l]) => <ToggleGroupItem key={v} value={v}>{l} <span className="tabular-nums text-muted-foreground">{count(v)}</span></ToggleGroupItem>)}
          </ToggleGroup>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setClosed(closed.size ? new Set() : new Set(dests.map(x => x.d.home)))}>{closed.size ? "Expand all" : "Collapse all"}</Button>
        </div>
        {!D.serve && count("open") > 0 && <Note className="-mt-2 mb-4 text-xs">Read-only snapshot: Approve, Change and Ignore stage a decision in this browser. Download them from the bar at the bottom and apply them with <code className="font-mono">dsa decide --file</code>.</Note>}

        <div className="flex flex-col gap-6">
          {dests.map(({ d, units }) => <Destination key={d.home} d={d} units={units} open={!closed.has(d.home)} onOpenChange={v => setOpen(d.home, v)} />)}
          {!dests.length && <Note>{show === "open" ? "Nothing waiting on a decision." : "Nothing matches this filter."}</Note>}
        </div>

        <Housekeeping unused={unused} mine={mine} />
        <Note className="mt-8 text-xs">How these are made: each element is read from the code and matched to {SYS}. Confidence is the scanner’s score, adjusted by what reviewers decided before; below {Math.round(th * 100)}% a person decides. {E.shotsTaken ? `Screenshots from ${fmtDT(E.shotsTaken)}; matches under ${Math.round(SHOT_MIN * 100)}% aren’t shown.` : "No screenshots yet (dsa setup turns them on)."} {E.rendered ? `${SYS} rendered from ${E.rendered.source}.` : ""}{deferred ? ` ${deferred} elements sit in temporary or allowed exceptions and aren’t listed.` : ""}{lab ? ` ${lab} elements are on lab pages (specimens, not product UI) and aren’t listed.` : ""}</Note>
        {!D.serve && <StagedBar />}
      </div>
      {picker && <Picker target={picker} onClose={() => setPicker(null)} />}
      {lb && <Lightbox ids={lb.ids} start={lb.i} onClose={() => setLb(null)} />}
      {code && <CodeViewer id={code} onClose={() => setCode(null)} />}
    </ElCtx.Provider>
  )
}

/** Unused code and shared styles: useful, but not decisions. Folded at the end. */
function Housekeeping({ unused, mine }: { unused: any[]; mine: any[] }) {
  const E = D.elements
  const styles = E.patterns.filter((p: any) => mine.some((e: any) => e.styleKey === p.key || e.styleSig === p.key))
  if (!unused.length && !styles.length) return null
  return (
    <>
      <SectionTitle>Housekeeping</SectionTitle>
      <Card><CardContent className="flex flex-col divide-y">
        {unused.length > 0 && (
          <Fold title="Unused code" meta={`${unused.length} element${unused.length > 1 ? "s" : ""} in files nothing renders`}>
            <Note className="mb-2 text-xs">Nothing the app renders imports these files, so they aren’t reviewed. Delete them, or wire them back in.</Note>
            {(() => { const m = new Map<string, any[]>(); for (const e of unused) m.set(e.file, [...(m.get(e.file) ?? []), e]); return [...m].sort((a, b) => b[1].length - a[1].length).map(([f, items]) => <Fold key={f} title={<span className="font-mono">{short(f)}</span>} meta={`${items.length}`}>{items.map(e => <ElementRow key={e.id} e={e} />)}</Fold>) })()}
          </Fold>
        )}
        {styles.length > 0 && (
          <Fold title="Shared styles" meta={`${styles.length} looks reused across elements`}>
            <Note className="mb-2 text-xs">The same classes on several elements: a house component in all but name. One answer can cover all of them.</Note>
            <Table>
              <TableHeader><TableRow><TableHead>What it is</TableHead><TableHead className="text-right">Uses</TableHead><TableHead className="text-right">Files</TableHead><TableHead>Becomes</TableHead></TableRow></TableHeader>
              <TableBody>{styles.map((p: any) => (
                <TableRow key={p.key}>
                  <TableCell className="whitespace-normal"><span className="font-medium">{p.title || "Elements with the same look"}</span>{styleName(p.named ? p.key : null) && <span className="ml-2 font-mono text-xs text-muted-foreground">{p.key}</span>}{!p.named && <span className="ml-2 text-xs text-muted-foreground">same classes</span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.n}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.files}</TableCell>
                  <TableCell className="whitespace-normal text-sm">{p.recs.map((r: any) => `${r.rec}${p.recs.length > 1 ? ` ×${r.n}` : ""}`).join(", ")}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </Fold>
        )}
      </CardContent></Card>
    </>
  )
}

function Fold({ title, meta, children }: { title: React.ReactNode; meta: string; children: React.ReactNode }) {
  return (
    <Collapsible className="py-2">
      <CollapsibleTrigger className="flex min-w-0 items-baseline gap-2 text-left text-sm underline-offset-4 hover:underline"><b className="font-medium">{title}</b><span className="text-xs text-muted-foreground">{meta}</span></CollapsibleTrigger>
      <CollapsibleContent className="mt-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}
