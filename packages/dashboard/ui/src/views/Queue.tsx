import * as React from "react"
import { cn } from "cn"
import { CaretDownIcon, CopyIcon, ArrowsClockwiseIcon, GithubLogoIcon, ArrowSquareOutIcon, CheckCircleIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Card, CardAction, CardDescription, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Panel, Pre, SevBadge, Stat, sevTone } from "@/components/bits"
import { D, SCOPES, ago, api, copy, fmtD, say } from "@/lib/dsa"
import { AskAgent } from "@/agent/AskAgent"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { CERTAINTY, ROLES, classify, forRole, useRole, type Certainty } from "@/lib/insight"

/** Only https links reach an href (a javascript: or data: URL from the data never does). */
const safeHref = (u: unknown) => { try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href : undefined } catch { return undefined } }

/**
 * The Action Queue: everything that needs someone to act. Findings (raised by the scan) and Review
 * Approvals (migrations a human approved in Element Review), each with a drafted GitHub issue. Closing an
 * item's issue moves it to Completed. When served, the queue reloads from the server and pulls live issue
 * state once a minute; the static report shows the snapshot it was built with.
 */
type Q = { items: any[]; prompt: string; github: { token: boolean; defaultRepo: string | null }; syncedAt: string | null; syncError?: string }

