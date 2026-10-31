import * as React from "react"
import { cn } from "cn"
import { MagnifyingGlassIcon, StarIcon, WarningIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldLabel } from "@/components/ui/field"
import { Code, Note, Pre } from "@/components/bits"
import { D, api, at, pct100, say, short } from "@/lib/dsa"
import { desc, useEl } from "./shared"

/**
 * Component picker: any system component, every prop it has (variant axes with how well each option fits
 * the elements, plus what its stories declare), what each instance keeps (label, icons), a live preview
 * of the first instance in Storybook, and the JSX each instance becomes. "Use" records the choice.
 */
const AXIS_SKIP = /^(children|className|class|style|asChild|ref|key|as|render)$|^on[A-Z]/
const G: any = (window as any).__dsaPicker ??= {}

/**
 * Called when the app loads (served only): the server already started Storybook in the background,
 * this waits for it and keeps the result, so the picker opens with previews ready.
 */
export function warmStorybook(): Promise<any> {
  if (G.sb) return Promise.resolve(G.sb)
  G.sbPromise ??= api("/api/storybook", {}).then((r: any) => { G.sb = r; return r }, (e: any) => { G.sbPromise = null; throw e })
  return G.sbPromise
}
type Content = { label: string; leading: string; trailing: string; iconSize: string }

