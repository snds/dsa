import crypto from 'node:crypto';
import { grade, type Catalog, type MetricDef, type Settings } from './catalog.js';
import { clusterThreshold } from './settings.js';
import { system } from './system.js';
import type { Config } from './config.js';
import type { MetricRow, ScanData } from './metrics.js';
import type { Finding, LibraryDef, Scope, Severity, Target } from './types.js';

/**
 * Rules turn metrics into OBSERVATIONS: one per subject a rule looked at.
 * An observation carries a draft finding only when the subject breaches.
 * The evaluator (evaluate.ts) applies lifecycle: open, update, hold (hysteresis), resolve.
 *
 * Attribution follows the ladder from the framework, Phase 1 subset:
 *   stale version -> the consumer or child library that is behind
 *   isolated misuse -> the consumer
 *   clustered misuse (>= threshold consumers, same component + override kind) -> the library that owns the component
 *   look-alikes clustered across consumers -> the library (a coverage or docs gap)
 */

export type Draft = Omit<Finding, 'status' | 'openedAt' | 'updatedAt' | 'resolvedAt' | 'snoozeUntil' | 'snoozeReason'>;

export interface Observation {
  id: string;
  rule: string;
  subject: string;
  metric: MetricDef;
  value: number;
  breach: Draft | null;
  /** Resolve even inside the hysteresis band (e.g. rolled into a cluster finding). */
  forceResolve?: string | undefined;
}

export const findingId = (rule: string, subject: string) =>
  'F-' + crypto.createHash('sha1').update(`${rule}|${subject}`).digest('hex').slice(0, 6).toUpperCase();

interface Ctx {
  data: ScanData;
  config: Config;
  catalog: Catalog;
  settings: Settings;
  metrics: MetricRow[];
  prev: Map<string, number>;
  consumers: Target[];
  /** DS-team-owned consumers: scored, but excluded from cluster counts. */
  internal: Set<string>;
}

const lib = (config: Config, name: string): LibraryDef | undefined =>
  [config.designSystem.core, ...(config.designSystem.children ?? [])].find(l => l.name === name);

function libScope(config: Config, libName: string): Scope {
  return libName === config.designSystem.core.name ? 'core' : 'child';
}

function sevFor(g: 'act' | 'watch', sampled = false): Severity {
  if (sampled) return g === 'act' ? 'warn' : 'watch';
  return g === 'act' ? 'serious' : 'warn';
}

/** 0-100. Grade sets the base, family weight scales it, reach and a worsening trend add to it. */
function scoreOf(ctx: Ctx, g: 'act' | 'watch', family: string, affected: number, worse: boolean): number {
  const w = ctx.settings.severity_weights?.[family] ?? 0.7;
  const reach = ctx.consumers.length ? affected / ctx.consumers.length : 0;
  return Math.min(100, Math.round((g === 'act' ? 62 : 40) * w + 30 * reach + (worse ? 6 : 0)));
}

function worsened(ctx: Ctx, m: MetricDef, subject: string, value: number): boolean {
  const p = ctx.prev.get(`${m.id}|${subject}`);
  if (p === undefined) return false;
  return m.direction === 'down' ? value > p : value < p;
}

const settingsUsed = (ctx: Ctx, component?: string) => ({
  misuse_cluster_threshold: component ? clusterThreshold(ctx.settings, component) : ctx.settings.misuse_cluster_threshold,
  sample_floor_instances: ctx.settings.sample_floor_instances,
});

export function runRules(data: ScanData, config: Config, catalog: Catalog, settings: Settings, metrics: MetricRow[], prev: Map<string, number>): Observation[] {
  const ctx: Ctx = { data, config, catalog, settings, metrics, prev, consumers: data.targets.filter(t => t.role === 'consumer'), internal: new Set() };
  ctx.internal = new Set(config.internalConsumers ?? []);
  return [...versionRule(ctx), ...pinRule(ctx), ...misuseRule(ctx), ...lookalikeRule(ctx), ...tokenRule(ctx), ...deprecationRule(ctx), ...figmaRule(ctx), ...readinessRule(ctx)];
}

