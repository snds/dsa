import fs from 'node:fs';
import path from 'node:path';
import type { EngineContext } from '@snds/dsa';
import { DEFAULT_THRESHOLD, openStore, latestEvals, loadHints, resolveTargets } from '@snds/dsa/engine';

import { buildQueue } from '@snds/dsa-dashboard';

/**
 * What an agent reads: one JSON file per data folder, written when a session starts and after each scan.
 * The MCP server reads this instead of the DuckDB store, so an agent (in the dashboard, in Cursor, in
 * Claude Code) never holds the store open while the dashboard writes to it.
 */
export interface Snapshot {
  generatedAt: string;
  root: string;
  dataDir: string;
  title: string;
  run: { id: string; takenAt: string } | null;
  threshold: number;
  targets: { name: string; role: string; dir: string; repo?: string }[];
  evals: any[];
  shots: Record<string, { file: string; abs: string; page?: string; match?: number; revealedBy?: string | null }>;
  missingShots: string[];
  queue: any[];
  readiness: any[];
  hints: any[];
}

export const agentDir = (dataDir: string) => path.join(dataDir, 'agent');
const file = (dataDir: string) => path.join(agentDir(dataDir), 'snapshot.json');

export async function writeSnapshot(ctx: Pick<EngineContext, 'root' | 'config' | 'dataDir' | 'configDir' | 'profile'>): Promise<Snapshot> {
  const { root, config, dataDir, profile } = ctx;
  const usageMetric = profile.readiness?.usageMetric ?? '';
  const { runId, evals } = await latestEvals(dataDir);
  const queue = await buildQueue(root, config, dataDir).catch(() => ({ items: [] as any[] }));
  let run: Snapshot['run'] = null;
  let readiness: any[] = [];
  const lookalikes: { target: string; file: string }[] = [];
  if (runId) {
    const store = await openStore(dataDir, 'agent snapshot');
    try {
      const [r] = await store.all<any>('select run_id, taken_at from runs where run_id=$1', [runId]);
      run = r ? { id: r.run_id, takenAt: String(r.taken_at) } : null;
      const rows = await store.all<any>(`select metric_id, scope, subject, value, detail from metrics where run_id=$1 and metric_id in ('agent_readiness', $2)`, [runId, usageMetric]);
      const det = (d: any) => (typeof d === 'string' ? JSON.parse(d) : d);
      readiness = rows.filter(x => x.metric_id === 'agent_readiness').map(x => {
        const u = usageMetric ? rows.find(y => y.metric_id === usageMetric && y.subject === x.subject) : undefined;
        return { subject: x.subject, scope: x.scope, score: x.value, ...det(x.detail), usage: u ? det(u.detail) : null };
      });
      lookalikes.push(...await store.all<any>('select target, file from lookalikes where run_id=$1', [runId]));
    } finally { store.close(); }
  }
  let targets: Snapshot['targets'] = [];
  try { targets = resolveTargets(root, config).map(t => ({ name: t.name, role: t.role, dir: t.dir, repo: t.repo })); } catch { /* a missing child path */ }
  for (const r of readiness) {
    const t = targets.find(x => x.name === r.subject);
    if (r.usage && t && profile.readiness?.reconcile) r.reconcile = profile.readiness.reconcile(r.usage, lookalikes.filter(l => l.target === t.name), t.dir, root);
  }
  const idxFile = path.join(dataDir, 'shots', 'index.json');
  const idx = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : { shots: {}, missing: [] };
  const shots: Snapshot['shots'] = {};
  for (const [id, s] of Object.entries<any>(idx.shots ?? {})) shots[id] = { file: s.file, abs: path.join(dataDir, 'shots', s.file), page: String(s.page ?? '').replace(/^https?:\/\/[^/]+/, '') || undefined, match: s.matchScore, revealedBy: revealedOf(s.revealedBy) };
  const snap: Snapshot = {
    generatedAt: new Date().toISOString(), root, dataDir, title: config.report?.title || config.designSystem?.core?.name || path.basename(root), run,
    threshold: config.review?.threshold ?? DEFAULT_THRESHOLD, targets, evals, shots, missingShots: idx.missing ?? [],
    queue: (queue.items ?? []).map((i: any) => ({ ...i, issue: i.issue ? { title: i.issue.title, body: String(i.issue.body ?? '').slice(0, 6000) } : null })),
    readiness, hints: loadHints(ctx.configDir).hints,
  };
  fs.mkdirSync(agentDir(dataDir), { recursive: true });
  fs.writeFileSync(file(dataDir), JSON.stringify(snap));
  return snap;
}

export function readSnapshot(dataDir: string): Snapshot | null {
  try { return JSON.parse(fs.readFileSync(file(dataDir), 'utf8')); } catch { return null; }
}

// shots/index.json stores how a screenshot was revealed as one phrase ("opening “Add Image”", "flow “x”: a › b").
// Older snapshots may hold a list of steps; join those so readers always get a string.
export const revealedOf = (r: unknown): string | null => Array.isArray(r) ? (r.length ? r.join(' › ') : null) : typeof r === 'string' && r ? r : null;
