import * as React from "react"
import { cn } from "cn"
import { ArrowDownIcon, ArrowUpIcon, ArrowRightIcon, MinusIcon, WarningIcon, CheckCircleIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Note, Panel, StatusDot } from "@/components/bits"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { D, SYS, band, fmt, fmtDT, ratio, threshold, type Band } from "@/lib/dsa"
import { CERTAINTY, ROLES, classify, forRole, useRole, type Certainty } from "@/lib/insight"

/**
 * The first screen: is the system healthy, what should my team do next, and how far can I trust this scan.
 * Five measures with their trend and status; the open actions split into definite fixes and decisions,
 * filtered by the viewer's role; and the scan's own confidence, with what to do where it is low.
 */
export function Overview({ go }: { go: (view: string) => void }) {
  const [role] = useRole()
  const runs: any[] = D.runs ?? []
  const last = runs[runs.length - 1] ?? null
  const prev = runs.length > 1 ? runs[runs.length - 2] : null
  const items: any[] = (D.queue?.items ?? []).filter((i: any) => i.status === "open")
  const mine = items.filter((i) => forRole(role, i.rule))
  const definite = mine.filter((i) => classify(i.rule).certainty === "definite")
  const decide = mine.filter((i) => classify(i.rule).certainty === "recommendation")
  const cu = threshold("correct_use_rate"), tc = threshold("token_compliance_new_code")
  const currentShare = (r: any) => ratio(r?.current_consumers, r?.consumers)

  const kpis: Kpi[] = [
    { label: "Used as intended", value: last?.correct_use, prev: prev?.correct_use, unit: "%", up: true, band: band(last?.correct_use, cu?.watch ?? 90, cu?.act ?? 75), how: "measured",
      means: `Share of ${SYS} component uses in app code with no class, style or spread-prop overrides.`, to: "apps" },
    { label: "Apps on a current version", value: currentShare(last), prev: currentShare(prev), unit: "%", up: true, band: band(currentShare(last), 100, 75), how: "measured",
      means: `Apps within one major version of the latest ${SYS} release.`, to: "apps" },
    { label: "Tokens in new code", value: last?.token_compliance, prev: prev?.token_compliance, unit: "%", up: true, band: band(last?.token_compliance, tc?.watch ?? 95, tc?.act ?? 90), how: "measured",
      means: "Share of colour, space and type values in recently changed files that use a token instead of a hard-coded value.", to: "apps" },
    { label: "Custom look-alikes", value: last?.lookalikes, prev: prev?.lookalikes, unit: "", up: false, band: "", how: "estimated",
      means: `Native elements and custom components that look like a ${SYS} component. Found by resemblance, so each one is a recommendation to check.`, to: "queue" },
  ]

  return (
    <div className="flex flex-col gap-6">
      <Coverage />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {kpis.map((k) => <KpiCard key={k.label} k={k} onOpen={() => go(k.to)} since={prev?.taken_at} />)}
        <ActionsCard definite={definite.length} decide={decide.length} role={role} onOpen={() => go("queue")} />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel title="What to do next" description={role === "all" ? "Open actions, highest impact first" : `For ${ROLES.find((r) => r.id === role)?.label}: ${ROLES.find((r) => r.id === role)?.hint.toLowerCase()}`}
          action={<Button variant="ghost" size="sm" onClick={() => go("queue")}>All actions<ArrowRightIcon data-icon="inline-end" /></Button>}>
          <ActionGroup kind="definite" items={definite} go={go} />
          <ActionGroup kind="recommendation" items={decide} go={go} />
          {!mine.length && <Note>Nothing open{role === "all" ? "" : " for this role"}. That is the goal.</Note>}
        </Panel>
        <ScanConfidence go={go} />
      </div>
    </div>
  )
}

interface Kpi { label: string; value: number | null | undefined; prev: number | null | undefined; unit: string; up: boolean; band: Band; how: "measured" | "estimated"; means: string; to: string }

/** A number to show, or null for "not measured": missing, or not a number at all (0/0, a stray string). */
const measured = (x: unknown) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x))

/**
 * When the scan couldn't read the apps it measures: none at all (every repo failed to fetch, or none
 * was found), or some. Without this the tiles below just look empty.
 */
