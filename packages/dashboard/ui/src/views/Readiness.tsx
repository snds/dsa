import { cn } from "cn"
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { Line, LineChart, YAxis } from "recharts"
import { ChartContainer, type ChartConfig } from "@/components/ui/chart"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Code, Note, Panel, Pre, Stat } from "@/components/bits"
import { D, SYS, fmtD, fmt, ratio } from "@/lib/dsa"
import { AskAgent } from "@/agent/AskAgent"

/**
 * Agent Readiness: how well agents can build with the design system in each repo, from the design
 * system's own agent tools. The audit scores the repo (no model, every scan); its usage checker counts the
 * errors an agent would be told to fix; bench runs show how agents actually did, by context.
 */
const TIER_TONE: Record<string, string> = { "AI-native": "border-success-soft-border text-success-soft-foreground", Invested: "border-warning-soft-border text-warning-soft-foreground", Emerging: "border-destructive/40 text-destructive" }

export function Readiness() {
  const rows: any[] = D.readiness ?? []
  if (!rows.length && !D.bench?.length) return (
    <Empty className="border"><EmptyHeader><EmptyTitle>No readiness data in this scan</EmptyTitle>
      <EmptyDescription>The audit runs with every scan when the design system's profile names its agent-readiness tool and the tool is installed. Re-run the scan.</EmptyDescription></EmptyHeader></Empty>
  )
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {rows.map(r => <Stat key={r.subject} label={r.subject} value={`${r.score}`} detail={<span className="flex flex-wrap items-center gap-1.5"><Badge variant="outline" className={cn("text-[11px]", TIER_TONE[r.tier])}>{r.tier}</Badge>{r.kit ? "Agent kit installed" : "No agent kit"}</span>} />)}
      </div>
      {rows.map(r => <RepoCard key={r.subject} r={r} />)}
      <Bench />
    </div>
  )
}

function RepoCard({ r }: { r: any }) {
  const data = (r.trend ?? []).map((t: any) => ({ at: fmtD(t.at), v: t.score }))
  const config: ChartConfig = { v: { label: "Readiness", color: "var(--chart-3)" } }
  const rules = Object.entries<number>(r.usage?.byRule ?? {}).sort((a, b) => b[1] - a[1])
  const max = rules[0]?.[1] ?? 1
  return (
    <Panel
      title={<span className="flex items-center gap-2">{r.subject}<Badge variant="outline" className={TIER_TONE[r.tier]}>{r.tier} · {r.score}/100</Badge></span>}
      description={r.bestTier !== r.tier ? `Was ${r.bestTier}: a finding is open until it's back.` : r.scope === "core" ? "The design system itself" : "A repo that builds with the design system"}
      action={<AskAgent subject={{ kind: "readiness", subject: r.subject }} label="Ask how to raise it" />}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <section>
          <h3 className="mb-2 text-sm font-medium">Checks</h3>
          <ul className="flex flex-col gap-2.5">
            {r.checks.map((c: any) => (
              <li key={c.id} className="text-sm">
                <div className="flex items-center gap-2">
                  {c.score >= 80 ? <CheckCircleIcon className="size-4 shrink-0 text-success-soft-foreground" weight="fill" /> : <WarningCircleIcon className={cn("size-4 shrink-0", c.score < 50 ? "text-destructive" : "text-warning-soft-foreground")} />}
                  <span className="flex-1">{c.title}</span>
                  <span className="w-24"><span className="block h-1.5 rounded-full bg-muted"><span className="block h-1.5 rounded-full bg-primary" style={{ width: `${c.score}%` }} /></span></span>
                  <span className="w-8 text-right tabular-nums">{c.score}</span>
                </div>
                {c.score < 100 && <p className="mt-0.5 ml-6 line-clamp-2 text-xs text-muted-foreground" title={[...c.evidence, ...c.fixes].join("\n")}>{c.evidence.filter((e: string) => !e.startsWith("✓"))[0]}{c.fixes[0] ? ` → ${c.fixes[0]}` : ""}</p>}
              </li>
            ))}
          </ul>
        </section>
        <section className="flex flex-col gap-4">
          {data.length > 1 && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Trend</h3>
              <ChartContainer config={config} className="aspect-auto h-20 w-full">
                <LineChart data={data} margin={{ top: 4, bottom: 4, left: 0, right: 4 }}>
                  <YAxis hide domain={[0, 100]} />
                  <Line dataKey="v" type="monotone" stroke="var(--color-v)" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            </div>
          )}
          {r.usage && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Usage checker: {fmt(r.usage.errors)} errors in {fmt(r.usage.files - r.usage.clean)} of {fmt(r.usage.files)} files</h3>
              <ul className="flex flex-col gap-1 text-xs">
                {rules.map(([k, n]) => (
                  <li key={k} className="grid grid-cols-[8rem_minmax(0,1fr)_3rem] items-center gap-2">
                    <Code className="truncate">{k}</Code>
                    <span className="h-1.5 rounded-full bg-muted"><span className="block h-1.5 rounded-full bg-chart-3" style={{ width: `${ratio(n, max) ?? 0}%` }} /></span>
                    <span className="text-right tabular-nums">{n}</span>
                  </li>
                ))}
              </ul>
              {r.reconcile && <Note className="mt-2 text-xs">Raw elements: the checker {r.reconcile.checkUsage} vs this scan's look-alikes {r.reconcile.dsa}. {r.reconcile.note}</Note>}
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-muted-foreground">Worst files</summary>
                <ul className="mt-1 font-mono">{r.usage.byFile.map((f: any) => <li key={f.file} className="flex justify-between gap-2"><span className="truncate">{f.file}</span><span className="tabular-nums">{f.errors}</span></li>)}</ul>
              </details>
            </div>
          )}
        </section>
      </div>
    </Panel>
  )
}