const targetOf = (ctx: Ctx, name: string) => ctx.data.targets.find(t => t.name === name);
/** A child library is routed as a child library, not as a consumer. */
const roleScope = (ctx: Ctx, name: string): Scope => (targetOf(ctx, name)?.role === 'child' ? 'child' : 'consumer');
const ownerOfTarget = (ctx: Ctx, name: string) => { const t = targetOf(ctx, name); return { owner: t?.owner ?? name, repo: t?.repo ?? (t?.role === 'child' ? lib(ctx.config, name)?.repo : undefined) }; };
const ownerOfLib = (ctx: Ctx, libName: string, component?: string) => {
  const l = lib(ctx.config, libName);
  return { owner: component ? `${libName} · ${component}` : libName, repo: l?.repo ?? ctx.config.github?.defaultRepo };
};
const metricsOf = (ctx: Ctx, id: string, scope?: string) => ctx.metrics.filter(m => m.metric_id === id && (!scope || m.scope === scope));

// ---------- version currency ----------
function versionRule(ctx: Ctx): Observation[] {
  const m = ctx.catalog.byId.get('version_currency')!;
  return metricsOf(ctx, 'version_currency').map(row => {
    const id = findingId('version-currency', row.subject);
    const g = grade(m, row.value);
    const pkgs = (row.detail.packages as any[]).filter(p => (p.majorsBehind ?? 0) > 0);
    if (!g) return { id, rule: 'version-currency', subject: row.subject, metric: m, value: row.value, breach: null };
    const t = targetOf(ctx, row.subject)!;
    // A child library's lag is inherited by everyone who consumes it.
    const childPkgs = t.role === 'child' ? (lib(ctx.config, t.name)?.packages ?? []) : [];
    const downstream = childPkgs.length ? ctx.consumers.filter(c => childPkgs.some(p => p in c.deps)).map(c => c.name) : [];
    const affected = [row.subject, ...downstream];
    const lead = pkgs[0];
    const { owner, repo } = ownerOfTarget(ctx, row.subject);
    return {
      id, rule: 'version-currency', subject: row.subject, metric: m, value: row.value,
      breach: {
        id, rule: 'version-currency', subject: row.subject, scope: t.role === 'child' ? 'child' : 'consumer', owner, repo, family: 'adoption',
        severity: sevFor(g), score: scoreOf(ctx, g, 'adoption', affected.length, worsened(ctx, m, row.subject, row.value)),
        title: `Upgrade ${row.subject} to the latest ${lead.library} major (${row.value} behind)`,
        why: t.role === 'child'
          ? `${row.subject} is pinned behind core, so its ${downstream.length} consumer(s) miss every core fix until it rebases.`
          : `${row.subject} is ${row.value} major version(s) behind, so fixes shipped since then don't reach it.`,
        evidence: pkgs.map(p => `${p.pkg}: ${p.resolved ?? '?'} (declared ${p.declared}), latest ${p.latest}`).join('; '),
        fix: `Bump ${pkgs.map(p => `${p.pkg} to ^${p.latest}`).join(', ')} and run the codemod for each skipped major.`,
        exit: 'On the latest major of every DS package it uses.',
        affected, settingsUsed: settingsUsed(ctx), metricValue: row.value,
      },
    };
  });
}

