import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog, withMetrics } from './catalog.js';
import { appSettings, readExceptions, type Config } from './config.js';
import { defaultExcludes, globMatch, targetRelative } from './paths.js';
import type { Store, StoreFactory } from './store.js';
import { effectiveSettings } from './settings.js';
import { resolveTargets, latestVersions } from './workspaces.js';
import { scanVersions, scanPins } from './scanners/versions.js';
import { scanCode } from './scanners/code.js';
import { scanTokens, gitTouchedFiles } from './scanners/tokens.js';
import { loadHints } from './hints.js';
import { auditTargets, collectReadiness, readinessMetrics } from './readiness.js';
import { computeMetrics, type MetricRow, type ScanData } from './metrics.js';
import { runRules } from './rules.js';
import { applyObservations, type EvalSummary } from './evaluate.js';
import { materializeRemotes } from './remotes.js';
import { buildGraph, reachFor, type Reach } from './reach.js';
import { readPagePlacement } from './placement.js';
import { evaluateRows, loadRoleMap, readDecisions, ruleStats, DEFAULT_THRESHOLD, type ElementEval } from './elements.js';
import { resetFeatureCaches } from './scanners/features.js';
import { buildSignatures, signatureSummary, type SignatureSet } from './signatures.js';
import { resetSystemIndex } from './host-context.js';
import { useSystem } from './system.js';
import type { ResolvedProfile } from '../profile.js';
import type { Lookalike, Target } from './types.js';

/**
 * A step an add-on adds to `dsa run`. "scan" stages run after the code scan and before metrics (a
 * Figma crawl adds its rows to `data.figma`); "metrics" stages run after metrics, with the store open,
 * and may push rows to `metrics`. A stage that fails costs only itself: the run notes it and goes on.
 */
export interface PipelineStage {
  id: string;
  phase: 'scan' | 'metrics';
  run(ctx: StageContext): Promise<void> | void;
}

export interface StageContext {
  root: string;
  dataDir: string;
  config: Config;
  profile: ResolvedProfile;
  data: ScanData;
  /** Metric rows so far ("metrics" stages only; empty before). */
  metrics: MetricRow[];
  /** The previous run's metric rows, by "metric_id|subject" ("metrics" stages only). */
  previous: Map<string, { value: number; detail: unknown }>;
  /** Open store ("metrics" stages only). */
  store?: Store | undefined;
  /** Merged into the run's `sources` record (e.g. { figma: true, figmaDiag }). */
  sources: Record<string, unknown>;
  notes: string[];
  now: Date;
  log: (msg: string) => void;
  /** Options the CLI passed through for add-ons (e.g. { figma: false }). */
  options: Record<string, unknown>;
}

export interface RunOptions {
  root: string;
  dataDir: string;
  /** The engine config (engineConfig() builds it from dsa.config.json and the profile). */
  config: Config;
  /** The system's profile. */
  profile: ResolvedProfile;
  /** Opens the run history (the history add-on supplies a DuckDB one). */
  store: StoreFactory;
  /** Where dsa.hints.json lives: the config's folder (default: root). */
  configDir?: string | undefined;
  /** Add-on stages, run in order within their phase. */
  stages?: PipelineStage[] | undefined;
  /** Passed to stages as ctx.options. */
  stageOptions?: Record<string, unknown> | undefined;
  registry?: boolean | undefined;
  /** Always use git clones for targets that declare a git source, even when a local path exists. */
  remote?: boolean | undefined;
  /** false = ignore git history (every file counts as new code). Tests use this for determinism. */
  git?: boolean | undefined;
  now?: Date | undefined;
  log?: (msg: string) => void | undefined;
  /** false = skip the profile's agent-readiness provider. */
  readiness?: boolean | undefined;
}

export interface RunResult {
  runId: string;
  data: ScanData;
  summary: EvalSummary;
  notes: string[];
}

/** The design system's core packages, by folder and published name. */
function corePackages(targets: Target[]) {
  return targets.filter(t => t.role === 'core').map(t => ({ dir: t.dir, name: (JSON.parse(fs.readFileSync(path.join(t.dir, 'package.json'), 'utf8')).name as string) ?? t.name }));
}

/** Set the system for this run and drop caches from the last one. */
function begin(config: Config, profile: ResolvedProfile) {
  useSystem(profile, [config.designSystem.core, ...(config.designSystem.children ?? [])].flatMap(l => l.packages));
  resetFeatureCaches();
  resetSystemIndex();
}

