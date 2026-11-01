import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Code, Panel } from "@/components/bits"
import { D, fmtD, num, ratio } from "@/lib/dsa"

const SERIES: { key: string; name: string; unit: string; value: (r: any) => number | null }[] = [
  { key: "current", name: "Consumers within one major", unit: "%", value: r => ratio(r.current_consumers, r.consumers) },
  { key: "correct", name: "Used as intended (avg)", unit: "%", value: r => r.correct_use },
  { key: "tokens", name: "Token compliance, new code (avg)", unit: "%", value: r => r.token_compliance },
  { key: "lookalikes", name: "Raw look-alikes", unit: "", value: r => r.lookalikes },
]

export function Trends() {
  if (D.runs.length < 2)
    return <Empty className="border"><EmptyHeader><EmptyTitle>Trends start at the second run</EmptyTitle><EmptyDescription>One run is a snapshot. Schedule <Code>dsa run</Code> weekly (a CI cron or a scheduled job) and this view fills in.</EmptyDescription></EmptyHeader></Empty>
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {SERIES.map(s => {
        // A run that didn't measure this leaves a gap, never NaN.
        const data = D.runs.map((r: any) => { const v = num(s.value(r)); return { at: fmtD(r.taken_at), v: v == null ? null : Math.round(v * 10) / 10 } })
        const last = [...data].reverse().find((d: any) => d.v != null)?.v
        const config: ChartConfig = { v: { label: s.name, color: "var(--chart-3)" } }
        return (
          <Panel key={s.key} title={s.name} description={`Latest ${last == null ? "—" : last + s.unit}`}>
            <ChartContainer config={config} className="aspect-auto h-52 w-full">
              <LineChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="at" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} />
                <YAxis width={40} tickLine={false} axisLine={false} domain={s.unit === "%" ? [0, 100] : [0, "auto"]} tickFormatter={(v: any) => `${v}${s.unit}`} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line dataKey="v" type="monotone" stroke="var(--color-v)" strokeWidth={2} dot={{ r: 3 }} connectNulls />
              </LineChart>
            </ChartContainer>
          </Panel>
        )
      })}
    </div>
  )
}