// ---------- pin currency (SHA-pinned consumers) ----------
function pinRule(ctx: Ctx): Observation[] {
  const m = ctx.catalog.byId.get('pin_currency_days')!;
  return metricsOf(ctx, 'pin_currency_days').map(row => {
    const id = findingId('pin-currency', row.subject);
    const g = grade(m, row.value);
    if (!g) return { id, rule: 'pin-currency', subject: row.subject, metric: m, value: row.value, breach: null };
    const t = targetOf(ctx, row.subject)!;
    const { owner, repo } = ownerOfTarget(ctx, row.subject);
    return {
      id, rule: 'pin-currency', subject: row.subject, metric: m, value: row.value,
      breach: {
        id, rule: 'pin-currency', subject: row.subject, scope: t.role === 'child' ? 'child' : 'consumer', owner, repo, family: 'adoption',
        severity: sevFor(g), score: scoreOf(ctx, g, 'adoption', 1, worsened(ctx, m, row.subject, row.value)),
        title: `Bump ${row.subject}'s ${row.detail.pinFile} (${row.value} days, ${row.detail.commitsBehind} commits behind ${ctx.config.designSystem.core.name})`,
        why: `${row.subject} consumes ${ctx.config.designSystem.core.name} at a pinned commit, so nothing merged since reaches it.`,
        evidence: `Pinned ${row.detail.pinned}; latest ${row.detail.latest}; ${row.detail.commitsBehind} commits and ${row.value} days apart.`,
        fix: `Check the pin-eligibility list on the latest main, then bump ${row.detail.pinFile} in a separate host change.`,
        exit: `Pin within ${m.thresholds?.watch} days of main.`,
        affected: [row.subject], settingsUsed: settingsUsed(ctx), metricValue: row.value,
      },
    };
  });
}