async function runStages(stages: PipelineStage[] | undefined, phase: PipelineStage['phase'], ctx: StageContext) {
  for (const st of stages ?? []) {
    if (st.phase !== phase) continue;
    try { await st.run(ctx); } catch (e) { ctx.notes.push(`${st.id} skipped: ${String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 200)}`); }
  }
}

/** scan -> metrics -> rules -> finding lifecycle, all in one run id. */
export async function runPipeline(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const { config, notes: remoteNotes } = materializeRemotes(opts.config, opts.root, opts.dataDir, opts.remote, log);
  const catalog = withMetrics(loadCatalog(), opts.profile.metrics);
  const settings = effectiveSettings(catalog, config, opts.dataDir);
  const excludes = [...defaultExcludes(opts.root), ...(config.exclude ?? []).map(e => path.resolve(opts.root, e))];
  const notes: string[] = [...remoteNotes];

  begin(config, opts.profile);
  const targets = resolveTargets(opts.root, config);
  const roleMap = loadRoleMap(opts.root, config);
  const threshold = config.review?.threshold ?? DEFAULT_THRESHOLD;
  const hints = loadHints(opts.configDir ?? opts.root).hints;
  const decisionFiles = new Map(targets.filter(t => t.role !== 'core').map(t => [t.name, readDecisions(t.dir, config.rawElementDecisions)]));
  const stats = ruleStats([...decisionFiles.values()]);
  const evals: ElementEval[] = [];
  // What the crawler saw around each element last time (landmarks, live ARIA, geometry).
  const page = readPagePlacement(opts.dataDir);
  // Component signatures straight from the core packages' source: structure, props, tokens.
  let sigs: SignatureSet | undefined;
  try {
    sigs = buildSignatures(corePackages(targets));
    fs.mkdirSync(opts.dataDir, { recursive: true });
    fs.writeFileSync(path.join(opts.dataDir, 'signatures.json'), JSON.stringify(signatureSummary(sigs), null, 1));
    // Token aliases and root values, so fit scores can be computed later without rebuilding signatures.
    fs.writeFileSync(path.join(opts.dataDir, 'signatures.set.json'), JSON.stringify({ aliases: [...sigs.aliases], values: [...sigs.values] }));
    log(`Signatures: ${sigs.components.size} components, ${[...sigs.components.values()].reduce((a, c) => a + c.sigs.length, 0)} variant × size combinations, ${sigs.aliases.size} token aliases`);
  } catch (e: any) { notes.push(`Component signatures unavailable: ${String(e?.message ?? e).slice(0, 160)}`); }
  log(`Targets: ${[...new Set(targets.map(t => `${t.name} (${t.role})`))].join(', ') || 'none'}`);
  if (!targets.some(t => t.role === 'consumer')) notes.push('No consumers found. Add "consumers" to dsa.config.json, or check that workspaces depend on the DS packages.');

  const latest = latestVersions(opts.root, config, opts.registry);
  const { rows: versions, lockfile } = scanVersions(opts.root, config, targets, latest);
  const pins = scanPins(opts.root, config, targets);
  versions.push(...pins.rows);
  // Per-app switches: an app with versions off drops out of currency metrics.
  for (let i = versions.length - 1; i >= 0; i--) if (!appSettings(config, versions[i]!.target).versions) versions.splice(i, 1);
  notes.push(...pins.notes);
  log(`Versions: ${versions.length} dependency rows (lockfile: ${lockfile})`);
  if (lockfile === 'none') notes.push('No lockfile found; resolved versions fall back to the minimum of each declared range.');
  const missingLatest = Object.entries(latest).filter(([, v]) => !v).map(([k]) => k);
  if (missingLatest.length) notes.push(`Latest version unknown for ${missingLatest.join(', ')} (not a workspace here). Re-run with --registry to ask npm.`);

  const data: ScanData = { targets, versions, instances: [], lookalikes: [], tokens: [], figma: [], figmaCrawled: false, elementEvals: evals };
  // Each target can sit in its own repo, so "new code" comes from that repo's history.
  const touchedCache = new Map<string, Set<string> | null>();
  const touchedFor = (dir: string) => {
    if (opts.git === false) return null;
    if (!touchedCache.has(dir)) touchedCache.set(dir, gitTouchedFiles(dir, settings.new_code_days));
    return touchedCache.get(dir)!;
  };
  const touched = touchedFor(opts.root);
  if (!touched) notes.push('Git history not available; every file counts as new code for token compliance.');
  for (const t of targets.filter(t => t.role !== 'core')) {
    const tEx = [...excludes, ...(t.exclude ?? [])];
    const app = appSettings(config, t.name);
    const res = scanCode(opts.root, config, t, tEx);
    if (app.components) data.instances.push(...res.instances);
    if (app.lookalikes) {
      const { kept: keptEx, exceptionOf } = exceptLookalikes(opts.root, config, t, res.lookalikes, notes, now);
      // Reachability: unused files come out of the counts (delete them instead of migrating);
      // everything else gets the trace of what it takes to see it.
      const reachOf = new Map<Lookalike, Reach>();
      try {
        const graph = buildGraph(t.dir, tEx, t.aliases);
        for (const r of res.lookalikes) if (r.features?.framework === 'react') reachOf.set(r, reachFor(graph, path.join(t.dir, targetRelative(opts.root, r.file, t.dir)), r.line, r.features.context.gates ?? []));
        if (!graph.ok) notes.push(`${t.name}: no app entry point found (index.html script or Next pages), so unused-code detection is off.`);
      } catch (e: any) { notes.push(`${t.name}: reachability skipped: ${String(e?.message ?? e).split('\n')[0]}`); }
      const unused = keptEx.filter(r => reachOf.get(r)?.status === 'unused');
      for (const r of unused) exceptionOf.set(r, 'unused');
      const kept = keptEx.filter(r => !unused.includes(r));
      if (unused.length) notes.push(`${t.name}: ${unused.length} look-alike${unused.length === 1 ? '' : 's'} in ${new Set(unused.map(r => r.file)).size} unused file${new Set(unused.map(r => r.file)).size === 1 ? '' : 's'} (nothing the app renders imports them): not counted; delete rather than migrate.`);
      data.lookalikes.push(...kept);
      // Evaluate everything, exceptions included: the review shows deferred debt too, flagged as such.
      evals.push(...evaluateRows({ root: opts.root, target: t, rows: res.lookalikes, exceptionOf, reachOf, map: roleMap, decisions: decisionFiles.get(t.name)!, stats, threshold, sigs, pageOf: id => page.get(id), hints, labPaths: config.review?.labPaths }));
    }
    for (const e of res.parseErrors.slice(0, 3)) notes.push(`Parse error skipped in ${e.file}: ${e.message}`);
    if (app.tokens) {
      // tokenSkip globs are relative to the app's own folder.
      const rel = (f: string) => targetRelative(opts.root, f, t.dir);
      data.tokens.push(...scanTokens(config, t, tEx, touchedFor(t.dir), opts.root).filter(r => !app.tokenSkip.some(g => globMatch(g, rel(r.file)))));
    }
    const off = (['versions', 'components', 'lookalikes', 'tokens'] as const).filter(k => !app[k]);
    if (off.length) log(`  ${t.name}: not measuring ${off.join(', ')}`);
    log(`  ${t.name}${t.remote ? ' (remote clone)' : ''}: ${res.filesScanned} files, ${res.instances.length} DS instances${res.shimModules ? ` (via ${res.shimModules} local shim modules)` : ''}, ${res.lookalikes.length} look-alikes`);
  }

  // Add-on stages (a Figma crawl) add to the scan before metrics. A stage's problem never costs the code scan.
  const sources: Record<string, unknown> = {};
  const stageCtx: StageContext = { root: opts.root, dataDir: opts.dataDir, config, profile: opts.profile, data, metrics: [], previous: new Map(), sources, notes, now, log, options: opts.stageOptions ?? {} };
  await runStages(opts.stages, 'scan', stageCtx);

  const metrics = computeMetrics(data, config);
  const store = await opts.store(opts.dataDir);
  try {
    const prevRun = await store.latestRunId();
    const prev = new Map<string, number>();
    const prevReady = new Map<string, any>();
    const previous = new Map<string, { value: number; detail: unknown }>();
    if (prevRun) for (const r of await store.all<any>('select metric_id, subject, value, detail from metrics where run_id=$1', [prevRun])) {
      const detail = typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail;
      prev.set(`${r.metric_id}|${r.subject}`, r.value);
      previous.set(`${r.metric_id}|${r.subject}`, { value: r.value, detail });
      if (r.metric_id === 'agent_readiness') prevReady.set(r.subject, detail);
    }
    // Agent readiness from the profile's provider, for the core and every host repo.
    const provider = opts.profile.readiness;
    if (opts.readiness !== false && provider) {
      const ready = await collectReadiness(opts.root, provider, auditTargets(opts.root, config, targets, provider), notes);
      metrics.push(...readinessMetrics(ready, prevReady));
      if (ready.length) log(`Agent readiness: ${ready.map(r => `${r.subject} ${r.score} (${r.tier})`).join(', ')}`);
    }
    Object.assign(stageCtx, { metrics, previous, store });
    await runStages(opts.stages, 'metrics', stageCtx);

    const runId = `R-${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`;
    await store.insertMany('runs', ['run_id', 'taken_at', 'host_root', 'settings', 'sources'], [[runId, now.toISOString(), opts.root, JSON.stringify(settings), JSON.stringify({ lockfile, git: Boolean(touched), figma: data.figmaCrawled, figmaDiag: sources.figmaDiag ?? null, ...omit(sources, 'figmaDiag'), notes })]]);
    await store.insertMany('versions', ['run_id', 'target', 'role', 'pkg', 'library', 'declared', 'resolved', 'latest', 'majors_behind', 'days_behind', 'commits_behind'], versions.map(v => [runId, v.target, v.role, v.pkg, v.library, v.declared, v.resolved, v.latest, v.majorsBehind, v.daysBehind ?? null, v.commitsBehind ?? null]));
    await store.insertMany('instances', ['run_id', 'target', 'library', 'pkg', 'component', 'file', 'line', 'framework', 'overrides'], data.instances.map(i => [runId, i.target, i.library, i.pkg, i.component, i.file, i.line, i.framework, i.overrides.join(',')]));
    await store.insertMany('lookalikes', ['run_id', 'target', 'element', 'component', 'file', 'line'], data.lookalikes.map(l => [runId, l.target, l.element, l.component, l.file, l.line]));
    await store.insertMany('tokens', ['run_id', 'target', 'file', 'raw_values', 'token_refs', 'is_new'], data.tokens.map(t => [runId, t.target, t.file, t.rawValues, t.tokenRefs, t.isNew]));
    await store.insertMany('element_evals', ['run_id', 'id', 'target', 'file', 'line', 'element', 'role', 'verdict', 'use_component', 'confidence', 'needs_human', 'exception', 'decided', 'data'],
      evals.map(e => [runId, e.id, e.target, e.file, e.line, e.element, e.role, e.decided?.decision.verdict ?? e.verdict, e.decided?.decision.use ?? e.use ?? null, e.confidence, e.needsHuman, e.exception ?? null, Boolean(e.decided), JSON.stringify(e)]));
    await store.insertMany('figma_usage', ['run_id', 'file_key', 'file_name', 'project', 'library', 'component', 'instances', 'lookalike_frames'], data.figma.map(f => [runId, f.fileKey, f.fileName, f.project, f.library, f.component, f.instances, f.lookalikeFrames]));
    await store.insertMany('metrics', ['run_id', 'metric_id', 'scope', 'subject', 'value', 'detail'], metrics.map(m => [runId, m.metric_id, m.scope, m.subject, m.value, JSON.stringify(m.detail)]));

    const obs = runRules(data, config, catalog, settings, metrics, prev);
    const summary = await applyObservations(store, runId, obs, now);
    return { runId, data, summary, notes };
  } finally {
    store.close();
  }
}

