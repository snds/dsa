import * as React from "react"
import { XIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { PinnedThread } from "./PinnedThread"
import { History } from "./history"
import { anchorKeyOf, useAgent, type SetItem, type Subject } from "./store"

/** An issue as the conversation needs it: key, title, where its detail lives, its apps. */
export interface ScopeIssue { key: string; title: string; source?: any; apps: string[] }

/** The subject for issues chosen together: one issue is its own conversation; more make a set. */
export function scopeSubject(list: ScopeIssue[], one: (i: ScopeIssue) => Subject): Subject {
  if (list.length === 1) return one(list[0]!)
  return { kind: "set", items: list.map(i => ({ key: i.key, title: i.title, source: i.source, app: i.apps[0] })) }
}

const asItems = (list: ScopeIssue[]): SetItem[] => list.map(i => ({ key: i.key, title: i.title, source: i.source, app: i.apps[0] }))

/**
 * The Inbox's right column (agentic Inbox, PR A): a conversation about the ticked issues, or the open
 * issue when none are ticked. "About:" chips show the scope before you send. Sending freezes it: ticking
 * more afterwards offers "Add to this" (the same conversation, now about more) or "Start new".
 */
export function Conversation({ scope, fromTicks, one, appOf, onUntick, onHide, className }: {
  scope: ScopeIssue[]; fromTicks: boolean; one: (i: ScopeIssue) => Subject; appOf: (key: string) => string | undefined
  onUntick: (key: string) => void; onHide?: () => void; className?: string
}) {
  const a = useAgent()
  const wanted = scopeSubject(scope, one)
  const wantedKey = anchorKeyOf(wanted)
  // The conversation's subject and the issues it is about (a question's subject is its element batch, so
  // the issues are kept beside it for the chips).
  const [{ subject: conv, items }, setState] = React.useState<{ subject: Subject; items: SetItem[] }>({ subject: wanted, items: asItems(scope) })
  const setConv = (subject: Subject, list: SetItem[] = subject.kind === "set" ? subject.items : asItems(scope)) => setState({ subject, items: list })
  const convKey = anchorKeyOf(conv)
  const live = a.session && (anchorKeyOf(a.session.subject) === convKey || a.threads[convKey]?.session === a.session.id) ? a.session : null
  const talked = (live?.messages.length ?? 0) > 0
  // Follow the selection until the conversation has started. After that, a change of ticks (or leaving a
  // conversation about several issues) asks first; moving to another issue with nothing ticked follows.
  const asks = talked && wantedKey !== convKey && (fromTicks || conv.kind === "set")
  React.useEffect(() => { if (!asks && wantedKey !== convKey) setConv(wanted) }, [wantedKey, asks]) // eslint-disable-line react-hooks/exhaustive-deps

  const remove = (key: string) => {
    if (!talked) return onUntick(key)
    const left = items.filter(i => i.key !== key)
    if (!left.length) return
    const next: Subject = left.length === 1 ? { kind: "issue", key: left[0]!.key, title: left[0]!.title, source: left[0]!.source } : { kind: "set", items: left }
    void a.rescope(next).then(() => setConv(next, left))
  }
  const addToThis = () => {
    const have = new Set(items.map(i => i.key))
    const more = asItems(scope).filter(i => !have.has(i.key))
    const next: Subject = { kind: "set", items: [...items, ...more] }
    void a.rescope(next).then(() => setConv(next))
  }

  return (
    <PinnedThread subject={conv} heading="Conversation" onHide={onHide} className={className}>
      <div className="flex flex-col gap-2 border-b px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">About:</span>
          <span className="order-last ml-auto"><History keys={items.map(i => i.key)} anchor={convKey} /></span>
          {items.length ? items.map(i => (
            <span key={i.key} className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/50 py-0.5 pr-1 pl-2">
              <span className="truncate" title={i.title ?? i.key}>{i.title ?? i.key}</span>
              {(i.app ?? appOf(i.key)) && <span className="shrink-0 text-muted-foreground">· {i.app ?? appOf(i.key)}</span>}
              {items.length > 1 && <button type="button" aria-label={`Leave out ${i.title ?? i.key}`} className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground" onClick={() => remove(i.key)}><XIcon className="size-3" /></button>}
            </span>
          )) : <span>{conv.kind === "scan" ? "The whole scan" : "This issue"}</span>}
        </div>
        {!talked && <p className="text-xs text-muted-foreground">{fromTicks ? `From the ${items.length} ticked issue${items.length === 1 ? "" : "s"}.` : "The open issue. Tick issues in the list to talk about several at once."}</p>}
        {asks && (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-warning-soft-border bg-warning-soft px-2.5 py-1.5 text-xs text-foreground">
            <span>Selection changed: {fromTicks ? `${scope.length} ticked` : "no ticks"}.</span>
            {fromTicks && <Button size="xs" variant="outline" onClick={addToThis}>Add to this</Button>}
            <Button size="xs" variant="outline" onClick={() => setConv(wanted)}>{fromTicks ? "Start new" : "Open issue instead"}</Button>
          </div>
        )}
      </div>
    </PinnedThread>
  )
}