// ---------- misuse: isolated vs clustered ----------
function misuseRule(ctx: Ctx): Observation[] {
  const m = ctx.catalog.byId.get('correct_use_rate')!;
  const rows = metricsOf(ctx, 'correct_use_rate', 'component');
  const floor = ctx.settings.sample_floor_instances;
  const breaching = rows.filter(r => (r.detail.instances as number) >= floor && grade(m, r.value));
  const out: Observation[] = [];
  const clustered = new Set<string>(); // target|component pairs rolled into a cluster

  // Group breaching targets by component + override kind.
  const byCompKind = new Map<string, MetricRow[]>();
  for (const r of breaching) for (const k of Object.keys(r.detail.kinds as object)) {
    const key = `${r.detail.component}|${k}`;
    if (!byCompKind.has(key)) byCompKind.set(key, []);
    byCompKind.get(key)!.push(r);
  }
  const clusterMetric: MetricDef = { ...m, id: 'misuse_cluster_size', direction: 'down', thresholds: { watch: 0, act: 0 } };
  for (const [key, rs] of byCompKind) {
    const [component, kind] = key.split('|') as [string, string];
    const threshold = clusterThreshold(ctx.settings, component);
    const id = findingId('misuse-cluster', key);
    const cm: MetricDef = { ...clusterMetric, thresholds: { watch: threshold, act: threshold } };
    const external = rs.filter(r => !ctx.internal.has(r.detail.target as string));
    if (external.length < threshold) { out.push({ id, rule: 'misuse-cluster', subject: key, metric: cm, value: external.length, breach: null }); continue; }
    for (const r of rs) clustered.add(`${r.detail.target}|${component}`);
    const library = rs[0]!.detail.library as string;
    const total = rs.reduce((a, r) => a + ((r.detail.kinds as any)[kind] ?? 0), 0);
    const { owner, repo } = ownerOfLib(ctx, library, component);
    const targets = rs.map(r => r.detail.target as string);
    out.push({
      id, rule: 'misuse-cluster', subject: key, metric: cm, value: external.length,
      breach: {
        id, rule: 'misuse-cluster', subject: key, scope: libScope(ctx.config, library), owner, repo, family: 'fidelity',
        severity: 'serious', score: scoreOf(ctx, 'act', 'fidelity', rs.length, false),
        title: `${component}: ${external.length} consumers override it with ${kind} — likely an API or docs gap`,
        why: `${external.length} consumers (threshold ${threshold}${rs.length > external.length ? `; ${rs.length - external.length} internal app(s) also do it` : ''}) override ${component} the same way. Misuse at this scale points at the component, so it routes to ${library}.`,
        evidence: `${total} ${kind} overrides on ${component} across ${targets.join(', ')}. Examples: ${rs.flatMap(r => (r.detail.examples as string[]).slice(0, 2)).slice(0, 4).join(', ')}`,
        fix: `Find out what the overrides are doing (sample the examples), then add a variant or prop for it, document it, and ship a codemod that removes the overrides.`,
        exit: `Fewer than ${threshold} consumers override ${component} with ${kind}.`,
        affected: targets, settingsUsed: settingsUsed(ctx, component), metricValue: external.length,
      },
    });
  }

  // Isolated misuse: one finding per target x component, unless it's part of a cluster.
  for (const r of rows) {
    const target = r.detail.target as string;
    const component = r.detail.component as string;
    const subject = `${target}|${component}`;
    const id = findingId('misuse-isolated', subject);
    const g = (r.detail.instances as number) >= floor ? grade(m, r.value) : null;
    if (clustered.has(subject)) { out.push({ id, rule: 'misuse-isolated', subject, metric: m, value: r.value, breach: null, forceResolve: 'rolled into a cluster finding routed to the component owner' }); continue; }
    if (!g) { out.push({ id, rule: 'misuse-isolated', subject, metric: m, value: r.value, breach: null }); continue; }
    const kinds = Object.entries(r.detail.kinds as Record<string, number>).map(([k, n]) => `${n} ${k}`).join(', ');
    const { owner, repo } = ownerOfTarget(ctx, target);
    out.push({
      id, rule: 'misuse-isolated', subject, metric: m, value: r.value,
      breach: {
        id, rule: 'misuse-isolated', subject, scope: roleScope(ctx, target), owner, repo, family: 'fidelity',
        severity: sevFor(g), score: scoreOf(ctx, g, 'fidelity', 1, worsened(ctx, m, subject, r.value)),
        title: `Remove overrides on ${component} in ${target} (${r.value}% used as intended)`,
        why: `Below the cluster threshold of ${clusterThreshold(ctx.settings, component)} consumers, so ${target} owns the fix.`,
        evidence: `${r.detail.overridden} of ${r.detail.instances} instances overridden (${kinds}). Examples: ${(r.detail.examples as string[]).join(', ')}`,
        fix: `Replace the overrides with documented props, variants, or spacing tokens. If none fit, raise it with the design system team.`,
        exit: `${component} used as intended in at least ${m.thresholds?.close ?? m.thresholds?.watch}% of instances.`,
        affected: [target], settingsUsed: settingsUsed(ctx, component), metricValue: r.value,
      },
    });
  }
  return out;
}

