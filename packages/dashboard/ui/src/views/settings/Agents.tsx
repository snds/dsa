import * as React from "react"
import { ArrowsClockwiseIcon, CheckCircleIcon, CopyIcon, ArrowSquareOutIcon, TrashIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Code, Note, Panel, Pre } from "@/components/bits"
import { D, api, copy, say } from "@/lib/dsa"
import { ProposalCard } from "@/agent/AgentPanel"

/**
 * Settings › Agents: connect Claude Code or Cursor, set how sessions start, and see what agents have
 * proposed and taught the scanner. Written for a designer who hasn't set up an agent before.
 */
export function Agents() {
  const [v, setV] = React.useState<any>(null)
  const [props, setProps] = React.useState<any[]>([])
  const [err, setErr] = React.useState<string | null>(null)
  const load = React.useCallback(async (refresh = false) => {
    try {
      setV(await api(`/api/agent/status${refresh ? "?refresh=1" : ""}`))
      setProps((await api("/api/agent/proposals?status=open")).proposals)
    } catch (e: any) { setErr(e.message) }
  }, [])
  React.useEffect(() => { if (D.serve) load() }, [load])

  if (!D.serve) return <Note>Agents work when the dashboard is served. Run <Code>./bin/dsa.js serve</Code> and open it from there.</Note>
  if (err) return <Note className="text-destructive">{err}</Note>
  if (!v) return <Skeleton className="h-64" />
  const s = v.settings
  const save = async (patch: any) => {
    const next = { ...s, ...patch }
    setV({ ...v, settings: next })
    try { await api("/api/agent/settings", next); say("Saved") } catch (e: any) { say(e.message, true) }
  }
  const chat = v.providers.filter((p: any) => p.id !== "cursor-ide")

  return (
    <div className="flex flex-col gap-6">
      <Panel title="What the agent does here">
        <ul className="ml-4 list-disc space-y-1.5 text-sm">
          <li>It's a senior design-system engineer to think out loud with. Open it from a review card, a queue item, or Agent Readiness, and it starts already briefed: the scan's evidence, the screenshots, the design-system docs, and why the rules are the way they are.</li>
          <li>It looks before it answers (screenshots, code, the design system's docs) and tells you how sure it is.</li>
          <li>It never changes anything itself. Decisions, policies, scanner hints, and issue drafts come back as proposals you accept or reject.</li>
          <li>To try a change, switch the session to <b>Try in sandbox</b>. It edits a throwaway copy of the repo; you see the diff and keep it as a local branch, or throw it away. Nothing is pushed.</li>
          <li>When it spots the scanner reading something wrong, it proposes a <b>scanner hint</b>. Accepted hints apply on every scan from then on.</li>
        </ul>
      </Panel>

      <Panel title="Agents on this computer" action={<Button variant="outline" size="sm" onClick={() => load(true)}><ArrowsClockwiseIcon data-icon="inline-start" />Check again</Button>}>
        <ul className="divide-y">
          {v.providers.map((p: any) => (
            <li key={p.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                {p.installed ? <CheckCircleIcon className="size-4 text-success-soft-foreground" weight="fill" /> : <WarningCircleIcon className="size-4 text-muted-foreground" />}
                <span className="font-medium">{p.label}</span>
                {p.installed ? <Badge variant="secondary">{p.version}</Badge> : <Badge variant="outline">Not installed</Badge>}
                {p.chat && <Badge variant="outline">Chats in the dashboard</Badge>}
                {p.id === "cursor-ide" && p.installed && <Badge variant="outline">Takes handoffs</Badge>}
              </div>
              {!p.installed && (
                <div className="text-sm text-muted-foreground">
                  To install, run in a terminal:
                  <Pre className="mt-1">{p.install.steps.join("\n")}</Pre>
                  <a className="mt-1 inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline" href={p.install.docs} target="_blank" rel="noopener noreferrer">Setup guide<ArrowSquareOutIcon className="size-3.5" /></a>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="How sessions start" description="Applies to new sessions. You can switch Advise and Try in sandbox inside any session.">
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="ag-provider">Agent</FieldLabel>
            <NativeSelect id="ag-provider" className="w-full" value={s.provider} onChange={e => save({ provider: e.target.value })}>
              {chat.map((p: any) => <NativeSelectOption key={p.id} value={p.id} disabled={!p.chat}>{p.label}{p.chat ? "" : " (not installed)"}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="ag-mode">Start in</FieldLabel>
            <NativeSelect id="ag-mode" className="w-full" value={s.mode} onChange={e => save({ mode: e.target.value })}>
              <NativeSelectOption value="advise">Advise (reads, can't edit)</NativeSelectOption>
              <NativeSelectOption value="try">Try in sandbox (may edit a copy)</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="ag-model">Claude model</FieldLabel>
            <Input id="ag-model" defaultValue={s.model} placeholder="Your Claude Code default" onBlur={e => e.target.value !== s.model && save({ model: e.target.value })} />
            <FieldDescription>Optional, e.g. <Code>claude-sonnet-5-5</Code>. Blank uses your default.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="ag-cmodel">Cursor model</FieldLabel>
            <Input id="ag-cmodel" defaultValue={s.cursorModel} placeholder="Cursor's default" onBlur={e => e.target.value !== s.cursorModel && save({ cursorModel: e.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="ag-time">Time limit per answer (minutes)</FieldLabel>
            <Input id="ag-time" type="number" min={1} max={60} defaultValue={s.timeoutMinutes} onBlur={e => Number(e.target.value) !== s.timeoutMinutes && save({ timeoutMinutes: Number(e.target.value) })} />
          </Field>
        </FieldGroup>
      </Panel>

      <Panel title="Use the scan from your own editor" description="Connect once. Then any Cursor or Claude Code chat can read this scan and send proposals here.">
        <div className="flex flex-col gap-5 text-sm">
          <section>
            <h3 className="mb-1 font-medium">Cursor</h3>
            <p className="text-muted-foreground">Each button asks Cursor to add a tool server; Cursor shows what it will run before you confirm.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" nativeButton={false} render={<a href={v.setup.cursor.installDsa} />}>Add the scan tools (dsa)</Button>
              <Button size="sm" variant="outline" nativeButton={false} render={<a href={v.setup.cursor.installSystem} />}>Add the design-system tools</Button>
            </div>
          </section>
          <section>
            <h3 className="mb-1 font-medium">Claude Code</h3>
            <p className="text-muted-foreground">Run both in a terminal, once.</p>
            <Pre className="mt-2">{`${v.setup.claudeCode.add}\n${v.setup.claudeCode.addCds}`}</Pre>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => copy(`${v.setup.claudeCode.add}\n${v.setup.claudeCode.addCds}`, "Commands copied")}><CopyIcon data-icon="inline-start" />Copy</Button>
          </section>
          <section>
            <h3 className="mb-1 font-medium">Any other MCP client</h3>
            <p className="text-muted-foreground">Paste into its MCP settings file (the usual <Code>mcpServers</Code> shape).</p>
            <Pre className="mt-2 max-h-48">{v.setup.json}</Pre>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => copy(v.setup.json, "Copied")}><CopyIcon data-icon="inline-start" />Copy</Button>
          </section>
        </div>
      </Panel>

      <Panel title={`Waiting for you (${props.length})`} description="Proposals from every session, including Cursor and Claude Code.">
        {props.length ? <div className="flex flex-col gap-3" onClick={() => setTimeout(() => load(), 800)}>{props.map(p => <ProposalCard key={p.id} p={p} />)}</div> : <Note>Nothing waiting.</Note>}
      </Panel>

      <Panel title={`Scanner hints (${v.hints.length})`} description="Reviewed corrections the scanner applies on every scan. Saved in dsa.hints.json; commit it so everyone gets them.">
        {v.hints.length ? (
          <ul className="divide-y text-sm">
            {v.hints.map((h: any) => (
              <li key={h.id} className="flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p><Code>{h.id}</Code> {h.prefer ? <>prefer <b>{h.prefer.use ?? h.prefer.verdict}</b></> : <>never <b>{(h.avoid ?? []).join(", ")}</b></>} for <Code>&lt;{h.when.element}&gt;</Code>{Object.entries(h.when).filter(([k]) => k !== "element").map(([k, x]) => ` · ${k} ${Array.isArray(x) ? x.join(" ") : x}`).join("")}</p>
                  <p className="text-muted-foreground">{h.why}</p>
                  <p className="text-xs text-muted-foreground">{h.who ? `${h.who}, ` : ""}{h.date}{h.source?.session ? ` · from ${h.source.session}` : ""}</p>
                </div>
                <Button variant="ghost" size="icon-sm" aria-label={`Remove hint ${h.id}`} onClick={async () => { try { await api("/api/agent/hint/delete", { id: h.id }); say("Hint removed; the review was re-scored"); load() } catch (e: any) { say(e.message, true) } }}><TrashIcon /></Button>
              </li>
            ))}
          </ul>
        ) : <Note>None yet. Agents propose them when the scanner misreads an element.</Note>}
      </Panel>

      {v.feedback.length > 0 && (
        <Panel title={`Scanner notes (${v.feedback.length})`} description="Accepted bug reports and ideas for the scanner's code (dsa.feedback.json).">
          <ul className="divide-y text-sm">{v.feedback.map((f: any, i: number) => <li key={i} className="py-2"><p>{f.problem}</p>{f.suggestion && <p className="text-muted-foreground">{f.suggestion}</p>}<p className="text-xs text-muted-foreground">{f.who}, {f.date}{f.examples?.length ? ` · ${f.examples.slice(0, 4).join(", ")}` : ""}</p></li>)}</ul>
        </Panel>
      )}
    </div>
  )
}
