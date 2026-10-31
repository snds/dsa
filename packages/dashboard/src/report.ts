

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_THRESHOLD, openStore, withMetrics, appSettings, closestRendered, compareRendered, computeFit, effectiveSettings, familyKey, figmaEnabled, homeOf, loadCatalog, patterns as stylePatterns, pushedThisWeek, questions, readEvents, readProposals, readRendered, renderIssue, renderedFor as composeRendered, resolveTargets, rowToFinding, sourceExcerpts, titleOf, type Config } from '@snds/dsa/engine';

import type { PageActions, ResolvedProfile } from '@snds/dsa';
import { buildQueue, PKG_DIR } from './queue.js';

/**
 * Builds a single self-contained HTML report from the store: no server, opens from disk,
 * safe to attach or host anywhere. Data is embedded as JSON; the page renders it.
 */
export async function buildReport(root: string, config: Config, dataDir: string, profile: ResolvedProfile, outFile: string): Promise<string> {
  const html = await renderReport(root, config, dataDir, profile);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html);
  return outFile;
}

/** Same page for the static file and for `dsa serve`; `serve` turns the Settings view into a form. */
/**
 * `serve`: the live dashboard (assets from the server). `site`: a published copy (dsa publish), with its
 * images next to the page. Neither: a single file opened from <data>/report.
 */
export interface ReportOptions {
  serve?: boolean;
  site?: boolean;
  /** `serve` under a sub-path (host.base, e.g. "/dsa/"): where the page's API calls and images go. Default "/". */
  base?: string;
  /** What a published page's Re-scan and decision buttons do (the host adapter's actions). */
  actions?: PageActions | null;
}