export function Queue() {
  const [q, setQ] = React.useState<Q | null>(D.queue ?? null)
  const [scope, setScope] = React.useState("all")
  const [role] = useRole()
  const [certainty, setCertainty] = React.useState<"any" | Certainty>("any")
  // An Overview link opens the queue on one item: #queue/<id>.
  const [current, setCurrent] = React.useState<string | null>(() => { const id = location.hash.split("/")[1]; return id ? decodeURIComponent(id) : null })
  const [syncing, setSyncing] = React.useState(false)
  const [confirm, setConfirm] = React.useState(false)
  const [creating, setCreating] = React.useState<string[] | null>(null)

  const load = React.useCallback(async (sync: "" | "1" | "force" = "1") => {
    if (!D.serve) return
    if (sync === "force") setSyncing(true)
    try {
      const r = await api(`/api/queue${sync ? `?sync=${sync}` : ""}`)
      setQ(r)
      if (sync === "force" && r.syncError) say(`GitHub: ${r.syncError}`, true)
    } catch (e: any) { if (sync === "force") say(e.message, true) }
    finally { setSyncing(false) }
  }, [])
  // Fresh on open (approvals made in Element Review since the page loaded), then live issue state each minute.
  React.useEffect(() => { load("1"); const t = setInterval(() => load("1"), 60000); return () => clearInterval(t) }, [load])

  async function create(ids?: string[]) {
    setCreating(ids ?? ["*"])
    try {
      const r = await api("/api/issues/create", ids ? { ids } : {})
      const n = r.created.length
      if (n) say(`Created ${n} issue${n === 1 ? "" : "s"}`)
      if (r.skipped.length) say(`${r.skipped.length} skipped: ${[...new Set(r.skipped.map((s: any) => s.reason))].join("; ")}`, !n)
      await load("")
    } catch (e: any) { say(e.message, true) }
    finally { setCreating(null); setConfirm(false) }
  }

  if (!q) return <Empty className="border"><EmptyHeader><EmptyTitle>The queue isn't in this report</EmptyTitle><EmptyDescription>Re-run the scan to build it.</EmptyDescription></EmptyHeader></Empty>

  const inScope = (i: any) => (scope === "all" || i.scope === scope) && forRole(role, i.rule) && (certainty === "any" || classify(i.rule).certainty === certainty)
  const open = q.items.filter(i => i.status === "open")
  const findings = open.filter(i => i.kind === "finding" && inScope(i)).sort((a, b) => b.score - a.score)
  const approvals = open.filter(i => i.kind === "approval" && inScope(i))
  const completed = q.items.filter(i => i.status === "done" && inScope(i)).sort((a, b) => String(b.doneAt ?? "").localeCompare(String(a.doneAt ?? "")))
  const all = [...findings, ...approvals, ...completed]
  const sel = all.find(i => i.id === current) ?? findings[0] ?? approvals[0] ?? null
  const fileable = open.filter(i => !(i.link?.state === "open"))
  const fileableWithRepo = fileable.filter(i => i.repo)
  const tiles: [string, string, number, string][] = [
    ["all", "All open", open.length, `${open.filter(i => i.kind === "approval").length} review approvals · top ${D.budget} findings pushed this week`],
    ...(["core", "child", "consumer"] as const).map(s => [s, SCOPES[s], open.filter(i => i.scope === s).length, s === "core" ? "Including re-routed misuse and system gaps" : s === "child" ? "Federated owners" : "With the cheapest fix"] as [string, string, number, string]),
  ]
  const noToken = !q.github.token

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map(([k, l, n, d]) => <Stat key={k} label={l} value={n} detail={d} active={scope === k} onClick={() => { setScope(k); setCurrent(null) }} />)}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup value={[certainty]} onValueChange={(v: any) => { const c = Array.isArray(v) ? v[0] : v; if (c) setCertainty(c) }} variant="outline" size="sm">
          <ToggleGroupItem value="any">All</ToggleGroupItem>
          {(["definite", "recommendation"] as const).map(c => (
            <Tooltip key={c}><TooltipTrigger render={<ToggleGroupItem value={c} />}>{CERTAINTY[c].label}</TooltipTrigger><TooltipContent>{CERTAINTY[c].hint}</TooltipContent></Tooltip>
          ))}
        </ToggleGroup>
        {role !== "all" && <span className="text-sm text-muted-foreground">Showing actions for {ROLES.find(r => r.id === role)?.label}. Change the role at the top of the page.</span>}
      </div>

      <AgentPrompt prompt={q.prompt} count={open.length} />

      {D.serve && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <GithubLogoIcon className="size-4" />
            {noToken ? <span>Add a GitHub token in <a href="#settings/general" className="text-primary underline-offset-4 hover:underline">Settings</a> to file issues and follow them here.</span>
              : <span>Issues sync every minute{q.syncedAt ? ` · last synced ${ago(q.syncedAt).toLowerCase()}` : ""}{q.syncError ? " · last sync had an error (Settings › Notes)" : ""}</span>}
          </p>
          <div className="flex items-center gap-2">
            {!noToken && <Button variant="outline" size="sm" onClick={() => load("force")} disabled={syncing}><ArrowsClockwiseIcon data-icon="inline-start" className={syncing ? "animate-spin" : ""} />Sync Now</Button>}
            <Gate off={noToken || !fileableWithRepo.length} why={noToken ? "Add a GitHub token in Settings first." : fileable.length ? "No repo for these items: set a default repo in Settings." : "Every open item already has an issue."}>
              <Button size="sm" onClick={() => setConfirm(true)} disabled={noToken || !fileableWithRepo.length || !!creating}>
                <GithubLogoIcon data-icon="inline-start" />Create Issues for All ({fileableWithRepo.length})
              </Button>
            </Gate>
          </div>
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Findings" description="By severity score" contentClassName="px-0">
            {findings.length ? <ul className="divide-y">{findings.map(i => <Row key={i.id} i={i} sel={sel?.id === i.id} onClick={() => setCurrent(i.id)} />)}</ul>
              : <Empty><EmptyHeader><EmptyTitle>Nothing breaches a threshold</EmptyTitle><EmptyDescription>That is the goal, not a bug.</EmptyDescription></EmptyHeader></Empty>}
          </Panel>
          <Panel title="Review Approvals" description="Element migrations a reviewer approved, one item per app and decision" contentClassName="px-0">
            {approvals.length ? <ul className="divide-y">{approvals.map(i => <Row key={i.id} i={i} sel={sel?.id === i.id} onClick={() => setCurrent(i.id)} />)}</ul>
              : <p className="px-4 text-sm text-muted-foreground">Nothing approved and waiting. Approve or change a recommendation in Element Review and it lands here.</p>}
          </Panel>
          <CompletedPanel items={completed} sel={sel?.id} onPick={setCurrent} />
        </div>
        {sel ? <Detail i={sel} q={q} busy={!!creating} onCreate={() => create([sel.id])} /> : <Panel><p className="text-sm text-muted-foreground">Select an item.</p></Panel>}
      </div>

      <Dialog open={confirm} onOpenChange={o => !creating && setConfirm(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create {fileableWithRepo.length} GitHub issue{fileableWithRepo.length === 1 ? "" : "s"}?</DialogTitle>
            <DialogDescription>One issue per open item without one, in the owner's repo. Items already linked to an open issue are skipped, and re-running never duplicates an issue.</DialogDescription>
          </DialogHeader>
          <ul className="text-sm">
            {Object.entries(fileableWithRepo.reduce((m: Record<string, number>, i) => ({ ...m, [i.repo]: (m[i.repo] ?? 0) + 1 }), {})).map(([r, n]) => <li key={r} className="flex justify-between gap-4 py-0.5"><span className="font-mono text-xs">{r}</span><span className="tabular-nums">{String(n)}</span></li>)}
          </ul>
          {fileable.length > fileableWithRepo.length && <p className="text-xs text-muted-foreground">{fileable.length - fileableWithRepo.length} item(s) have no repo and will be skipped. Set a default repo in Settings to include them.</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)} disabled={!!creating}>Cancel</Button>
            <Button onClick={() => create()} disabled={!!creating}>{creating ? "Creating…" : "Create Issues"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Tooltip that explains a disabled control (disabled buttons don't get hover events, so wrap them). */
function Gate({ off, why, children }: { off: boolean; why: string; children: React.ReactElement }) {
  if (!off) return children
  return <Tooltip><TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>{children}</TooltipTrigger><TooltipContent>{why}</TooltipContent></Tooltip>
}

/** The whole open queue as one prompt for an agent. Collapsed by default: it's long and mostly for copying. */
function AgentPrompt({ prompt, count }: { prompt: string; count: number }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} render={<Card size="sm" />}>
      <CardHeader>
        <CardTitle>Agentic Completion Prompt</CardTitle>
        <CardDescription>{count ? `Covers all ${count} open item${count === 1 ? "" : "s"}: review approvals first, then findings by score` : "Nothing open"}</CardDescription>
        <CardAction className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Copy prompt" onClick={() => copy(prompt, "Prompt copied")} />}><CopyIcon /></TooltipTrigger>
            <TooltipContent>Copy prompt</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<CollapsibleTrigger render={<Button variant="ghost" size="icon-sm" aria-label={open ? "Collapse prompt" : "Expand prompt"} />} />}>
              <CaretDownIcon className={cn("transition-transform", open && "rotate-180")} />
            </TooltipTrigger>
            <TooltipContent>{open ? "Collapse" : "Expand"}</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>
      <CollapsibleContent>
        <CardContent><Pre className="max-h-[28rem]">{prompt}</Pre></CardContent>
      </CollapsibleContent>
    </Collapsible>
  )
}

function CompletedPanel({ items, sel, onPick }: { items: any[]; sel?: string; onPick: (id: string) => void }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} render={<Card />}>
      <CardHeader>
        <CardTitle>Completed ({items.length})</CardTitle>
        <CardDescription>Issue closed, resolved by a scan, or migrated (last 30 days for findings)</CardDescription>
        <CardAction>
          <CollapsibleTrigger render={<Button variant="ghost" size="icon-sm" aria-label={open ? "Collapse completed" : "Expand completed"} disabled={!items.length} />}>
            <CaretDownIcon className={cn("transition-transform", open && "rotate-180")} />
          </CollapsibleTrigger>
        </CardAction>
      </CardHeader>
      <CollapsibleContent>
        <CardContent className="px-0"><ul className="divide-y border-t">{items.map(i => <Row key={i.id} i={i} sel={sel === i.id} onClick={() => onPick(i.id)} />)}</ul></CardContent>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Definite (measured, known fix) or a recommendation (inferred: a person decides), with who acts. */
function CertaintyBadge({ rule }: { rule?: string }) {
  const c = classify(rule)
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Badge variant={c.certainty === "definite" ? "default" : "outline"}>{c.verb} · {CERTAINTY[c.certainty].label}</Badge>
      </TooltipTrigger>
      <TooltipContent>{CERTAINTY[c.certainty].hint} For {c.roles.map(r => ROLES.find(x => x.id === r)?.label).join(", ")}.</TooltipContent>
    </Tooltip>
  )
}

