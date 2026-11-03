import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Legend, Note, Panel, StatusDot } from "@/components/bits"
import { D, band, fmt, pct, threshold } from "@/lib/dsa"
import { useApp } from "@/lib/app"
import { AllAppsNote } from "@/components/app-select"

export function Components() {
  const cu = threshold("correct_use_rate"), cr = threshold("custom_ratio")
  const app = useApp()
  // One app chosen: that app's counts, and only the components it uses or imitates.
  const split = D.components.some((c: any) => c.byTarget)
  const rows: any[] = !app || !split ? D.components : D.components.map((c: any) => c.byTarget?.[app] ? { ...c, ...c.byTarget[app], consumers: 1 } : null).filter(Boolean)
  return (
    <Panel title={`${rows.length} components in use${app && split ? ` in ${app}` : ""}`} action={<Legend />} contentClassName="px-0">
      {!split && <AllAppsNote className="px-4 pb-2">Across all apps; this report doesn't split components by app yet. Re-run the scan to split them.</AllAppsNote>}
      <Table>
        <TableHeader><TableRow>
          <TableHead className="pl-4">Component</TableHead><TableHead>Library</TableHead><TableHead className="text-right">Instances</TableHead><TableHead className="text-right">Consumers</TableHead>
          <TableHead className="text-right">Used as intended</TableHead><TableHead className="text-right">Raw look-alikes</TableHead><TableHead className="pr-4">Status</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.map((c: any) => {
            const used = c.instances ? 100 - c.overridden_pct : null
            return (
              <TableRow key={c.component + c.library}>
                <TableCell className="pl-4 font-medium">{c.component}</TableCell>
                <TableCell className="text-muted-foreground">{c.library}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(c.instances)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(c.consumers)}</TableCell>
                <TableCell className="text-right tabular-nums"><span className="inline-flex items-center gap-2">{used == null ? "—" : pct(used)}<StatusDot band={band(used, cu?.watch ?? 90, cu?.act ?? 75)} /></span></TableCell>
                <TableCell className="text-right tabular-nums">{fmt(c.lookalikes)}</TableCell>
                <TableCell className="pr-4">{c.deprecated ? <Badge variant="outline">Deprecated → {c.replacement}</Badge> : c.instances === 0 ? <Badge variant="outline">Only look-alikes</Badge> : null}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <Note className="mt-3 px-4">"Used as intended" is the share of instances with no className, style, or spread-prop overrides. Look-alikes are raw native elements that imitate the component (thresholds: watch {cr?.watch}%, act {cr?.act}%).</Note>
    </Panel>
  )
}