export function Picker({ target, onClose }: { target: { ids: string[]; pattern?: string | null }; onClose: () => void }) {
  const { byId, applyLocal, refresh } = useEl()
  const items = target.ids.map(id => byId.get(id)).filter(Boolean)
  const first = items[0]
  const prior = first.decided?.decision?.verdict === "replace" ? first.decided.decision : null
  const suggested = [...new Set<string>([prior?.use, first.use, ...first.alternatives.map((a: any) => a.use)].filter(Boolean))]

  const [comps, setComps] = React.useState<any[] | null>(G.comps ?? null)
  const [loadErr, setLoadErr] = React.useState("")
  const [sb, setSb] = React.useState<any>(G.sb ?? null)
  const [sbBusy, setSbBusy] = React.useState(false)
  const [q, setQ] = React.useState("")
  const [comp, setComp] = React.useState<any>(null)
  const [props, setProps] = React.useState<Record<string, string>>({})
  const [args, setArgs] = React.useState<Record<string, string>>({})
  const [setByUser, setSetByUser] = React.useState<Set<string>>(new Set())
  const [content, setContent] = React.useState<Content>({ label: "source", leading: "source", trailing: "source", iconSize: "component" })
  const [custom, setCustom] = React.useState({ label: "", leading: "", trailing: "" })
  const [story, setStory] = React.useState("")
  const [fit, setFit] = React.useState<any>(null)
  const [maps, setMaps] = React.useState<any>(null)
  const [described, setDescribed] = React.useState<any>(null)
  const [preview, setPreview] = React.useState<{ helper: boolean; jsx: boolean | null; icons: any; error?: string }>({ helper: false, jsx: null, icons: null })
  const [note, setNote] = React.useState("")
  const frame = React.useRef<HTMLIFrameElement>(null)

  React.useEffect(() => {
    if (comps) { pick(comps.find(c => c.component === (prior?.use ?? first.use)) ?? comps.find(c => c.component === suggested[0]) ?? null); return }
    api("/api/components").then(r => { G.comps = r.components; G.icons = r.icons ?? []; setComps(r.components); pick(r.components.find((c: any) => c.component === (prior?.use ?? first.use)) ?? r.components.find((c: any) => c.component === suggested[0]) ?? null) }, e => setLoadErr(e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** Seed from the recorded decision, or the evaluator's pick, for the component being shown. */
  function pick(c: any) {
    setComp(c)
    const p: Record<string, string> = {}, a: Record<string, string> = {}, user = new Set<string>()
    const ct: Content = { label: "source", leading: "source", trailing: "source", iconSize: "component" }
    const cu = { label: "", leading: "", trailing: "" }
    for (const ax of Object.keys(c?.axes ?? {})) p[ax] = c.defaults?.[ax] ?? c.axes[ax][0]
    const src = !c ? null : prior?.use === c.component ? prior : first.use === c.component ? first : null
    if (src?.props) for (const [k, v] of Object.entries<string>(src.props)) { if (c.axes?.[k]) { p[k] = v; user.add(k) } else a[k] = v }
    if (src?.content) for (const k of ["label", "leading", "trailing"] as const) { const v = src.content[k]; if (v && typeof v === "object") { ct[k] = "custom"; cu[k] = v.text ?? v.icon ?? "" } else if (v) ct[k] = v }
    if (src?.content?.iconSize) ct.iconSize = src.content.iconSize
    setProps(p); setArgs(a); setSetByUser(user); setContent(ct); setCustom(cu); setFit(null); setMaps(null); setDescribed(null); setStory("")
  }

  const typed = (v: string) => (v === "true" ? true : v === "false" ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v)
  const contentSpec = () => {
    const o: any = {}
    for (const k of ["label", "leading", "trailing"] as const) o[k] = content[k] === "custom" ? (k === "label" ? { text: custom[k] } : { icon: custom[k] }) : content[k]
    o.iconSize = content.iconSize
    return o
  }
  const decisionNow = () => ({
    verdict: "replace", role: "picked", use: comp.component, from: comp.from,
    props: { ...Object.fromEntries(Object.entries(props).filter(([k, v]) => v !== comp.defaults?.[k])), ...Object.fromEntries(Object.entries(args).filter(([, v]) => v !== "" && v != null).map(([k, v]) => [k, String(v)])) },
    content: contentSpec(),
  })
  const label = comp ? `${comp.component}${Object.entries(decisionNow().props).map(([k, v]) => ` ${k}="${v}"`).join("")}` : ""
  const hasContent = (c: any) => !!c && (/^(button|a|span|label)$/.test(c.tag || "") || /button|badge|chip|tab|link|toggle|menu.*item/i.test(c.component))

  // Stories: args-driven ones first (Playground, Default); a gallery story ignores the controls.
  const storiesFor = (c: any) => {
    if (!c) return []
    let ids: string[] = c.stories ?? []
    const pref = (id: string) => { const n = (sb?.stories.find((s: any) => s.id === id)?.name ?? id).toLowerCase(); return /playground|interactive/.test(n) ? 0 : /default|basic|primary/.test(n) ? 1 : /all|variants|sizes|gallery|matrix/.test(n) ? 3 : 2 }
    if (sb) { const stem = (c.file || "").replace(/\.tsx$/, ""); const own = sb.stories.filter((s: any) => (s.importPath || "").split("/").pop().replace(/\.stories\.tsx?$/, "") === stem && !/\.shadcn$/.test((s.importPath || "").replace(/\.stories\.tsx?$/, ""))).map((s: any) => s.id); if (own.length) ids = own }
    return [...ids].sort((a, b) => pref(a) - pref(b))
  }
  const stories = storiesFor(comp)
  // No story of its own: render the component directly over a host story (dev Storybook only).
  const direct = !!(sb?.harness && comp?.abs && !stories.length)
  const hostStory = () => { const all = sb?.stories ?? []; return (all.find((s: any) => /--default$/.test(s.id)) ?? all[0])?.id ?? "" }
  const storyId = direct ? hostStory() : stories.includes(story) ? story : stories[0] ?? ""
  const storyName = (id: string) => sb?.stories.find((s: any) => s.id === id)?.name ?? id.split("--").pop()

  // ---- fit and mapping, refreshed as the choice changes
  const seq = React.useRef({ fit: 0, map: 0 })
  React.useEffect(() => {
    if (!comp || !Object.keys(comp.axes ?? {}).length) { setFit(undefined); return }
    const n = ++seq.current.fit
    const t = setTimeout(() => api("/api/fit", { ids: target.ids, component: comp.component, current: props }).then(f => {
      if (n !== seq.current.fit) return
      setFit(f)
      // Axes the user hasn't set take the closest fit.
      const moved = Object.entries<string>(f.best ?? {}).filter(([a, b]) => !setByUser.has(a) && props[a] !== b)
      if (moved.length) setProps(p => ({ ...p, ...Object.fromEntries(moved) }))
    }, () => setFit(undefined)), 150)
    return () => clearTimeout(t)
  }, [comp, JSON.stringify(props), setByUser]) // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!comp) return
    const n = ++seq.current.map
    const t = setTimeout(() => api("/api/mapping", { ids: target.ids, decision: decisionNow() }).then(r => { if (n === seq.current.map) setMaps(r) }, () => setMaps({ mappings: [], clean: 0, check: 0 })), 300)
    return () => clearTimeout(t)
  }, [comp, JSON.stringify(props), JSON.stringify(args), JSON.stringify(content), JSON.stringify(custom)]) // eslint-disable-line react-hooks/exhaustive-deps

  const shared = React.useMemo(() => { const ms = maps?.mappings ?? []; return ms.length < 2 ? [] : ms[0].flags.filter((f: string) => ms.every((x: any) => x.flags.includes(f))) }, [maps])
  const own = (x: any) => x.flags.filter((f: string) => !shared.includes(f))
  const status = (x: any) => (x.status === "unreadable" ? "unreadable" : own(x).length ? "check" : "clean")
  const nCheck = (maps?.mappings ?? []).filter((x: any) => status(x) !== "clean").length
  const hadSummary = (which: "leading" | "trailing") => {
    if (!maps) return ""
    const m = new Map<string, number>()
    for (const x of maps.mappings) { const v = x.had?.[which] || "none"; m.set(v, (m.get(v) ?? 0) + 1) }
    return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(", ")
  }
  // The source icons, as glyphs, under "From each element".
  const sourceIcons = (which: "leading" | "trailing") => {
    const m = new Map<string, number>()
    for (const x of maps?.mappings ?? []) { const v = x.had?.[which]; if (v) m.set(v, (m.get(v) ?? 0) + 1) }
    if (!m.size) return null
    return <div className="flex flex-wrap gap-1.5">{[...m].map(([n, c]) => <span key={n} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs" title={n}><Glyph name={n} />{n}{c > 1 && <span className="text-muted-foreground">×{c}</span>}</span>)}</div>
  }
  // The preview shows the first instance, with its own label and icons unless overridden.
  const previewContent = () => {
    const had = maps?.mappings?.[0]?.had ?? {}
    const plain = (s: string) => (!s ? "" : /[{<]/.test(s) ? first.match?.text || "Label" : s)
    const ic = (k: "leading" | "trailing") => (content[k] === "none" ? null : content[k] === "custom" ? custom[k] || null : had[k] || null)
    return { label: content.label === "custom" ? custom.label : plain(had.label) || (first.match?.text ?? ""), leading: ic("leading"), trailing: ic("trailing") }
  }

  // ---- live preview: a small helper in the proxied Storybook iframe answers these messages
  const post = (m: any) => frame.current?.contentWindow?.postMessage({ dsa: 1, from: "report", ...m }, "*")
  const sent = React.useRef<string[]>([])
  const pushArgs = () => {
    if (!sb || !storyId) return
    const a = Object.fromEntries([...Object.entries(props), ...Object.entries(args).filter(([, v]) => v !== "")].map(([k, v]) => [k, typed(String(v))]))
    if (direct) { if (preview.helper) post({ type: "mount", harness: sb.harness, module: sb.fsBase + comp.abs, exportName: comp.component, args: a, content: hasContent(comp) ? previewContent() : null, iconModule: sb.iconModule }); return }
    if (preview.helper) { post({ type: "args", storyId, args: a, content: hasContent(comp) ? previewContent() : null, iconModule: sb.iconModule }); return }
    // No helper (a Storybook without the proxy): Storybook's own channel, props only.
    const send = (type: string, x: any) => frame.current?.contentWindow?.postMessage(JSON.stringify({ key: "storybook-channel", event: { type, from: "manager", args: [x] } }), "*")
    const gone = sent.current.filter(k => !(k in a))
    if (gone.length) send("resetStoryArgs", { storyId, argNames: gone })
    send("updateStoryArgs", { storyId, updatedArgs: a })
    sent.current = Object.keys(a)
  }
  const latest = React.useRef(pushArgs)
  latest.current = pushArgs
  React.useEffect(() => {
    const on = (ev: MessageEvent) => {
      const d = ev.data
      if (d && d.dsa === 1 && d.from === "preview") {
        if (d.type === "hello") { setPreview(p => ({ ...p, helper: true })); if (!direct) post({ type: "describe", storyId }) }
        if (d.type === "mounted") setPreview(p => ({ ...p, error: undefined, jsx: true }))
        if (d.type === "described" && d.storyId === storyId) setDescribed(d)
        if (d.type === "applied") setPreview(p => ({ ...p, jsx: d.jsx, icons: d.icons }))
        if (d.type === "error") setPreview(p => ({ ...p, error: d.message }))
        return
      }
      let x = d; try { x = typeof d === "string" ? JSON.parse(d) : d } catch { return }
      if (x?.key === "storybook-channel" && /storyRendered/.test(x.event?.type ?? "")) latest.current()
    }
    addEventListener("message", on); return () => removeEventListener("message", on)
  }, [storyId, direct]) // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { pushArgs() }, [preview.helper, described, JSON.stringify(props), JSON.stringify(args), JSON.stringify(content), JSON.stringify(custom), maps]) // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { setPreview({ helper: false, jsx: null, icons: null }); setDescribed(null); sent.current = [] }, [storyId, sb?.url, direct ? comp?.component : ""])

  // Storybook is warmed when the app loads (warmStorybook); the picker just waits for it.
  const [sbErr, setSbErr] = React.useState<string | null>(null)
  function startSb() {
    if (!D.serve || G.sb) return
    setSbBusy(true); setSbErr(null)
    warmStorybook().then(r => setSb(r), (e: any) => setSbErr(e.message)).finally(() => setSbBusy(false))
  }
  React.useEffect(() => { startSb() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  async function record(decision: any) {
    try {
      const r = await api("/api/decide", { ...(target.pattern ? { pattern: target.pattern } : { ids: target.ids }), decision, note: note || undefined })
      applyLocal(target.pattern ? D.elements.evals.filter((e: any) => e.styleKey === target.pattern || e.styleSig === target.pattern).map((e: any) => e.id) : target.ids, r.decided)
      say(`Recorded for ${r.recorded} element(s): ${desc(decision)}`)
      onClose(); refresh()
    } catch (e: any) { say(e.message, true) }
  }

  // ---- controls
  const fitText = (axis: string, o: string) => {
    if (!fit) return ""
    const f = fit.axes?.[axis]?.[o]
    if (!f) return " — not measured"
    if (f.note) return ` — ${f.note}`
    return ` — ${pct100(f.score)} fit${f.height ? `, ${Math.round(f.height)}px tall` : ""}${fit.best[axis] === o ? " ★ closest" : ""}`
  }
  const argControls = () => {
    if (sb && !stories.length) return <Note className="text-xs">{comp.component} has no story, so Storybook documents no other props for it.</Note>
    if (!described) return <Note className="text-xs">{sb ? "Reading props from Storybook…" : "More props (booleans, text, other options) load from Storybook with the live preview."}</Note>
    const rows: React.ReactNode[] = []
    for (const [name, at] of Object.entries<any>(described.argTypes ?? {})) {
      if (comp.axes?.[name] || AXIS_SKIP.test(name) || at?.table?.disable || at?.control === false) continue
      const ctype = (typeof at.control === "string" ? at.control : at.control?.type) || at.type?.name || ""
      let opts: string[] | null = at.options ?? (Array.isArray(at.type?.value) ? at.type.value.map((v: any) => (typeof v === "object" ? v.value ?? v.name : v)) : null)
      if (opts) opts = opts.map(o => String(o).replace(/^["']|["']$/g, ""))
      const cur = args[name] ?? ""
      const setArg = (v: string) => setArgs(a => { const n = { ...a }; if (v === "") delete n[name]; else n[name] = v; return n })
      const choices = /bool/.test(ctype) ? ["true", "false"] : opts?.length ? opts : null
      rows.push(
        <Field key={name}>
          <FieldLabel title={at.description}>{name}</FieldLabel>
          {choices ? (
            <NativeSelect className="w-full" value={String(cur)} onChange={e => setArg(e.target.value)}>
              <NativeSelectOption value="">(default)</NativeSelectOption>
              {choices.map(v => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}
            </NativeSelect>
          ) : /number|range/.test(ctype) ? <Input type="number" value={cur} onChange={e => setArg(e.target.value)} /> : /text|string/.test(ctype) ? <Input value={cur} placeholder="(default)" onChange={e => setArg(e.target.value)} /> : null}
        </Field>,
      )
    }
    return rows.length ? rows : <Note className="text-xs">No other props in its stories.</Note>
  }
  const m = fit?.measured
  const bs = fit?.best?.size, bf = bs && fit.axes.size?.[bs]

  if (loadErr) return <Dialog open onOpenChange={o => !o && onClose()}><DialogContent><DialogTitle>Couldn't load components</DialogTitle><Note>{loadErr}</Note></DialogContent></Dialog>
  const sug = comps ? suggested.map(n => comps.find(x => x.component === n)).filter(Boolean) : []
  const list = comps ? comps.filter(x => !q || x.component.toLowerCase().includes(q.toLowerCase()) || (x.from || "").includes(q)) : []
  const row = (x: any) => (
    <button key={x.component} type="button" onClick={() => pick(x)} className={cn("flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-muted", comp?.component === x.component && "bg-primary/10")}>
      <span className="text-sm font-medium">{x.component}</span><span className="text-xs text-muted-foreground">{x.from}</span>
    </button>
  )

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-[1320px] flex-col gap-0 p-0 sm:max-w-[1320px]">
        <DialogHeader className="border-b px-4 py-3 pr-12">
          <DialogTitle>Replace &lt;{first.element}&gt;</DialogTitle>
          <DialogDescription>{short(first.file)}:{first.line}{items.length > 1 && ` and ${items.length - 1} more`}{target.pattern && ` · pattern ${target.pattern}`}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 md:grid-cols-[230px_320px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r">
            <div className="relative p-2"><MagnifyingGlassIcon className="absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-8" placeholder="Search components" value={q} onChange={e => setQ(e.target.value)} /></div>
            <ScrollArea className="min-h-0 flex-1"><div className="flex flex-col gap-0.5 p-2 pt-0">
              {!comps ? <Note className="p-2 text-xs">Loading components…</Note> : <>
                {sug.length > 0 && !q && <><p className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Suggested</p>{sug.map(row)}<p className="px-2 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">All components</p></>}
                {list.map(row)}
              </>}
            </div></ScrollArea>
          </aside>

          <ScrollArea className="min-h-0 border-r"><div className="flex flex-col gap-4 p-4">
            {!comp ? <Note>Pick a component.</Note> : <>
              <div><p className="font-medium">{comp.component}</p><p className="text-xs text-muted-foreground">{comp.from}</p></div>
              {fit === null ? <Note className="text-xs">Measuring fit…</Note> : m && (
                <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                  {m.from === "rendered"
                    ? <p><b className="font-medium text-foreground">Source, as rendered</b> {[m.height != null && `${m.height}px tall`, m.paddingX != null && `${m.paddingX}px side padding`, m.fontSize != null && `${m.fontSize}px text`, m.radius != null && `${m.radius}px radius`].filter(Boolean).join(" · ")} ({m.own === m.shared ? `${m.own} measured` : `${m.own} measured, shared with ${m.shared - m.own} identically styled`})</p>
                    : <p><b className="font-medium text-foreground">Source, from its classes</b> {m.text} (no screenshot measured, so fit is read from classes)</p>}
                  {bf && bf.score < 0.7 && <div className="flex gap-2 rounded-md border border-warning-soft-border bg-warning-soft p-2 text-foreground"><WarningIcon className="mt-0.5 size-4 shrink-0 text-warning-soft-foreground" /><span>No size is close. The closest, <b>{bs}</b>{bf.height ? ` (${Math.round(bf.height)}px)` : ""}, still changes how these look: decide whether that's acceptable or the system needs a compact size.</span></div>}
                </div>
              )}
              <Section title="Props">
                {Object.keys(comp.axes ?? {}).map(k => (
                  <Field key={k}>
                    <FieldLabel>{k}{!setByUser.has(k) && fit?.best?.[k] && <Badge variant="secondary" className="ml-1 gap-1 font-normal"><StarIcon weight="fill" />closest fit</Badge>}</FieldLabel>
                    <NativeSelect className="w-full" value={props[k]} onChange={e => { setProps(p => ({ ...p, [k]: e.target.value })); setSetByUser(s => new Set(s).add(k)) }}>
                      {comp.axes[k].map((v: string) => <NativeSelectOption key={v} value={v}>{v}{k === "size" && ICON_ONLY.test(v) ? " (icon only)" : ""}{fitText(k, v)}</NativeSelectOption>)}
                    </NativeSelect>
                  </Field>
                ))}
                {!Object.keys(comp.axes ?? {}).length && <Note className="text-xs">No variant axes.</Note>}
                {argControls()}
              </Section>
              {hasContent(comp) && (
                <Section title="Content" hint="what each instance keeps">
                  <ContentField label="Label" value={content.label} onChange={v => setContent(c => ({ ...c, label: v }))} options={[["source", "From each element"], ["custom", "Same text for all…"]]} custom={content.label === "custom" ? <Input value={custom.label} placeholder="Label text for every instance" onChange={e => setCustom(c => ({ ...c, label: e.target.value }))} /> : null} />
                  {(["leading", "trailing"] as const).map(k => (
                    <ContentField key={k} label={k === "leading" ? "Leading icon" : "Trailing icon"} value={content[k]} onChange={v => setContent(c => ({ ...c, [k]: v }))}
                      options={[["source", `From each element${hadSummary(k) ? ` (${hadSummary(k)})` : ""}`], ["none", "None"], ["custom", "Same icon for all…"]]}
                      custom={content[k] === "custom" ? <IconPicker value={custom[k]} icons={G.icons ?? []} onChange={v => setCustom(c => ({ ...c, [k]: v }))} /> : null}
                      preview={content[k] === "source" && maps ? sourceIcons(k) : null} />
                  ))}
                  <ContentField label="Icon size" value={content.iconSize} onChange={v => setContent(c => ({ ...c, iconSize: v }))} options={[["component", `${comp.component} sizes icons (drops each icon's size)`], ["source", "Keep each icon's own size"]]} />
                </Section>
              )}
              {stories.length > 0 && (
                <Section title="Story">
                  <NativeSelect className="w-full" value={storyId} onChange={e => setStory(e.target.value)}>
                    {stories.map(id => <NativeSelectOption key={id} value={id}>{storyName(id)}{GALLERY.test(storyName(id) ?? "") ? " (fixed gallery: ignores these props)" : ""}</NativeSelectOption>)}
                  </NativeSelect>
                </Section>
              )}
            </>}
          </div></ScrollArea>

          <Tabs defaultValue="preview" className="min-h-0 gap-0 p-3">
            <TabsList variant="line">
              <TabsTrigger value="preview">Preview</TabsTrigger>
              <TabsTrigger value="instances">Instances {maps && <span className="ml-1 text-xs text-muted-foreground">{maps.mappings.length}{nCheck ? <> · <span className="text-destructive">{nCheck} to check</span></> : " · each maps cleanly"}{shared.length ? " · 1 decision for all" : ""}</span>}</TabsTrigger>
            </TabsList>
            <TabsContent value="preview" className="flex min-h-0 flex-col gap-2 pt-3">
              {comp && sb && !stories.length && !direct ? (
                <div className="flex flex-col gap-2">
                  <Note><b className="font-medium text-foreground">{comp.component}</b> has no story in Storybook, so there's nothing to preview.{sb.harness ? "" : " A static Storybook build can't render it directly; the dev server can."}</Note>
                </div>
              ) : comp && sb && storyId ? (
                <>
                  <iframe ref={frame} key={sb.url + storyId + (direct ? comp.component : "")} title="Live preview" src={`${sb.url}iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`} className="min-h-0 w-full flex-1 rounded-lg border bg-background"
                    onLoad={() => setTimeout(() => { if (!preview.helper) { setTimeout(pushArgs, 700); setTimeout(pushArgs, 2000) } }, 2500)} />
                  <p className="text-xs text-muted-foreground">{direct ? <>Rendered directly from <code className="font-mono">{comp.file}</code>: <b className="font-medium text-foreground">{comp.component}</b> has no story in Storybook, so this skips Storybook's decorators and any story-supplied props</> : <>Live from Storybook: <b className="font-medium text-foreground">{label}</b></>}{hasContent(comp) && (() => { const pc = previewContent(); return <>, showing the first instance's content{pc.leading ? ` (icon ${pc.leading})` : ""}.{preview.jsx === false ? " This Storybook couldn’t render the icon here; the label shows." : preview.icons === "glyph" && (pc.leading || pc.trailing) ? " No story exposes the Icon component, so the icon is drawn with the same glyph markup it renders." : ""}</> })()} {preview.error && <span className="text-destructive">{preview.error}</span>}</p>
                </>
              ) : comp ? (
                <div className="flex flex-col gap-3">
                  {Object.keys(comp.thumbs || {}).length ? (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
                      {Object.entries<string>(comp.thumbs).map(([k, u]) => (
                        <button key={k} type="button" className={cn("flex flex-col items-center gap-1 rounded-lg border bg-muted/40 p-2", k === `${props.variant ?? "default"}/${props.size ?? "default"}` && "border-primary ring-2 ring-primary/20")}
                          onClick={() => { const [v, z] = k.split("/"); setProps(p => ({ ...p, ...(comp.axes?.variant ? { variant: v } : {}), ...(comp.axes?.size ? { size: z } : {}) })); setSetByUser(s => new Set([...s, "variant", "size"])) }}>
                          <img src={u} alt={k} className="max-h-16 max-w-full object-contain" /><span className="font-mono text-[11px] text-muted-foreground">{k}</span>
                        </button>
                      ))}
                    </div>
                  ) : <Note>No measured renderings for this component.</Note>}
                  {!D.serve ? <Note className="text-xs">Live previews need <code className="font-mono">dsa serve</code>.</Note>
                    : sbErr ? <div className="flex flex-col gap-2"><Note className="text-xs text-destructive">Storybook didn't start: {sbErr}</Note><Button variant="outline" className="w-fit" onClick={startSb}>Try Again</Button></div>
                    : <Note className="text-xs">{sbBusy ? "Storybook is still starting in the background (the first start can take a minute). The live preview appears here when it's ready." : "Connecting to Storybook…"}</Note>}
                </div>
              ) : null}
            </TabsContent>
            <TabsContent value="instances" className="min-h-0 overflow-auto pt-3">
              {!maps ? <Note>Mapping each instance…</Note> : (
                <div className="flex flex-col gap-2">
                  <Note className="text-xs">{maps.mappings.length - nCheck} of {maps.mappings.length} map cleanly. Import <Code>{`{ ${comp?.component} }`}</Code> from <Code>{maps.from || comp?.from}</Code> (or the repo's ui/ wrap).</Note>
                  {shared.length > 0 && (
                    <div className="rounded-lg border border-l-4 border-l-warning p-3 text-xs">
                      <b className="font-medium">Applies to all {maps.mappings.length}:</b>
                      <ul className="mt-1 ml-4 list-disc space-y-0.5">{shared.map((f: string) => <li key={f}>{f}</li>)}</ul>
                    </div>
                  )}
                  {maps.mappings.map((x: any) => (
                    <Collapsible key={x.id} defaultOpen={status(x) !== "clean"} className="rounded-lg border px-3 py-2">
                      <CollapsibleTrigger className="flex w-full items-center gap-2 text-left text-xs">
                        <Badge variant={status(x) === "clean" ? "secondary" : "outline"} className={cn("uppercase", status(x) === "clean" ? "text-success-soft-foreground" : "border-warning-soft-border text-warning-soft-foreground")}>{status(x)}</Badge>
                        <Code>{short(x.file)}:{x.line}</Code>{own(x)[0] && <span className="truncate text-muted-foreground">{own(x)[0]}</span>}
                      </CollapsibleTrigger>
                      <CollapsibleContent className="flex flex-col gap-2 pt-2">
                        {own(x).length > 1 && <ul className="ml-4 list-disc text-xs">{own(x).slice(1).map((f: string) => <li key={f}>{f}</li>)}</ul>}
                        {x.jsx && <Pre>{x.jsx}</Pre>}
                        <p className="text-xs text-muted-foreground">{x.kept.length > 0 && `Kept: ${x.kept.join(", ")}. `}{x.dropped.length > 0 && `Dropped: ${x.dropped.join("; ")}.`}</p>
                      </CollapsibleContent>
                    </Collapsible>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
        <DialogFooter className="mx-0 mb-0 flex-row items-center gap-2 rounded-b-xl border-t px-4 py-3 sm:justify-end">
          <Input className="flex-1" placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} />
          <Button variant="outline" onClick={() => record({ verdict: "keep", role: first.role })}>Keep native</Button>
          <Button variant="outline" onClick={() => { const what = prompt("What is missing from the design system?", first.gap || ""); if (what !== null) record({ verdict: "gap", role: first.role, gap: what }) }}>Mark as system gap</Button>
          <Button disabled={!comp} onClick={() => record(decisionNow())}>Use {label}{nCheck ? ` (${nCheck} to check)` : ""}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}{hint && <span className="ml-1 font-normal tracking-normal normal-case">{hint}</span>}</h4>
      {children}
    </div>
  )
}

function ContentField({ label, value, onChange, options, custom, preview }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; custom?: React.ReactNode; preview?: React.ReactNode }) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <NativeSelect className="w-full" value={value} onChange={e => onChange(e.target.value)}>{options.map(([v, t]) => <NativeSelectOption key={v} value={v}>{t}</NativeSelectOption>)}</NativeSelect>
      {preview}
      {custom}
    </Field>
  )
}

// Sizes that drop the label (icon, icon-sm, toolbar-icon…): icon buttons are a size, not a variant.
const ICON_ONLY = /(^|-)icon($|-)/
// Stories that render a fixed set (All Variants, All Sizes) and so ignore the props set here.
const GALLERY = /\b(all|gallery|matrix|showcase)\b|variants|sizes/i

/**
 * The design system's icon font (Material Symbols). `dsa serve` sends it from the host repo's
 * node_modules; if that fails (an older server, no font installed), Google's copy is the fallback.
 * Until a font is ready, glyphs show as a placeholder rather than their names in a text font.
 */
type FontState = "loading" | "ok" | "fail"
let fontState: FontState | null = null
const fontSubs = new Set<(s: FontState) => void>()
const FAMILY = '"DSA Icons", "Material Symbols Outlined Variable", "Material Symbols Outlined"'
// document.fonts.check() answers true for a family it has never heard of, so look for a loaded face instead.
const ready = () => { try { return [...(document.fonts as any)].some((f: FontFace) => /^"?(DSA Icons|Material Symbols Outlined)"?$/.test(f.family) && f.status === "loaded") } catch { return false } }
/** Start loading the icon font. Called when the app loads (served), so the picker opens with glyphs ready. */
export function preloadIconFont() {
  if (fontState === "loading" || fontState === "ok" || !D.serve) return
  fontState = "loading"
  const done = (s: FontState) => { fontState = s; fontSubs.forEach(f => f(s)) }
  const local = new FontFace("DSA Icons", `url(${at("/fonts/icons.woff2")})`, { display: "block" })
  local.load().then(f => { (document.fonts as any).add(f); done("ok") }, () => {
    // Google Fonts: the same Material Symbols font, by its own family name.
    const fallback = () => document.fonts.load('24px "Material Symbols Outlined"', "home").then(f => done(f.length ? "ok" : "fail"), () => done("fail"))
    if (document.getElementById("dsa-icon-font")) return fallback()
    const l = document.createElement("link")
    l.id = "dsa-icon-font"; l.rel = "stylesheet"
    l.href = "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200"
    l.onload = fallback; l.onerror = () => done("fail")
    document.head.appendChild(l)
  })
}
function useIconFont(): FontState {
  const [s, set] = React.useState<FontState>(fontState === "ok" || ready() ? "ok" : "loading")
  React.useEffect(() => {
    fontSubs.add(set)
    // A failed load is retried the next time a glyph mounts (the server may have been restarted since).
    if (fontState === null || fontState === "fail") preloadIconFont()
    if (fontState === "ok" || ready()) set("ok")
    // Belt and braces: if the font becomes usable by any route, show it without waiting for a re-render.
    const t = setInterval(() => { if (fontState === "ok" || ready()) { set("ok"); clearInterval(t) } else if (fontState === "fail") { set("fail"); clearInterval(t) } }, 300)
    return () => { fontSubs.delete(set); clearInterval(t) }
  }, [])
  return s
}
export function Glyph({ name, size = 18 }: { name: string; size?: number }) {
  const st = useIconFont()
  if (st === "loading") return <span aria-hidden className="inline-block shrink-0 animate-pulse rounded-sm bg-muted" style={{ width: size, height: size }} />
  if (st === "fail") return <span className="inline-block max-w-full truncate font-mono text-[10px] text-muted-foreground">{name}</span>
  return <span aria-hidden className="inline-block shrink-0 overflow-hidden text-center leading-none select-none" style={{ fontFamily: FAMILY, fontSize: size, width: size, height: size, fontFeatureSettings: '"liga"', fontVariationSettings: '"FILL" 0, "wght" 400, "opsz" 20', whiteSpace: "nowrap", fontWeight: 400, fontStyle: "normal" }}>{name}</span>
}

/** Pick an icon by sight: search the design system's icon names, see each glyph. */
function IconPicker({ value, icons, onChange }: { value: string; icons: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = React.useState(!value)
  const [q, setQ] = React.useState("")
  const list = React.useMemo(() => { const t = q.trim().toLowerCase().replace(/\s+/g, "_"); return (t ? icons.filter(n => n.includes(t)).sort((a, b) => (a.startsWith(t) ? 0 : 1) - (b.startsWith(t) ? 0 : 1) || a.length - b.length) : icons).slice(0, 240) }, [q, icons])
  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex h-9 w-full items-center gap-2 rounded-lg border bg-transparent px-2.5 text-left text-sm hover:bg-muted/50">
        {value ? <><Glyph name={value} size={20} /><span className="flex-1 truncate font-mono text-xs">{value}</span></> : <span className="flex-1 text-muted-foreground">Choose an icon…</span>}
        <span className="text-xs text-muted-foreground">{open ? "Close" : "Change"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 rounded-lg border p-2">
          <Input autoFocus value={q} placeholder={`Search ${icons.length.toLocaleString()} icons`} onChange={e => setQ(e.target.value)} />
          {!icons.length ? <Note className="text-xs">No icon names found in the design system's icon catalog.</Note> : (
            <div className="grid max-h-64 grid-cols-6 gap-1 overflow-auto">
              {list.map(n => (
                <button key={n} type="button" title={n} onClick={() => { onChange(n); setOpen(false) }}
                  className={cn("flex aspect-square items-center justify-center rounded-md hover:bg-muted", n === value && "bg-primary/10 ring-1 ring-primary")}>
                  <Glyph name={n} size={22} />
                </button>
              ))}
            </div>
          )}
          {list.length === 240 && <Note className="text-xs">Showing the first 240. Search to narrow.</Note>}
          {q && !list.length && <Note className="text-xs">No icon matches “{q}”.</Note>}
        </div>
      )}
    </div>
  )
}