function IssueBadge({ link }: { link: any }) {
  if (!link) return null
  return <Badge variant={link.state === "open" ? "secondary" : "outline"} className="gap-1"><GithubLogoIcon />#{link.number} {link.state}{link.assignees?.length ? ` · ${link.assignees.join(", ")}` : ""}</Badge>
}

function Row({ i, sel, onClick }: { i: any; sel: boolean; onClick: () => void }) {
  const done = i.status === "done"
  return (
    <li>
      <button type="button" onClick={onClick} aria-current={sel}
        className={cn("flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50", sel && "bg-muted")}>
        <span className={cn("w-1 shrink-0 self-stretch rounded-full", done ? "bg-success" : i.kind === "approval" ? "bg-primary" : sevTone[i.severity])} />
        <span className={cn("min-w-0 flex-1", done && "opacity-70")}>
          <span className="block text-sm font-medium">{i.title}</span>
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            <CertaintyBadge rule={i.rule} />
            {i.kind === "finding" ? <SevBadge sev={i.severity} /> : <Badge variant="outline">Approved{i.approvedBy ? ` by ${i.approvedBy}` : ""}</Badge>}
            <Badge variant="secondary">{i.owner}</Badge>
            {i.kind === "finding" && <Badge variant="outline">{i.family}</Badge>}
            {i.pushed && !done && <Badge variant="outline">Pushed this week</Badge>}
            {done && <Badge variant="outline" className="gap-1"><CheckCircleIcon />{i.doneReason}</Badge>}
            {i.stillDetected && <Badge variant="destructive">Still detected</Badge>}
            {i.newSinceIssue > 0 && <Badge variant="outline">{i.newSinceIssue} new since issue closed</Badge>}
            {!done && <IssueBadge link={i.link} />}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-heading text-lg font-semibold tabular-nums">{i.kind === "finding" ? Math.round(i.score) : i.ids?.length ?? ""}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{i.id}</span>
        </span>
      </button>
    </li>
  )
}

