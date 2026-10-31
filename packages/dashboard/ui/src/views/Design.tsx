import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Panel, StatusDot } from "@/components/bits"
import { D, band, fmt, pct, ratio } from "@/lib/dsa"

const ST: Record<string, string> = { crawled: "Crawled", stale: "Not edited recently", library: "Library file (skipped)", capped: "Over max files", error: "Unreadable" }

/** Figma library usage (optional module). When there's nothing to show, says why, most likely first. */
export function Design({ onSettings }: { onSettings: () => void }) {
  const src = D.run?.sources ?? {}, g = src.figmaDiag
  let why: [string, string] | null = null
  if (!src.figma && !g) why = ["Figma wasn't crawled in this run", "Add a Figma token and at least one library file in Settings, then run a scan. The crawler uses only the standard file API, so it works on Organization plans."]
  else if (g?.error) why = ["The Figma crawl failed", `${g.error} Check the token in Settings with Test. The code scan still ran.`]
  else if (g && !g.sources.files) why = ["No design files to scan", "The crawl read your library, but there were no product files to look in. Library files only define components, so they don't count as usage. Add the team, project, or file links where product design happens under Settings › Files to scan."]
  else if (g && !g.crawled) why = ["Every file was skipped", `${g.files.filter((f: any) => f.status === "stale").length} file(s) weren't edited within the window, and ${g.files.filter((f: any) => f.status === "error").length} couldn't be read. Widen "Edited within (days)" in Settings, or check file access.`]
  else if (!D.figma.length) why = ["No library components found in the crawled files", `${fmt(g?.crawled ?? 0)} file(s) were read, but none placed a component from your configured libraries. Check that the library link points to the published library those files use.`]

  return (
    <div className="flex flex-col gap-6">
      {D.figma.length ? (
        <Panel title="Library usage in recently edited design files" description="Look-alike frames are a name-based detach proxy (sampled)" contentClassName="px-0">
          <Table>
            <TableHeader><TableRow><TableHead className="pl-4">Component</TableHead><TableHead>Library</TableHead><TableHead className="text-right">Instances</TableHead><TableHead className="text-right">Look-alike frames</TableHead><TableHead className="text-right">Share rebuilt</TableHead><TableHead className="pr-4 text-right">Files</TableHead></TableRow></TableHeader>
            <TableBody>{D.figma.map((r: any) => { const share = ratio(r.frames, Number(r.instances) + Number(r.frames)); return (
              <TableRow key={r.library + r.component}><TableCell className="pl-4 font-medium">{r.component}</TableCell><TableCell>{r.library}</TableCell><TableCell className="text-right">{fmt(r.instances)}</TableCell><TableCell className="text-right">{fmt(r.frames)}</TableCell><TableCell className="text-right"><span className="inline-flex items-center gap-2">{pct(share)}<StatusDot band={band(share, 10, 25, false)} /></span></TableCell><TableCell className="pr-4 text-right">{fmt(r.files)}</TableCell></TableRow>) })}</TableBody>
          </Table>
        </Panel>
      ) : why && (
        <Empty className="border"><EmptyHeader><EmptyTitle>{why[0]}</EmptyTitle><EmptyDescription>{why[1]}</EmptyDescription></EmptyHeader>{D.serve && <EmptyContent><Button variant="outline" onClick={onSettings}>Open Settings</Button></EmptyContent>}</Empty>
      )}
      {g?.errors?.length > 0 && <Alert variant="destructive"><AlertTitle>Crawl errors</AlertTitle><AlertDescription><ul className="list-disc pl-4">{g.errors.map((e: string) => <li key={e}>{e}</li>)}</ul></AlertDescription></Alert>}
      {g?.libraries?.length > 0 && (
        <Panel title="Libraries" description="Components matched by key" contentClassName="px-0">
          <Table><TableHeader><TableRow><TableHead className="pl-4">Library</TableHead><TableHead className="text-right">Components</TableHead><TableHead className="text-right">Sets</TableHead><TableHead className="pr-4">Status</TableHead></TableRow></TableHeader>
            <TableBody>{g.libraries.map((l: any) => <TableRow key={l.name}><TableCell className="pl-4 font-medium">{l.name}</TableCell><TableCell className="text-right">{fmt(l.components)}</TableCell><TableCell className="text-right">{fmt(l.sets)}</TableCell><TableCell className="pr-4">{l.error ? <span className="text-destructive">{l.error}</span> : "Read"}</TableCell></TableRow>)}</TableBody></Table>
        </Panel>
      )}
      {g?.files?.length > 0 && (
        <Panel title="Files" description={`${fmt(g.sources.files)} found via ${fmt(g.sources.teams)} team and ${fmt(g.sources.projects)} project link(s)`} contentClassName="px-0">
          <Table><TableHeader><TableRow><TableHead className="pl-4">File</TableHead><TableHead>Project</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Library instances</TableHead><TableHead className="text-right">Look-alike frames</TableHead><TableHead className="pr-4 text-right">Other instances</TableHead></TableRow></TableHeader>
            <TableBody>{[...g.files].sort((a: any, b: any) => (b.instances || 0) - (a.instances || 0)).map((f: any) => (
              <TableRow key={f.key ?? f.name}><TableCell className="pl-4 font-medium">{f.name}</TableCell><TableCell>{f.project}</TableCell><TableCell>{ST[f.status] || f.status}{f.error && <span className="ml-2 text-muted-foreground">{f.error}</span>}</TableCell>
                <TableCell className="text-right">{f.status === "crawled" ? fmt(f.instances) : "—"}</TableCell><TableCell className="text-right">{f.status === "crawled" ? fmt(f.lookalikes) : "—"}</TableCell><TableCell className="pr-4 text-right">{f.status === "crawled" ? fmt(f.otherInstances) : "—"}</TableCell></TableRow>))}</TableBody></Table>
        </Panel>
      )}
    </div>
  )
}
