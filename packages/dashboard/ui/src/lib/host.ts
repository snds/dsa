// What a published (static) dashboard's live buttons do. The host adapter that published the page
// decided (D.actions): open a page that starts the scan job or POST to it; download the decisions,
// POST them to a webhook, or file them as an issue a workflow applies. `dsa serve` uses none of this.
import { D, say } from "@/lib/dsa"
import { FILE_NAME, decisionsFile, downloadDecisions, type Staged } from "@/lib/staged"

export interface PageActions {
  host: string
  rescan: { kind: "link" | "post" | "issue" | "none"; url?: string; label: string; help: string; shots?: boolean; command?: string; title?: string; labels?: string[] }
  decisions: { kind: "export" | "post" | "issue"; url?: string; label: string; help: string; title?: string; labels?: string[]; apply: string }
  /** Discuss on GitHub (stage 9): the new-issue page, the issue list to search, and the label. */
  thread?: { url: string; search: string; label: string; labels: string[]; help: string }
}

export const ACTIONS: PageActions | null = D.actions ?? null

/** Start a scan the way the host says: a page in a new tab, or a POST the page makes itself. */
export async function rescan(): Promise<void> {
  const r = ACTIONS?.rescan
  if (!r || r.kind === "none" || !r.url) return
  if (r.kind === "link") { if (!openTab(r.url)) say(BLOCKED, true); return }
  const res = await fetch(r.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dsa: "rescan", run: D.run?.id ?? null, revision: D.live?.head ?? null }) })
  if (!res.ok) throw new Error(`The scan job answered ${res.status}.`)
  say("Scan requested. The dashboard updates when it is published.")
}

/** Browsers and GitHub refuse very long URLs; past this the body goes on the clipboard instead. */
const MAX_URL = 7000

/**
 * Open a new tab, and say whether the browser allowed it. ("noopener" makes window.open return null even
 * when it opens, so the opener is cleared by hand instead: code review C C-31.)
 */
export function openTab(url: string): boolean {
  const w = window.open(url, "_blank")
  if (w) { try { w.opener = null } catch { /* cross-origin already */ } }
  return Boolean(w)
}
const BLOCKED = "The browser blocked the new tab. Allow pop-ups for this page, then send again."

/** One answer in plain words, for people reading the issue before the workflow applies it. */
const answerLine = (x: Staged) => {
  const d = x.decision ?? {}
  const what = d.verdict === "replace" ? `replace with ${d.use}${d.props && Object.keys(d.props).length ? ` (${Object.entries(d.props).map(([k, v]) => `${k}="${v}"`).join(", ")})` : ""}` : d.verdict === "keep" ? "keep as it is" : d.verdict === "gap" ? "a gap in the system" : d.verdict === "ignore" ? "leave out of the review" : String(d.verdict ?? "?")
  return `- ${x.label || x.key} in ${x.target}: ${what}${x.note ? `. "${x.note}"` : ""}`
}

/** The issue body: what it is in plain words, then the file in a fenced block the apply workflow reads. */
export function issueBody(list: Staged[]): string {
  const file = JSON.stringify(decisionsFile(list), null, 1)
  return [
    `${list.length} review decision${list.length === 1 ? "" : "s"} from the dashboard${D.run?.id ? ` (scan ${D.run.id}${D.live?.head ? ` at ${String(D.live.head).slice(0, 7)}` : ""})` : ""}:`,
    "",
    ...list.map(answerLine),
    "",
    `A workflow applies them with \`${ACTIONS?.decisions.apply ?? "dsa apply-decisions"}\`. Edit the block below to change them before it runs.`,
    "",
    "```json",
    file,
    "```",
  ].join("\n")
}

