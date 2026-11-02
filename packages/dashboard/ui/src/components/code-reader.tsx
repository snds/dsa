import * as React from "react"
import { ArrowSquareOutIcon, CaretLeftIcon, CaretRightIcon, CopyIcon } from "@phosphor-icons/react"
import { cn } from "cn"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Disclosure } from "@/components/bits"
import { D, api, copy } from "@/lib/dsa"

/**
 * Evidence as a list of places, each opening a code reader: the lines around the place with the
 * cited line marked, prev/next through the places, copy, and a link to the commit the scan read.
 * A published page carries the lines (excerpts captured at scan time); `dsa serve` reads the file.
 */

export interface Place { target?: string; file: string; line: number; col?: number; kind?: string; vendored?: boolean }
export interface SourceFile { repo?: string; ref?: string; rel: string; chunks: { start: number; lines: string[] }[]; total?: number }

/** Lines shown either side of a place. */
export const CONTEXT = 12

/**
 * The path worth reading: without the checkout folder a scan clones into ("<repo>-main/",
 * "<repo>-master/"), which is the same for every place in a repo.
 */
export function shortPath(file: string): string {
  return file.replace(/^[^/]+-(?:main|master|trunk|develop|default)\//, "")
}

// ── A small highlighter: comments, strings, keywords, numbers and JSX tags, in the theme's tokens. ──
const TOKENS = /(\/\/.*$|\/\*.*?\*\/|<!--.*?-->)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(<\/?[A-Za-z][\w.-]*|\/?>)|\b(import|export|from|default|const|let|var|function|return|if|else|for|while|class|extends|new|type|interface|async|await|true|false|null|undefined|this)\b|(\b\d+(?:\.\d+)?(?:px|rem|em|%)?\b)/g
// Tags take the primary color in light mode; on a dark background a chart token keeps them readable.
const TONE = ["text-muted-foreground italic", "text-success-soft-foreground", "text-primary dark:text-chart-2", "font-semibold text-foreground", "text-warning-soft-foreground"]

export function highlight(line: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let at = 0
  for (const m of line.matchAll(TOKENS)) {
    if (m.index! > at) out.push(line.slice(at, m.index))
    const kind = [1, 2, 3, 4, 5].findIndex(i => m[i] != null)
    out.push(<span key={m.index} className={TONE[kind]}>{m[0]}</span>)
    at = m.index! + m[0].length
  }
  if (at < line.length) out.push(line.slice(at))
  return out
}

/** Numbered, highlighted lines with [first, last] marked; the first marked line is scrolled into view. */
export function CodeLines({ src, first, last = first, around }: { src: SourceFile; first: number; last?: number; around?: number }) {
  const mark = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => { mark.current?.scrollIntoView({ block: "center" }) }, [src, first])
  const lo = around == null ? -Infinity : first - around, hi = around == null ? Infinity : last + around
  const chunks = src.chunks.map(c => {
    const from = Math.max(c.start, lo), to = Math.min(c.start + c.lines.length - 1, hi)
    return { start: from, lines: from > to ? [] : c.lines.slice(from - c.start, to - c.start + 1) }
  }).filter(c => c.lines.length)
  if (!chunks.length) return <p className="p-4 text-muted-foreground">Line {first} isn't in the lines this page carries.</p>
  return (
    <>
      {chunks.map((c, ci) => (
        <React.Fragment key={c.start}>
          {ci > 0 && <div className="border-y border-dashed px-3 py-1 text-muted-foreground select-none">⋯ lines {chunks[ci - 1]!.start + chunks[ci - 1]!.lines.length}–{c.start - 1} not shown</div>}
          {c.lines.map((t, i) => {
            const n = c.start + i, on = n >= first && n <= last
            return (
              <div key={n} ref={n === first ? mark : undefined} data-line={n} aria-current={on ? "true" : undefined} className={cn("grid grid-cols-[3.5rem_1fr]", on && "bg-primary/10")}>
                <span className={cn("pr-3 text-right text-muted-foreground tabular-nums select-none", on && "border-l-2 border-primary text-foreground")}>{n}</span>
                <code className="pr-4 whitespace-pre">{t ? highlight(t) : " "}</code>
              </div>
            )
          })}
        </React.Fragment>
      ))}
    </>
  )
}

/** The lines for a place: carried in the page, or read by `dsa serve`. */
function useSource(p: Place | undefined): SourceFile | null | "loading" {
  const carried = (f: string) => D.evidenceSources?.[f] ?? D.elements?.sources?.[f] ?? null
  const [src, setSrc] = React.useState<SourceFile | null | "loading">(null)
  React.useEffect(() => {
    if (!p) return
    if (!D.serve) { setSrc(carried(p.file)); return }
    let live = true
    setSrc("loading")
    api(`/api/source?target=${encodeURIComponent(p.target ?? "")}&file=${encodeURIComponent(p.file)}`).then(s => live && setSrc(s), () => live && setSrc(carried(p.file)))
    return () => { live = false }
  }, [p?.file, p?.target])
  return src
}

