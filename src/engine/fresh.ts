import fs from 'node:fs';
import path from 'node:path';

/**
 * Is a screenshot from this run? The crawler stamps its index with the run it belongs to
 * (`run: { id, ref, at }`; `ref` is the source commit, or "worktree" when the checkout has changes) and
 * each shot with the run that took it and when (`run`, `at`). A shot it carried forward from an older
 * run keeps its old stamp. A photo from before the code changed can show something the code no longer
 * draws, so it isn't evidence of the code being scored:
 *
 *   - a shot from another run, taken before this run started, is missing;
 *   - a shot with no stamp at all (an index written before stamping) is missing too.
 *
 * Age is read from the shot's own `at`, never from the index, so a carried-forward photo shows its age.
 */
export interface ShotRun { id: string; ref: string; at: string }

export type StaleWhy = 'older-run' | 'unstamped';

export interface ShotFreshness {
  /** The run the index belongs to, or null for an index written before stamping. */
  run: ShotRun | null;
  /** The shots that count, by element id. */
  shots: Record<string, any>;
  /** The shots that don't, by element id, with why and when each was taken. */
  stale: Record<string, { why: StaleWhy; at: string | null; run: string | null }>;
}

/** One shot against its index's run: fresh, or why not. */
export function staleWhy(shot: any, run: ShotRun | null | undefined): StaleWhy | null {
  if (!shot || typeof shot !== 'object') return null;
  if (!run?.id || !shot.run || !shot.at) return 'unstamped';
  if (shot.run === run.id) return null;
  const taken = Date.parse(shot.at), started = Date.parse(run.at);
  return Number.isFinite(taken) && Number.isFinite(started) && taken < started ? 'older-run' : null;
}

/** Split an index's shots into those that count and those that don't. */
export function freshShots(index: any): ShotFreshness {
  const run: ShotRun | null = index?.run && typeof index.run.id === 'string' ? index.run : null;
  const shots: Record<string, any> = {}, stale: ShotFreshness['stale'] = {};
  for (const [id, s] of Object.entries<any>(index?.shots ?? {})) {
    const why = staleWhy(s, run);
    if (why) stale[id] = { why, at: typeof s?.at === 'string' ? s.at : null, run: typeof s?.run === 'string' ? s.run : null };
    else shots[id] = s;
  }
  return { run, shots, stale };
}

/** Where a run's screenshots are: `<runDir>/shots` when scoring is pointed at one run's folder, else `<data>/shots`. */
export const shotsDirOf = (dataDir: string, runDir?: string | null) => path.join(runDir ?? dataDir, 'shots');

/** The screenshot index, or an empty one. */
export function readShotIndex(dataDir: string, runDir?: string | null): any {
  try { return JSON.parse(fs.readFileSync(path.join(shotsDirOf(dataDir, runDir), 'index.json'), 'utf8')); } catch { return { shots: {} }; }
}

/**
 * The oldest shot that counts in each app, and how many were set aside, so a report can say "the
 * oldest photo is 3 hours older than this run". Ages are in hours before the run (or before `now`
 * for an unstamped index).
 */
export function freshnessByApp(f: ShotFreshness, appOf: (id: string) => string | undefined, now = new Date()): Record<string, { kept: number; olderRun: number; unstamped: number; oldestAt: string | null; oldestHours: number | null }> {
  const ref = f.run ? Date.parse(f.run.at) : now.getTime();
  const out: Record<string, { kept: number; olderRun: number; unstamped: number; oldestAt: string | null; oldestHours: number | null }> = {};
  const row = (app: string) => (out[app] ??= { kept: 0, olderRun: 0, unstamped: 0, oldestAt: null, oldestHours: null });
  for (const [id, s] of Object.entries<any>(f.shots)) {
    const app = appOf(id);
    if (!app) continue;
    const r = row(app);
    r.kept++;
    const at = typeof s?.at === 'string' && Number.isFinite(Date.parse(s.at)) ? s.at : null;
    if (at && (!r.oldestAt || Date.parse(at) < Date.parse(r.oldestAt))) r.oldestAt = at;
  }
  for (const [id, s] of Object.entries(f.stale)) {
    const app = appOf(id);
    if (!app) continue;
    if (s.why === 'older-run') row(app).olderRun++; else row(app).unstamped++;
  }
  for (const r of Object.values(out)) if (r.oldestAt && Number.isFinite(ref)) r.oldestHours = Math.max(0, Math.round(((ref - Date.parse(r.oldestAt)) / 36e5) * 10) / 10);
  return out;
}
