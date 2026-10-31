import * as React from "react"
import { forgetToken, token } from "@/lib/useScan"
import { TrashIcon, PlusIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Code, Note, Panel, Pre } from "@/components/bits"
import { D, SCOPES, api, say } from "@/lib/dsa"

const RULES: [string, string, string][] = [
  ["misuse_cluster_threshold", "Misuse cluster threshold", "Outside consumers doing the same thing before a finding routes to the core team."],
  ["sample_floor_instances", "Minimum sample", "Instances needed before a rate-based finding can open."],
  ["new_code_days", "New-code window (days)", "Files changed within this window count as new code for token compliance."],
  ["weekly_queue_budget", "Weekly issue budget", "Most new GitHub issues filed per run, highest score first."],
]
const LABEL: Record<string, string> = { apps: "Measures", modules: "Modules", report: "Report", figma: "Figma", github: "GitHub", sources: "Sources", rules: "Rule settings" }

/**
 * Where the design system's code is. dsa scores every folder in the repo against the signs a design system
 * leaves and reads the ones at or above the threshold; below it, a person confirms. Ticking folders pins them.
 */
function SystemFolders({ d, onPin }: { d: any; onPin: (dirs: string[]) => void }) {
  const [add, setAdd] = React.useState("")
  if (!d) return null
  const reading = new Set<string>(d.reading)
  const isRead = (c: any) => c.members.every((m: string) => reading.has(m) || [...reading].some(r => r === "." || m.startsWith(`${r}/`)))
  const toggle = (c: any, on: boolean) => {
    const next = new Set<string>(reading)
    for (const m of c.members) on ? next.add(m) : next.delete(m)
    onPin([...next].sort())
  }
  const pct = (n: number) => `${Math.round(n * 100)}%`
  const how: Record<string, string> = { pinned: "You chose these folders.", expected: "Found where the config points.", discovered: "Found by scanning the repo.", none: "No folder reached the threshold. Pick the right one below." }
  return (
    <div className="mb-6 flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium">Where the system's code is</h3>
        <Note className="text-xs">{how[d.how] ?? ""} A folder dsa finds on its own needs {pct(d.threshold)} confidence; tick any folder to read it instead.{d.error ? ` (${d.error})` : ""}</Note>
      </div>
      <div className="flex flex-wrap gap-1.5">{d.reading.length ? d.reading.map((r: string) => <Badge key={r} variant="secondary"><Code>{r}</Code></Badge>) : <Note className="text-xs">Nothing is read yet.</Note>}</div>
      {d.candidates.length > 0 && (
        <Table>
          <TableHeader><TableRow><TableHead className="w-10">Read</TableHead><TableHead>Folder</TableHead><TableHead className="w-20 text-right">Confidence</TableHead><TableHead>Why</TableHead></TableRow></TableHeader>
          <TableBody>{d.candidates.map((c: any) => (
            <TableRow key={c.dir}>
              <TableCell><Checkbox checked={isRead(c)} onCheckedChange={on => toggle(c, Boolean(on))} aria-label={`Read ${c.dir}`} /></TableCell>
              <TableCell><Code>{c.dir}</Code>{c.because && <span className="ml-2 text-xs text-muted-foreground">{c.because}</span>}</TableCell>
              <TableCell className={`text-right tabular-nums ${c.confidence >= d.threshold ? "" : "text-muted-foreground"}`}>{pct(c.confidence)}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{c.why.join(" · ")}</TableCell>
            </TableRow>))}</TableBody>
        </Table>
      )}
      <div className="flex items-end gap-2">
        <Field className="flex-1"><FieldLabel htmlFor="s-addsrc">Add a folder</FieldLabel><Input id="s-addsrc" value={add} placeholder="src/components/ui" onChange={e => setAdd(e.target.value)} /></Field>
        <Button variant="outline" disabled={!add.trim()} onClick={() => { onPin([...new Set([...reading, add.trim()])].sort()); setAdd("") }}><PlusIcon />Add</Button>
        {d.pinned.length > 0 && <Button variant="ghost" onClick={() => onPin([])}>Find again</Button>}
      </div>
    </div>
  )
}