export async function renderReport(root: string, config: Config, dataDir: string, profile: ResolvedProfile, opts: ReportOptions = {}): Promise<string> {
  // Built before the store opens below: it opens its own connection, and DuckDB allows one per file.
  const queue = await buildQueue(root, config, dataDir).catch(e => { console.error(`Queue: ${e.message}`); return null; });
  const store = await openStore(dataDir, 'report');
  try {
    const runId = await store.latestRunId();
    if (!runId) return shell(root, config, { ...emptyPayload(root, config, profile, opts.serve), ...hostOpts(opts) });
    const catalog = withMetrics(loadCatalog(), profile.metrics);
    const settings = effectiveSettings(catalog, config, dataDir);
    const [run] = await store.all<any>('select * from runs where run_id=$1', [runId]);
    void settings;

    const findingsRaw = await store.all<any>(`select * from findings where status <> 'resolved' or resolved_at >= now() - interval 30 day order by score desc`);
    const findings = findingsRaw.map(rowToFinding);
    const pushed = new Set(pushedThisWeek(findings, settings.weekly_queue_budget).map(f => f.id));
    const events = await store.all<any>(`select id, ts as at, event, detail from finding_events order by ts`);
    const findingsOut = findings.map(f => ({
      ...f,
      issueUrl: findingsRaw.find(r => r.id === f.id)?.issue_url ?? null,
      pushed: pushed.has(f.id),
      issue: renderIssue(f),
      history: events.filter(e => e.id === f.id).map(e => ({ at: e.at, event: e.event, detail: typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail })),
    }));

    const components = await store.all<any>(`
      with i as (select * from instances where run_id=$1),
      l as (select component, count(*) n from lookalikes where run_id=$1 group by 1)
      select i.component, any_value(i.library) library, count(*) instances, count(distinct i.target) consumers,
             round(100.0 * count(*) filter (where i.overrides <> '') / count(*), 1) overridden_pct,
             coalesce(any_value(l.n), 0) lookalikes
      from i left join l using (component) group by i.component order by instances desc, i.component`, [runId]);
    const orphanLookalikes = await store.all<any>(`select component, count(*) n from lookalikes where run_id=$1 and component not in (select distinct component from instances where run_id=$1) group by 1`, [runId]);
    const deprecated = config.deprecated ?? {};

    const metrics = await store.all<any>(`select metric_id, scope, subject, value, detail from metrics where run_id=$1`, [runId]);
    const mval = (id: string, subject: string) => metrics.find(m => m.metric_id === id && m.subject === subject)?.value ?? null;
    const versions = await store.all<any>(`select * from versions where run_id=$1`, [runId]);
    const targetNames = [...new Set([...versions.map(v => v.target), ...metrics.filter(m => m.scope !== 'component').map(m => m.subject)])];
    const roles = new Map(versions.map(v => [v.target, v.role]));
    const instByTarget = await store.all<any>(`select target, count(*) n from instances where run_id=$1 group by 1`, [runId]);
    const lookByTarget = await store.all<any>(`select target, count(*) n from lookalikes where run_id=$1 group by 1`, [runId]);
    const targets = targetNames.map(name => ({
      name,
      role: roles.get(name) ?? metrics.find(m => m.subject === name)?.scope ?? 'consumer',
      versions: versions.filter(v => v.target === name).map(v => ({ pkg: v.pkg, library: v.library, declared: v.declared, resolved: v.resolved, latest: v.latest, majorsBehind: v.majors_behind })),
      worstMajors: mval('version_currency', name),
      correctUse: mval('correct_use_rate', name),
      tokenCompliance: mval('token_compliance_new_code', name),
      deprecated: mval('deprecation_burndown', name) ?? 0,
      instances: instByTarget.find(r => r.target === name)?.n ?? 0,
      lookalikes: lookByTarget.find(r => r.target === name)?.n ?? 0,
      measures: appSettings(config, name),
      openFindings: findings.filter(f => f.status !== 'resolved' && f.affected.includes(name)).length,
    })).sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'child' ? -1 : 1));

    const figma = await store.all<any>(`select library, component, sum(instances) instances, sum(lookalike_frames) frames, count(distinct file_key) files from figma_usage where run_id=$1 group by 1, 2 order by instances desc`, [runId]);

    // Trends across runs (one row per run).
    const runs = await store.all<any>(`
      select r.run_id, r.taken_at, r.sources,
        (select count(*) from metrics m where m.run_id=r.run_id and m.metric_id='version_currency' and m.scope='consumer') consumers,
        (select count(*) from metrics m where m.run_id=r.run_id and m.metric_id='version_currency' and m.scope='consumer' and m.value <= 1) current_consumers,
        (select avg(value) from metrics m where m.run_id=r.run_id and m.metric_id='correct_use_rate' and m.scope in ('consumer','child')) correct_use,
        (select avg(value) from metrics m where m.run_id=r.run_id and m.metric_id='token_compliance_new_code') token_compliance,
        (select count(*) from lookalikes l where l.run_id=r.run_id) lookalikes,
        (select count(*) from instances i where i.run_id=r.run_id) instances
      from runs r order by r.taken_at`);
    for (const r of runs) { try { r.sources = typeof r.sources === 'string' ? JSON.parse(r.sources) : r.sources; } catch { r.sources = null; } }
    const openAt = await store.all<any>(`select run_id, count(*) filter (where event in ('opened','reopened')) opened, count(*) filter (where event='resolved') resolved from finding_events where run_id is not null group by 1`);

    const settingsLog = await store.all<any>(`select ts as at, key, old_value, new_value, note from settings_log order by ts desc limit 50`);
    const thresholds = catalog.metrics.filter(m => m.phase1).map(m => ({ id: m.id, family: m.family, direction: m.direction, thresholds: m.thresholds ?? null, tier: m.tier, question: m.question }));

    // Module off: keep the stored data, but leave it out of the page (findings, thresholds, usage).
    const fOn = figmaEnabled(config);
    // Element review: every evaluation (trimmed), the questions for a human, shared styles, and example shots.
    const evalRows = await store.all<any>('select data from element_evals where run_id=$1 order by target, file, line', [runId]);
    const evals = evalRows.map(r => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
    const shotsFile = path.join(dataDir, 'shots', 'index.json');
    const shotIdx = fs.existsSync(shotsFile) ? JSON.parse(fs.readFileSync(shotsFile, 'utf8')) : { shots: {} };
    const base = opts.base ?? '/';
    const shotUrl = (f: string) => (opts.serve ? `${base}shots/${f}` : opts.site ? `shots/${f}` : `../shots/${f}`);
    const renderedSet = readRendered(dataDir);
    const renderedUrl = (f: string) => (opts.serve ? `${base}rendered/${f}` : opts.site ? `rendered/${f}` : `../rendered/${f}`);
    // Element (as rendered in the app) vs the recommended system variant/size (as rendered in Storybook).
    const renderedFor = (e: any) => {
      const st = shotIdx.shots[e.id]?.styles;
      const comp = e.signature && renderedSet?.components[e.signature.component];
      if (!st || !comp) return null;
      const target = composeRendered(comp, e.signature.variant, e.signature.size);
      const closest = closestRendered(st, comp);
      return {
        key: target?.key ?? `${e.signature.variant}/${e.signature.size}`,
        composed: target?.composed ?? false,
        sizeMissing: target?.sizeMissing ?? false,
        diff: target ? compareRendered(st, target.styles) : null,
        systemShot: target?.shot ? renderedUrl(target.shot) : null,
        closest: closest ? { key: closest.key, score: closest.diff.score, shot: comp[closest.key]?.shot ? renderedUrl(comp[closest.key].shot!) : null } : null,
      };
    };
    let sigList: any[] = [];
    try { sigList = JSON.parse(fs.readFileSync(path.join(dataDir, 'signatures.json'), 'utf8')); } catch { /* none yet */ }
    const sigDefaults = (c: string) => sigList.find(x => x.component === c)?.defaults?.size ?? 'default';
    const systemPreview = (e: any) => {
      const comp = e.signature && renderedSet?.components[e.signature.component];
      const t = comp && composeRendered(comp, e.signature.variant, e.signature.size);
      return t?.shot ? { url: renderedUrl(t.shot), key: t.key } : null;
    };
    const elements = {
      threshold: config.review?.threshold ?? DEFAULT_THRESHOLD,
      evals: evals.map((e: any) => ({ id: e.id, target: e.target, file: e.file, line: e.line, element: e.element, verdict: e.verdict, role: e.role, use: e.use, from: e.from, props: e.props, gap: e.gap,
        confidence: e.confidence, needsHuman: e.needsHuman, decided: e.decided, exception: e.exception, ruleId: e.ruleId, reasons: e.reasons, alternatives: e.alternatives, signature: e.signature,
        snippet: e.snippet, a11y: e.a11y, styleKey: e.styleKey, styleSig: e.styleSig, regions: e.regions ?? null, how: e.how ?? null, parent: e.parent ?? null, recipe: e.recipe ?? null,
        // Design identity (identity.ts): the family it belongs to, its name in designer words, and where its answer lands.
        family: familyKey(e), title: titleOf(e), home: homeOf(e.decided?.decision ?? e),
        // What a person sees on it (its text, aria-label, or title), and how many lines its source spans: for the element list and code viewer.
        label: e.match?.text || e.match?.ariaLabel || e.match?.title || null, span: typeof e.source === 'string' ? e.source.split('\n').length : 1,
        shot: shotIdx.shots[e.id] ? { url: shotUrl(shotIdx.shots[e.id].file), match: shotIdx.shots[e.id].matchScore, page: shotIdx.shots[e.id].page, box: shotIdx.shots[e.id].box ?? null, revealedBy: shotIdx.shots[e.id].revealedBy ?? null } : null,
        shotMissing: !shotIdx.shots[e.id] && (shotIdx.missing ?? []).includes(e.id),
        rendered: renderedFor(e),
        // What it takes to see the element (reach.ts), and the system's replacement as rendered, for cards without a screenshot.
        reach: e.reach ? { status: e.reach.status, why: e.reach.why, via: e.reach.via, steps: e.reach.steps.map((x: any) => x.label), gates: e.reach.gates.map((g: any) => ({ kind: g.kind, test: g.test, negated: g.negated, overlay: g.overlay, component: g.component })) } : null,
        systemPreview: systemPreview(e) })),
      questions: questions(evals, { answered: true, threshold: config.review?.threshold ?? DEFAULT_THRESHOLD }).map(q => {
        // Closest measured size for the recommended component, when the pick doesn't already match it.
        // The automated pick takes the closest measured size when the evaluator didn't name one
        // (or named one that measures clearly worse), so "Approve" means the size too.
        const autoFor = (items: typeof q.items, rec: any) => {
          let fit: any = null;
          if (rec?.verdict === 'replace' && rec.use) {
            const f = computeFit(dataDir, items, rec.use, rec.props ?? {});
            const sz = f?.axes?.size;
            if (sz && f!.best.size) fit = { best: f!.best.size, score: sz[f!.best.size].score, recSize: rec.props?.size ?? sigDefaults(rec.use), source: sz[f!.best.size].source };
          }
          let auto = rec;
          if (fit && rec && fit.best !== fit.recSize && fit.source !== 'static') {
            const recScore = computeFit(dataDir, items, rec.use!, rec.props ?? {})?.axes?.size?.[fit.recSize]?.score ?? 0;
            if (!rec.props?.size || fit.score - recScore >= 0.03) auto = { ...rec, props: { ...(rec.props ?? {}), size: fit.best } };
          }
          return { auto, fit };
        };
        const { auto, fit } = autoFor(q.items, q.options[0]?.decision);
        return {
          key: q.key, kind: q.kind, title: q.title, ask: q.ask, home: q.home, note: q.note ?? null, ids: q.items.map(i => i.id), options: q.options, auto, fit,
          parts: q.parts?.map(p => ({ key: p.key, ask: p.ask, ids: p.items.map(i => i.id), options: p.options, ...autoFor(p.items, p.options[0]?.decision) })) ?? null,
          context: q.context?.map(i => i.id) ?? null,
        };
      }),
      // A shared style in designer words: what its elements are (the most common title), not a class hash.
      patterns: stylePatterns(evals).map(p => ({ key: p.key, named: p.named, title: mostCommon(p.items.map(titleOf)), n: p.items.length, files: p.files, recs: p.recs, min: p.min, max: p.max, decided: p.decided })),
      // The code viewer's text. dsa serve reads whole files on request (/api/source); a static page carries excerpts.
      sources: opts.serve ? null : sourceExcerpts(root, config, evals.map((e: any) => ({ target: e.target, file: e.file, line: e.line, span: typeof e.source === 'string' ? e.source.split('\n').length : 1 }))),
      shotsTaken: shotIdx.takenAt ?? null,
      rendered: renderedSet ? { takenAt: renderedSet.takenAt, source: renderedSet.source, combos: Object.values(renderedSet.components).reduce((a, c) => a + Object.keys(c).length, 0) } : null,
      // Each proposed replacement rendered with its exact props (dsa render), keyed like proposalKey: the review shows the options as they would look.
      proposals: Object.fromEntries(Object.entries(readProposals(dataDir)).map(([k, p]) => [k, { use: p.use, props: p.props, check: p.check, url: p.shot ? renderedUrl(p.shot) : null, story: p.story ?? null, content: p.content ?? null, actual: p.actual ?? null, note: p.note ?? null }])),
    };
    // Agent readiness: this run per repo (audit checks, the profile's usage checker by kind, reconciled with look-alikes), the trend, and bench runs.
    const provider = profile.readiness;
    const det = (d: any) => (typeof d === 'string' ? JSON.parse(d) : d);
    const readyTrend = await store.all<any>(`select m.subject, m.value, r.taken_at as at, m.detail->>'tier' as tier from metrics m join runs r using (run_id) where m.metric_id='agent_readiness' order by r.taken_at`);
    let hostDirs: { name: string; dir: string }[] = [];
    try { hostDirs = resolveTargets(root, config).map(t => ({ name: t.name, dir: t.dir })); } catch { /* a missing child path */ }
    const lookRows = await store.all<any>('select target, file from lookalikes where run_id=$1', [runId]);
    const readiness = metrics.filter(m => m.metric_id === 'agent_readiness').map(m => {
      const d = det(m.detail);
      const u = provider?.usageMetric ? metrics.find(x => x.metric_id === provider.usageMetric && x.subject === m.subject) : undefined;
      const usage = u ? det(u.detail) : null;
      const dir = hostDirs.find(t => t.name === m.subject)?.dir;
      return {
        subject: m.subject, scope: m.scope, score: m.value, tier: d.tier, bestTier: d.bestTier, kit: d.kit, checks: d.checks,
        usage: usage ? { files: usage.files, clean: usage.clean, errors: usage.errors, byRule: usage.byRule, byFile: usage.byFile.slice(0, 15) } : null,
        reconcile: usage && dir && provider?.reconcile ? provider.reconcile(usage, lookRows.filter(l => l.target === m.subject), dir, root) : null,
        trend: readyTrend.filter(t => t.subject === m.subject).map(t => ({ at: t.at, score: t.value, tier: t.tier })),
      };
    });
    const bench: any[] = !provider?.benchRuns ? [] : await provider.benchRuns([...new Set([root, ...readiness.map(r => hostDirs.find(t => t.name === r.subject)?.dir).filter((x): x is string => Boolean(x))])]).catch(() => []);
    const payload = {
      generatedAt: new Date().toISOString(),
      root: path.basename(root),
      run: { id: runId, takenAt: run.taken_at, sources: typeof run.sources === 'string' ? JSON.parse(run.sources) : run.sources },
      budget: settings.weekly_queue_budget,
      findings: fOn ? findingsOut : findingsOut.filter((f: any) => f.rule !== 'figma-lookalike'),
      components: components.map(c => ({ ...c, deprecated: c.component in deprecated, replacement: deprecated[c.component] ?? null })).concat(
        orphanLookalikes.map(o => ({ component: o.component, library: '—', instances: 0, consumers: 0, overridden_pct: 0, lookalikes: o.n, deprecated: false, replacement: null }))),
      targets,
      figma: fOn ? figma : [],
      runs: runs.map(r => ({ ...r, ...(openAt.find(o => o.run_id === r.run_id) ?? { opened: 0, resolved: 0 }) })),
      events: readEvents(dataDir),
      settings,
      settingsLog,
      elements,
      queue,
      readiness,
      bench: bench.map(b => ({ id: b.id, at: b.at, repo: b.repo, rows: b.rows, cells: b.cells, errored: b.errored, tasks: b.tasks, findings: b.findings, manifest: b.manifest })),
      usage: profile.usage?.(root) ?? null,
      thresholds: fOn ? thresholds : thresholds.filter(t => !t.id.startsWith('figma_')),
      libraries: [config.designSystem.core, ...(config.designSystem.children ?? [])].map(l => ({ name: l.name, packages: l.packages })),
      // What the system is (inventory, kinds, facets, tokens, where its code was found), from this scan.
      model: readJson(path.join(dataDir, 'model-summary.json')),
      ...displayOpts(root, config, profile, opts.serve),
      published: Boolean(opts.site),
      // What the scan read: the live revision and when it went live, or why it isn't the live one.
      live: liveOf(run),
      ...hostOpts(opts),
    };
    return shell(root, config, payload);
  } finally {
    store.close();
  }
}

