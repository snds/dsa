import * as React from "react"
import { cn } from "cn"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Code, Note, Panel, Stat } from "@/components/bits"
import { D, SYS, copy, fmt, fmtDT } from "@/lib/dsa"

/**
 * System Usage: where the system's tokens and components are used, per library, from the system's own
 * usage scan (the profile's `usage`), so usage, the element review, readiness, and the bench are one dashboard.
 */
type Hit = { name: string; total: number; files: string[] }
type Lib = { id: string; name: string; role: "parent" | "consumer" | "product"; present: boolean; note: string | null; componentUses: Hit[]; tokenUses: Hit[] }
type Issue = { id: string; kind: "primitive-color" | "unused-component"; libraryId: string; libraryName: string; file: string; line: number | null; evidence: string; summary: string; action: string }
type Report = { generatedAt: string; tokens: { name: string; category: "color" | "typography" | "spacing"; source: string }[]; components: { name: string; file: string }[]; libraries: Lib[]; issues: Issue[]; issueTotal: number }

const ROLE = { parent: "Parent", consumer: "Consumer", product: "Product" }
const inView = (l: Lib, id: string) => l.present && (id === "all" || (id === "products" ? l.role === "product" : id === "consumers" ? l.role === "consumer" : l.id === id))
const ticket = (i: Issue) => [`Design system: ${i.summary}`, "", `Library: ${i.libraryName}`, `Where: ${i.file}${i.line ? `:${i.line}` : ""}`, `Found: ${i.evidence}`, "", i.action].join("\n")

