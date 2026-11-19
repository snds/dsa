import { CaretLineRightIcon, ChatCircleIcon, GithubLogoIcon, GitPullRequestIcon, MagnifyingGlassIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { D, fmtD } from "@/lib/dsa"
import { pageLink, safeHref, ACTIONS, discussAnchor, threadIssueUrl, threadSearchUrl } from "@/lib/host"
import { THREAD_STATE } from "./ThreadBadge"
import { anchorKeyOf, type Subject } from "./store"

/**
 * A thread on a published page (redesign stage 9, decision D6). A static page can't run an agent, so
 * it shows what the thread was about as of publishing: the question, the last answer, the proposals
 * and what people decided. To go on, Discuss on GitHub opens an issue the dsa-thread workflow answers.
 */
/** Whether a published page has anything to show for this subject's thread: a summary, or Discuss on GitHub. */
export const publishedThreadShown = (subject: Subject): boolean => Boolean((D.threads ?? {})[anchorKeyOf(subject)] || ACTIONS?.thread)

export function PublishedThread({ subject, title, className, onHide }: { subject: Subject; title: string; className?: string; onHide?: () => void }) {
  const key = anchorKeyOf(subject)
  const t = (D.threads ?? {})[key] as any
  // What Discuss on GitHub writes: a set by its issue keys, so the workflow can brief it.
  const discuss = discussAnchor(subject as any, key)
  const gh = ACTIONS?.thread ?? null
  if (!t && !gh) return null
  const st = t ? THREAD_STATE[t.state as keyof typeof THREAD_STATE] : null
  return (
    <section aria-label="Thread for this issue" className={`flex flex-col gap-3 rounded-lg border bg-background p-4 text-sm ${className ?? ""}`}>
      <header className="flex flex-wrap items-center gap-2">
        <ChatCircleIcon className="size-4" />
        <h3 className="font-semibold">{subject.kind === "set" ? "Conversation" : "Thread"}</h3>
        {st && <Badge variant="outline" className={st.tone}><st.icon />{st.label}</Badge>}
        {t?.updatedAt && <span className="text-xs text-muted-foreground">as of {fmtD(t.updatedAt)}</span>}
        {onHide && <span className="ml-auto" />}
        {onHide && <Button variant="ghost" size="icon-sm" className="hidden @7xl:inline-flex" aria-label="Hide the thread" title="Hide the thread: give the issue the room" onClick={onHide}><CaretLineRightIcon /></Button>}
      </header>
      {/* Issues discussed together: say which (agentic Inbox). */}
      {subject.kind === "set" && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">About:</span>
          {subject.items.map(i => <span key={i.key} className="max-w-full truncate rounded-full border bg-muted/50 px-2 py-0.5" title={i.title ?? i.key}>{i.title ?? i.key}{i.app ? ` · ${i.app}` : ""}</span>)}
        </div>
      )}
      {t ? (
        <>
          {t.asked && <div><p className="text-xs font-medium text-muted-foreground">Asked</p><p className="mt-0.5">{t.asked}</p></div>}
          {t.answer && <div><p className="text-xs font-medium text-muted-foreground">Last answer, in short</p><p className="mt-0.5 whitespace-pre-line">{t.answer}</p></div>}
          {t.proposals?.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Proposals</p>
              <ul className="mt-1 flex flex-col gap-1">
                {t.proposals.map((p: any) => <li key={p.id} className="flex flex-wrap items-center gap-2"><Badge variant="outline">{p.status}</Badge><span>{p.title}</span></li>)}
              </ul>
            </div>
          )}
          {safeHref(t.pr?.url) && <a href={safeHref(t.pr.url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 underline underline-offset-4"><GitPullRequestIcon />Draft PR{t.pr.number ? ` #${t.pr.number}` : ""}</a>}
          <p className="text-xs text-muted-foreground">A summary from the last publish. The full thread lives where it ran.</p>
        </>
      ) : <p className="text-muted-foreground">No thread on this yet.</p>}
      {gh && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {/* Look first, so one issue gets one discussion (UX review B U-06): a new one is the second step. */}
          <Button size="sm" variant="outline" nativeButton={false} render={<a href={threadSearchUrl(gh, discuss)} target="_blank" rel="noreferrer" />}><MagnifyingGlassIcon data-icon="inline-start" />Find the discussion</Button>
          <a href={threadIssueUrl(gh, discuss, t?.title || title, pageLink())} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline underline-offset-4"><GithubLogoIcon />Start a new one on GitHub</a>
          <p className="w-full text-xs text-muted-foreground">Look for an open discussion first: one per issue. {gh.help}</p>
        </div>
      )}
    </section>
  )
}