function Coverage() {
  const c = D.coverage
  if (!c || !D.run) return null
  const skipped = (c.skipped ?? []).map((s: any) => `${s.name}: couldn't fetch ${s.url} (${s.why})`)
  if (c.none) return (
    <Alert variant="destructive">
      <WarningIcon />
      <AlertTitle>No apps were scanned{skipped.length ? `: ${c.skipped.length === 1 ? "the app's repo" : `all ${c.skipped.length} app repos`} failed to fetch` : ""}</AlertTitle>
      <AlertDescription>
        {skipped.length ? <ul className="list-disc pl-4">{skipped.map((s: string) => <li key={s}>{s}</li>)}</ul> : <p>{c.reason ?? "The scan found no apps that use the system."}</p>}
        <p>The numbers below are empty because nothing was measured, not because usage is zero. {skipped.length ? "Check the scan job's git credentials for those URLs, then re-scan." : "Add consumers to dsa.config.json, then re-scan."}</p>
      </AlertDescription>
    </Alert>
  )
  if (skipped.length) return (
    <Alert>
      <WarningIcon />
      <AlertTitle>{skipped.length} of {skipped.length + c.scanned.length} apps weren't scanned</AlertTitle>
      <AlertDescription><ul className="list-disc pl-4">{skipped.map((s: string) => <li key={s}>{s}</li>)}</ul><p>The numbers below leave them out.</p></AlertDescription>
    </Alert>
  )
  return null
}

function KpiCard({ k, onOpen, since }: { k: Kpi; onOpen: () => void; since?: string }) {
  const m = measured(k.value), pm = measured(k.prev)
  const v = m == null ? null : Math.round(m * 10) / 10
  const d = v == null || pm == null ? null : Math.round((v - pm) * 10) / 10
  const better = d == null || d === 0 ? null : (d > 0) === k.up
  return (
    <button type="button" onClick={onOpen} className="flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/60">
      <span className="flex items-start justify-between gap-2">
        <Tooltip>
          <TooltipTrigger render={<span className="text-xs font-medium text-muted-foreground underline decoration-dotted underline-offset-4" />}>{k.label}</TooltipTrigger>
          <TooltipContent className="max-w-xs">{k.means}</TooltipContent>
        </Tooltip>
        <StatusDot band={k.band} />
      </span>
      <span className="font-heading text-3xl font-semibold tabular-nums">{v == null ? "—" : fmt(v)}{v != null && k.unit}</span>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        {v == null ? <span>Not measured in this scan</span> : d == null ? <span>No earlier scan to compare</span> : (
          <>
            <span className={cn("inline-flex items-center gap-0.5 font-medium", better === true && "text-success-soft-foreground", better === false && "text-destructive")}>
              {d > 0 ? <ArrowUpIcon className="size-3" /> : d < 0 ? <ArrowDownIcon className="size-3" /> : <MinusIcon className="size-3" />}
              {d > 0 ? "+" : ""}{fmt(d)}{k.unit === "%" ? " pts" : ""}
            </span>
            <span>vs scan of {since ? fmtDT(since) : "before"}</span>
          </>
        )}
      </span>
      <Badge variant="outline" className="mt-1 w-fit">{k.how === "measured" ? "Measured" : "Estimated"}</Badge>
    </button>
  )
}

function ActionsCard({ definite, decide, role, onOpen }: { definite: number; decide: number; role: string; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/60">
      <span className="text-xs font-medium text-muted-foreground">Open actions{role === "all" ? "" : ", your role"}</span>
      <span className="font-heading text-3xl font-semibold tabular-nums">{fmt(definite + decide)}</span>
      <span className="text-xs text-muted-foreground">{fmt(definite)} definite · {fmt(decide)} to decide</span>
    </button>
  )
}