function merge(libs: Lib[], key: "tokenUses" | "componentUses", id: string): Hit[] {
  const m = new Map<string, Hit>()
  for (const l of libs) if (inView(l, id)) for (const h of l[key]) {
    const c = m.get(h.name) ?? { name: h.name, total: 0, files: [] }
    c.total += h.total
    for (const f of h.files) if (c.files.length < 40 && !c.files.includes(f)) c.files.push(f)
    m.set(h.name, c)
  }
  return [...m.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

export function Usage() {
  const r: Report | null = D.usage ?? null
  const [lib, setLib] = React.useState("products")
  const [cat, setCat] = React.useState<"color" | "typography" | "spacing">("color")
  const [tok, setTok] = React.useState<string | null>(null)
  const tokenHits = React.useMemo(() => (r ? merge(r.libraries, "tokenUses", lib) : []), [r, lib])
  const compHits = React.useMemo(() => (r ? merge(r.libraries, "componentUses", lib) : []), [r, lib])
  if (!r) return (
    <Empty className="border"><EmptyHeader><EmptyTitle>No system-usage scan in this report</EmptyTitle>
      <EmptyDescription>The design system's profile supplies this view (its <Code>usage</Code> hook). Run the system's usage scan, then re-run this scan.</EmptyDescription></EmptyHeader></Empty>
  )
  // The whole system: every product, everything, or the parent library itself.
  const isWhole = (id: string) => id === "products" || id === "all" || r.libraries.some(l => l.id === id && l.role === "parent")
  const issues = r.issues.filter(i => (i.kind === "unused-component" ? isWhole(lib) : (() => { const l = r.libraries.find(x => x.id === i.libraryId); return l ? inView(l, lib) : false })()))
  const colors = issues.filter(i => i.kind === "primitive-color")
  const unused = issues.filter(i => i.kind === "unused-component")
  const tokens = r.tokens.filter(t => t.category === cat).map(t => ({ ...t, hit: tokenHits.find(h => h.name === t.name) ?? null })).sort((a, b) => (b.hit?.total ?? 0) - (a.hit?.total ?? 0) || a.name.localeCompare(b.name))
  const sel = tokens.find(t => t.name === tok) ?? tokens[0] ?? null
  // Only names in the catalog count: the scan also records names it can't match to a system token or component.
  const used = (key: "tokenUses" | "componentUses") => { const known = new Set((key === "tokenUses" ? r.tokens : r.components).map(x => x.name)); return new Set(merge(r.libraries, key, lib).filter(h => h.total > 0 && known.has(h.name)).map(h => h.name)).size }
  const present = r.libraries.filter(l => l.present)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap gap-1.5">
          {r.libraries.map(l => <Badge key={l.id} variant={l.present ? "secondary" : "outline"}>{ROLE[l.role]} · {l.name}{l.present ? "" : " · not scanned"}</Badge>)}
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium sm:w-72">Library
          <NativeSelect className="w-full" value={lib} onChange={e => { setLib(e.target.value); setTok(null) }}>
            <NativeSelectOption value="products">Child products</NativeSelectOption>
            <NativeSelectOption value="consumers">{`Consumers inside ${SYS}`}</NativeSelectOption>
            <NativeSelectOption value="all">Everything</NativeSelectOption>
            <NativeSelectOptGroup label="Child products">{present.filter(l => l.role === "product").map(l => <NativeSelectOption key={l.id} value={l.id}>{l.name}</NativeSelectOption>)}</NativeSelectOptGroup>
            <NativeSelectOptGroup label="Consumers">{present.filter(l => l.role === "consumer").map(l => <NativeSelectOption key={l.id} value={l.id}>{l.name}</NativeSelectOption>)}</NativeSelectOptGroup>
            <NativeSelectOptGroup label="Parent">{present.filter(l => l.role === "parent").map(l => <NativeSelectOption key={l.id} value={l.id}>{l.name}</NativeSelectOption>)}</NativeSelectOptGroup>
          </NativeSelect>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Components used" value={`${used("componentUses")} / ${r.components.length}`} detail={`${SYS} components imported at least once`} />
        <Stat label="Tokens used" value={`${used("tokenUses")} / ${r.tokens.length}`} detail="Semantic tokens referenced at least once" />
        <Stat label="Primitive colors" value={fmt(colors.length)} detail="Raw palette steps instead of a color role" />
        <Stat label="Unused components" value={fmt(unused.length)} detail="No child product imports them" />
      </div>
      <Note className="text-xs">Scanned {fmtDT(r.generatedAt)} with <Code>npm run system:scan</Code>.{r.issueTotal > r.issues.length ? ` The scan found ${r.issueTotal} issues; the first ${r.issues.length} are kept.` : ""}</Note>

      <Tabs defaultValue="issues">
        <TabsList variant="line">
          <TabsTrigger value="issues">Issues ({issues.length})</TabsTrigger>
          <TabsTrigger value="tokens">Tokens</TabsTrigger>
          <TabsTrigger value="components">Components ({compHits.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="issues" className="mt-4 flex flex-col gap-6">
          <Panel title="Components no child product imports" description="Candidates to promote, document, or retire" contentClassName="px-0">
            {unused.length ? <ul className="divide-y">{unused.map(i => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <span><Code>{i.evidence}</Code> <span className="text-muted-foreground">· {i.summary}</span></span>
                <Button size="sm" variant="outline" onClick={() => copy(ticket(i), "Ticket text copied")}>Copy ticket</Button>
              </li>))}</ul> : <Note className="px-4">{isWhole(lib) ? "Every scanned component is imported by at least one child product." : `Choose Child products, Everything, or ${SYS} to see unused components.`}</Note>}
          </Panel>
          <Panel title="Primitive colors" description="Classes that name a raw palette step instead of a semantic color role" contentClassName="px-0">
            <Table>
              <TableHeader><TableRow><TableHead>Issue</TableHead><TableHead>Where</TableHead><TableHead>Action</TableHead></TableRow></TableHeader>
              <TableBody>
                {colors.length ? colors.map(i => (
                  <TableRow key={i.id}>
                    <TableCell className="align-top whitespace-normal"><span className="block font-medium">{i.summary}</span><Code className="mt-1 inline-block">{i.evidence}</Code></TableCell>
                    <TableCell className="align-top font-mono text-xs whitespace-normal">{i.libraryName}<br />{i.file}{i.line ? `:${i.line}` : ""}</TableCell>
                    <TableCell className="align-top whitespace-normal"><p className="mb-2 text-sm">{i.action}</p><Button size="sm" variant="outline" onClick={() => copy(ticket(i), "Ticket text copied")}>Copy ticket</Button></TableCell>
                  </TableRow>
                )) : <TableRow><TableCell colSpan={3} className="text-muted-foreground">None for this library.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </Panel>
        </TabsContent>
        <TabsContent value="tokens" className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Token group">
            {(["color", "typography", "spacing"] as const).map(c => <Button key={c} size="sm" variant={cat === c ? "default" : "outline"} aria-pressed={cat === c} onClick={() => { setCat(c); setTok(null) }}>{c === "typography" ? "Type" : c[0].toUpperCase() + c.slice(1)}</Button>)}
          </div>
          <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <ul aria-label={`${cat} tokens`} className="max-h-[28rem] overflow-auto rounded-lg border">
              {tokens.map(t => (
                <li key={t.name}><button type="button" onClick={() => setTok(t.name)} aria-current={sel?.name === t.name ? "true" : undefined}
                  className={cn("flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted", sel?.name === t.name && "bg-muted")}>
                  <span className="truncate font-mono text-xs">{t.name}</span><span className="text-xs text-muted-foreground tabular-nums">{t.hit?.total ?? 0}</span>
                </button></li>
              ))}
            </ul>
            {sel ? <UsageTable rows={sel.hit ? [sel.hit] : []} empty={`Nothing in this view uses ${sel.name}.`} /> : <Note>This group has no tokens.</Note>}
          </div>
        </TabsContent>
        <TabsContent value="components" className="mt-4"><UsageTable rows={compHits} empty={`Nothing in this view imports a ${SYS} component.`} /></TabsContent>
      </Tabs>
    </div>
  )
}

function UsageTable({ rows, empty }: { rows: Hit[]; empty: string }) {
  return (
    <Panel contentClassName="px-0">
      <Table>
        <TableHeader><TableRow><TableHead>Name</TableHead><TableHead className="text-right">Uses</TableHead><TableHead>Files</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.length ? rows.map(h => (
            <TableRow key={h.name}>
              <TableCell className="align-top font-mono text-xs">{h.name}</TableCell>
              <TableCell className="text-right align-top tabular-nums">{fmt(h.total)}</TableCell>
              <TableCell className="whitespace-normal"><details><summary className="cursor-pointer text-xs text-muted-foreground">{h.files.length} file{h.files.length === 1 ? "" : "s"}</summary><ul className="mt-1 space-y-0.5 font-mono text-xs">{h.files.map(f => <li key={f}>{f}</li>)}</ul></details></TableCell>
            </TableRow>
          )) : <TableRow><TableCell colSpan={3} className="text-muted-foreground">{empty}</TableCell></TableRow>}
        </TableBody>
      </Table>
    </Panel>
  )
}
