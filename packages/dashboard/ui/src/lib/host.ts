// What a published (static) dashboard's live buttons do. The host adapter that published the page
// decided (D.actions): open a page that starts the scan job or POST to it; download the decisions,
// POST them to a webhook, or file them as an issue a workflow applies. `dsa serve` uses none of this.
import { D, say } from "@/lib/dsa"
import { FILE_NAME, decisionsFile, downloadDecisions, type Staged } from "@/lib/staged"

export interface PageActions {
  host: string
  rescan: { kind: "link" | "post" | "none"; url?: string; label: string; help: string }
  decisions: { kind: "export" | "post" | "issue"; url?: string; label: string; help: string; title?: string; labels?: string[]; apply: string }
}

export const ACTIONS: PageActions | null = D.actions ?? null

/** Start a scan the way the host says: a page in a new tab, or a POST the page makes itself. */
export async function rescan(): Promise<void> {
  const r = ACTIONS?.rescan
  if (!r || r.kind === "none" || !r.url) return
  if (r.kind === "link") { window.open(r.url, "_blank", "noopener"); return }
  const res = await fetch(r.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dsa: "rescan", run: D.run?.id ?? null, revision: D.live?.head ?? null }) })
  if (!res.ok) throw new Error(`The scan job answered ${res.status}.`)
  say("Scan requested. The dashboard updates when it is published.")
}

/** Browsers and GitHub refuse very long URLs; past this the body goes on the clipboard instead. */
const MAX_URL = 7000

/** The issue body: what it is, then the file in a fenced block the apply workflow reads. */
export function issueBody(list: Staged[]): string {
  const file = JSON.stringify(decisionsFile(list), null, 1)
  return [
    `${list.length} review decision${list.length === 1 ? "" : "s"} from the dashboard${D.run?.id ? ` (scan ${D.run.id}${D.live?.head ? ` at ${String(D.live.head).slice(0, 7)}` : ""})` : ""}.`,
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
  if (u.toString().length <= MAX_URL) { window.open(u.toString(), "_blank", "noopener"); return "Opened a new issue with the decisions. Submit it to apply them." }
  // Too long for a link: the issue opens with a placeholder and the decisions go on the clipboard.
  u.searchParams.set("body", "Paste the decisions here (they are on your clipboard).")
  try { await navigator.clipboard.writeText(body) } catch { downloadDecisions(list); window.open(u.toString(), "_blank", "noopener"); return `Too many to put in a link: saved ${FILE_NAME}. Paste its contents into the issue in a \`\`\`json block.` }
  window.open(u.toString(), "_blank", "noopener")
  return "Opened a new issue. The decisions are on your clipboard: paste them as the issue's body."
}