export function General({ onTitle }: { onTitle: (t: string) => void }) {
  const [v, setV] = React.useState<any>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<Record<string, { text: string; bad?: boolean }>>({})
  const chain = React.useRef(Promise.resolve<any>(null))
  React.useEffect(() => { if (D.serve) api("/api/settings").then(setV, e => setErr(e.message)) }, [])

  if (!D.serve) return (
    <div className="flex flex-col gap-6">
    <BrowserToken />
    <Panel title="Settings are edited in the live view">
      <Note>This file is a snapshot. To change tokens, Figma links, the time zone, sources, or rule settings, start the live view and open it in your browser:</Note>
      <Pre className="my-3">dsa serve</Pre>
      <Note>Then go to http://localhost:4319. Tokens are stored in .dsa/secrets.json (never in dsa.config.json), so the config stays safe to commit.</Note>
    </Panel>
    </div>
  )
  if (err) return <Panel><Note>Couldn't load settings: {err}</Note></Panel>
  if (!v) return <div className="flex flex-col gap-4"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>

  // Saves are queued so two quick edits never race; each section saves (and validates) as a whole.
  const save = (sec: string, body: any, okText?: string) => (chain.current = chain.current.then(async () => {
    setStatus(s => ({ ...s, [sec]: { text: "Saving…" } }))
    try {
      const r = await api("/api/settings", body)
      setStatus(s => ({ ...s, [sec]: { text: "Saved" } }))
      setTimeout(() => setStatus(s => (s[sec]?.text === "Saved" ? { ...s, [sec]: { text: "" } } : s)), 2500)
      say(okText || `${LABEL[sec]} saved`)
      if (sec === "modules") setTimeout(() => location.reload(), 600)
      if (sec === "report") { D.timeZone = body.report.timeZone || null; D.title = body.report.title || D.root; onTitle(D.title) }
      // Only the link types come back changed (team / project / file); everything else is what's on screen.
      if (sec === "figma" && r.view) setV((cur: any) => ({ ...cur, figma: { ...cur.figma, links: r.view.figma.links } }))
      return r
    } catch (e: any) {
      setStatus(s => ({ ...s, [sec]: { text: "Not saved", bad: true } }))
      say((e.data?.errors || [e.message]).join(" "), true)
      return null
    }
  }))
  const set = (path: string[], value: any) => setV((cur: any) => { const n = structuredClone(cur); let o = n; for (const k of path.slice(0, -1)) o = o[k]; o[path[path.length - 1]] = value; return n })
  const st = (sec: string) => status[sec]?.text ? <span className={status[sec].bad ? "text-destructive" : "text-muted-foreground"}>{status[sec].text}</span> : undefined

  const bodies: Record<string, (x: any) => any> = {
    report: x => ({ report: { title: x.report.title, timeZone: x.report.timeZone } }),
    figma: x => ({ figma: { libraries: x.figma.libraries, links: x.figma.links.map((l: any) => ({ url: l.url, label: l.label })), editedWithinDays: x.figma.editedWithinDays, maxFiles: x.figma.maxFiles } }),
    github: x => ({ github: { defaultRepo: x.github.defaultRepo, labels: x.github.labels } }),
    sources: x => ({ sources: { children: x.sources.children, internalConsumers: x.sources.internalConsumers, ...(x.sources.pin ? { pinned: x.sources.pin } : {}) } }),
    apps: x => ({ apps: x.apps.map((a: any) => ({ name: a.name, tokenSkip: a.tokenSkip, versions: a.versions, components: a.components, lookalikes: a.lookalikes, tokens: a.tokens })) }),
    modules: x => ({ modules: { figma: x.modules.figma } }),
    rules: x => ({ rules: x.rules }),
  }
  // Text fields save when they lose focus; selects, checkboxes, and switches save right away.
  const commit = (sec: string, next?: any) => save(sec, bodies[sec](next ?? v))
  const change = (sec: string, path: string[], value: any) => { const n = structuredClone(v); let o = n; for (const k of path.slice(0, -1)) o = o[k]; o[path[path.length - 1]] = value; setV(n); commit(sec, n) }

  const zones: string[] = (Intl as any).supportedValuesOf ? (Intl as any).supportedValuesOf("timeZone") : ["America/Los_Angeles", "America/New_York", "Europe/London", "UTC"]
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  return (
    <div className="flex flex-col gap-6">
      <Panel title="Report" description={st("report") ?? "How this page shows things"}>
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field><FieldLabel htmlFor="s-title">Title</FieldLabel><Input id="s-title" value={v.report.title} placeholder={D.root} onChange={e => set(["report", "title"], e.target.value)} onBlur={() => commit("report")} /></Field>
          <Field><FieldLabel htmlFor="s-tz">Time zone</FieldLabel>
            <NativeSelect id="s-tz" className="w-full" value={v.report.timeZone} onChange={e => change("report", ["report", "timeZone"], e.target.value)}>
              <NativeSelectOption value="">This browser ({browserZone})</NativeSelectOption>
              {zones.map(z => <NativeSelectOption key={z} value={z}>{z}</NativeSelectOption>)}
            </NativeSelect>
            <FieldDescription>Used for every date and time in the report.</FieldDescription></Field>
        </FieldGroup>
      </Panel>

      {v.modules.figma && (
        <Panel title="Figma" description={st("figma") ?? "Organization plan: standard file API only"}>
          <FieldGroup>
            <TokenField id="figma" label="Personal access token with file read access (Figma › Settings › Security › Personal access tokens)." token={v.figma.token} fromEnv={v.figma.tokenFromEnv} save={save} testUrl="/api/figma/test" onView={setV} />
            <div>
              <h3 className="text-sm font-medium">Library files</h3><Note className="mb-2 text-xs">Published libraries. Their components define what counts as a design system instance.</Note>
              <EditRows rows={v.figma.libraries} cols={[["name", "Name", "Core"], ["url", "File link", "https://www.figma.com/design/…"]]}
                onChange={rows => set(["figma", "libraries"], rows)} onCommit={rows => change("figma", ["figma", "libraries"], rows)} onBlur={() => commit("figma")} addLabel="Add library" />
            </div>
            <div>
              <h3 className="text-sm font-medium">Files to scan</h3><Note className="mb-2 text-xs">Paste team, project, or file links. Teams and projects are expanded to their recently edited files.</Note>
              <EditRows rows={v.figma.links} cols={[["url", "Link", "Team, project, or file link"], ["label", "Label", "Label (optional)"]]} extra={r => <Badge variant="outline">{r.parsed?.kind || "—"}</Badge>}
                onChange={rows => set(["figma", "links"], rows)} onCommit={rows => change("figma", ["figma", "links"], rows)} onBlur={() => commit("figma")} addLabel="Add link" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field><FieldLabel htmlFor="s-days">Edited within (days)</FieldLabel><Input id="s-days" type="number" min={1} value={v.figma.editedWithinDays} onChange={e => set(["figma", "editedWithinDays"], e.target.value)} onBlur={() => commit("figma")} /></Field>
              <Field><FieldLabel htmlFor="s-max">Max files per run</FieldLabel><Input id="s-max" type="number" min={1} value={v.figma.maxFiles} onChange={e => set(["figma", "maxFiles"], e.target.value)} onBlur={() => commit("figma")} /></Field>
            </div>
          </FieldGroup>
        </Panel>
      )}

      <Panel title="GitHub issues" description={st("github") ?? "Where findings get filed"}>
        <FieldGroup>
          <TokenField id="github" label="Fine-grained token with Issues: read and write on the target repos." token={v.github.token} fromEnv={v.github.tokenFromEnv} save={save} testUrl="/api/github/test" onView={setV} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field><FieldLabel htmlFor="s-repo">Default repo</FieldLabel><Input id="s-repo" value={v.github.defaultRepo} placeholder="owner/name" onChange={e => set(["github", "defaultRepo"], e.target.value)} onBlur={() => commit("github")} /><FieldDescription>For core findings and owners without their own repo.</FieldDescription></Field>
            <Field><FieldLabel htmlFor="s-labels">Extra labels</FieldLabel><Input id="s-labels" value={v.github.labels} placeholder="design-system, triage" onChange={e => set(["github", "labels"], e.target.value)} onBlur={() => commit("github")} /></Field>
          </div>
        </FieldGroup>
      </Panel>

      <Panel title="Sources" description={st("sources") ?? `Core: ${v.sources.core.name} (${v.sources.core.packages.join(", ")})`}>
        <SystemFolders d={v.sources.discovery} onPin={(dirs: string[]) => {
          // Pin the new set, then reload so the list shows what is read now.
          const next = { ...v, sources: { ...v.sources, pin: dirs } }
          save("sources", bodies.sources(next), dirs.length ? "Folders pinned" : "Finding folders again").then(r => { if (r?.view) setV(r.view) })
        }} />
        {v.sources.children.length > 0 && (
          <>
            <h3 className="text-sm font-medium">Child libraries</h3>
            <Note className="mb-2 text-xs">The local path is read in place. The git link is used when the path is missing, or always with --remote.</Note>
            <Table>
              <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Local path</TableHead><TableHead>Git link</TableHead><TableHead>Branch</TableHead><TableHead>Skip folders</TableHead></TableRow></TableHeader>
              <TableBody>{v.sources.children.map((c: any, i: number) => (
                <TableRow key={c.name}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  {(["path", "gitUrl", "gitRef", "exclude"] as const).map(k => (
                    <TableCell key={k}><Input value={c[k]} className={k === "gitRef" ? "w-24" : ""} onChange={e => set(["sources", "children", String(i), k], e.target.value)} onBlur={() => commit("sources")} /></TableCell>
                  ))}
                </TableRow>))}</TableBody>
            </Table>
          </>
        )}
        <Field className="mt-4"><FieldLabel htmlFor="s-internal">Internal apps</FieldLabel><Input id="s-internal" value={v.sources.internalConsumers} placeholder="@acme/docs, @acme/storybook" onChange={e => set(["sources", "internalConsumers"], e.target.value)} onBlur={() => commit("sources")} />
          <FieldDescription>Owned by the design system team: scored, but they don't count toward cross-team clusters.</FieldDescription></Field>
      </Panel>

      <Panel title="What to measure, per app" description={st("apps") ?? "Unchecked measures are left out of scores and findings"} contentClassName="px-0">
        <Table>
          <TableHeader><TableRow><TableHead className="pl-4">App</TableHead><TableHead>Role</TableHead>{["Versions", "Components", "Look-alikes", "Tokens"].map(h => <TableHead key={h} className="text-center">{h}</TableHead>)}<TableHead className="pr-4">Skip for token compliance</TableHead></TableRow></TableHeader>
          <TableBody>
            {v.apps.length ? v.apps.map((a: any, i: number) => (
              <TableRow key={a.name}>
                <TableCell className="pl-4 font-medium">{a.name}{a.internal && <Badge variant="outline" className="ml-2">Internal</Badge>}</TableCell>
                <TableCell className="text-muted-foreground">{SCOPES[a.role] ?? a.role}</TableCell>
                {(["versions", "components", "lookalikes", "tokens"] as const).map(k => (
                  <TableCell key={k} className="text-center"><Checkbox aria-label={`${a.name}: ${k}`} checked={!!a[k]} onCheckedChange={(c: any) => change("apps", ["apps", String(i), k], !!c)} /></TableCell>
                ))}
                <TableCell className="pr-4"><Input value={a.tokenSkip} placeholder="None" disabled={!a.tokens} onChange={e => set(["apps", String(i), "tokenSkip"], e.target.value)} onBlur={() => commit("apps")} /></TableCell>
              </TableRow>
            )) : <TableRow><TableCell colSpan={7} className="pl-4 text-muted-foreground">No apps found yet. Run a scan first.</TableCell></TableRow>}
          </TableBody>
        </Table>
        <Note className="mt-3 px-4 text-xs">Skip patterns are relative to the app's folder. A bare file name matches anywhere in the app; <Code>*</Code> stays in one folder, <Code>**</Code> crosses folders. Use them for reference sheets that show raw values on purpose.</Note>
      </Panel>

      <Panel title="Rule settings" description={st("rules") ?? "Every change is logged in Notes"}>
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          {RULES.map(([k, l, h]) => (
            <Field key={k}><FieldLabel htmlFor={`r-${k}`}>{l}</FieldLabel><Input id={`r-${k}`} type="number" min={0} value={v.rules[k]} onChange={e => set(["rules", k], e.target.value)} onBlur={() => commit("rules")} /><FieldDescription>{h}</FieldDescription></Field>
          ))}
        </FieldGroup>
      </Panel>

      <Panel title="Modules" description={st("modules") ?? "Off modules keep their settings and data"}>
        <Field orientation="horizontal">
          <Switch id="m-figma" checked={v.modules.figma} onCheckedChange={(c: any) => change("modules", ["modules", "figma"], !!c)} />
          <div><FieldLabel htmlFor="m-figma">Figma design files</FieldLabel>
            <FieldDescription>Crawls team and project files for library instances and rebuilt look-alike frames. On the Organization plan it only sees files in teams you can list; library-wide usage needs Figma Enterprise (Library Analytics API). Turning it on adds the Design Files tab and Figma settings.</FieldDescription></div>
        </Field>
      </Panel>

      <Note className="px-1 text-xs">Changes save on their own when you leave a field, to {v.configFile || "dsa.config.json"}. Tokens save with their own button, to .dsa/secrets.json.</Note>
    </div>
  )
}

