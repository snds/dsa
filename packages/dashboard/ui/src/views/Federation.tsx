import * as React from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Panel, Stat, StatusDot } from "@/components/bits"
import { D, SCOPES, band, fmt, pct, threshold } from "@/lib/dsa"

export function Federation() {
  const vc = threshold("version_currency"), cu = threshold("correct_use_rate"), tc = threshold("token_compliance_new_code")
  const children = D.targets.filter((t: any) => t.role === "child"), consumers = D.targets.filter((t: any) => t.role === "consumer")
  const current = consumers.filter((t: any) => t.worstMajors != null && t.worstMajors <= 1).length
  const off = (t: any, k: string, node: React.ReactNode) => (t.measures && t.measures[k] === false ? <span className="text-muted-foreground">Off</span> : node)
  const cell = (v: React.ReactNode, b: any) => <span className="inline-flex items-center gap-2">{v}<StatusDot band={b} /></span>
  const table = (rows: any[]) => (
    <Table>
      <TableHeader><TableRow>
        <TableHead className="pl-4">Name</TableHead><TableHead>Role</TableHead><TableHead>DS packages (resolved / latest)</TableHead>
        <TableHead className="text-right">Majors behind</TableHead><TableHead className="text-right">Instances</TableHead><TableHead className="text-right">Used as intended</TableHead>
        <TableHead className="text-right">Look-alikes</TableHead><TableHead className="text-right">Tokens, new code</TableHead><TableHead className="text-right">Deprecated</TableHead><TableHead className="pr-4 text-right">Open findings</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {!rows.length && <TableRow><TableCell colSpan={10} className="pl-4 text-muted-foreground">None found in this run.</TableCell></TableRow>}
        {rows.map(t => (
          <TableRow key={t.name}>
            <TableCell className="pl-4 font-medium">{t.name}</TableCell>
            <TableCell className="text-muted-foreground">{SCOPES[t.role] ?? t.role}</TableCell>
            <TableCell className="font-mono text-xs whitespace-normal">{t.versions.map((v: any) => <div key={v.pkg}>{v.pkg} {v.resolved ?? "?"}{v.latest ? ` / ${v.latest}` : ""}</div>)}{!t.versions.length && "—"}</TableCell>
            <TableCell className="text-right tabular-nums">{off(t, "versions", cell(t.worstMajors ?? "—", band(t.worstMajors, 0, (vc?.act ?? 2) - 1, false)))}</TableCell>
            <TableCell className="text-right tabular-nums">{off(t, "components", fmt(t.instances))}</TableCell>
            <TableCell className="text-right tabular-nums">{off(t, "components", cell(pct(t.correctUse), band(t.correctUse, cu?.watch ?? 90, cu?.act ?? 75)))}</TableCell>
            <TableCell className="text-right tabular-nums">{off(t, "lookalikes", fmt(t.lookalikes))}</TableCell>
            <TableCell className="text-right tabular-nums">{off(t, "tokens", cell(pct(t.tokenCompliance), band(t.tokenCompliance, tc?.watch ?? 95, tc?.act ?? 90)))}</TableCell>
            <TableCell className="text-right tabular-nums">{fmt(t.deprecated)}</TableCell>
            <TableCell className="pr-4 text-right tabular-nums">{fmt(t.openFindings)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Consumers" value={consumers.length} detail={`${children.length} child librar${children.length === 1 ? "y" : "ies"}`} />
        <Stat label="Within one major" value={consumers.length ? Math.round((100 * current) / consumers.length) + "%" : "—"} detail={`${current} of ${consumers.length} consumers`} />
        <Stat label="Libraries" value={D.libraries.length} detail={D.libraries.map((l: any) => l.name).join(", ")} />
      </div>
      {children.length > 0 && <Panel title="Child libraries" description="Scored as consumers of core" contentClassName="px-0">{table(children)}</Panel>}
      <Panel title="Consumers" description="Share each team's own row with it; leadership gets the aggregates" contentClassName="px-0">{table(consumers)}</Panel>
    </div>
  )
}