function Bench() {
  const runs: any[] = D.bench ?? []
  return (
    <Panel title="Bench runs" description="Agents building real tasks, scored with and without the design system's guidance.">
      {runs.length ? (
        <Table>
          <TableHeader><TableRow><TableHead>Run</TableHead><TableHead>Model</TableHead><TableHead>Context</TableHead><TableHead className="text-right">Score</TableHead><TableHead className="text-right">Lift</TableHead><TableHead className="text-right">Pass / fail</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
          <TableBody>
            {runs.flatMap(b => b.rows.map((x: any, i: number) => (
              <TableRow key={`${b.id}-${i}`}>
                <TableCell className="text-xs">{i === 0 ? <>{fmtD(b.at)}<span className="block text-muted-foreground">{b.repo}{b.errored ? ` · ${b.errored} errored` : ""}</span></> : null}</TableCell>
                <TableCell className="font-mono text-xs">{x.model}</TableCell>
                <TableCell><Badge variant="outline">{x.context}</Badge></TableCell>
                <TableCell className="text-right tabular-nums">{x.overall == null ? "—" : Math.round(x.overall)}</TableCell>
                <TableCell className="text-right tabular-nums">{x.lift == null ? "—" : `${x.lift >= 0 ? "+" : ""}${Math.round(x.lift)}`}</TableCell>
                <TableCell className="text-right tabular-nums">{x.pass} / {x.fail}</TableCell>
                <TableCell className="text-right tabular-nums">${(x.costUsd ?? 0).toFixed(2)}</TableCell>
              </TableRow>
            )))}
          </TableBody>
        </Table>
      ) : null}
      {runs[0]?.tasks?.length > 0 && <LatestRun b={runs[0]} />}
      {!runs.length && (
        <div className="text-sm">
          <Note>No bench runs yet. A run has agents build the bench tasks three ways (no guidance, AGENTS.md, and the MCP tools) and scores each. It uses real agent time, so preview it first.</Note>
                    <Note className="mt-2 text-xs">The design system's benchmark tool says how to start one. Results show here on the next scan.</Note>
        </div>
      )}
    </Panel>
  )
}

/** The newest run, task by task: where guidance helped, and the rules agents broke most. */
function LatestRun({ b }: { b: any }) {
  const contexts: string[] = [...new Set<string>(b.tasks.flatMap((t: any) => Object.keys(t.scores)))].sort((x, y) => ["bare", "agents-md", "mcp"].indexOf(x) - ["bare", "agents-md", "mcp"].indexOf(y))
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <section>
        <h3 className="mb-1 text-sm font-medium">Latest run by task{b.manifest?.label ? ` (${b.manifest.label})` : ""}</h3>
        <Note className="mb-2 text-xs">{b.manifest?.profile ? `Profile ${b.manifest.profile}. ` : ""}{b.manifest?.systemCommit ? `${SYS} at ${b.manifest.systemCommit}. ` : ""}{b.manifest?.agent ? `${b.manifest.agent}.` : ""}</Note>
        <Table>
          <TableHeader><TableRow><TableHead>Task</TableHead>{contexts.map(c => <TableHead key={c} className="text-right">{c}</TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {b.tasks.map((t: any) => (
              <TableRow key={t.task}>
                <TableCell className="font-mono text-xs">{t.task}</TableCell>
                {contexts.map(c => <TableCell key={c} className={cn("text-right tabular-nums", t.gates[c] === "fail" && "text-destructive")}>{t.scores[c] ?? "—"}{t.gates[c] === "fail" ? " ✗" : ""}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Note className="mt-1 text-xs">✗ = failed a hard gate (it doesn't compile, or it uses something the design system doesn't have).</Note>
      </section>
      <section>
        <h3 className="mb-2 text-sm font-medium">What agents got wrong most</h3>
        <ul className="flex flex-col gap-2 text-sm">
          {b.findings.map((f: any) => <li key={f.rule}><span className="flex justify-between gap-2"><Code>{f.rule}</Code><span className="tabular-nums">{f.n}</span></span><span className="block text-xs text-muted-foreground">{f.example}</span></li>)}
        </ul>
      </section>
    </div>
  )
}
