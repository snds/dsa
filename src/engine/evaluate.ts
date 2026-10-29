import { recovered } from './catalog.js';
import type { Store } from './store.js';
import type { Observation } from './rules.js';
import type { Finding } from './types.js';

/**
 * Apply finding lifecycle to a run's observations.
 *  - breach + no finding         -> open
 *  - breach + open finding       -> update (severity, score, evidence)
 *  - breach + resolved finding   -> reopen
 *  - no breach + open finding    -> hold while inside the hysteresis band, else resolve
 *  - forceResolve                -> resolve now (e.g. rolled into a cluster)
 *  - open finding not observed   -> resolve ("no longer observed": subject gone or below every floor)
 *  - snoozed                     -> stays snoozed until snooze_until passes, then follows the rules above
 * Every transition is written to finding_events, so history is never rewritten.
 */
export interface EvalSummary { opened: string[]; updated: string[]; reopened: string[]; resolved: string[]; held: string[] }

export async function applyObservations(store: Store, runId: string, obs: Observation[], now = new Date()): Promise<EvalSummary> {
  const at = now.toISOString();
  const existing = new Map((await store.all<any>('select * from findings')).map(f => [f.id, f]));
  const sum: EvalSummary = { opened: [], updated: [], reopened: [], resolved: [], held: [] };
  const seen = new Set<string>();
  const event = (id: string, ev: string, detail: object = {}) => store.insertMany('finding_events', ['id', 'run_id', 'ts', 'event', 'detail'], [[id, runId, at, ev, JSON.stringify(detail)]]);

  for (const o of obs) {
    seen.add(o.id);
    const f = existing.get(o.id);
    // Stored timestamps are UTC without a zone suffix; parse them as UTC.
    const snoozed = f?.status === 'snoozed' && f.snooze_until && Date.parse(String(f.snooze_until).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(f.snooze_until)) ? '' : 'Z')) > now.getTime();
    if (o.breach && !o.forceResolve) {
      const d = o.breach;
      if (!f) {
        await store.insertMany('findings', ['id', 'rule', 'subject', 'scope', 'owner', 'repo', 'family', 'severity', 'score', 'title', 'why', 'evidence', 'fix', 'exit', 'affected', 'settings_used', 'status', 'opened_at', 'updated_at', 'metric_value'],
          [[d.id, d.rule, d.subject, d.scope, d.owner, d.repo ?? null, d.family, d.severity, d.score, d.title, d.why, d.evidence, d.fix, d.exit, JSON.stringify(d.affected), JSON.stringify(d.settingsUsed), 'open', at, at, d.metricValue]]);
        await event(d.id, 'opened', { value: o.value });
        sum.opened.push(d.id);
      } else {
        const status = snoozed ? 'snoozed' : 'open';
        await store.exec(`update findings set scope=$2, owner=$3, repo=$4, severity=$5, score=$6, title=$7, why=$8, evidence=$9, fix=$10, exit=$11, affected=$12, settings_used=$13, status=$14, updated_at=$15, resolved_at=null, metric_value=$16 where id=$1`,
          [d.id, d.scope, d.owner, d.repo ?? null, d.severity, d.score, d.title, d.why, d.evidence, d.fix, d.exit, JSON.stringify(d.affected), JSON.stringify(d.settingsUsed), status, at, d.metricValue]);
        if (f.status === 'resolved') { await event(d.id, 'reopened', { value: o.value }); sum.reopened.push(d.id); }
        else { if (f.metric_value !== d.metricValue || f.severity !== d.severity) await event(d.id, 'updated', { from: f.metric_value, to: d.metricValue }); sum.updated.push(d.id); }
      }
      continue;
    }
    if (!f || f.status === 'resolved') continue;
    if (o.forceResolve || recovered(o.metric, o.value)) {
      await store.exec(`update findings set status='resolved', resolved_at=$2, updated_at=$2, metric_value=$3 where id=$1`, [o.id, at, o.value]);
      await event(o.id, 'resolved', { value: o.value, reason: o.forceResolve ?? 'metric recovered past its close threshold' });
      sum.resolved.push(o.id);
    } else {
      await store.exec(`update findings set updated_at=$2, metric_value=$3 where id=$1`, [o.id, at, o.value]);
      sum.held.push(o.id);
    }
  }
  for (const [id, f] of existing) {
    if (seen.has(id) || f.status === 'resolved') continue;
    await store.exec(`update findings set status='resolved', resolved_at=$2, updated_at=$2 where id=$1`, [id, at]);
    await event(id, 'resolved', { reason: 'no longer observed' });
    sum.resolved.push(id);
  }
  return sum;
}

export async function snooze(store: Store, id: string, days: number, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error('A snooze needs a reason, so it can be reviewed later.');
  const rows = await store.all('select id from findings where id=$1', [id]);
  if (!rows.length) throw new Error(`No finding ${id}.`);
  const until = new Date(Date.now() + days * 864e5).toISOString();
  await store.exec(`update findings set status='snoozed', snooze_until=$2, snooze_reason=$3 where id=$1`, [id, until, reason]);
  await store.insertMany('finding_events', ['id', 'run_id', 'ts', 'event', 'detail'], [[id, null, new Date().toISOString(), 'snoozed', JSON.stringify({ days, reason })]]);
}

export function rowToFinding(r: any): Finding {
  return {
    id: r.id, rule: r.rule, subject: r.subject, scope: r.scope, owner: r.owner, repo: r.repo ?? undefined, family: r.family,
    severity: r.severity, score: r.score, title: r.title, why: r.why, evidence: r.evidence, fix: r.fix, exit: r.exit,
    affected: typeof r.affected === 'string' ? JSON.parse(r.affected) : r.affected ?? [],
    settingsUsed: typeof r.settings_used === 'string' ? JSON.parse(r.settings_used) : r.settings_used ?? {},
    status: r.status, openedAt: r.opened_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at, snoozeUntil: r.snooze_until, snoozeReason: r.snooze_reason,
    metricValue: r.metric_value,
  };
}
