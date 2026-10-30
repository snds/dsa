import * as React from "react"
import { cn } from "cn"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { SEV, type Band } from "@/lib/dsa"

/** Healthy / watch / act, as a shape and a color (never color alone). */
export function StatusDot({ band }: { band: Band }) {
  if (!band) return null
  const label = band === "good" ? "healthy" : band === "warn" ? "watch" : "act"
  return (
    <span aria-label={label} title={label} className={cn("inline-block size-2.5 shrink-0",
      band === "good" && "rounded-full bg-success",
      band === "warn" && "rotate-45 rounded-[2px] bg-warning",
      band === "crit" && "rounded-[2px] bg-destructive")} />
  )
}

export function Legend() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5"><StatusDot band="good" />Healthy</span>
      <span className="flex items-center gap-1.5"><StatusDot band="warn" />Watch</span>
      <span className="flex items-center gap-1.5"><StatusDot band="crit" />Act</span>
    </div>
  )
}

export const sevTone: Record<string, string> = {
  crit: "bg-destructive", serious: "bg-caution", warn: "bg-warning", watch: "bg-muted-foreground/50",
}

export function SevBadge({ sev }: { sev: string }) {
  return (
    <Badge variant="outline" className="gap-1.5">
      <span className={cn("size-2 rounded-full", sevTone[sev])} />
      {SEV[sev] ?? sev}
    </Badge>
  )
}

/** A number with its label and context, optionally a filter button. */
export function Stat({ label, value, detail, active, onClick }: { label: string; value: React.ReactNode; detail?: React.ReactNode; active?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="font-heading text-2xl font-semibold tabular-nums">{value}</span>
      {detail != null && <span className="text-xs text-muted-foreground">{detail}</span>}
    </>
  )
  const cls = cn("flex min-w-0 flex-col gap-1 rounded-lg border bg-card p-3 text-left", onClick && "cursor-pointer transition-colors hover:bg-muted/60", active && "border-primary ring-2 ring-primary/20")
  return onClick ? <button type="button" className={cls} aria-pressed={active} onClick={onClick}>{body}</button> : <div className={cls}>{body}</div>
}

export function StatRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{children}</div>
}

export function Panel({ title, description, action, children, className, contentClassName }: { title?: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; contentClassName?: string }) {
  return (
    <Card className={className}>
      {(title || description || action) && (
        <CardHeader>
          {title && <CardTitle>{title}</CardTitle>}
          {description && <CardDescription>{description}</CardDescription>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  )
}

export function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mt-8 mb-3 flex items-baseline justify-between gap-4">
      <h2 className="font-heading text-base font-semibold">{children}</h2>
      {aside}
    </div>
  )
}

export function Code({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.8em]", className)}>{children}</code>
}

export function Pre({ children, className }: { children: React.ReactNode; className?: string }) {
  return <pre className={cn("overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap", className)}>{children}</pre>
}

export function Note({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>
}