// ---------- look-alikes ----------
function lookalikeRule(ctx: Ctx): Observation[] {
  const m = ctx.catalog.byId.get('custom_ratio')!;
  const floor = ctx.settings.sample_floor_instances;
  const rows = metricsOf(ctx, 'custom_ratio', 'component');
  const breach = (r: MetricRow) => (r.detail.lookalikes as number) + (r.detail.instances as number) >= floor && grade(m, r.value);
  const out: Observation[] = [];
  const byComp = new Map<string, MetricRow[]>();
  for (const r of rows.filter(breach)) { const c = r.detail.component as string; if (!byComp.has(c)) byComp.set(c, []); byComp.get(c)!.push(r); }
  const clustered = new Set<string>();
  for (const [component, rs] of byComp) {
    const threshold = clusterThreshold(ctx.settings, component);
    const id = findingId('coverage-gap', component);
    const cm: MetricDef = { ...m, id: 'lookalike_cluster_size', direction: 'down', thresholds: { watch: threshold, act: threshold } };
    const external = rs.filter(r => !ctx.internal.has(r.detail.target as string));
    if (external.length < threshold) { out.push({ id, rule: 'coverage-gap', subject: component, metric: cm, value: external.length, breach: null }); continue; }
    rs.forEach(r => clustered.add(r.subject));
    const libName = ctx.data.instances.find(i => i.component === component)?.library ?? ctx.config.designSystem.core.name;
    const { owner, repo } = ownerOfLib(ctx, libName, component);
    const n = rs.reduce((a, r) => a + (r.detail.lookalikes as number), 0);
    out.push({
      id, rule: 'coverage-gap', subject: component, metric: cm, value: external.length,
      breach: {
        id, rule: 'coverage-gap', subject: component, scope: libScope(ctx.config, libName), owner, repo, family: 'adoption',
        severity: 'serious', score: scoreOf(ctx, 'act', 'adoption', rs.length, false),
        title: `${external.length} consumers hand-build ${component} with raw elements — coverage or docs gap`,
        why: `When ${threshold}+ teams build their own ${component}, the system's version is probably missing something they need.`,
        evidence: `${n} raw <${[...new Set(rs.flatMap(r => r.detail.elements as string[]))].join('>, <')}> across ${rs.map(r => r.detail.target).join(', ')}. Examples: ${rs.flatMap(r => (r.detail.examples as string[]).slice(0, 2)).slice(0, 4).join(', ')}`,
        fix: `Sample the look-alikes to see what they do that ${component} doesn't. Close the gap, then ship a migration guide or codemod.`,
        exit: `Fewer than ${threshold} consumers above the look-alike threshold for ${component}.`,
        affected: rs.map(r => r.detail.target as string), settingsUsed: settingsUsed(ctx, component), metricValue: external.length,
      },
    });
  }
  for (const r of rows) {
    const target = r.detail.target as string;
    const component = r.detail.component as string;
    const id = findingId('lookalike', r.subject);
    if (clustered.has(r.subject)) { out.push({ id, rule: 'lookalike', subject: r.subject, metric: m, value: r.value, breach: null, forceResolve: 'rolled into a coverage-gap finding' }); continue; }
    const g = breach(r) ? grade(m, r.value) : null;
    if (!g) { out.push({ id, rule: 'lookalike', subject: r.subject, metric: m, value: r.value, breach: null }); continue; }
    const { owner, repo } = ownerOfTarget(ctx, target);
    out.push({
      id, rule: 'lookalike', subject: r.subject, metric: m, value: r.value,
      breach: {
        id, rule: 'lookalike', subject: r.subject, scope: roleScope(ctx, target), owner, repo, family: 'adoption',
        severity: sevFor(g), score: scoreOf(ctx, g, 'adoption', 1, worsened(ctx, m, r.subject, r.value)),
        title: `Replace ${r.detail.lookalikes} raw <${(r.detail.elements as string[]).join('>, <')}> with ${component} in ${target}`,
        why: `${r.value}% of ${component}-like UI in ${target} is hand-built, so it misses the system's fixes and accessibility work.`,
        evidence: `${r.detail.lookalikes} raw elements vs ${r.detail.instances} ${component} instances. Examples: ${(r.detail.examples as string[]).join(', ')}`,
        fix: `Swap the raw elements for ${component}. If ${component} can't do what they need, say so in the issue so it can be routed to the system team.`,
        exit: `Under ${m.thresholds?.close ?? m.thresholds?.watch}% hand-built.`,
        affected: [target], settingsUsed: settingsUsed(ctx, component), metricValue: r.value,
      },
    });
  }
  return out;
}

