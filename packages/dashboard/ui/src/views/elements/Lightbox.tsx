import * as React from "react"
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { short, SYS } from "@/lib/dsa"
import { Dims, Ring, desc, rec, useEl } from "./shared"

/**
 * Large, side by side, at the same scale: the element in the app and the system variant in Storybook.
 * Screenshots are 2× device pixels, so 1× is their on-screen size; Fit shows both at 2× and shrinks only
 * what doesn't fit, so sizes compare honestly. Click an image to step the zoom; ←/→ go through the set.
 */
export function Lightbox({ ids, start, onClose }: { ids: string[]; start: number; onClose: () => void }) {
  const { byId } = useEl()
  const [i, setI] = React.useState(start)
  const [zoom, setZoom] = React.useState(0)
  const e = byId.get(ids[i]), r = e?.rendered
  const step = (n: number) => setI(x => (x + n + ids.length) % ids.length)
  React.useEffect(() => {
    const on = (k: KeyboardEvent) => {
      if (k.key === "ArrowRight" && ids.length > 1) step(1)
      if (k.key === "ArrowLeft" && ids.length > 1) step(-1)
      if (k.key === "+" || k.key === "=") setZoom(z => Math.min(4, (z || 1) * 2))
      if (k.key === "-") setZoom(z => (z <= 1 ? 0 : z / 2))
    }
    addEventListener("keydown", on); return () => removeEventListener("keydown", on)
  })
  if (!e?.shot) return null
  const panel = (src: string, label: string, box?: any) => (
    <figure className="m-0 flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto rounded-lg border bg-muted/40 p-3">
        <Frame src={src} zoom={zoom} box={box} onClick={() => setZoom(z => (z === 0 ? 2 : z === 2 ? 4 : 0))} />
      </div>
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  )
  const d = r?.diff
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="flex h-[90vh] w-[96vw] max-w-[1400px] flex-col sm:max-w-[1400px]">
        <DialogHeader className="flex-row flex-wrap items-center justify-between gap-3 pr-10">
          <div className="min-w-0">
            <DialogTitle className="font-mono text-sm">{short(e.file)}:{e.line}</DialogTitle>
            <DialogDescription>&lt;{e.element}&gt; → {desc(rec(e))} · {Math.round(e.confidence * 100)}%</DialogDescription>
          </div>
          <div className="flex items-center gap-2">
            <ButtonGroup>{[0, 1, 2, 4].map(z => <Button key={z} size="sm" variant={z === zoom ? "secondary" : "outline"} onClick={() => setZoom(z)}>{z ? `${z}×` : "Fit"}</Button>)}</ButtonGroup>
            {ids.length > 1 && <>
              <span className="text-xs text-muted-foreground tabular-nums">{i + 1} / {ids.length}</span>
              <ButtonGroup><Button size="icon-sm" variant="outline" aria-label="Previous" onClick={() => step(-1)}><CaretLeftIcon /></Button><Button size="icon-sm" variant="outline" aria-label="Next" onClick={() => step(1)}><CaretRightIcon /></Button></ButtonGroup>
            </>}
          </div>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 gap-4">
          {panel(e.shot.url, `In the app${e.shot.revealedBy ? ` · after opening “${e.shot.revealedBy}”` : ""}`, e.shot.box)}
          {r?.systemShot && panel(r.systemShot, `${SYS} ${e.use || ""} ${r.key} · Storybook${r.sizeMissing ? " · default size (that size has no story)" : ""}`)}
        </div>
        {d && <div className="text-xs"><b className="font-medium">Rendered parity {Math.round(d.score * 100)}%</b><Dims bad={d.diffs.map((x: any) => `${x.label}: ${x.element} vs ${x.system}`)} ok={d.same} /></div>}
      </DialogContent>
    </Dialog>
  )
}

function Frame({ src, zoom, box, onClick }: { src: string; zoom: number; box?: any; onClick: () => void }) {
  const [w, setW] = React.useState<number | null>(null)
  return (
    <div className="relative shrink-0 cursor-zoom-in" style={w ? { width: (w / 2) * (zoom || 2), maxWidth: zoom ? undefined : "100%" } : undefined} onClick={onClick}>
      <img src={src} alt="" className="block w-full" onLoad={ev => setW((ev.target as HTMLImageElement).naturalWidth)} />
      <Ring b={box} />
    </div>
  )
}
