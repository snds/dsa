import * as React from "react"

/**
 * Just enough Markdown for agent replies: paragraphs, headings, lists, code blocks, inline code, bold,
 * italics, and https links. It builds React elements from text, so nothing in a reply is ever parsed
 * as HTML.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = []
  const lines = text.replace(/\r/g, "").split("\n")
  let i = 0, k = 0
  while (i < lines.length) {
    const l = lines[i]
    const fence = l.match(/^\s*```(\w*)/)
    if (fence) {
      const body: string[] = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i])
      i++
      blocks.push(<pre key={k++} className="my-2 overflow-auto rounded-md border bg-muted/50 p-2.5 font-mono text-xs leading-relaxed">{body.join("\n")}</pre>)
      continue
    }
    const h = l.match(/^(#{1,4})\s+(.*)/)
    if (h) { blocks.push(<p key={k++} className="mt-3 mb-1 font-heading text-sm font-semibold">{inline(h[2])}</p>); i++; continue }
    if (/^\s*([-*]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, "")
        for (i++; i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]); i++) item += " " + lines[i].trim()
        items.push(item)
      }
      const L = ordered ? "ol" : "ul"
      blocks.push(<L key={k++} className={`my-1.5 ml-5 space-y-1 ${ordered ? "list-decimal" : "list-disc"}`}>{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</L>)
      continue
    }
    if (!l.trim()) { i++; continue }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++])
    blocks.push(<p key={k++} className="my-1.5">{inline(para.join(" "))}</p>)
  }
  return <div className="text-sm leading-relaxed [&>*:first-child]:mt-0">{blocks}</div>
}

function inline(s: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https:\/\/[^)\s]+)\))/g
  let last = 0, m: RegExpExecArray | null, k = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const t = m[0]
    if (m[1]) out.push(<code key={k++} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{t.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k++} className="font-semibold">{t.slice(2, -2)}</strong>)
    else if (m[3]) out.push(<em key={k++}>{t.slice(1, -1)}</em>)
    else if (m[4]) out.push(<a key={k++} href={m[5]} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-4 hover:underline">{t.slice(1, t.indexOf("]"))}</a>)
    last = m.index + t.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
