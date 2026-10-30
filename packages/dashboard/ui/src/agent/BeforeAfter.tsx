import * as React from "react"
import { CaretDownIcon, ImagesIcon } from "@phosphor-icons/react"
import { cn } from "cn"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useAgent, type Pair, type Shot } from "./store"

/**
 * Before/after pictures of a sandbox change. Opt-in: the server starts the app twice (the commit the
 * sandbox started from, then the sandbox) and pictures the elements the change touches.
 */
export function BeforeAfter() {
  const a = useAgent()
  const run = a.session?.visual
  const v = a.visual
  const [log, setLog] = React.useState(false)
  const take = (
    <Button size="sm" variant="outline" onClick={a.takePictures} disabled={a.busy || v.running}>
      <ImagesIcon data-icon="inline-start" />{run ? "Take them again" : "Show before/after"}
    </Button>
  )
  return (
    <div className="mt-3 border-t pt-3">
      {!run && !v.running && (
        <div className="flex flex-col items-start gap-2">
          {take}
          <p className="text-xs text-muted-foreground">Starts the app twice, before and after the change, and takes pictures of up to 4 elements it touches. It takes a few minutes.</p>
        </div>
      )}
      {v.running && (
        <div className="flex flex-col gap-1 text-xs" aria-live="polite">
          <p className="font-medium animate-pulse">Taking before/after pictures…</p>
          <p className="truncate text-muted-foreground" title={v.log.at(-1)}>{v.log.at(-1) ?? "Getting ready…"}</p>
        </div>
      )}
      {v.error && <p role="alert" className="mt-2 text-xs text-destructive">{v.error}</p>}
      {run && !v.running && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Before ({run.base}) and after, in {run.target} · {run.seconds}s</p>
            {take}
          </div>
          {v.stale && <p className="text-xs text-warning-soft-foreground">The sandbox changed after these were taken. Take them again to see the latest.</p>}
          {run.pairs.map(p => <PairView key={p.id} p={p} session={a.session!.id} />)}
          {run.notes.length > 0 && <ul className="list-disc pl-4 text-xs text-muted-foreground">{run.notes.map(n => <li key={n}>{n}</li>)}</ul>}
        </div>
      )}
      {v.log.length > 0 && !v.running && (
        <Collapsible open={log} onOpenChange={setLog}>
          <CollapsibleTrigger className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:underline">
            <CaretDownIcon className={cn("transition-transform", log && "rotate-180")} />{log ? "Hide what it did" : "What it did"}
          </CollapsibleTrigger>
          <CollapsibleContent><ol className="mt-1 max-h-48 overflow-y-auto font-mono text-xs text-muted-foreground">{v.log.map((l, i) => <li key={i}>{l}</li>)}</ol></CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

function PairView({ p, session }: { p: Pair; session: string }) {
  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium">{p.label}</span>
        <code className="font-mono text-muted-foreground">{p.file}:{p.line}</code>
        {p.same === true && <Badge variant="outline">No visible change</Badge>}
        {p.same === false && <Badge variant="secondary">Changed</Badge>}
        {p.after.loose && <Badge variant="outline" title="Its classes changed, so it was found again by its words on the same page.">Found by its words</Badge>}
      </figcaption>
      <div className="grid grid-cols-2 gap-2">
        <Picture shot={p.before} session={session} label="Before" />
        <Picture shot={p.after} session={session} label="After" />
      </div>
      <p className="text-xs text-muted-foreground">{p.reason}{p.before.page ? ` · on ${p.before.page || "/"}` : ""}{p.before.revealedBy ? ` after ${p.before.revealedBy}` : ""}</p>
    </figure>
  )
}

function Picture({ shot, session, label }: { shot: Shot; session: string; label: string }) {
  const src = shot.file ? `/api/agent/visual/img?id=${encodeURIComponent(session)}&f=${encodeURIComponent(shot.file)}` : null
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {src
        ? <a href={src} target="_blank" rel="noopener" className="block overflow-hidden rounded-md border bg-muted/30" title={`${label}: open full size`}><img src={src} alt={`${label} the change`} className="h-auto w-full" /></a>
        : <div className="flex min-h-16 items-center justify-center rounded-md border border-dashed p-2 text-center text-xs text-muted-foreground">Not found {label === "Before" ? "before" : "after"} the change</div>}
    </div>
  )
}
