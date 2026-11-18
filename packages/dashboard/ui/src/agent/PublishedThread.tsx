import { ChatCircleIcon, GithubLogoIcon, GitPullRequestIcon, MagnifyingGlassIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { D, fmtD } from "@/lib/dsa"
import { ACTIONS, threadIssueUrl, threadSearchUrl } from "@/lib/host"
import { THREAD_STATE } from "./ThreadBadge"
import { anchorKeyOf, type Subject } from "./store"

/**
 * A thread on a published page (redesign stage 9, decision D6). A static page can't run an agent, so
 * it shows what the thread was about as of publishing: the question, the last answer, the proposals
 * and what people decided. To go on, Discuss on GitHub opens an issue the dsa-thread workflow answers.
 */
/** Whether a published page has anything to show for this subject's thread: a summary, or Discuss on GitHub. */
export const publishedThreadShown = (subject: Subject): boolean => Boolean((D.threads ?? {})[anchorKeyOf(subject)] || ACTIONS?.thread)

export function PublishedThread({ subject, title, className }: { subject: Subject; title: string; className?: string }) {
  const key = anchorKeyOf(subject)
  const t = (D.threads ?? {})[key] as any
  const gh = ACTIONS?.thread ?? null
  if (!t && !gh) return null
  const st = t ? THREAD_STATE[t.state as keyof typeof THREAD_STATE] : null
  return (
    <section aria-label="Thread for this issue" className={`flex flex-col gap-3 rounded-lg border bg-background p-4 text-sm ${className ?? ""}`}>
      <header className="flex flex-wrap items-center gap-2">
        <ChatCircleIcon className="size-4" />
        <h3 className="font-semibold">Thread</h3>
        {st && <Badge variant="outline" className={st.tone}><st.icon />{st.label}</Badge>}
        {t?.updatedAt && <span className="text-xs text-muted-foreground">as of {fmtD(t.updatedAt)}</span>}
      </header>
      {t ? (
        <>
          {t.asked && <div><p className="text-xs font-medium text-muted-foreground">Asked</p><p className="mt-0.5">{t.asked}</p></div>}
          {t.answer && <div><p className="text-xs font-medium text-muted-foreground">Last answer</p><p className="mt-0.5 whitespace-pre-line">{t.answer}</p></div>}
          {t.proposals?.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Proposals</p>
              <ul className="mt-1 flex flex-col gap-1">
                {t.proposals.map((p: any) => <li key={p.id} className="flex flex-wrap items-center gap-2"><Badge variant="outline">{p.status}</Badge><span>{p.title}</span></li>)}
              </ul>
            </div>
          )}
          {t.pr?.url && <a href={t.pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 underline underline-offset-4"><GitPullRequestIcon />Draft PR{t.pr.number ? ` #${t.pr.number}` : ""}</a>}
          <p className="text-xs text-muted-foreground">A summary from the last publish. The full thread lives where it ran.</p>
        </>
      ) : <p className="text-muted-foreground">No thread on this yet.</p>}
      {gh && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button size="sm" variant="outline" nativeButton={false} render={<a href={threadIssueUrl(gh, key, t?.title || title, location.href)} target="_blank" rel="noreferrer" />}><GithubLogoIcon data-icon="inline-start" />{gh.label}</Button>
          <a href={threadSearchUrl(gh, key)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline underline-offset-4"><MagnifyingGlassIcon />Find the discussion</a>
          <p className="w-full text-xs text-muted-foreground">{gh.help}</p>
        </div>
      )}
    </section>
  )
}