function Detail({ i, q, busy, onCreate }: { i: any; q: Q; busy: boolean; onCreate: () => void }) {
  const issue = i.issue.title + (i.issue.body ? "\n\n" + i.issue.body : "")
  const cmd = `./bin/dsa.js issues sync --apply --only ${i.id}`
  const l = i.link
  const d = i.decision
  const rows: [string, React.ReactNode][] = [
    ["Routed to", <><b>{i.owner}</b> <Badge variant="outline" className="ml-1">{SCOPES[i.scope] ?? i.scope}</Badge>{i.repo && <span className="ml-2 font-mono text-xs">{i.repo}</span>}</>],
    ...(i.why ? [["Why them", i.why] as [string, React.ReactNode]] : []),
    ...(d?.verdict === "replace" ? [["Decision", <code className="font-mono text-xs">&lt;{d.use}{Object.entries(d.props ?? {}).filter(([, v]) => v).map(([k, v]) => ` ${k}="${v}"`).join("")}&gt;{i.from ? ` from ${i.from}` : ""}</code>] as [string, React.ReactNode]] : []),
    ["Evidence", <span className="break-words">{i.evidence}</span>],
    ...(i.exit ? [["Done when", i.exit] as [string, React.ReactNode]] : []),
    ["History", i.history.map((h: any) => `${fmtD(h.at)} ${h.event}${h.detail ? ` (${h.detail})` : ""}`).join(" · ") || "—"],
    ...(l ? [["Issue", (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <a className="text-primary underline-offset-4 hover:underline" href={safeHref(l.url)} target="_blank" rel="noopener">{l.repo}#{l.number}</a>
        <Badge variant={l.state === "open" ? "secondary" : "outline"}>{l.state}{l.stateReason && l.state === "closed" ? ` · ${String(l.stateReason).replace("_", " ")}` : ""}</Badge>
        {l.assignees?.length ? <span className="text-muted-foreground">Assigned to {l.assignees.join(", ")}</span> : <span className="text-muted-foreground">Unassigned</span>}
        {l.comments != null && <span className="text-muted-foreground">· {l.comments} comment{l.comments === 1 ? "" : "s"}</span>}
        {l.updatedAt && <span className="text-muted-foreground">· updated {ago(l.updatedAt).toLowerCase()}</span>}
      </span>
    )] as [string, React.ReactNode]] : []),
  ]
  const canCreate = D.serve && i.status === "open" && l?.state !== "open"
  const createBlock = !q.github.token ? "Add a GitHub token in Settings first." : !i.repo ? "No repo for this owner: set a default repo in Settings." : ""
  return (
    <Panel title={i.title} action={i.kind === "finding" ? <SevBadge sev={i.severity} /> : <Badge variant="outline">Review approval</Badge>} className="lg:sticky lg:top-36">
      {i.status === "done" && (
        <p className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <CheckCircleIcon className="size-4 text-success-soft-foreground" /><b className="font-medium">Done</b>
          <span className="text-muted-foreground">{i.doneReason}{i.doneAt ? ` · ${fmtD(i.doneAt)}` : ""}</span>
          {i.stillDetected && <span className="text-destructive">The last scan still sees it{i.kind === "approval" ? ": the elements are still in the code." : "."}</span>}
        </p>
      )}
      {i.newSinceIssue > 0 && <p className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">{i.newSinceIssue} element{i.newSinceIssue === 1 ? " was" : "s were"} approved after issue #{l?.number} closed, so this is open again. A new issue covers the whole set.</p>}
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
        {rows.map(([k, v]) => <React.Fragment key={k}><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></React.Fragment>)}
      </dl>
      {i.issue.body && <>
        <Separator className="my-4" />
        <h3 className="mb-2 text-sm font-medium">{l ? "GitHub issue (as filed)" : "Drafted GitHub issue"}</h3>
        <Pre className="max-h-80">{issue}</Pre>
        <div className="mt-3 flex flex-wrap gap-2">
          {canCreate && (
            <Gate off={!!createBlock} why={createBlock}>
              <Button onClick={onCreate} disabled={!!createBlock || busy}><GithubLogoIcon data-icon="inline-start" />{busy ? "Creating…" : l ? "Create New Issue" : "Create Issue"}</Button>
            </Gate>
          )}
          {l && <Button variant="outline" nativeButton={false} render={<a href={safeHref(l.url)} target="_blank" rel="noopener" />}><ArrowSquareOutIcon data-icon="inline-start" />Open Issue</Button>}
          <Button variant="outline" onClick={() => copy(issue, "Issue text copied")}>Copy Issue</Button>
          <AskAgent subject={{ kind: "queue", id: i.id }} label="Work on this with the agent" size="sm" />
          {i.kind === "finding" && <Button variant="outline" onClick={() => copy(cmd, `Copied: ${cmd}`)}>Copy File Command</Button>}
        </div>
      </>}
    </Panel>
  )
}
