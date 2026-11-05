

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_THRESHOLD, locate, freshShots, freshnessByApp, readShotIndex, autoPick, contentHash, ownOf, openStore, plainText, withPlain, withMetrics, appSettings, closestRendered, compareRendered, effectiveSettings, familyKey, figmaEnabled, homeOf, loadCatalog, patterns as stylePatterns, pushedThisWeek, questions, readEvents, readProposals, readRendered, renderIssue, renderedFor as composeRendered, resolveTargets, rowToFinding, sourceExcerpts, placeExcerpts, titleOf, type Config } from '@snds/dsa/engine';

import { scanEstimate, type PageActions, type ResolvedProfile } from '@snds/dsa';
import { buildQueue, PKG_DIR } from './queue.js';
import { hashText, propsAt } from '@snds/dsa';
import { pageName, withReview, type Precedent, type ReviewQueueEntry } from './review.js';

/**
 * Builds a single self-contained HTML report from the store: no server, opens from disk,
 * safe to attach or host anywhere. Data is embedded as JSON; the page renders it.
 */
export async function buildReport(root: string, config: Config, dataDir: string, profile: ResolvedProfile, outFile: string, opts: { runDir?: string | undefined } = {}): Promise<string> {
  const html = await renderReport(root, config, dataDir, profile, { runDir: opts.runDir });
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
  /** When scans run by themselves (cron lines, UTC); a published page takes it from `actions`. */
  schedule?: string[] | undefined;
  /**
   * One run's folder (it holds that run's `shots/`, and `rendered/` when it has one): score and show that
   * run's evidence instead of the shared data folder's, so photos from different runs never mix.
   */
  runDir?: string | undefined;
  /** The review queue (`dsa labels queue --out`); default <data>/review-queue.jsonl when it exists. */
  reviewQueue?: string | undefined;
}

