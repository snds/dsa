import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Code, Panel } from "@/components/bits"
import { D } from "@/lib/dsa"

export function Rules() {
  return (
    <div className="flex flex-col gap-6">
      <Panel title="Rule settings in force" description={<>Change them under Settings, or with <Code>dsa settings set</Code>. Every change is logged in Notes, and findings keep the settings that raised them.</>} contentClassName="px-0">
        <Table>
          <TableBody>
            {Object.entries(D.settings ?? {}).map(([k, v]) => (
              <TableRow key={k}><TableCell className="pl-4 font-mono text-xs">{k}</TableCell><TableCell className="pr-4 font-mono text-xs whitespace-normal">{JSON.stringify(v)}</TableCell></TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
      <Panel title="Thresholds" description="From the metric catalog. A finding opens at watch or act and closes once past close (hysteresis)." contentClassName="px-0">
        <Table>
          <TableHeader><TableRow><TableHead className="pl-4">Metric</TableHead><TableHead>Family</TableHead><TableHead>Direction</TableHead><TableHead className="text-right">Watch</TableHead><TableHead className="text-right">Act</TableHead><TableHead className="text-right">Close</TableHead><TableHead className="pr-4">Tier</TableHead></TableRow></TableHeader>
          <TableBody>
            {D.thresholds.map((t: any) => (
              <TableRow key={t.id}>
                <TableCell className="pl-4 whitespace-normal"><div className="font-mono text-xs font-medium">{t.id}</div><div className="mt-0.5 text-xs text-muted-foreground">{t.question}</div></TableCell>
                <TableCell>{t.family}</TableCell>
                <TableCell>{t.direction === "up" ? "Higher is better" : "Lower is better"}</TableCell>
                <TableCell className="text-right tabular-nums">{t.thresholds?.watch ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{t.thresholds?.act ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{t.thresholds?.close ?? t.thresholds?.watch ?? "—"}</TableCell>
                <TableCell className="pr-4">{t.tier}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </div>
  )
}
