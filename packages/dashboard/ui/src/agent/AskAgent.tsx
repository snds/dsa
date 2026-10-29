import * as React from "react"
import { CaretDownIcon, CopyIcon, SparkleIcon, TerminalWindowIcon, ArrowSquareOutIcon, ChatCircleDotsIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Pre } from "@/components/bits"
import { api, copy, say } from "@/lib/dsa"
import { canChat, useAgent, type Subject } from "./store"

/**
 * The way into the agent from any card: chat here (the side panel), or take the same brief to Cursor
 * or a Claude Code terminal. All three start from the same facts.
 */
export function AskAgent({ subject, label = "Ask the agent", ask, size = "sm", variant = "outline" }: { subject: Subject; label?: string; ask?: string; size?: "sm" | "xs"; variant?: "outline" | "ghost" | "default" }) {
  const a = useAgent()
  const [handoff, setHandoff] = React.useState<any>(null)
  const live = canChat()
  async function take() {
    try { setHandoff(await api("/api/agent/handoff", { subject, question: ask ?? "" })) } catch (e: any) { say(e.message, true) }
  }
  const main = <Button variant={variant} size={size} onClick={() => a.start(subject, { ask })} disabled={!live}><SparkleIcon data-icon="inline-start" />{label}</Button>
  return (
    <>
      <ButtonGroup>
        {live ? main : <Tooltip><TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>{main}</TooltipTrigger><TooltipContent>Agents work when the dashboard is served (dsa serve).</TooltipContent></Tooltip>}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant={variant} size={size === "xs" ? "icon-xs" : "icon-sm"} aria-label="Other ways to work with an agent" disabled={!live} />}><CaretDownIcon /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onClick={() => a.start(subject, { ask })}><ChatCircleDotsIcon />Chat here</DropdownMenuItem>
            <DropdownMenuItem onClick={() => a.start(subject, { ask, mode: "try" })}><SparkleIcon />Chat here, with a sandbox to try changes</DropdownMenuItem>
            <DropdownMenuItem onClick={take}><ArrowSquareOutIcon />Take it to Cursor or Claude Code…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
      <Dialog open={!!handoff} onOpenChange={o => !o && setHandoff(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Work on this in your editor</DialogTitle>
            <DialogDescription>Same brief, your own tool. Proposals the agent makes there still land in this dashboard for you to accept. Needs the dsa tools connected once (Settings › Agents).</DialogDescription>
          </DialogHeader>
          {handoff && (
            <div className="flex flex-col gap-4 text-sm">
              <section>
                <h3 className="mb-1 font-medium">Cursor</h3>
                <ol className="ml-4 list-decimal space-y-1 text-muted-foreground">
                  <li>Open {handoff.repo.name} in Cursor: <button className="text-primary underline-offset-4 hover:underline" onClick={() => copy(handoff.cursor.open, "Command copied")}>copy the command</button>.</li>
                  <li>Send the prompt to Cursor's chat. You review it before it runs.</li>
                </ol>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" nativeButton={false} render={<a href={handoff.cursor.prompt} />}><ArrowSquareOutIcon data-icon="inline-start" />Send to Cursor</Button>
                  <Button size="sm" variant="outline" onClick={() => copy(handoff.prompt, "Prompt copied")}><CopyIcon data-icon="inline-start" />Copy the prompt</Button>
                </div>
              </section>
              <section>
                <h3 className="mb-1 font-medium">Claude Code (terminal)</h3>
                <p className="text-muted-foreground">Paste into a terminal. It opens Claude in the repo with the dsa tools, the design system's tools, and the brief.</p>
                <Pre className="mt-2 max-h-28">{handoff.claudeCode}</Pre>
                <Button size="sm" variant="outline" className="mt-2" onClick={() => copy(handoff.claudeCode, "Command copied")}><TerminalWindowIcon data-icon="inline-start" />Copy the command</Button>
              </section>
              <p className="text-xs text-muted-foreground">Brief: <code className="font-mono">{handoff.brief}</code></p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