function ActionGroup({ kind, items, go }: { kind: Certainty; items: any[]; go: (v: string) => void }) {
  if (!items.length) return null
  const top = [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 5)
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="mb-1 flex items-baseline gap-2 text-sm font-medium">
        {kind === "definite" ? "Do now" : "Decide"}
        <span className="text-xs font-normal text-muted-foreground">{CERTAINTY[kind].hint}</span>
      </h3>
      <ul className="divide-y">
        {top.map((i) => {
          const c = classify(i.rule)
          return (
            <li key={i.id}>
              <a href={`#queue/${encodeURIComponent(i.id)}`} onClick={(e) => { e.preventDefault(); location.hash = `queue/${encodeURIComponent(i.id)}`; go("queue") }} className="flex items-start gap-3 py-2.5 hover:bg-muted/40">
                <Badge variant={kind === "definite" ? "default" : "outline"} className="mt-0.5 shrink-0">{c.verb}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{i.title}</span>
                  <span className="text-xs text-muted-foreground">{i.owner}{i.affected?.length ? ` · ${i.affected.length} place${i.affected.length === 1 ? "" : "s"}` : ""} · for {c.roles.map((r) => ROLES.find((x) => x.id === r)?.label).join(", ")}</span>
                </span>
              </a>
            </li>
          )
        })}
      </ul>
      {items.length > top.length && <Note className="mt-1 text-xs">and {items.length - top.length} more</Note>}
    </section>
  )
}

/** How far to trust this scan: where the system's code was found, what's in the inventory, and the known limits. */
function ScanConfidence({ go }: { go: (v: string) => void }) {
  const m = D.model
  if (!m) return (
    <Panel title="How sure is this scan"><Note>This scan was made before dsa recorded its own confidence. Re-run the scan to see where the system's code was found and how sure each fact is.</Note></Panel>
  )
  const comps: any[] = m.components ?? []
  const check = comps.filter((c) => c.inferred || c.evidence.tier === "convention" || c.kind?.ambiguous).length
  const unused = comps.filter((c) => !c.uses.consumer).length
  const how: Record<string, [string, boolean]> = {
    pinned: ["Folders your team chose", true], expected: ["Where the config points", true],
    discovered: ["Found by scanning the repo, at or above the confidence bar", true],
    none: ["No folder reached the confidence bar: pick the right one", false], unknown: ["Not recorded", false],
  }
  const [howText, ok] = how[m.sources.how] ?? how.unknown!
  const rows: { ok: boolean; title: string; body: React.ReactNode; act?: [string, () => void] }[] = [
    { ok, title: "Where the system's code is", body: <>{howText}. Reading {m.sources.read.length ? m.sources.read.map((s: string) => <code key={s} className="mr-1 rounded bg-muted px-1 font-mono text-xs">{s}</code>) : "nothing"}</>,
      act: ["Check sources", () => { location.hash = "settings/general" }] },
    { ok: true, title: `${fmt(m.counts.components)} components`, body: <>Plus {fmt(m.counts.parts)} parts (DialogTitle, MenuItem) and {fmt(m.counts.icons)} icons, counted apart.</>, act: ["See inventory", () => go("system")] },
    { ok: check === 0, title: `${fmt(check)} need a check`, body: "Known only from how apps write them, found by naming alone, or of an unclear kind. Confirm or correct them.", act: ["Review", () => { location.hash = "system/check"; go("system") }] },
    { ok: unused === 0, title: `${fmt(unused)} not used by any app`, body: "Candidates to promote, document, or retire. Some are building blocks used only inside the system.", act: ["Review", () => { location.hash = "system/unused"; go("system") }] },
    { ok: false, title: "Known limits", body: "Token tiers (primitive, semantic, component) are a guide: names are reliable, tiers less so. Component parts can be partial for systems that build anatomy in unusual ways." },
  ]
  return (
    <Panel title="How sure is this scan" description="Read this before acting on a number">
      <ul className="flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.title} className="flex gap-3">
            {r.ok ? <CheckCircleIcon className="mt-0.5 size-4 shrink-0 text-success-soft-foreground" /> : <WarningIcon className="mt-0.5 size-4 shrink-0 text-warning" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{r.title}</p>
              <p className="text-sm text-muted-foreground">{r.body}</p>
            </div>
            {r.act && <Button variant="ghost" size="sm" onClick={r.act[1]} className="shrink-0">{r.act[0]}</Button>}
          </li>
        ))}
      </ul>
    </Panel>
  )
}
