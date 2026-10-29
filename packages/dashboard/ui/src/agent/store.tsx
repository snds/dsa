import * as React from "react"
import { D, api, say } from "@/lib/dsa"

/**
 * The agent workbench, client side: which session is open in the side panel, its transcript, and the
 * turn being streamed. Sessions live on the server (<data>/agent/sessions); this only mirrors one.
 */
export type Subject =
  | { kind: "review"; ids: string[]; title?: string; pattern?: string | null }
  | { kind: "queue"; id: string }
  | { kind: "readiness"; subject: string }
  | { kind: "scan" }

export interface Tool { name: string; summary: string }
export interface Msg { role: "user" | "assistant"; text: string; at: string; tools?: Tool[]; error?: string; costUsd?: number; proposals?: string[] }
export interface Proposal { id: string; kind: string; session: string; title: string; rationale: string; confidence?: string; evidence?: string[]; payload: any; status: "open" | "accepted" | "rejected"; createdAt: string; result?: string }
export interface Starter { label: string; prompt: string; mode?: "try" }
export interface Session { id: string; title: string; subject: Subject; provider: "claude-code" | "cursor"; model?: string; mode: "advise" | "try"; repo: { name: string; dir: string }; sandbox: string | null; brief: string; starters: Starter[]; messages: Msg[]; kept?: { branch: string; commit: string }; visual?: VisualRun }
export interface Changes { files: { file: string; status: string }[]; stat: string; diff: string }
export interface Shot { file?: string; page?: string; revealedBy?: string; match?: number; loose?: boolean }
export interface Pair { id: string; label: string; file: string; line: number; reason: string; before: Shot; after: Shot; same: boolean | null }
export interface VisualRun { key: string; at: string; base: string; target: string; pairs: Pair[]; notes: string[]; seconds: number }

interface State {
  open: boolean
  session: Session | null
  proposals: Proposal[]
  changes: Changes | null
  streaming: Msg | null
  busy: boolean
  starting: boolean
  error: string | null
  /** Before/after pictures: being taken, their progress lines, and whether the sandbox changed since. */
  visual: { running: boolean; log: string[]; stale: boolean; error: string | null }
}

interface Api extends State {
  start: (subject: Subject, opts?: { mode?: "advise" | "try"; provider?: string; ask?: string }) => Promise<void>
  resume: (id: string) => Promise<void>
  send: (text: string, mode?: "advise" | "try") => Promise<void>
  cancel: () => Promise<void>
  close: () => void
  setOpen: (o: boolean) => void
  decide: (p: Proposal, action: "accept" | "reject") => Promise<void>
  changesAction: (action: "keep" | "discard") => Promise<void>
  takePictures: () => Promise<void>
  refresh: () => Promise<void>
}

const Ctx = React.createContext<Api | null>(null)
export const useAgent = () => { const c = React.useContext(Ctx); if (!c) throw new Error("useAgent outside AgentProvider"); return c }
/** True when this page can talk to an agent (served by `dsa serve`, not opened from disk). */
export const canChat = () => Boolean(D.serve)

const NO_VISUAL: State["visual"] = { running: false, log: [], stale: false, error: null }

