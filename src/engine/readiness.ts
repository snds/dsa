import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { Target } from './types.js';
import type { MetricRow } from './metrics.js';
import type { ReadinessProvider, ReadinessRow } from '../profile.js';

/**
 * Agent readiness, from the design system's own agent tools. The profile's readiness provider runs
 * them (an audit that scores how ready each repo is for an agent to build with the system, and any
 * usage checker it has); dsa only picks the repos, stores the rows and raises findings. A system
 * without a provider gets no readiness rows.
 */
export type Readiness = ReadinessRow;

export const TIERS = ['Emerging', 'Invested', 'AI-native'] as const;
export const tierRank = (t: string | undefined) => Math.max(0, TIERS.indexOf((t ?? 'Emerging') as typeof TIERS[number]));

/** Repos worth auditing: the system's own repo (when the provider says the root is it) and every child library or consumer with its own repo. */
export function auditTargets(root: string, config: Config, targets: Target[], provider?: ReadinessProvider): { subject: string; dir: string }[] {
  const internal = new Set(config.internalConsumers ?? []);
  const out = new Map<string, string>();
  if (provider?.isSystemRepo?.(root)) out.set(path.resolve(root), config.designSystem.core.name);
  for (const t of targets) {
    if (t.role === 'core' || internal.has(t.name)) continue;
    const dir = path.resolve(t.dir);
    if (!out.has(dir) && fs.existsSync(path.join(dir, 'package.json'))) out.set(dir, t.name);
  }
  return [...out].map(([dir, subject]) => ({ subject, dir }));
}

/** Audit each repo with the provider. Never throws: a repo that fails is reported in `notes`. */
export async function collectReadiness(root: string, provider: ReadinessProvider | undefined, list: { subject: string; dir: string }[], notes: string[]): Promise<Readiness[]> {
  if (!provider) return [];
  if (!provider.available(root)) { notes.push(provider.missingNote ?? `Agent readiness skipped: ${provider.id} is not available.`); return []; }
  try {
    return await provider.collect(list, notes);
  } catch (e) {
    notes.push(`Agent readiness skipped: ${String((e as Error)?.message ?? e).split('\n')[0]}`);
    return [];
  }
}

/**
 * Metric rows. `agent_readiness` carries the best tier and whether the kit was ever installed, so a drop
 * stays a finding until it recovers (prev = the previous run's details, by subject). A provider's extra
 * rows (a usage checker's errors) follow their repo's readiness row.
 */
export function readinessMetrics(rows: Readiness[], prev: Map<string, any>): MetricRow[] {
  const out: MetricRow[] = [];
  for (const r of rows) {
    const p = prev.get(r.subject) ?? {};
    const bestTier = TIERS[Math.max(tierRank(p.bestTier), tierRank(r.tier))];
    const scope = r.mode === 'host' ? 'consumer' : 'core';
    out.push({ metric_id: 'agent_readiness', scope, subject: r.subject, value: r.score, detail: { tier: r.tier, bestTier, kit: r.kit, hadKit: Boolean(p.hadKit || r.kit), mode: r.mode, checks: r.checks } } as MetricRow);
    for (const m of r.metrics ?? []) out.push({ metric_id: m.metric_id, scope, subject: r.subject, value: m.value, detail: m.detail } as MetricRow);
  }
  return out;
}