export async function renderReport(root: string, config: Config, dataDir: string, profile: ResolvedProfile, opts: ReportOptions = {}): Promise<string> {
  // Built before the store opens below: it opens its own connection, and DuckDB allows one per file.
  const queue = await buildQueue(root, config, dataDir).catch(e => { console.error(`Queue: ${e.message}`); return null; });
  const store = await openStore(dataDir, 'report');
  try {
    const runId = await store.latestRunId();
    if (!runId) return shell(root, config, { ...emptyPayload(root, config, profile, opts.serve), ...hostOpts(opts, dataDir) });
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
    // The same counts per app, so the dashboard's app selector shows one app's uses and look-alikes.
    const compByTarget = numeric(await store.all<any>(`
      with i as (select component, target, count(*) instances, count(*) filter (where overrides <> '') overridden, count(distinct file) files from instances where run_id=$1 group by 1, 2),
      l as (select component, target, count(*) n from lookalikes where run_id=$1 group by 1, 2)
      select coalesce(i.component, l.component) component, coalesce(i.target, l.target) app, coalesce(i.instances, 0) instances, coalesce(i.overridden, 0) overridden,
             coalesce(i.files, 0) files, coalesce(l.n, 0) lookalikes
      from i full join l on i.component = l.component and i.target = l.target`, [runId]), ['instances', 'overridden', 'files', 'lookalikes']);
    const byTargetOf = (component: string) => Object.fromEntries(compByTarget.filter(r => r.component === component).map(r => [r.app, {
      instances: r.instances, overridden_pct: r.instances ? Math.round((1000 * r.overridden) / r.instances) / 10 : 0, files: r.files, lookalikes: r.lookalikes,
    }]));
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
      instances: Number(instByTarget.find(r => r.target === name)?.n ?? 0),
      lookalikes: Number(lookByTarget.find(r => r.target === name)?.n ?? 0),
      measures: appSettings(config, name),
      openFindings: findings.filter(f => f.status !== 'resolved' && f.affected.includes(name)).length,
    })).sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'child' ? -1 : 1));

    const figma = numeric(await store.all<any>(`select library, component, sum(instances) instances, sum(lookalike_frames) frames, count(distinct file_key) files from figma_usage where run_id=$1 group by 1, 2 order by instances desc`, [runId]), ['instances', 'frames', 'files']);

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
    // Each run's measures per app, for the app selector: Overview's cards and Trends' lines for one app.
    const perApp = numeric(await store.all<any>(`
      with m as (select run_id, subject,
          max(value) filter (where metric_id='correct_use_rate') correct_use,
          max(value) filter (where metric_id='token_compliance_new_code') token_compliance,
          max(value) filter (where metric_id='version_currency') majors
        from metrics where scope in ('consumer','child') group by 1, 2),
      l as (select run_id, target subject, count(*) n from lookalikes group by 1, 2),
      i as (select run_id, target subject, count(*) n from instances group by 1, 2)
      select coalesce(m.run_id, l.run_id, i.run_id) run_id, coalesce(m.subject, l.subject, i.subject) subject, m.correct_use, m.token_compliance, m.majors,
             coalesce(l.n, 0) lookalikes, coalesce(i.n, 0) instances
      from m full join l on m.run_id = l.run_id and m.subject = l.subject full join i on coalesce(m.run_id, l.run_id) = i.run_id and coalesce(m.subject, l.subject) = i.subject`), ['correct_use', 'token_compliance', 'majors', 'lookalikes', 'instances']);
    for (const r of runs) r.byTarget = Object.fromEntries(perApp.filter(p => p.run_id === r.run_id).map(p => [p.subject, { correct_use: p.correct_use, token_compliance: p.token_compliance, majors: p.majors, lookalikes: p.lookalikes, instances: p.instances }]));
    // DuckDB hands counts back as text ("0"), which a ratio would turn into NaN: make them numbers.
    numeric(runs, ['consumers', 'current_consumers', 'correct_use', 'token_compliance', 'lookalikes', 'instances']);
    const openAt = await store.all<any>(`select run_id, count(*) filter (where event in ('opened','reopened')) opened, count(*) filter (where event='resolved') resolved from finding_events where run_id is not null group by 1`);

    const settingsLog = await store.all<any>(`select ts as at, key, old_value, new_value, note from settings_log order by ts desc limit 50`);
    const thresholds = catalog.metrics.filter(m => m.phase1).map(m => ({ id: m.id, family: m.family, direction: m.direction, thresholds: m.thresholds ?? null, tier: m.tier, question: m.question }));

    // Module off: keep the stored data, but leave it out of the page (findings, thresholds, usage).
    const fOn = figmaEnabled(config);
    // Element review: every evaluation (trimmed), the questions for a human, shared styles, and example shots.
    const evalRows = await store.all<any>('select data from element_evals where run_id=$1 order by target, file, line', [runId]);
    const evals = evalRows.map(r => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
    // This run's photos only (engine fresh.ts): one carried forward from an older run, or with no stamp,
    // is treated as missing, and the page says how many and how old the oldest that counts is, per app.
    const rawIdx = readShotIndex(dataDir, opts.runDir);
    const fresh = freshShots(rawIdx);
    const shotIdx = { ...rawIdx, shots: fresh.shots, missing: [...new Set([...(rawIdx.missing ?? []), ...Object.keys(fresh.stale)])] };
    const appOfId = new Map<string, string>(evals.map((e: any) => [e.id, e.target]));
    const evidenceDir = opts.runDir && fs.existsSync(path.join(opts.runDir, 'rendered')) ? opts.runDir : dataDir;
    const base = opts.base ?? '/';
    const shotUrl = (f: string) => (opts.serve ? `${base}shots/${f}` : opts.site ? `shots/${f}` : opts.runDir ? path.relative(path.dirname(path.join(dataDir, 'report', 'index.html')), path.join(opts.runDir, 'shots', f)).split(path.sep).join('/') : `../shots/${f}`);
    // A photo, and what the capture checked: blank (nothing painted in the box), covered (another layer on
    // top), how it was made to show (hover, focus), and ties (one of N alike; N source lines claim it).
    // Tagged: found by its source tag, so the place is exact (ties are then the nodes its one line made).
    const shotOf = (s: any) => ({ url: shotUrl(s.file), match: s.matchScore, page: s.page, box: s.box ?? null, revealedBy: s.revealedBy ?? null,
      ...(s.blank ? { blank: true } : {}), ...(s.covered ? { covered: true } : {}), ...(s.via ? { via: s.via } : {}), ...(s.ties > 1 ? { ties: s.ties, alike: s.alike ?? 1 } : {}), ...(s.shared ? { shared: s.shared } : {}), ...(s.tagged ? { tagged: true } : {}),
      // Drawn direct from code (mount, markup): shown, labelled, never a photo. Uncovered: covering layers hidden.
      ...(s.drawn ? { drawn: s.drawn } : {}), ...(s.exact ? { exact: true } : {}), ...(s.uncovered ? { uncovered: s.uncovered } : {}),
      // An isolated render: mounted in the app's build with the props it was recorded with. And the run that took it, and when.
      ...(s.source ? { source: s.source } : {}), ...(s.run ? { run: s.run } : {}), ...(s.at ? { at: s.at } : {}),
      // A wider crop of the page around it (about 800 × 500 CSS px), with the element's box inside it.
      ...(s.context?.file && s.context.box ? { context: { url: shotUrl(s.context.file), box: s.context.box } } : {}) });
    const renderedSet = readRendered(evidenceDir);
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
    const systemPreview = (e: any) => {
      const comp = e.signature && renderedSet?.components[e.signature.component];
      const t = comp && composeRendered(comp, e.signature.variant, e.signature.size);
      return t?.shot ? { url: renderedUrl(t.shot), key: t.key } : null;
    };
    const elements = plainHows({
      threshold: config.review?.threshold ?? DEFAULT_THRESHOLD,
      evals: evals.map((e: any) => ({ id: e.id, target: e.target, file: e.file, line: e.line, element: e.element, verdict: e.verdict, role: e.role, use: e.use, from: e.from, props: e.props, gap: e.gap,
        confidence: e.confidence, needsHuman: e.needsHuman, evidenceCap: e.evidenceCap ?? null, decided: e.decided, exception: e.exception, ruleId: e.ruleId, reasons: withPlain(e.reasons ?? []), alternatives: e.alternatives, signature: e.signature,
        snippet: e.snippet, srcHash: typeof e.source === 'string' ? hashText(e.source) : undefined, a11y: e.a11y, styleKey: e.styleKey, styleSig: e.styleSig, regions: e.regions ?? null,
how: e.how ?? null, parent: e.parent ?? null, recipe: e.recipe ?? null,
        // Design identity (identity.ts): the family it belongs to, its name in designer words, and where its answer lands.
        family: familyKey(e), title: titleOf(e), home: homeOf(e.decided?.decision ?? e),
        // What a person sees on it (its text, aria-label, or title), and how many lines its source spans: for the element list and code viewer.
        label: e.match?.text || e.match?.ariaLabel || e.match?.title || null, span: typeof e.source === 'string' ? e.source.split('\n').length : 1,
        shot: shotIdx.shots[e.id] ? shotOf(shotIdx.shots[e.id]) : null,
        // Its own content's key: its proposal drawn with its words and icon is stored under proposalKey#ownHash.
        ownHash: contentHash(ownOf(e, shotIdx.shots[e.id])),
        shotMissing: !shotIdx.shots[e.id] && (shotIdx.missing ?? []).includes(e.id),
        ...(fresh.stale[e.id] ? { staleShot: fresh.stale[e.id] } : {}),
        rendered: renderedFor(e),
        // What it takes to see the element (reach.ts), and the system's replacement as rendered, for cards without a screenshot.
        reach: e.reach ? { status: e.reach.status, why: e.reach.why, via: e.reach.via, steps: e.reach.steps.map((x: any) => x.label), gates: e.reach.gates.map((g: any) => ({ kind: g.kind, test: g.test, negated: g.negated, overlay: g.overlay, component: g.component })) } : null,
        systemPreview: systemPreview(e) })),
      questions: questions(evals, { answered: true, threshold: config.review?.threshold ?? DEFAULT_THRESHOLD }).map(q => {
        // Closest measured size for the recommended component, when the pick doesn't already match it.
        // The automated pick takes the closest measured size when the evaluator didn't name one
        // (or named one that measures clearly worse), so "Approve" means the size too.
        // The card's pick (engine autopick.ts): the recommendation with the closest measured size; dsa render draws the same.
        const autoFor = (items: typeof q.items, rec: any) => autoPick(dataDir, items, rec);
        const { auto, fit } = autoFor(q.items, q.options[0]?.decision);
        return {
          key: q.key, kind: q.kind, title: q.title, ask: plainText(q.ask) ?? 'Choose the answer.', home: q.home, note: plainText(q.note), noteRaw: q.note ?? null, ids: q.items.map(i => i.id), options: q.options, auto, fit,
          parts: q.parts?.map(p => ({ key: p.key, ask: plainText(p.ask) ?? 'Choose the answer.', ids: p.items.map(i => i.id), options: p.options, ...autoFor(p.items, p.options[0]?.decision) })) ?? null,
          context: q.context?.map(i => i.id) ?? null,
        };
      }),
      // A shared style in designer words: what its elements are (the most common title), not a class hash.
      patterns: stylePatterns(evals).map(p => ({ key: p.key, named: p.named, title: mostCommon(p.items.map(titleOf)), n: p.items.length, files: p.files, recs: p.recs, min: p.min, max: p.max, decided: p.decided })),
      // The code viewer's text. dsa serve reads whole files on request (/api/source); a static page carries excerpts.
      sources: opts.serve ? null : sourceExcerpts(root, config, evals.map((e: any) => ({ target: e.target, file: e.file, line: e.line, span: typeof e.source === 'string' ? e.source.split('\n').length : 1 }))),
      shotsTaken: shotIdx.takenAt ?? null,
      // Which run the photos are from, how many were set aside as older or unstamped, and the oldest that counts, per app.
      freshness: { run: fresh.run, stale: Object.keys(fresh.stale).length, byApp: freshnessByApp(fresh, id => appOfId.get(id)) },
      rendered: renderedSet ? { takenAt: renderedSet.takenAt, source: renderedSet.source, combos: Object.values(renderedSet.components).reduce((a, c) => a + Object.keys(c).length, 0) } : null,
      // Each proposed replacement rendered with its exact props (dsa render), keyed like proposalKey: the review shows the options as they would look.
      proposals: Object.fromEntries(Object.entries(readProposals(evidenceDir)).map(([k, p]) => [k, { use: p.use, props: p.props, check: p.check, url: p.shot ? renderedUrl(p.shot) : null, story: p.story ?? null, content: p.content ?? null, actual: p.actual ?? null, note: p.note ?? null, own: p.own ?? false, fallback: p.fallback ? renderedUrl(p.fallback) : null, ...(p.noSource ? { noSource: true } : {}) }])),
    });
    // Review for people: what each element can show, the queue, the system's allowed props, and where
    // the app already uses each proposal (its precedents).
    withReview(payload0(elements), {
      queue: readQueue(opts.reviewQueue ?? path.join(dataDir, 'review-queue.jsonl')),
      system: (readJson(path.join(dataDir, 'signatures.json')) ?? []).map((c: any) => ({ component: c.component, axes: c.axes ?? {}, defaults: c.defaults ?? {} })),
      // The engine's own index of existing uses (<data>/precedent.json, when a run writes one), else the scan's uses.
      precedents: precedentFile(dataDir, shotIdx, shotUrl) ?? await precedentsOf(store, runId, root, config, elements, shotIdx, shotUrl),
      sourceRef: (e: any) => elements.sources?.[e.file]?.ref ?? 'worktree',
    });
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
      components: components.map(c => ({ ...c, deprecated: c.component in deprecated, replacement: deprecated[c.component] ?? null, byTarget: byTargetOf(c.component) })).concat(
        orphanLookalikes.map(o => ({ component: o.component, library: '—', instances: 0, consumers: 0, overridden_pct: 0, lookalikes: o.n, deprecated: false, replacement: null, byTarget: byTargetOf(o.component) }))),
      targets,
      figma: fOn ? figma : [],
      runs: runs.map(r => ({ ...r, ...(openAt.find(o => o.run_id === r.run_id) ?? { opened: 0, resolved: 0 }) })),
      events: readEvents(dataDir),
      settings,
      settingsLog,
      elements,
      queue,
      // The code reader's lines for each place an action cites. dsa serve reads them on request.
      evidenceSources: opts.serve || !queue ? null : placeExcerpts(root, config, queue.items.flatMap((i: any) => i.places ?? [])),
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
      coverage: coverageOf(run, targets),
      ...hostOpts(opts, dataDir),
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

/**
 * The review's face speaks plainly: every "how" (an element's, a decision's, a part's container) in plain
 * words, the scanner's own line (attribute names, .map()) kept as howRaw for Technical details.
 */
function plainHows<T>(x: T): T {
  if (Array.isArray(x)) { for (const v of x) plainHows(v); return x; }
  if (!x || typeof x !== 'object') return x;
  const o = x as any;
  if (typeof o.how === 'string' && o.howRaw === undefined) { o.howRaw = o.how; o.how = plainText(o.how); }
  for (const k of Object.keys(o)) if (k !== 'sources' && o[k] && typeof o[k] === 'object') plainHows(o[k]);
  return x;
}

/** Rows' count columns as numbers (null stays null). */
function numeric<T extends Record<string, any>>(rows: T[], keys: string[]): T[] {
  for (const r of rows) for (const k of keys) if (r[k] != null) (r as any)[k] = Number(r[k]);
  return rows;
}

/**
 * Which apps the run read and which it skipped (a repo it couldn't fetch). Runs from before the run
 * recorded it: the apps in the scan, and the skips from the run's notes.
 */
function coverageOf(run: any, targets: { name: string; role: string }[]) {
  const src = typeof run?.sources === 'string' ? JSON.parse(run.sources) : run?.sources;
  const apps = src?.apps;
  const notes: string[] = Array.isArray(src?.notes) ? src.notes : [];
  const scanned: string[] = Array.isArray(apps?.scanned) ? apps.scanned : targets.filter(t => t.role !== 'core').map(t => t.name);
  const skipped: { name: string; url: string; why: string }[] = Array.isArray(apps?.skipped) ? apps.skipped
    : notes.map(n => n.match(/^Could not fetch (.+?) from (\S+) \((.*)\)\. Skipped it this run/)).filter((m): m is RegExpMatchArray => Boolean(m)).map(m => ({ name: m[1]!, url: m[2]!, why: m[3]! }));
  const noConsumers = notes.find(n => n.startsWith('No consumers found')) ?? null;
  return { scanned, skipped, none: scanned.length === 0, reason: scanned.length ? null : skipped.length ? null : noConsumers };
}

/**
 * Where the page's requests go (serve), what its static buttons do (publish), and how long a scan
 * usually takes (the median of recorded scans), which decides whether a progress dialog opens.
 */
function hostOpts(opts: ReportOptions, dataDir: string) {
  const estimate = scanEstimate(dataDir);
  const actions = opts.site && opts.actions ? { ...opts.actions, rescan: { ...opts.actions.rescan, estimateSeconds: opts.actions.rescan.estimateSeconds ?? estimate } } : null;
  return { base: opts.serve ? opts.base ?? '/' : null, actions, scanEstimate: estimate, schedule: opts.schedule ?? opts.actions?.schedule ?? [] };
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

/** withReview takes a payload; the elements block is all it reads. */
const payload0 = (elements: any) => ({ elements });

function readQueue(file: string): ReviewQueueEntry[] | null {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((q: any) => typeof q.id === 'string').map((q: any) => ({ id: q.id, why: q.why === 'disagree' ? 'disagree' : 'audit' }));
  } catch { return null; }
}

/**
 * Where the app already uses each proposed component: the scan's system-component uses, with their
 * literal props read from the source, and a photo when the crawler took one (shots/index.json `uses`,
 * keyed by "<file>:<line>"). Only components some card proposes are read.
 */
async function precedentsOf(store: any, runId: string, root: string, config: Config, elements: any, shotIdx: any, shotUrl: (f: string) => string): Promise<Precedent[]> {
  const wanted = new Set<string>();
  for (const e of elements.evals ?? []) { if (e.use) wanted.add(e.use); for (const a of e.alternatives ?? []) if (a?.use) wanted.add(a.use); }
  for (const q of elements.questions ?? []) if (q.auto?.use) wanted.add(q.auto.use);
  if (!wanted.size) return [];
  const rows = await store.all('select target, component, file, line from instances where run_id=$1 order by target, file, line', [runId]).catch(() => []);
  let targets: any[] = [];
  try { targets = resolveTargets(root, config); } catch { return []; }
  const texts = new Map<string, string | null>();
  const out: Precedent[] = [];
  const perComponent = new Map<string, number>();
  for (const r of rows as any[]) {
    if (!wanted.has(r.component)) continue;
    if (!texts.has(r.file)) { const at = locate(root, targets, r.target, r.file); texts.set(r.file, at ? fs.readFileSync(at.abs, 'utf8') : null); }
    const src = texts.get(r.file);
    const props = src ? propsAt(src, Number(r.line), r.component) : null;
    if (!props) continue;
    // Up to 20 per app, component and props: enough examples for every answer, not a whole index.
    const k = `${r.target}\u0001${r.component}\u0001${JSON.stringify(Object.entries(props).sort())}`;
    if ((perComponent.get(k) ?? 0) >= 20) continue;
    perComponent.set(k, (perComponent.get(k) ?? 0) + 1);
    const s = shotIdx.uses?.[`${r.file}:${r.line}`];
    out.push({ app: r.target, file: r.file, line: Number(r.line), component: r.component, props,
      shot: s && !s.blank && !s.covered ? { url: shotUrl(s.file), box: s.box ?? null, page: s.page, pageName: pageName(s.page), ...(s.context?.file && s.context.box ? { context: { url: shotUrl(s.context.file), box: s.context.box } } : {}) } : null });
  }
  return out;
}

/** `<data>/precedent.json` ({ uses: [{ component, file, line, props }] }), as precedents, when a run wrote one. */
function precedentFile(dataDir: string, shotIdx: any, shotUrl: (f: string) => string): Precedent[] | null {
  const j = readJson(path.join(dataDir, 'precedent.json'));
  if (!Array.isArray(j?.uses)) return null;
  return j.uses.filter((u: any) => u?.component && u.file && u.line).map((u: any) => {
    const s = shotIdx.uses?.[`${u.file}:${u.line}`];
    return { app: u.app ?? u.file.split('/')[0], file: u.file, line: Number(u.line), component: u.component, props: u.props ?? {},
      shot: s && !s.blank && !s.covered ? { url: shotUrl(s.file), box: s.box ?? null, page: s.page, pageName: pageName(s.page) } : null };
  });
}