/** POST, then read the server's newline-delimited JSON events as they arrive. */
async function stream(url: string, body: unknown, onEvent: (e: any) => void) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-DSA": "1" }, body: JSON.stringify(body) })
  if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.statusText) }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (line.trim()) onEvent(JSON.parse(line))
    }
  }
}

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [s, set] = React.useState<State>({ open: false, session: null, proposals: [], changes: null, streaming: null, busy: false, starting: false, error: null, visual: NO_VISUAL })
  const patch = (p: Partial<State>) => set(x => ({ ...x, ...p }))
  const sid = s.session?.id

  const load = React.useCallback(async (id: string) => {
    const r = await api(`/api/agent/session?id=${encodeURIComponent(id)}`)
    set(x => ({ ...x, session: r.session, proposals: r.proposals, changes: r.changes, busy: r.running, visual: { ...x.visual, running: x.visual.running || r.visualRunning, stale: r.visualStale } }))
  }, [])

  const send = React.useCallback(async (text: string, mode?: "advise" | "try", id = sid) => {
    if (!id || !text.trim()) return
    const now = new Date().toISOString()
    set(x => ({ ...x, busy: true, error: null, streaming: { role: "assistant", text: "", at: now, tools: [] },
      session: x.session ? { ...x.session, mode: mode ?? x.session.mode, messages: [...x.session.messages, { role: "user", text, at: now }] } : x.session }))
    try {
      await stream("/api/agent/send", { id, text, mode }, e => {
        set(x => {
          const m = x.streaming ?? { role: "assistant" as const, text: "", at: now, tools: [] }
          if (e.type === "text") return { ...x, streaming: { ...m, text: m.text + e.delta } }
          if (e.type === "tool") return { ...x, streaming: { ...m, tools: [...(m.tools ?? []), { name: e.name, summary: e.summary }] } }
          if (e.type === "proposals") return { ...x, proposals: [...x.proposals.filter(p => !e.items.some((n: Proposal) => n.id === p.id)), ...e.items] }
          if (e.type === "changes") return { ...x, changes: { files: e.files, stat: e.stat, diff: x.changes?.diff ?? "" } }
          if (e.type === "result" && !e.ok) return { ...x, error: e.error ?? "The agent stopped." }
          return x
        })
      })
    } catch (e: any) { patch({ error: e.message }) }
    finally {
      set(x => ({ ...x, streaming: null, busy: false }))
      await load(id).catch(() => {})
    }
  }, [sid, load])

  const start = React.useCallback(async (subject: Subject, opts: { mode?: "advise" | "try"; provider?: string; ask?: string } = {}) => {
    if (!canChat()) { say("Agents work when the dashboard is served: run dsa serve.", true); return }
    patch({ open: true, starting: true, error: null, session: null, proposals: [], changes: null, visual: NO_VISUAL })
    try {
      const r = await api("/api/agent/session", { subject, mode: opts.mode, provider: opts.provider })
      set(x => ({ ...x, session: r.session, starting: false }))
      if (opts.ask) await send(opts.ask, opts.mode, r.session.id)
    } catch (e: any) { patch({ starting: false, error: e.message }) }
  }, [send])

  const api_: Api = {
    ...s,
    start,
    send: (t, m) => send(t, m),
    resume: async id => { patch({ open: true, error: null, visual: NO_VISUAL }); try { await load(id) } catch (e: any) { patch({ error: e.message }) } },
    cancel: async () => { if (sid) await api("/api/agent/cancel", { id: sid }).catch(() => {}) },
    close: () => patch({ open: false }),
    setOpen: o => patch({ open: o }),
    refresh: async () => { if (sid) await load(sid) },
    decide: async (p, action) => {
      try {
        const r = await api("/api/agent/proposal", { id: p.id, action })
        if (action === "accept") say(r.result && !/^https:/.test(r.result) ? r.result : "Accepted")
        if (action === "accept" && /^https:\/\/github\.com\//.test(r.result ?? "")) window.open(r.result, "_blank", "noopener")
        set(x => ({ ...x, proposals: x.proposals.map(y => (y.id === p.id ? { ...y, status: action === "accept" ? "accepted" : "rejected", result: r.result } : y)) }))
      } catch (e: any) { say(e.message, true) }
    },
    takePictures: async () => {
      if (!sid || s.visual.running) return
      patch({ visual: { running: true, log: [], stale: false, error: null } })
      const add = (line: string) => set(x => ({ ...x, visual: { ...x.visual, log: [...x.visual.log.slice(-200), line] } }))
      try {
        await stream("/api/agent/visual", { id: sid }, e => {
          if (e.type === "log") add(e.text)
          if (e.type === "error") set(x => ({ ...x, visual: { ...x.visual, error: e.error } }))
        })
      } catch (e: any) { set(x => ({ ...x, visual: { ...x.visual, error: e.message } })) }
      finally {
        set(x => ({ ...x, visual: { ...x.visual, running: false } }))
        await load(sid).catch(() => {})
      }
    },
    changesAction: async action => {
      if (!sid) return
      try {
        const r = await api("/api/agent/changes", { id: sid, action })
        say(action === "keep" ? `Kept on branch ${r.branch} (${r.commit}) in your local repo. Nothing was pushed.` : "Sandbox thrown away")
        await load(sid)
      } catch (e: any) { say(e.message, true) }
    },
  }
  return <Ctx.Provider value={api_}>{children}</Ctx.Provider>
}