// ---------- tokens ----------
function tokenRule(ctx: Ctx): Observation[] {
  const m = ctx.catalog.byId.get('token_compliance_new_code')!;
  return metricsOf(ctx, 'token_compliance_new_code').map(row => {
    const id = findingId('token-compliance', row.subject);
    const total = (row.detail.rawValues as number) + (row.detail.tokenRefs as number);
    const g = total >= ctx.settings.sample_floor_instances ? grade(m, row.value) : null;
    if (!g) return { id, rule: 'token-compliance', subject: row.subject, metric: m, value: row.value, breach: null };
    const { owner, repo } = ownerOfTarget(ctx, row.subject);
    return {
      id, rule: 'token-compliance', subject: row.subject, metric: m, value: row.value,
      breach: {
        id, rule: 'token-compliance', subject: row.subject, scope: targetOf(ctx, row.subject)?.role === 'child' ? 'child' : 'consumer', owner, repo, family: 'adoption',
        severity: sevFor(g), score: scoreOf(ctx, g, 'adoption', 1, worsened(ctx, m, row.subject, row.value)),
        title: `Replace ${row.detail.rawValues} hard-coded style values in new ${row.subject} code (${row.value}% tokens)`,
        why: `Hard-coded values in recently changed files won't follow theme, brand, or accessibility changes.`,
        evidence: `${row.detail.rawValues} raw values vs ${row.detail.tokenRefs} token references in ${row.detail.newFiles} recently changed files. Worst: ${(row.detail.worstFiles as string[]).join(', ')}`,
        fix: `Swap raw colors for semantic tokens; a token codemod can handle exact matches.`,
        exit: `At least ${m.thresholds?.close ?? m.thresholds?.watch}% token usage in new code.`,
        affected: [row.subject], settingsUsed: settingsUsed(ctx), metricValue: row.value,
      },
    };
  });
}

// ---------- deprecations ----------
function deprecationRule(ctx: Ctx): Observation[] {
  const m = ctx.catalog.byId.get('deprecation_burndown')!;
  return metricsOf(ctx, 'deprecation_burndown').map(row => {
    const id = findingId('deprecated', row.subject);
    const g = grade(m, row.value);
    if (!g) return { id, rule: 'deprecated', subject: row.subject, metric: m, value: row.value, breach: null };
    const repl = row.detail.replacements as Record<string, string>;
    const { owner, repo } = ownerOfTarget(ctx, row.subject);
    return {
      id, rule: 'deprecated', subject: row.subject, metric: m, value: row.value,
      breach: {
        id, rule: 'deprecated', subject: row.subject, scope: roleScope(ctx, row.subject), owner, repo, family: 'flow',
        severity: sevFor(g), score: scoreOf(ctx, g, 'flow', 1, worsened(ctx, m, row.subject, row.value)),
        title: `Migrate ${row.value} deprecated component use(s) in ${row.subject}`,
        why: `Deprecated components stop getting fixes and block their removal for everyone.`,
        evidence: Object.entries(row.detail.byComponent as Record<string, number>).map(([c, n]) => `${n}× ${c}`).join(', ') + `. Examples: ${(row.detail.examples as string[]).join(', ')}`,
        fix: Object.entries(repl).map(([c, r]) => `${c} → ${r}`).join('; '),
        exit: 'No deprecated components left.',
        affected: [row.subject], settingsUsed: settingsUsed(ctx), metricValue: row.value,
      },
    };
  });
}

