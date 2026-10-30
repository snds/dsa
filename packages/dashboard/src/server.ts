import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { discoverSources, runAfterHooks, type DsaAddon, type EngineContext, type ServeRequest } from '@snds/dsa';
import { MEASURES, appSettings, clearEvents, clearMappingCache, computeFit, decideMany, effectiveSettings, figmaToken, githubToken, latestEvals, loadCatalog, logEvent, mapInstance, mask, materializeRemotes, openStore, parseFigmaUrl, readRendered, readSource, resolveTargets, runPipeline, setSetting, targetRelative, undecide, withMetrics, writeSecrets, type AppSettings, type Config } from '@snds/dsa/engine';
import { renderReport } from './report.js';
import { buildQueue, createIssues, syncLinks } from './queue.js';

/** An optional add-on, or null when it isn't installed. */
async function optional<T>(name: string): Promise<T | null> {
  try { return (await import(name)) as T; } catch { return null; }
}
type Review = typeof import('@snds/dsa-review');
type Figma = typeof import('@snds/dsa-figma');

/**
 * `dsa serve`: the report plus a live Settings view, on localhost only.
 * - Binds 127.0.0.1, checks the Host header (DNS-rebinding guard), and requires an
 *   `X-DSA: 1` header on writes (a cross-site form can't set it).
 * - Tokens go to <data>/secrets.json and are only ever shown masked.
 * - Everything else is written to dsa.config.json, which stays safe to commit.
 */
const RULE_KEYS = ['misuse_cluster_threshold', 'sample_floor_instances', 'new_code_days', 'weekly_queue_budget'] as const;

/** What an error response may say: the first line of the message, never the error object or its stack. */
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Unexpected error').split('\n')[0].slice(0, 300);

export interface ServeOptions {
  /** Config, profile, repo and data folder, loaded fresh (Settings may change the config). */
  load: () => Promise<EngineContext>;
  port: number;
  /** Installed add-ons: their routes, run stages and after-run hooks. */
  addons: DsaAddon[];
  log?: (m: string) => void;
}

