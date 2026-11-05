import * as React from "react"
import { cn } from "cn"
import { ImageBrokenIcon } from "@phosphor-icons/react"

/** Screenshots and renders are taken at 2 device pixels per CSS pixel: drawn at half, they're their real size. */
export const DPR = 2
/** Room kept around the element in the app photo, like the render's own padding. */
const MARGIN = 6

interface Box { x: number; y: number; w: number; h: number; cw: number; ch: number }

/**
 * The element as the app draws it beside the proposal as Storybook draws it, both at their real CSS
 * size, so height, padding and type compare by eye. The photo is cropped to the element (its context
 * is one click away in the zoom view). Too wide for the card, a pane scrolls rather than shrinks.
 */
export function SameScale({ app, proposed, appLabel, proposedLabel }: {
  app: { url: string; box?: Box | null; alt: string; onOpen?: () => void }
  /** undefined: no proposal to compare (gap, keep); null: there should be one and there isn't. */
  proposed?: { url: string; alt: string } | null
  appLabel: React.ReactNode
  proposedLabel?: React.ReactNode
}) {
  return (
    // One above the other, left-aligned: edges line up, and a wide element doesn't push its pair away.
    <div className="flex min-w-0 flex-col items-start gap-2" data-slot="same-scale">
      <Pane label={appLabel} kind="app">
        <button type="button" onClick={app.onOpen} disabled={!app.onOpen} className="block enabled:cursor-zoom-in" aria-label="Open the screenshot with its surroundings">
          <Crop url={app.url} box={app.box} alt={app.alt} />
        </button>
      </Pane>
      {proposed !== undefined && (
        <Pane label={proposedLabel} kind="proposed">
          {proposed ? <Natural url={proposed.url} alt={proposed.alt} />
            : <span className="grid h-12 w-40 place-items-center rounded-md border border-dashed text-[11px] text-muted-foreground"><span className="flex items-center gap-1"><ImageBrokenIcon />No rendering</span></span>}
        </Pane>
      )}
    </div>
  )
}

function Pane({ label, kind, children }: { label: React.ReactNode; kind: "app" | "proposed"; children: React.ReactNode }) {
  return (
    <div className="flex max-w-full min-w-0 flex-col gap-1" data-pane={kind}>
      <div className="w-fit max-w-full overflow-x-auto rounded-md border bg-background p-1">{children}</div>
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}

/** The element and a small margin, cut from the screenshot at real size, with its box ringed. */
export function Crop({ url, box, alt }: { url: string; box?: Box | null; alt: string }) {
  if (!box) return <Natural url={url} alt={alt} />
  const x = Math.max(0, box.x - MARGIN), y = Math.max(0, box.y - MARGIN)
  const w = Math.min(box.cw - x, box.w + MARGIN * 2), h = Math.min(box.ch - y, box.h + MARGIN * 2)
  return (
    <span className="relative block overflow-hidden" style={{ width: w, height: h }} data-scale="1">
      <img src={url} alt={alt} loading="lazy" className="absolute max-w-none" style={{ left: -x, top: -y, width: box.cw, height: box.ch }} />
      <span className="pointer-events-none absolute rounded-[3px] outline-2 outline-offset-2 outline-primary/70" style={{ left: box.x - x, top: box.y - y, width: box.w, height: box.h }} />
    </span>
  )
}

/** An image at its real CSS size (its pixels over the capture's device pixel ratio). */
export function Natural({ url, alt }: { url: string; alt: string }) {
  const [w, setW] = React.useState<number | null>(null)
  return <img src={url} alt={alt} loading="lazy" data-scale="1" className={cn("block max-w-none", !w && "max-h-24")} style={w ? { width: w / DPR } : undefined} onLoad={ev => setW((ev.target as HTMLImageElement).naturalWidth)} />
}

/**
 * The element where it sits: the whole capture around it at its real size, the element ringed, with the
 * page it was on in plain words. A capture is a margin around the element, not the full page.
 */
export function InContext({ url, box, alt, page }: { url: string; box?: Box | null; alt: string; page: string }) {
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1" data-slot="in-context">
      <div className="w-fit max-w-full overflow-x-auto rounded-md border bg-background p-1">
        <span className="relative block" style={box ? { width: box.cw, height: box.ch } : undefined} data-scale="1">
          <img src={url} alt={alt} loading="lazy" className={cn("block max-w-none", box && "absolute inset-0")} style={box ? { width: box.cw, height: box.ch } : undefined} />
          {box && <span className="pointer-events-none absolute rounded-[3px] outline-2 outline-offset-2 outline-primary" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
        </span>
      </div>
      <figcaption className="text-[11px] text-muted-foreground">In context, on {page}</figcaption>
    </figure>
  )
}
