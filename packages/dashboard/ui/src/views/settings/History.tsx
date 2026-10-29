import * as React from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Note, Panel } from "@/components/bits"
import { D, api, fmt, fmtDT, say } from "@/lib/dsa"

/** One row per run, newest first. Grows with every scan; clearing keeps the latest run (the dashboard needs it). */
export function History() {
  const rows = [...D.runs].reverse()
  const [busy, setBusy] = React.useState(false)
  async function clear() {
    setBusy(true)
    try { const r = await api("/api/history/clear", {}); say(`Cleared ${r.removed} earlier run${r.removed === 1 ? "" : "s"}`); setTimeout(() => location.reload(), 500) } catch (e: any) { say(e.message, true); setBusy(false) }
  }
  return (
    <Panel title={`${rows.length} run${rows.length === 1 ? "" : "s"}`} description="Trends are drawn from these."
      action={D.serve && rows.length > 1 ? (
        <Dialog>
          <DialogTrigger render={<Button variant="outline" size="sm" />}>Clear history</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Clear run history?</DialogTitle>
              <DialogDescription>Removes the {rows.length - 1} earlier run{rows.length - 1 === 1 ? "" : "s"} and their measurements, so Trends start over. The latest run, open findings, decisions, and settings stay. This can't be undone.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button variant="destructive" onClick={clear} disabled={busy}>Clear {rows.length - 1} run{rows.length - 1 === 1 ? "" : "s"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : undefined}
      contentClassName="px-0">
      <Table>
        <TableHeader><TableRow>
          <TableHead className="pl-4">When</TableHead><TableHead>Run</TableHead><TableHead>Lockfile</TableHead><TableHead>Git history</TableHead>
          {D.modules?.figma && <TableHead>Figma</TableHead>}
          <TableHead className="text-right">Instances</TableHead><TableHead className="text-right">Look-alikes</TableHead><TableHead className="text-right">Opened</TableHead><TableHead className="text-right">Resolved</TableHead><TableHead className="pr-4 text-right">Notes</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.map((r: any, i: number) => {
            const s = r.sources ?? {}
            return (
              <TableRow key={r.run_id}>
                <TableCell className="pl-4">{fmtDT(r.taken_at)}{i === 0 && <Badge variant="secondary" className="ml-2">Latest</Badge>}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{r.run_id}</TableCell>
                <TableCell>{s.lockfile ?? "—"}</TableCell>
                <TableCell>{s.git == null ? "—" : s.git ? "Used" : "Not available"}</TableCell>
                {D.modules?.figma && <TableCell>{s.figmaDiag?.error ? "Failed" : s.figma ? `${s.figmaDiag?.crawled ?? "?"} files` : "Not crawled"}</TableCell>}
                <TableCell className="text-right tabular-nums">{fmt(r.instances)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.lookalikes)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.opened)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.resolved)}</TableCell>
                <TableCell className="pr-4 text-right tabular-nums">{fmt(s.notes?.length ?? 0)}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {!D.serve && <Note className="mt-3 px-4">Clearing history needs the live view (dsa serve).</Note>}
    </Panel>
  )
}