/** Start the server; resolves once it listens. `serve` keeps it running. */
export async function startServer(opts: ServeOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const first = await opts.load();
  const { root, dataDir } = first;
  const { port, addons } = opts;
  const say = opts.log ?? ((m: string) => console.log(m));
  const loadConfig = async (_root?: string) => opts.load();
  const review = await optional<Review>('@snds/dsa-review');
  const figma = await optional<Figma>('@snds/dsa-figma');
  let running = false;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  type SB = { url: string; stop: () => void; harness: string | null };
  let storybook: SB | null = null;
  // One Storybook per session, started in the background when the server starts so previews are
  // ready by the time anyone opens the picker. Every request shares the same start; a failed start
  // clears, so the next request tries again.
  let starting: Promise<SB> | null = null;
  const ensureStorybook = (): Promise<SB> => {
    if (storybook) return Promise.resolve(storybook);
    starting ??= (async () => {
      const { config } = await loadConfig(root);
      if (!review) throw new Error('Live previews need @snds/dsa-review.');
      const sb = await review.startStorybook(root, config, m => say(m));
      // Previews go through a small proxy that lets the picker render icons and labels in the story.
      const proxy = await review.startProxy(sb.url);
      // Components without a story render through a harness module the dev server serves (not a static build).
      let harness: string | null = null;
      if (sb.source === 'storybook dev' && sb.dir) {
        try {
          const f = path.join(sb.dir, 'node_modules', '.cache', 'dsa-preview', 'harness.mjs');
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, review.HARNESS);
          harness = `${proxy.url.replace(/\/$/, '')}/@fs${path.resolve(f)}`;
        } catch { /* read-only checkout: story-less components just won't preview */ }
      }
      const ready: SB = { url: proxy.url, stop: () => { proxy.stop(); sb.stop(); }, harness };
      storybook = ready;
      say(`Storybook ready for previews (${sb.source}).`);
      return ready;
    })().catch(e => { starting = null; throw e; });
    return starting;
  };
  const onExit = () => storybook?.stop();
  const onInt = () => { storybook?.stop(); process.exit(130); };
  process.once('exit', onExit);
  process.once('SIGINT', onInt);
  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : String(body));
    };
    try {
      if (!allowedHosts.has(String(req.headers.host))) return send(403, { error: 'Unexpected host.' });
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (req.method === 'POST' && req.headers['x-dsa'] !== '1') return send(403, { error: 'Missing X-DSA header.' });

      if (req.method === 'GET' && url.pathname === '/') {
        const { config, profile } = await loadConfig(root);
        return send(200, await renderReport(root, config, dataDir, profile, { serve: true }), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/settings') return send(200, readView(await loadConfig(root)));
      // Add-on routes: the agent workbench's sessions, proposals, handoff and settings.
      const sr: ServeRequest = { req, res, url, body: () => readBody(req), send, context: () => loadConfig(root), root, dataDir };
      for (const a of addons) if (a.routes && (await a.routes(sr))) return;
      if (req.method === 'GET' && (url.pathname.startsWith('/shots/') || url.pathname.startsWith('/rendered/'))) {
        const f = path.join(dataDir, url.pathname.startsWith('/shots/') ? 'shots' : 'rendered', path.basename(url.pathname));
        if (!/\.png$/.test(f) || !fs.existsSync(f)) return send(404, { error: 'No such screenshot.' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(f));
      }
      // The design system's icon font, for the picker's icon previews (served from the host repo's node_modules).
      if (req.method === 'GET' && url.pathname === '/fonts/icons.woff2') {
        const f = (await loadConfig(root)).profile.iconFont?.(root) ?? null;
        if (!f || !fs.existsSync(f)) return send(404, { error: "The profile names no icon font." });
        res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=86400' });
        return res.end(fs.readFileSync(f));
      }
      // One source file for the code viewer, read from inside its scan target only.
      if (req.method === 'GET' && url.pathname === '/api/source') {
        const { config } = await loadConfig(root);
        const src = readSource(root, config, url.searchParams.get('target') ?? '', url.searchParams.get('file') ?? '');
        return src ? send(200, src) : send(404, { error: 'That file is not part of a scan target.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/undecide') {
        const body = await readBody(req);
        const { config } = await loadConfig(root);
        try { return send(200, await undecide(root, config, dataDir, { ids: body.ids, pattern: body.pattern })); }
        catch (e: any) { return send(400, { error: errText(e) }); }
      }
      // Component picker: every component the core exports, its variant/size axes, and rendered thumbnails.
      if (req.method === 'GET' && url.pathname === '/api/components') {
        const f = path.join(dataDir, 'signatures.json');
        if (!fs.existsSync(f)) return send(404, { error: 'No signatures yet. Run a scan first.' });
        const sigs: any[] = JSON.parse(fs.readFileSync(f, 'utf8'));
        const rendered = readRendered(dataDir);
        const comps = sigs.map(c => ({
          component: c.component, from: c.from, tag: c.tag, role: c.role, axes: c.axes, defaults: c.defaults, file: c.file ? path.basename(c.file) : '', abs: c.file ? path.resolve(c.file) : null,
          thumbs: Object.fromEntries(Object.entries<any>(rendered?.components?.[c.component] ?? {}).filter(([, v]) => v.shot).map(([k, v]) => [k, `/rendered/${v.shot}`])),
          stories: Object.entries<any>((rendered as any)?.stories ?? {}).filter(([, v]) => (v.results ?? []).some((r: any) => r.component === c.component)).map(([id]) => id),
        }));
        // Icon names for the picker's icon fields: string literals in the Icon component's name catalog.
        let icons: string[] = [];
        const ic = sigs.find(c => c.component === 'Icon');
        if (ic?.file) {
          const dir = path.dirname(path.resolve(ic.file));
          for (const f of ['icon-names.ts', 'icon-names.tsx', 'iconNames.ts']) {
            const fp = path.join(dir, f);
            if (!fs.existsSync(fp)) continue;
            icons = [...new Set([...fs.readFileSync(fp, 'utf8').matchAll(/["']([a-z0-9_]{2,40})["']/g)].map(m => m[1]))].sort();
            break;
          }
        }
        return send(200, { components: comps, icons, storybook: storybook ? { url: storybook.url } : null });
      }
      // Live previews with controls: start the design system's Storybook once and keep it for this session.
      if (req.method === 'POST' && url.pathname === '/api/storybook') {
        try {
          const sbk = await ensureStorybook();
          const idx: any = await (await fetch(new URL('index.json', sbk.url))).json();
          const stories = Object.values<any>(idx.entries ?? idx.stories ?? {}).filter((s: any) => s.type !== 'docs').map((s: any) => ({ id: s.id, title: s.title, name: s.name, importPath: s.importPath }));
          // The Icon component's module, for previews whose story doesn't load it already.
          let iconModule: string | null = null;
          try { const sigs: any[] = JSON.parse(fs.readFileSync(path.join(dataDir, 'signatures.json'), 'utf8')); const ic = sigs.find(c => c.component === 'Icon'); if (ic?.file) iconModule = `${sbk.url.replace(/\/$/, '')}/@fs${path.resolve(ic.file)}`; } catch { /* no signatures */ }
          return send(200, { url: sbk.url, stories, iconModule, harness: sbk.harness, fsBase: sbk.harness ? `${sbk.url.replace(/\/$/, '')}/@fs` : null });
        } catch (e: any) { console.error(`Request failed: ${errText(e)}`);
      return send(500, { error: 'The server hit an unexpected error; the terminal running dsa serve has the details.' }); }
      }
      // How well each variant / size / axis option fits the elements being replaced.
      if (req.method === 'POST' && url.pathname === '/api/fit') {
        const body = await readBody(req);
        const { evals } = await latestEvals(dataDir);
        const items = evals.filter(e => (body.ids ?? []).includes(e.id));
        const fit = computeFit(dataDir, items, String(body.component ?? ''), body.current ?? {});
        return fit ? send(200, fit) : send(404, { error: 'No signature for that component yet. Run a scan.' });
      }
      // What each instance becomes under a decision: the JSX, what's kept or dropped, and what needs a look.
      if (req.method === 'POST' && url.pathname === '/api/mapping') {
        const body = await readBody(req);
        const { config } = await loadConfig(root);
        const { evals } = await latestEvals(dataDir);
        const items = evals.filter(e => (body.ids ?? []).includes(e.id)).slice(0, 300);
        const { config: cfg } = materializeRemotes(config, root, dataDir, false, () => {});
        const targets = resolveTargets(root, cfg);
        let comp: any;
        try { comp = (JSON.parse(fs.readFileSync(path.join(dataDir, 'signatures.json'), 'utf8')) as any[]).find(c => c.component === body.decision?.use); } catch { /* none */ }
        clearMappingCache();
        const maps = items.map(e => {
          const t = targets.find(x => x.name === e.target);
          const abs = [path.resolve(root, e.file), ...(t ? [path.join(t.dir, targetRelative(root, e.file, t.dir))] : [])].find(f => fs.existsSync(f)) ?? '';
          return mapInstance(e, abs, t?.dir ?? root, body.decision, comp);
        });
        return send(200, { mappings: maps, clean: maps.filter(m => m.status === 'clean').length, check: maps.filter(m => m.status !== 'clean').length, from: body.decision?.from ?? comp?.from ?? null });
      }
      // Action Queue, live: findings plus review approvals, with GitHub issue state (synced at most once a minute).
      if (req.method === 'GET' && url.pathname === '/api/queue') {
        const { config } = await loadConfig(root);
        let syncError: string | undefined;
        if (url.searchParams.get('sync')) {
          const r: { synced: boolean; error?: string } = await syncLinks(root, config, dataDir, { force: url.searchParams.get('sync') === 'force' }).catch((e: any) => ({ synced: false, error: errText(e) }));
          syncError = r.error && r.error !== 'No GitHub token.' ? r.error : undefined;
          if (syncError) logEvent(dataDir, { level: 'warning', source: 'GitHub', message: 'Issue sync hit an error.', detail: syncError });
        }
        return send(200, { ...(await buildQueue(root, config, dataDir)), syncError });
      }
      if (req.method === 'POST' && url.pathname === '/api/issues/create') {
        const body = await readBody(req);
        const { config } = await loadConfig(root);
        try { return send(200, await createIssues(root, config, dataDir, Array.isArray(body.ids) ? body.ids : undefined)); }
        catch (e: any) { return send(400, { error: errText(e) }); }
      }
      // Settings › Notes: clear the suite's own errors and warnings (scan notes stay with their run).
      if (req.method === 'POST' && url.pathname === '/api/notes/clear') { clearEvents(dataDir); return send(200, { cleared: true }); }
      // Settings › History: drop every run but the latest (the dashboard is built from it).
      if (req.method === 'POST' && url.pathname === '/api/history/clear') {
        const store = await openStore(dataDir, 'serve');
        try {
          const latest = await store.latestRunId();
          const old = (await store.all<any>('select run_id from runs where run_id <> $1', [latest])).map(r => r.run_id);
          for (const t of ['versions', 'instances', 'lookalikes', 'tokens', 'figma_usage', 'metrics', 'element_evals', 'runs']) await store.exec(`delete from ${t} where run_id <> $1`, [latest]);
          return send(200, { removed: old.length });
        } finally { store.close(); }
      }
      if (req.method === 'POST' && url.pathname === '/api/decide') {
        const body = await readBody(req);
        const { config } = await loadConfig(root);
        try {
          const r = await decideMany(root, config, dataDir, { ids: body.ids, pattern: body.pattern }, body.decision, body.who, body.note);
          return send(200, { recorded: r.reduce((a: number, x: any) => a + (x.count ?? 1), 0), files: [...new Set(r.map((x: any) => x.file))], decided: { by: body.pattern ? 'policy' : 'human', decision: body.decision, note: body.note } });
        } catch (e: any) { return send(400, { error: errText(e) }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const body = await readBody(req);
        const result = await saveView(await loadConfig(root), body);
        return send(result.errors.length ? 400 : 200, { ...result, view: readView(await loadConfig(root)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/figma/test') {
        const body = await readBody(req);
        const token = body.token || figmaToken(dataDir);
        if (!token) return send(400, { error: 'No Figma token saved yet.' });
        if (!figma) return send(400, { error: 'Install @snds/dsa-figma to use Figma.' });
        try { return send(200, await figma.figmaWhoAmI(token)); } catch (e: any) { return send(400, { error: errText(e) }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/github/test') {
        const body = await readBody(req);
        const token = body.token || githubToken(dataDir);
        if (!token) return send(400, { error: 'No GitHub token saved yet.' });
        const r = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
        if (!r.ok) return send(400, { error: `GitHub rejected the token (${r.status}).` });
        const j: any = await r.json();
        return send(200, { login: j.login });
      }
      if (req.method === 'POST' && url.pathname === '/api/run') {
        if (running) return send(409, { error: 'A run is already in progress.' });
        running = true;
        const lines: string[] = [];
        try {
          const ctx = await loadConfig(root);
          const r = await runPipeline({
            root: ctx.root, dataDir: ctx.dataDir, config: ctx.config, profile: ctx.profile, configDir: ctx.configDir, dsaConfig: ctx.loaded.config,
            store: d => openStore(d), stages: addons.flatMap(a => a.stages ?? []), log: m => { lines.push(m); },
          });
          // Screenshots (when shots.auto is on), the report, and the agent snapshot.
          await runAfterHooks(addons, { kind: 'run', ctx, options: { from: 'serve' }, store: d => openStore(d), notes: r.notes, log: m => lines.push(m) });
          return send(200, { runId: r.runId, summary: r.summary, notes: r.notes, log: lines });
        } catch (e: any) {
          logEvent(dataDir, { level: 'error', source: 'Scan', message: `The scan failed: ${String(e.message).split('\n')[0]}`, detail: lines.slice(-12).join('\n') });
          console.error(`Scan failed: ${errText(e)}`);
          return send(500, { error: 'The scan failed; the terminal running dsa serve has the details.', log: lines });
        } finally {
          running = false;
        }
      }
      return send(404, { error: 'Not found.' });
    } catch (e: any) {
      console.error(`Request failed: ${errText(e)}`);
      return send(500, { error: 'The server hit an unexpected error; the terminal running dsa serve has the details.' });
    }
  });

  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => ok()); });
  say(`dsa dashboard: http://localhost:${port}  (Ctrl+C to stop)`);
  // Warm Storybook now, unless turned off (rendered.autoStart: false) or there's no Storybook to start.
  try {
    const { config } = await loadConfig(root);
    if (config.rendered?.autoStart !== false) {
      console.log('Starting Storybook in the background for live previews…');
      ensureStorybook().catch((e: any) => {
        const msg = String(e.message).split('\n')[0];
        console.log(`Storybook didn't start: ${msg}`);
        logEvent(dataDir, { level: 'warning', source: 'Storybook', message: "Storybook didn't start, so live previews are off.", detail: msg });
      });
    }
  } catch { /* config errors surface elsewhere */ }
  return {
    url: `http://localhost:${port}`,
    close: () => new Promise<void>(ok => { storybook?.stop(); process.off('exit', onExit); process.off('SIGINT', onInt); server.close(() => ok()); server.closeAllConnections?.(); }),
  };
}

/** `dsa serve`: start, then keep serving until Ctrl+C. */
export async function serve(opts: ServeOptions): Promise<void> {
  await startServer(opts);
  await new Promise(() => {});
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((ok, fail) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { ok(data ? JSON.parse(data) : {}); } catch { fail(new Error('Body is not JSON.')); } });
    req.on('error', fail);
  });
}

/** What the Settings form shows. Tokens come back masked; nothing secret leaves the server. */
export function readView(ctx: EngineContext) {
  const { root, dataDir, config } = ctx;
  const configFile = ctx.loaded.configPath;
  const settings = effectiveSettings(withMetrics(loadCatalog(), ctx.profile.metrics), config, dataDir);
  return {
    configFile,
    modules: { figma: config.modules?.figma === true },
    apps: appList(root, config),
    report: { timeZone: config.report?.timeZone ?? '', title: config.report?.title ?? '' },
    figma: {
      token: mask(figmaToken(dataDir)),
      tokenFromEnv: Boolean(process.env.FIGMA_TOKEN),
      libraries: (config.figma?.libraries ?? []).map(l => ({ name: l.name, url: l.url ?? l.fileKey, fileKey: l.fileKey })),
      links: (config.figma?.links ?? []).map(l => ({ ...l, parsed: parseFigmaUrl(l.url) })),
      editedWithinDays: config.figma?.editedWithinDays ?? 90,
      maxFiles: config.figma?.maxFiles ?? 200,
    },
    github: {
      token: mask(githubToken(dataDir)),
      tokenFromEnv: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN),
      defaultRepo: config.github?.defaultRepo ?? '',
      labels: (config.github?.labels ?? []).join(', '),
    },
    rules: Object.fromEntries(RULE_KEYS.map(k => [k, settings[k]])),
    sources: {
      core: { name: config.designSystem.core.name, packages: config.designSystem.core.packages },
      children: (config.designSystem.children ?? []).map(c => ({ name: c.name, path: c.path ?? '', gitUrl: c.git?.url ?? '', gitRef: c.git?.ref ?? 'main', exclude: (c.exclude ?? []).join(', ') })),
      internalConsumers: (config.internalConsumers ?? []).join(', '),
      discovery: discoveryView(ctx),
    },
  };
}

/** Where the system's code is: the folders read, and every scored folder with its confidence and reasons. */
function discoveryView(ctx: EngineContext) {
  const sys = ctx.loaded.config.system as { path?: string; sources?: string[] };
  const pinned = sys.path ? [sys.path] : sys.sources ?? [];
  try {
    // Scored as if nothing were pinned, so the list shows what dsa would find on its own.
    const found = discoverSources(ctx.root, { ...ctx.loaded.config, system: { ...ctx.loaded.config.system, path: undefined, sources: undefined } } as any);
    const reading = pinned.length ? pinned : found.accepted;
    return {
      pinned, reading, how: pinned.length ? 'pinned' : found.how, threshold: found.threshold,
      candidates: found.candidates.slice(0, 15).map(c => ({
        dir: c.dir, confidence: c.confidence, because: c.because ?? '', members: c.members ?? [c.dir],
        why: c.signals.filter(s => s.score > 0).sort((a, b) => b.weight * b.score - a.weight * a.score).slice(0, 3).map(s => s.detail),
      })),
    };
  } catch (e) {
    return { pinned, reading: pinned, how: pinned.length ? 'pinned' : 'none', threshold: 0.9, candidates: [], error: errText(e) };
  }
}

const list = (s: unknown) => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);

/** Apply a Settings form submission. Returns validation errors without writing anything if there are any. */
export async function saveView(ctx: EngineContext, body: any): Promise<{ saved: string[]; errors: string[] }> {
  const { dataDir } = ctx;
  const errors: string[] = [];
  const saved: string[] = [];
  const configFile = ctx.loaded.configPath;
  if (!configFile) return { saved, errors: ['No dsa.config.json to save to. Run "dsa init" first.'] };
  // The file may be in dsa's format (system.children) or the analytics suite's (designSystem.children); the other keys are the same.
  const raw: any = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const catalog = withMetrics(loadCatalog(), ctx.profile.metrics);

  if (body.report) {
    const tz = String(body.report.timeZone ?? '').trim();
    if (tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { errors.push(`"${tz}" isn't a time zone name (try America/Los_Angeles).`); } }
    raw.report = { ...(raw.report ?? {}), timeZone: tz || undefined, title: String(body.report.title ?? '').trim() || undefined };
  }
  if (body.apps) {
    // Store only what differs from "measure everything", so the config stays readable.
    const apps: Record<string, AppSettings> = {};
    for (const a of body.apps) {
      const name = String(a.name ?? '').trim();
      if (!name) continue;
      const e: AppSettings = {};
      for (const k of MEASURES) if (a[k] === false) e[k] = false;
      const skip = list(a.tokenSkip);
      if (skip.length) e.tokenSkip = skip;
      if (Object.keys(e).length) apps[name] = e;
    }
    raw.apps = Object.keys(apps).length ? apps : undefined;
  }
  if (body.modules) raw.modules = { ...(raw.modules ?? {}), figma: Boolean(body.modules.figma) };
  if (body.figma) {
    const libs = (body.figma.libraries ?? []).filter((l: any) => l.url?.trim() || l.name?.trim()).map((l: any) => {
      const p = parseFigmaUrl(String(l.url ?? ''));
      if (!p || p.kind !== 'file') errors.push(`Library "${l.name || l.url}": paste the library's file link (figma.com/design/…).`);
      return { name: String(l.name ?? '').trim() || 'Library', fileKey: p?.id ?? '', url: String(l.url).trim() };
    });
    const links = (body.figma.links ?? []).filter((l: any) => l.url?.trim()).map((l: any) => {
      if (!parseFigmaUrl(l.url)) errors.push(`"${l.url}" isn't a Figma team, project, or file link.`);
      return { url: String(l.url).trim(), label: String(l.label ?? '').trim() || undefined };
    });
    const days = Number(body.figma.editedWithinDays), max = Number(body.figma.maxFiles);
    if (!(days > 0)) errors.push('"Edited within" needs a number of days above 0.');
    if (!(max > 0)) errors.push('"Max files per run" needs a number above 0.');
    raw.figma = { ...(raw.figma ?? {}), libraries: libs, links, editedWithinDays: days, maxFiles: max };
  }
  if (body.github) {
    const repo = String(body.github.defaultRepo ?? '').trim();
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) errors.push(`Default repo should look like owner/name, got "${repo}".`);
    raw.github = { ...(raw.github ?? {}), defaultRepo: repo || undefined, labels: list(body.github.labels) };
  }
  if (body.sources) {
    const kids: any[] = (raw.designSystem ?? raw.system ?? {}).children ?? [];
    for (const c of body.sources.children ?? []) {
      const k = kids.find(x => x.name === c.name);
      if (!k) continue;
      k.path = String(c.path ?? '').trim() || undefined;
      k.git = String(c.gitUrl ?? '').trim() ? { url: String(c.gitUrl).trim(), ref: String(c.gitRef ?? '').trim() || 'main' } : undefined;
      k.exclude = list(c.exclude);
    }
    raw.internalConsumers = list(body.sources.internalConsumers);
    // The folders the user points at as the system's code. An empty list goes back to finding them.
    if (Array.isArray(body.sources.pinned)) {
      const dirs = body.sources.pinned.map((d: unknown) => String(d ?? '').trim().replace(/\/+$/, '')).filter(Boolean);
      for (const d of dirs) if (!fs.existsSync(path.resolve(ctx.root, d)) || !fs.statSync(path.resolve(ctx.root, d)).isDirectory()) errors.push(`"${d}" isn't a folder in ${ctx.root}.`);
      const target = raw.designSystem ? (raw.designSystem.core ??= {}) : (raw.system ??= {});
      delete target.path;
      if (dirs.length) target.sources = [...new Set(dirs)]; else delete target.sources;
    }
  }
  const ruleChanges: [string, number][] = [];
  if (body.rules) {
    const current = effectiveSettings(catalog, ctx.config, dataDir);
    for (const k of RULE_KEYS) {
      if (body.rules[k] === undefined) continue;
      const v = Number(body.rules[k]);
      if (!Number.isFinite(v) || v < 0) { errors.push(`${k} needs a number of 0 or more.`); continue; }
      if (v !== current[k]) ruleChanges.push([k, v]);
    }
  }
  if (errors.length) return { saved, errors };

  fs.writeFileSync(configFile, JSON.stringify(raw, null, 2) + '\n');
  saved.push('config');
  if (ruleChanges.length) {
    const store = await openStore(dataDir, 'serve');
    try { for (const [k, v] of ruleChanges) await setSetting(store, catalog, ctx.config, dataDir, k, v, 'Settings page'); } finally { store.close(); }
    saved.push('rules');
  }
  if (body.secrets) {
    writeSecrets(dataDir, { figmaToken: body.secrets.figmaToken, githubToken: body.secrets.githubToken });
    saved.push('secrets');
  }
  return { saved, errors };
}

/** Every app the scan knows about (discovered + child libraries + anything already configured), with its switches. */
function appList(root: string, config: Config) {
  const roles = new Map<string, string>();
  try { for (const t of resolveTargets(root, config)) if (t.role !== 'core') roles.set(t.name, t.role); } catch { /* a missing child path shouldn't break Settings */ }
  for (const n of Object.keys(config.apps ?? {})) if (!roles.has(n)) roles.set(n, 'not found');
  const internal = new Set(config.internalConsumers ?? []);
  return [...roles].sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === 'child' ? -1 : 1))
    .map(([name, role]) => { const s = appSettings(config, name); return { name, role, internal: internal.has(name), ...s, tokenSkip: s.tokenSkip.join(', ') }; });
}