/** "Open on GitHub" at the commit the scan read, never the moving branch. */
export const commitUrl = (src: SourceFile, line: number) => (src.repo && src.ref && /^[0-9a-f]{7,40}$/.test(src.ref) ? `https://github.com/${src.repo}/blob/${src.ref}/${src.rel}#L${line}` : null)

export function CodeReader({ places, index, onIndex, onClose }: { places: Place[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const p = places[index]
  const src = useSource(p)
  if (!p) return null
  const n = places.length
  const step = (d: number) => onIndex((index + d + n) % n)
  const url = src && src !== "loading" ? commitUrl(src, p.line) : null
  const where = `${shortPath(p.file)}:${p.line}`
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent
        className="flex max-h-[90vh] w-[96vw] max-w-4xl flex-col sm:max-w-4xl"
        onKeyDown={e => {
          if (n < 2 || (e.target as HTMLElement).closest("input, textarea")) return
          if (e.key === "ArrowRight" || e.key === "j") { e.preventDefault(); step(1) }
          if (e.key === "ArrowLeft" || e.key === "k") { e.preventDefault(); step(-1) }
        }}
      >
        <DialogHeader className="pr-10">
          <DialogTitle className="font-mono text-sm break-all">{where}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            {n > 1 && <span>Place {index + 1} of {n}</span>}
            {p.kind && <Badge variant="outline" className="font-mono">{p.kind}</Badge>}
            {p.vendored && <Badge variant="secondary">Vendored: not this team's code</Badge>}
            {shortPath(p.file) !== p.file && <span className="font-mono text-xs">{p.file}</span>}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/30 font-mono text-xs leading-5" tabIndex={0} aria-label={`Source around ${where}`}>
          {src === "loading" ? <p className="p-4 text-muted-foreground">Reading the file…</p>
            : !src ? <p className="p-4 text-muted-foreground">These lines aren't in this page (the file is outside what the scan may show, or too far down the list). Open it in your editor, or run <code>dsa serve</code> to read it here.</p>
            : <CodeLines src={src} first={p.line} around={CONTEXT} />}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">{src && src !== "loading" && src.ref ? `As of commit ${src.ref.slice(0, 7)}.` : ""}{n > 1 ? " ← → or J K to step through." : ""}</span>
          <div className="flex flex-wrap gap-2">
            {n > 1 && <>
              <Button variant="outline" onClick={() => step(-1)} aria-label="Previous place"><CaretLeftIcon data-icon="inline-start" />Previous</Button>
              <Button variant="outline" onClick={() => step(1)} aria-label="Next place">Next<CaretRightIcon data-icon="inline-end" /></Button>
            </>}
            <Button variant="outline" onClick={() => copy(where, "Copied")}><CopyIcon data-icon="inline-start" />Copy path:line</Button>
            {url && <Button nativeButton={false} render={<a href={url} target="_blank" rel="noopener noreferrer" />}><ArrowSquareOutIcon data-icon="inline-start" />Open on GitHub</Button>}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * An action's evidence: its sentence, then "N places" folded. Open, one row per place (short path,
 * line, what's there, vendored marked); each opens the code reader. Without places (older reports),
 * the evidence text as it was.
 */
export function Evidence({ text, summary, places }: { text: string; summary?: string; places?: Place[] }) {
  const [at, setAt] = React.useState<number | null>(null)
  if (!places?.length) return <span className="break-words">{text}</span>
  const vendored = places.filter(p => p.vendored).length
  return (
    <div className="flex flex-col gap-1">
      {summary && <span>{summary}</span>}
      <Disclosure label={`${places.length} place${places.length === 1 ? "" : "s"}`} hint={vendored ? `${vendored} vendored` : undefined} className="border-t-0 pt-0">
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Places">
          {places.map((p, i) => (
            <li key={`${p.file}:${p.line}:${i}`}>
              <button type="button" onClick={() => setAt(i)} className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring" title={p.file}
                aria-label={`Open ${shortPath(p.file)} line ${p.line}${p.kind ? `, ${p.kind}` : ""}${p.vendored ? ", vendored" : ""}`} aria-haspopup="dialog">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{shortPath(p.file)}<span className="text-muted-foreground">:{p.line}</span></span>
                {p.kind && <Badge variant="outline" className="shrink-0 font-mono text-[11px]">{p.kind}</Badge>}
                {p.vendored && <Badge variant="secondary" className="shrink-0" title="Vendored or third-party code: not this team's to fix">Vendored</Badge>}
              </button>
            </li>
          ))}
        </ul>
      </Disclosure>
      {at != null && <CodeReader places={places} index={at} onIndex={setAt} onClose={() => setAt(null)} />}
    </div>
  )
}