/** Send the staged decisions where the host says. Resolves to what the page should tell the person. */
export async function sendDecisions(list: Staged[]): Promise<string> {
  const d = ACTIONS?.decisions
  if (!d || d.kind === "export") { downloadDecisions(list); return `Saved ${FILE_NAME}.` }
  if (d.kind === "post") {
    const res = await fetch(d.url!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(decisionsFile(list)) })
    if (!res.ok) throw new Error(`The decisions webhook answered ${res.status}.`)
    return `Sent ${list.length} decision${list.length === 1 ? "" : "s"}. They show here once applied and republished.`
  }
  const body = issueBody(list)
  const u = new URL(d.url!)
  if (d.title) u.searchParams.set("title", d.title)
  if (d.labels?.length) u.searchParams.set("labels", d.labels.join(","))
  u.searchParams.set("body", body)
  if (u.toString().length <= MAX_URL) return openTab(u.toString()) ? "Opened a new issue with the decisions. Submit it to apply them." : BLOCKED
  // Too long for a link: the issue opens with a placeholder and the decisions go on the clipboard. The tab
  // opens first, while the click still counts, then the copy (after an await the browser blocks the tab).
  u.searchParams.set("body", "Paste the decisions here (they are on your clipboard).")
  if (!openTab(u.toString())) return BLOCKED
  try { await navigator.clipboard.writeText(body) } catch { downloadDecisions(list); return `Too many to put in a link: saved ${FILE_NAME}. Paste its contents into the issue in a \`\`\`json block.` }
  return "Opened a new issue. The decisions are on your clipboard: paste them as the issue's body."
}

/** The new-issue link for Re-scan by issue: title, label, and the setting as a block the workflow reads. */
export function rescanIssueUrl(r: { url?: string | undefined; title?: string | undefined; labels?: string[] | undefined }, shots: string): string {
  const body = [
    "Re-scan requested from the dsa dashboard. Submit this issue to start the scan; it closes when the dashboard is updated.",
    "",
    "<!-- dsa:rescan -->",
    "```json",
    JSON.stringify({ dsa: "rescan", shots }),
    "```",
  ].join("\n")
  const q = new URLSearchParams({ title: r.title ?? "Re-scan the dsa dashboard", body, ...(r.labels?.length ? { labels: r.labels.join(",") } : {}) })
  return `${r.url}?${q.toString()}`
}

/**
 * Discuss on GitHub (redesign stage 9): a new issue for a thread, with its anchor in a hidden marker
 * the dsa-thread workflow reads, and the label it listens for. The person types their question there.
 */
export function threadIssueUrl(t: { url: string; labels: string[] }, anchor: string, title: string, page?: string): string {
  const body = [
    `About: ${title}`,
    `Thread: \`${anchor}\``,
    ...(page ? [`From the dashboard: ${page}`] : []),
    "",
    "Ask your question below. If the dsa-thread workflow is set up, the agent replies here to people with write access.",
    "",
    `<!-- dsa:thread ${anchor} -->`,
  ].join("\n")
  const q = new URLSearchParams({ title: `dsa: ${title}`.slice(0, 200), body, labels: t.labels.join(",") })
  return `${t.url}?${q.toString()}`
}

/** A link the page may open: http(s) only (code review C C-41). */
export const safeHref = (u: unknown): string | undefined => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : undefined)

/**
 * This page's address, for a new issue's body: only a real web address. A file:// copy or a localhost
 * preview would put a local path or a dev address into a possibly public issue (code review C, UX A).
 */
export function pageLink(href = location.href): string | undefined {
  try { const u = new URL(href); return u.protocol === "https:" && !/^(localhost|127\.|\[::1\])/.test(u.hostname) ? href : undefined } catch { return undefined }
}

/**
 * The search that finds the open GitHub issue already discussing an anchor. It looks for the hidden
 * marker, not the label: a new-issue link drops a label the repo doesn't have.
 */
export function threadSearchUrl(t: { search: string }, anchor: string): string {
  return `${t.search}?${new URLSearchParams({ q: `is:issue in:body "dsa:thread ${anchor}"` }).toString()}`
}
