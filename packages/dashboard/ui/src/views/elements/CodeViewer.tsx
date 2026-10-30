import * as React from "react"
import { ArrowSquareOutIcon, CopyIcon } from "@phosphor-icons/react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { D, api, copy, short } from "@/lib/dsa"
import { pickText, rec, useEl } from "./shared"

interface Source { repo?: string; ref?: string; rel: string; chunks: { start: number; lines: string[] }[]; total?: number }

/**
 * The element in its file, with its own lines highlighted. `dsa serve` reads the whole file; a
 * published page has the lines around each element (carried in the page), with gaps marked.
 */
export function CodeViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const { byId } = useEl()
  const e = byId.get(id)
  const [src, setSrc] = React.useState<Source | null | "loading">(() => (D.serve ? "loading" : D.elements.sources?.[e?.file] ?? null))
  const mark = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!D.serve || !e) return
    let live = true
    api(`/api/source?target=${encodeURIComponent(e.target)}&file=${encodeURIComponent(e.file)}`).then(s => live && setSrc(s), () => live && setSrc(null))
    return () => { live = false }
  }, [e])
  React.useEffect(() => { mark.current?.scrollIntoView({ block: "center" }) }, [src])
  if (!e) return null
  const first = e.line, last = e.line + Math.max(1, e.span ?? 1) - 1
  const url = src && src !== "loading" && src.repo && src.ref ? `https://github.com/${src.repo}/blob/${src.ref}/${src.rel}#L${first}${last > first ? `-L${last}` : ""}` : null
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] w-[96vw] max-w-5xl flex-col sm:max-w-5xl">
        <DialogHeader className="pr-10">
          <DialogTitle className="font-mono text-sm">{short(e.file)}:{e.line}</DialogTitle>
          <DialogDescription>{e.label ? `“${e.label}” · ` : ""}&lt;{e.element}&gt; → {pickText(rec(e))}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/30 font-mono text-xs leading-5">
          {src === "loading" ? <p className="p-4 text-muted-foreground">Reading the file…</p>
            : !src ? <p className="p-4 text-muted-foreground">The source isn't in this page. Open it in your editor, or run <code>dsa serve</code> to read it here.</p>
            : src.chunks.map((c, ci) => (
              <React.Fragment key={c.start}>
                {(ci > 0 || c.start > 1) && <div className="border-y border-dashed px-3 py-1 text-muted-foreground select-none">⋯ lines {ci > 0 ? src.chunks[ci - 1].start + src.chunks[ci - 1].lines.length : 1}–{c.start - 1} not shown</div>}
                {c.lines.map((t, i) => {
                  const n = c.start + i, on = n >= first && n <= last
                  return (
                    <div key={n} ref={n === first ? mark : undefined} className={cn("grid grid-cols-[3.5rem_1fr]", on && "bg-primary/10")}>
                      <span className={cn("pr-3 text-right text-muted-foreground tabular-nums select-none", on && "border-l-2 border-primary text-foreground")}>{n}</span>
                      <code className="pr-4 whitespace-pre">{t || " "}</code>
                    </div>
                  )
                })}
              </React.Fragment>
            ))}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">{src && src !== "loading" && src.ref ? `Lines as of commit ${src.ref.slice(0, 7)}.` : ""}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => copy(`${short(e.file)}:${e.line}`, "Path copied")}><CopyIcon data-icon="inline-start" />Copy path</Button>
            {url && <Button size="sm" render={<a href={url} target="_blank" rel="noreferrer" />}><ArrowSquareOutIcon data-icon="inline-start" />Open on GitHub</Button>}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
