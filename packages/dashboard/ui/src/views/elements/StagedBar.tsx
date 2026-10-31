import * as React from "react"
import { CaretDownIcon, DownloadSimpleIcon, PaperPlaneTiltIcon, XIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Code } from "@/components/bits"
import { copy, say } from "@/lib/dsa"
import { APPLY_COMMAND, FILE_NAME, clearStaged, downloadDecisions, unstage, useStaged } from "@/lib/staged"
import { ACTIONS, sendDecisions } from "@/lib/host"
import { pickText } from "./shared"

/**
 * The published dashboard can't write to the repo, so decisions made on it wait here: a bar docked
 * to the bottom of Element Review that lists them and sends them where the host adapter says (a
 * downloaded file, a webhook, an issue a workflow applies). Applying is `dsa apply-decisions`, the
 * same writes `dsa serve` makes.
 */
export function StagedBar() {
  const staged = useStaged()
  const [open, setOpen] = React.useState(false)
  const [confirm, setConfirm] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const kind = ACTIONS?.decisions.kind ?? "export"
  const send = async () => {
    setSending(true)
    try { say(await sendDecisions(staged)) } catch (e: any) { say(`${e.message} Download them instead.`, true) } finally { setSending(false) }
  }
  React.useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(false), 4000); return () => clearTimeout(t) }, [confirm])
  if (!staged.length) return null
  const n = staged.length
  return (
    <div className="sticky bottom-4 z-20 mt-8">
      <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border border-primary/50 bg-background p-3 shadow-lg">
        <div className="flex flex-wrap items-center gap-2">
          <CollapsibleTrigger className="mr-auto flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
            <CaretDownIcon className={open ? "rotate-180 transition-transform" : "transition-transform"} />
            {n} decision{n === 1 ? "" : "s"} staged in this browser
          </CollapsibleTrigger>
          {kind !== "export" && (
            <Button size="sm" onClick={send} disabled={sending}>
              <PaperPlaneTiltIcon data-icon="inline-start" />{ACTIONS!.decisions.label}
            </Button>
          )}
          <Button size="sm" variant={kind === "export" ? "default" : "outline"} onClick={() => { downloadDecisions(staged); say(`Saved ${FILE_NAME}. Apply it with the command in the list.`) }}>
            <DownloadSimpleIcon data-icon="inline-start" />Download decisions
          </Button>
          {kind === "export" && <Button size="sm" variant="outline" onClick={() => copy(APPLY_COMMAND, "Command copied")}>Copy apply command</Button>}
          <Button size="sm" variant={confirm ? "destructive" : "ghost"} onClick={() => (confirm ? (clearStaged(), setConfirm(false), say("Staged decisions cleared")) : setConfirm(true))}>
            {confirm ? `Clear all ${n}?` : "Clear"}
          </Button>
        </div>
        <CollapsibleContent className="mt-3 flex flex-col gap-3">
          <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-lg border text-sm">
            {staged.map(s => (
              <li key={s.key} className="flex items-start gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="font-mono text-xs">{s.label}</span>
                  <span className="text-muted-foreground"> → </span>
                  <b className="font-medium">{pickText(s.decision)}</b>
                  {s.note && <span className="block text-xs text-muted-foreground">“{s.note}”</span>}
                </span>
                <Button size="icon-xs" variant="ghost" aria-label={`Unstage ${s.label}`} onClick={() => unstage(s.key)}><XIcon /></Button>
              </li>
            ))}
          </ul>
          {kind === "export" ? (
            <p className="text-xs text-muted-foreground">
              This page is a static snapshot, so these stay in your browser until you apply them. Download the file, then run this from the repo root:{" "}
              <Code>{APPLY_COMMAND}</Code>. It records each decision exactly as <Code>dsa serve</Code> would.
              The next published scan shows them here; applied decisions then drop off this list.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {ACTIONS!.decisions.help} It runs <Code>{ACTIONS!.decisions.apply}</Code>, which records each decision exactly as <Code>dsa serve</Code> would.
              The next published scan shows them here; applied decisions then drop off this list.
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
