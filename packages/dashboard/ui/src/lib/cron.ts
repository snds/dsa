// When a scheduled scan runs next. Cron lines are read the way GitHub and most CI read them: five
// fields (minute hour day-of-month month day-of-week), in UTC, with lists, ranges, steps and
// names (MON-FRI, JAN). When both day fields are restricted, either one matching is enough.
// No React here, so the tests use it directly.

const NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

function field(src: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>()
  for (const part of src.toLowerCase().split(",")) {
    const m = part.match(/^(\*|[a-z0-9]+)(?:-([a-z0-9]+))?(?:\/(\d+))?$/)
    if (!m) return null
    const val = (s: string) => (s in NAMES ? NAMES[s]! : /^\d+$/.test(s) ? Number(s) : NaN)
    const from = m[1] === "*" ? lo : val(m[1]!)
    const to = m[1] === "*" ? hi : m[2] ? val(m[2]) : m[3] ? hi : from
    const step = m[3] ? Number(m[3]) : 1
    if (![from, to, step].every(Number.isFinite) || from < lo || to > hi || from > to || step < 1) return null
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return out
}

export interface Cron { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean }

/** A parsed cron line, or null when it isn't one. */
export function parseCron(line: string): Cron | null {
  const f = line.trim().split(/\s+/)
  if (f.length !== 5) return null
  const sets = f.map((s, i) => field(s, RANGES[i]!))
  if (sets.some(s => !s)) return null
  const dow = new Set([...sets[4]!].map(d => d % 7)) // 7 is Sunday too
  return { minute: sets[0]!, hour: sets[1]!, dom: sets[2]!, month: sets[3]!, dow, domAny: f[2] === "*", dowAny: f[4] === "*" }
}

/** The first time after `from` (UTC) the line fires, within a year; null if never or not a cron line. */
export function nextRun(line: string, from = new Date()): Date | null {
  const c = parseCron(line)
  if (!c) return null
  const t = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours(), from.getUTCMinutes() + 1))
  const end = from.getTime() + 366 * 864e5
  while (t.getTime() <= end) {
    if (!c.month.has(t.getUTCMonth() + 1)) { t.setUTCMonth(t.getUTCMonth() + 1, 1); t.setUTCHours(0, 0); continue }
    const domOk = c.dom.has(t.getUTCDate()), dowOk = c.dow.has(t.getUTCDay())
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk
    if (!dayOk) { t.setUTCDate(t.getUTCDate() + 1); t.setUTCHours(0, 0); continue }
    if (!c.hour.has(t.getUTCHours())) { t.setUTCHours(t.getUTCHours() + 1, 0); continue }
    if (!c.minute.has(t.getUTCMinutes())) { t.setUTCMinutes(t.getUTCMinutes() + 1); continue }
    return t
  }
  return null
}

/** The soonest next run across several lines. */
export function nextScheduled(lines: string[] | null | undefined, from = new Date()): Date | null {
  const times = (lines ?? []).map(l => nextRun(l, from)).filter((d): d is Date => d !== null)
  return times.length ? new Date(Math.min(...times.map(d => d.getTime()))) : null
}