export type { Config };

const omit = (o: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

/**
 * Re-evaluate the latest run's element review in place, with what the crawler has seen since
 * (page placement: landmarks, live ARIA, geometry). Metrics and findings are untouched; the run keeps
 * its id. Called after screenshots when they brought new placement, so a crawl corrects picks the
 * code alone got wrong (a nav row read as a toggle) within the same scan.
 */
export async function reevaluateElements(opts: { root: string; dataDir: string; config: Config; profile: ResolvedProfile; store: StoreFactory; configDir?: string | undefined; log?: (m: string) => void }): Promise<{ changed: number; total: number }> {
  const log = opts.log ?? (() => {});
  const { config } = materializeRemotes(opts.config, opts.root, opts.dataDir, false, () => {});
  const excludes = [...defaultExcludes(opts.root), ...(config.exclude ?? []).map(e => path.resolve(opts.root, e))];
  begin(config, opts.profile);
  const targets = resolveTargets(opts.root, config);
  const roleMap = loadRoleMap(opts.root, config);
  const threshold = config.review?.threshold ?? DEFAULT_THRESHOLD;
  const hints = loadHints(opts.configDir ?? opts.root).hints;
  const decisionFiles = new Map(targets.filter(t => t.role !== 'core').map(t => [t.name, readDecisions(t.dir, config.rawElementDecisions)]));
  const stats = ruleStats([...decisionFiles.values()]);
  const page = readPagePlacement(opts.dataDir);
  let sigs: SignatureSet | undefined;
  try { sigs = buildSignatures(corePackages(targets)); } catch { /* the first pass noted it */ }
  const evals: ElementEval[] = [];
  for (const t of targets.filter(t => t.role !== 'core' && appSettings(config, t.name).lookalikes)) {
    const tEx = [...excludes, ...(t.exclude ?? [])];
    const res = scanCode(opts.root, config, t, tEx);
    const { exceptionOf } = exceptLookalikes(opts.root, config, t, res.lookalikes, [], new Date());
    const reachOf = new Map<Lookalike, Reach>();
    try {
      const graph = buildGraph(t.dir, tEx, t.aliases);
      for (const r of res.lookalikes) if (r.features?.framework === 'react') reachOf.set(r, reachFor(graph, path.join(t.dir, targetRelative(opts.root, r.file, t.dir)), r.line, r.features.context.gates ?? []));
    } catch { /* the first pass noted it */ }
    for (const r of res.lookalikes) if (reachOf.get(r)?.status === 'unused' && !exceptionOf.has(r)) exceptionOf.set(r, 'unused');
    evals.push(...evaluateRows({ root: opts.root, target: t, rows: res.lookalikes, exceptionOf, reachOf, map: roleMap, decisions: decisionFiles.get(t.name)!, stats, threshold, sigs, pageOf: id => page.get(id), hints, labPaths: config.review?.labPaths }));
  }
  const store = await opts.store(opts.dataDir);
  try {
    const runId = await store.latestRunId();
    if (!runId) return { changed: 0, total: 0 };
    const before = new Map((await store.all<any>('select id, data from element_evals where run_id=$1', [runId])).map(r => { const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data; return [r.id, `${d.role}|${d.use}|${JSON.stringify(d.props ?? {})}`]; }));
    const changed = evals.filter(e => before.has(e.id) && before.get(e.id) !== `${e.role}|${e.use}|${JSON.stringify(e.props ?? {})}`).length;
    await store.exec('delete from element_evals where run_id=$1', [runId]);
    await store.insertMany('element_evals', ['run_id', 'id', 'target', 'file', 'line', 'element', 'role', 'verdict', 'use_component', 'confidence', 'needs_human', 'exception', 'decided', 'data'],
      evals.map(e => [runId, e.id, e.target, e.file, e.line, e.element, e.role, e.decided?.decision.verdict ?? e.verdict, e.decided?.decision.use ?? e.use ?? null, e.confidence, e.needsHuman, e.exception ?? null, Boolean(e.decided), JSON.stringify(e)]));
    log(`Re-evaluated ${evals.length} elements with page placement from ${page.size} screenshots: ${changed} recommendation${changed === 1 ? '' : 's'} changed.`);
    return { changed, total: evals.length };
  } finally { store.close(); }
}

/**
 * Drop look-alikes covered by the app's raw-element exceptions file (the same file the
 * no-raw-element lint rule reads), and say what was set aside so deferred debt stays visible.
 */
function exceptLookalikes(root: string, config: Config, t: Target, rows: Lookalike[], notes: string[], now: Date) {
  const exceptionOf = new Map<Lookalike, 'temporary' | 'allow' | 'unused'>();
  const ex = readExceptions(t.dir, config.rawElementExceptions);
  if (!ex || !rows.length) return { kept: rows, exceptionOf };
  const rel = (f: string) => targetRelative(root, f, t.dir);
  const hit = (paths: string[] = [], f: string) => paths.some(g => globMatch(g, rel(f)));
  const today = now.toISOString().slice(0, 10);
  const kept: typeof rows = [];
  const temp = new Map<number, number>();
  let allowed = 0;
  for (const r of rows) {
    const ti = ex.temporary.findIndex(e => hit(e.paths, r.file));
    if (ti >= 0) { temp.set(ti, (temp.get(ti) ?? 0) + 1); exceptionOf.set(r, 'temporary'); continue; }
    if (ex.allow.some(e => hit(e.paths, r.file))) { allowed++; exceptionOf.set(r, 'allow'); continue; }
    kept.push(r);
  }
  for (const [i, n] of temp) {
    const e = ex.temporary[i]!;
    const late = e.review && e.review < today;
    notes.push(`${t.name}: ${n} look-alike${n === 1 ? '' : 's'} set aside as a temporary exception (${e.paths.join(', ')}${e.owner ? `; owner: ${e.owner}` : ''}${e.review ? `; review ${late ? 'was due' : 'by'} ${e.review}` : ''}).${late ? ' Past its review date: migrate it or renew the exception.' : ''}`);
  }
  if (allowed) notes.push(`${t.name}: ${allowed} look-alike${allowed === 1 ? '' : 's'} in permanently allowed paths.`);
  return { kept, exceptionOf };
}