/** The run's live check (dsa run records it in the run's sources). Runs from before it existed have none. */
function liveOf(run: any) {
  const src = typeof run?.sources === 'string' ? JSON.parse(run.sources) : run?.sources;
  const l = src?.live;
  return l ? { state: l.state, ok: l.ok, unreleased: Boolean(l.unreleased), label: l.label, head: l.head ?? null, revision: l.revision ?? null } : null;
}

/** Where the page's requests go (serve) and what its static buttons do (publish). */
function hostOpts(opts: ReportOptions) {
  return { base: opts.serve ? opts.base ?? '/' : null, actions: opts.site ? opts.actions ?? null : null };
}

function displayOpts(root: string, config: Config, profile: ResolvedProfile, serve?: boolean) {
  return { label: profile.label, modules: { figma: figmaEnabled(config) }, timeZone: config.report?.timeZone ?? null, title: config.report?.title || config.designSystem?.core?.name || path.basename(root), serve: Boolean(serve) };
}

function emptyPayload(root: string, config: Config, profile: ResolvedProfile, serve?: boolean) {
  return {
    generatedAt: new Date().toISOString(), root: path.basename(root), run: null, budget: 0, findings: [], components: [], targets: [], figma: [], runs: [], elements: null, events: [],
    settings: {}, settingsLog: [], thresholds: [], libraries: [config.designSystem.core, ...(config.designSystem.children ?? [])].map(l => ({ name: l.name, packages: l.packages })),
    ...displayOpts(root, config, profile, serve),
  };
}

function shell(root: string, config: Config, payload: object): string {
  void config;
  // The UI is a React + shadcn app (ui/), built to one script and one stylesheet in templates/ui and
  // embedded here, so the page still works as a single file opened from disk.
  const dir = path.join(PKG_DIR, 'templates', 'ui');
  const css = fs.readFileSync(path.join(dir, 'app.css'), 'utf8');
  const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design System Analytics · ${escapeHtml((payload as any).title ?? path.basename(root))}</title>
<style>${css}</style></head>
<body><div id="root"></div>
<script id="dsa-data" type="application/json">${json}</script>
<script>${js}</script></body></html>`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const mostCommon = (xs: string[]) => { const n = new Map<string, number>(); for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1); return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''; };

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