function EditRows({ rows, cols, extra, onChange, onCommit, onBlur, addLabel }: { rows: any[]; cols: [string, string, string][]; extra?: (r: any) => React.ReactNode; onChange: (r: any[]) => void; onCommit: (r: any[]) => void; onBlur: () => void; addLabel: string }) {
  const list = rows.length ? rows : [{}]
  return (
    <div className="flex flex-col gap-2">
      {list.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          {cols.map(([k, , ph]) => <Input key={k} aria-label={k} value={r[k] ?? ""} placeholder={ph} onChange={e => onChange(list.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} onBlur={onBlur} />)}
          {extra?.(r)}
          <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => onCommit(list.filter((_, j) => j !== i))}><TrashIcon /></Button>
        </div>
      ))}
      <Button variant="outline" size="sm" className="w-fit" onClick={() => onChange([...list, {}])}><PlusIcon data-icon="inline-start" />{addLabel}</Button>
    </div>
  )
}

/** Tokens save only with their own button (a half-pasted token is never stored); removing takes two clicks. */
function TokenField({ id, label, token, fromEnv, save, testUrl, onView }: { id: "figma" | "github"; label: string; token: string; fromEnv: boolean; save: (sec: string, body: any, ok?: string) => Promise<any>; testUrl: string; onView: (v: any) => void }) {
  const [value, setValue] = React.useState("")
  const [armed, setArmed] = React.useState(false)
  const [check, setCheck] = React.useState("")
  const key = id === "figma" ? "figmaToken" : "githubToken"
  const name = id === "figma" ? "Figma" : "GitHub"
  return (
    <Field>
      <FieldLabel htmlFor={`tok-${id}`}>Token</FieldLabel>
      <div className="flex flex-wrap gap-2">
        <Input id={`tok-${id}`} type="password" autoComplete="off" className="min-w-60 flex-1" value={value} onChange={e => setValue(e.target.value)} placeholder={token ? `Saved: ${token}. Paste a new one to replace it` : "Paste a token"} />
        <Button onClick={async () => { if (!value.trim()) return say("Paste a token first.", true); const r = await save(id, { secrets: { [key]: value.trim() } }, `${name} token saved`); if (r) { setValue(""); onView(r.view) } }}>Save token</Button>
        <Button variant="outline" onClick={async () => { setCheck("Checking…"); try { const r = await api(testUrl, { token: value.trim() || undefined }); setCheck(r.handle ? `Works: signed in as ${r.handle}${r.email ? ` (${r.email})` : ""}.` : `Works: signed in as ${r.login}.`) } catch (e: any) { setCheck(e.message) } }}>Test</Button>
        {token && !fromEnv && <Button variant={armed ? "destructive" : "ghost"} onClick={async () => { if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 4000); return } const r = await save(id, { secrets: { [key]: null } }, "Token removed"); if (r) onView(r.view) }}>{armed ? "Click again to remove" : "Remove"}</Button>}
      </div>
      <FieldDescription>{label}{fromEnv ? " An environment variable is set and takes priority." : ""}{check ? ` ${check}` : ""}</FieldDescription>
    </Field>
  )
}

/** The GitHub token Re-scan uses on a published page: kept only in this browser, forgotten here. */
function BrowserToken() {
  const spec = D.actions?.rescan?.runner?.type === "github" ? D.actions.rescan.runner : null
  const [has, setHas] = React.useState(() => Boolean(token()?.get()))
  if (!spec) return null
  return (
    <Panel title="This browser" description={`Re-scan starts the ${spec.workflow} workflow in ${spec.repo} with a GitHub token you give it.`}>
      {has ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Note>A token is saved in this browser only (local storage for this site). It isn't in the report or anywhere else.</Note>
          <Button variant="outline" onClick={() => { forgetToken(); setHas(false); say("Token forgotten. Revoke it on GitHub too if you no longer need it.") }}>Forget token</Button>
        </div>
      ) : <Note>No token saved. Re-scan asks for one the first time.</Note>}
    </Panel>
  )
}