// ---------- Figma look-alike frames (sampled detach proxy) ----------
function figmaRule(ctx: Ctx): Observation[] {
  const m = ctx.catalog.byId.get('figma_detach_rate')!;
  return metricsOf(ctx, 'figma_detach_rate').map(row => {
    const id = findingId('figma-lookalike', row.subject);
    const total = (row.detail.instances as number) + (row.detail.lookalikeFrames as number);
    const g = total >= ctx.settings.sample_floor_instances ? grade(m, row.value) : null;
    if (!g) return { id, rule: 'figma-lookalike', subject: row.subject, metric: m, value: row.value, breach: null };
    const library = row.detail.library as string;
    const component = row.detail.component as string;
    const { owner, repo } = ownerOfLib(ctx, library, component);
    return {
      id, rule: 'figma-lookalike', subject: row.subject, metric: m, value: row.value,
      breach: {
        id, rule: 'figma-lookalike', subject: row.subject, scope: libScope(ctx.config, library), owner, repo, family: 'fidelity',
        severity: sevFor(g, true), score: scoreOf(ctx, g, 'fidelity', 0, worsened(ctx, m, row.subject, row.value)),
        title: `Find out why ${component} is rebuilt as plain frames in Figma (${row.value}% of uses)`,
        why: `Frames named like ${component} with no component link are usually detaches. Sometimes intentional, so sample before changing anything. (Sampled: name-based proxy.)`,
        evidence: `${row.detail.lookalikeFrames} look-alike frames vs ${row.detail.instances} instances. Files: ${(row.detail.files as string[]).slice(0, 5).join(', ')}`,
        fix: `Open a few of the files, log why each was detached, and fix the most common reason (often a missing slot or variant).`,
        exit: `Under ${m.thresholds?.watch}% look-alike frames.`,
        affected: [], settingsUsed: settingsUsed(ctx, component), metricValue: row.value,
      },
    };
  });
}

// ---------- agent readiness: a repo dropped a tier, or lost its agent kit ----------
const TIER_ORDER = ['Emerging', 'Invested', 'AI-native'];
function readinessRule(ctx: Ctx): Observation[] {
  const m = ctx.catalog.byId.get('agent_readiness');
  if (!m) return [];
  return metricsOf(ctx, 'agent_readiness').map(row => {
    const id = findingId('agent-readiness', row.subject);
    const d = row.detail as { tier: string; bestTier: string; kit: boolean; hadKit: boolean; checks: { id: string; title: string; score: number; fixes: string[] }[] };
    const dropped = TIER_ORDER.indexOf(d.tier) < TIER_ORDER.indexOf(d.bestTier);
    const lostKit = d.hadKit && !d.kit;
    if (!dropped && !lostKit) return { id, rule: 'agent-readiness', subject: row.subject, metric: m, value: row.value, breach: null };
    const core = row.scope === 'core';
    const { owner, repo } = core ? ownerOfLib(ctx, ctx.config.designSystem.core.name) : ownerOfTarget(ctx, row.subject);
    const g: 'act' | 'watch' = lostKit || TIER_ORDER.indexOf(d.tier) === 0 ? 'act' : 'watch';
    const weakest = [...d.checks].sort((a, b) => a.score - b.score).slice(0, 2);
    return {
      id, rule: 'agent-readiness', subject: row.subject, metric: m, value: row.value,
      breach: {
        id, rule: 'agent-readiness', subject: row.subject, scope: core ? 'core' : roleScope(ctx, row.subject), owner, repo, family: 'experience',
        severity: sevFor(g), score: scoreOf(ctx, g, 'experience', 1, worsened(ctx, m, row.subject, row.value)),
        title: lostKit ? `Reinstall the ${system().label} agent kit in ${row.subject}` : `${row.subject} dropped from ${d.bestTier} to ${d.tier} agent readiness (${row.value}/100)`,
        why: lostKit ? 'Without the kit (AGENTS.md section, MCP registration, skill, Cursor rule), agents in this repo stop reading the design system before they write UI.'
          : 'Agents in this repo now get less help from the design system than they did, so expect more invented components and raw elements.',
        evidence: `Score ${row.value}/100 (${d.tier}). Weakest checks: ${weakest.map(c => `${c.title} ${c.score}`).join(', ')}.`,
        fix: [...new Set(weakest.flatMap(c => c.fixes))].slice(0, 3).join(' · ') || (system().profile.readiness?.setupHint ?? 'Install the design system\'s agent kit in the repo.'),
        exit: lostKit ? 'The enablement check is back at 80 or more.' : `Back to ${d.bestTier}.`,
        affected: [row.subject], settingsUsed: settingsUsed(ctx), metricValue: row.value,
      },
    };
  });
}
