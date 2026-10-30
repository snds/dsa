// The report's data, formatters, and the live-server API. One page, two modes: a static snapshot
// (file://) and `dsa serve` (D.serve), where decisions, settings, and scans write back.
import { toast } from "sonner"

export const D: any = JSON.parse(document.getElementById("dsa-data")?.textContent || "{}")

/** The design system's short name, from its profile ("No Acme component fits"). */
export const SYS: string = D.label || "the design system"

// The store keeps UTC timestamps without a zone suffix ("2026-10-06 22:19:39"): read them as UTC.
export const T = (v: any) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? v : String(v).replace(" ", "T") + "Z")
const zone = () => D.timeZone || undefined
export const fmtDT = (v: any) => T(v).toLocaleString(undefined, { timeZone: zone(), year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
export const fmtD = (v: any) => T(v).toLocaleDateString(undefined, { timeZone: zone(), year: "numeric", month: "short", day: "numeric" })
export const fmt = (n: any) => (n == null ? "—" : Number(n).toLocaleString("en-US"))
export const pct = (n: any) => (n == null ? "—" : `${Math.round(n * 10) / 10}%`)
export const pct100 = (n: number) => `${Math.round(n * 100)}%`

/** "Just now", "12 minutes ago", "3 hours ago", then the date and time. */
export function ago(v: any, now = Date.now()) {
  const ms = now - T(v).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return "Just now"
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`
  return fmtDT(v)
}

export const SCOPES: Record<string, string> = { core: "Core", child: "Child library", consumer: "Consumer", triage: "DS triage" }
export const SEV: Record<string, string> = { crit: "Critical", serious: "Serious", warn: "Warning", watch: "Watch" }

export type Band = "good" | "warn" | "crit" | ""
export const band = (v: number | null | undefined, good: number, warn: number, up = true): Band =>
  v == null ? "" : up ? (v >= good ? "good" : v >= warn ? "warn" : "crit") : v <= good ? "good" : v <= warn ? "warn" : "crit"
export const threshold = (id: string) => D.thresholds?.find((t: any) => t.id === id)?.thresholds

export async function api(url: string, body?: unknown) {
  const r = await fetch(url, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-DSA": "1" }, body: body ? JSON.stringify(body) : undefined })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(j.error || (j.errors || []).join(" ") || r.statusText), { data: j })
  return j
}

export const say = (text: string, bad?: boolean) => (bad ? toast.error(text, { duration: 7000 }) : toast.success(text))

export async function copy(text: string, msg: string) {
  try { await navigator.clipboard.writeText(text); say(msg) } catch { say("Couldn't copy. Select the text and press Ctrl/Cmd+C.", true) }
}

export const short = (file: string) => file.replace(/^[^/]+\//, "")
