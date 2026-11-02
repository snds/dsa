import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { defineAddon, liveGate, type AddonApi, type EngineContext } from '@snds/dsa';
import { applyRenderedEvidence, capByEvidence, logEvent, materializeRemotes, openStore, pagePlacementKey, reevaluateElements, resolveTargets, type Config } from '@snds/dsa/engine';
import { detectApp, ensureBrowser, installAppDeps, linkCoreForChild } from './apps.js';
import { renderIfStale, renderProposals, renderSignatures } from './rendered.js';
import { takeShots } from './shots.js';

export { detectApp, discoverRoutes, ensureBrowser, freePort, installAppDeps, linkCoreForChild, startApp, type AppPlan, type RunningApp } from './apps.js';
export { takeShots, captureSession, type ShotResult } from './shots.js';
export { flowProblems, guardNetwork, routeUrl, runFlow, describeStep, NEVER, type Flow, type Step } from './flows.js';
export { HARNESS, startProxy } from './sbproxy.js';
export { READ_STYLE, argsParam, renderProposals, renderSignatures, renderIfStale, startStorybook, wantedProposals } from './rendered.js';

export interface ShotOptions {
  url?: string | undefined;
  routes?: string[] | undefined;
  target?: string | undefined;
  fresh?: boolean;
  retryMissing?: boolean;
  perGroup?: number | undefined;
}

/**
 * Screenshots for the element review, then what they taught: re-evaluate when the crawler learned
 * where elements sit (sidebar, dialog, live ARIA), and apply the rendered evidence.
 */
export async function shotsAndEvidence(ctx: EngineContext, o: ShotOptions, log: (m: string) => void) {
  const { root, dataDir, config } = ctx;
  const placedBefore = pagePlacementKey(dataDir);
  const r = await takeShots({
    root, dataDir, config,
    url: o.url ?? config.shots?.url,
    routes: o.routes,
    target: o.target,
    fresh: Boolean(o.fresh),
    retryMissing: Boolean(o.retryMissing),
    perGroup: Number(o.perGroup ?? config.shots?.perGroup ?? 3),
    log,
  });
  if (pagePlacementKey(dataDir) !== placedBefore) await reevaluateElements({ root, dataDir, config, profile: ctx.profile, configDir: ctx.configDir, store: d => openStore(d), log });
  const ev = await applyRenderedEvidence(dataDir, config.review?.threshold ?? 0.9);
  await capByEvidence(dataDir, config.review?.threshold ?? 0.9);
  return { shots: r, evidence: ev };
}

/** Apps the screenshots visit: not the core, not apps with look-alikes or screenshots turned off. */
function shotTargets(root: string, config: Config) {
  return resolveTargets(root, config).filter(t => t.role !== 'core' && config.apps?.[t.name]?.lookalikes !== false && config.apps?.[t.name]?.screenshots !== false);
}

/** One-time setup: the headless browser, app dependencies, and screenshots on for every run. */
export async function setup(ctx: EngineContext, log: (m: string) => void) {
  const { root, dataDir, config } = ctx;
  log('1. Headless browser');
  await ensureBrowser(m => log(`   ${m}`));
  log('   Ready.');
  log('2. Apps to screenshot');
  const { config: cfg } = materializeRemotes(config, root, dataDir, false, m => log(`   ${m}`));
  for (const t of shotTargets(root, cfg)) {
    if (t.role === 'child') linkCoreForChild(t.dir, root, config.designSystem.core.packages, m => log(`   ${m}`));
    const plan = detectApp(t, cfg);
    if ('reason' in plan) { log(`   ${t.name}: not started (${plan.reason}). Set apps["${t.name}"].start to override.`); continue; }
    const ok = installAppDeps(plan, m => log(`   ${m}`));
    log(`   ${t.name}: ${ok ? `starts with ${plan.how}` : 'dependencies failed to install; screenshots will skip it'}`);
  }
  const file = ctx.loaded.configPath;
  if (!file) throw new Error('No dsa.config.json to turn screenshots on in. Run "dsa init" first.');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.shots = { ...(raw.shots ?? {}), auto: true };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  log(`3. Screenshots now run with every scan (shots.auto in ${file}; --no-shots skips one run).`);
}

/**
 * Open a visible browser at `url`, let a person sign in, and save the session (cookies and local
 * storage, Playwright's storage state). It is saved as the person goes, so closing the window or
 * pressing Enter both keep the signed-in state.
 */
export async function login(url: string, out: string, log: (m: string) => void, opts: LoginOptions = {}): Promise<void> {
  const browser = opts.browser ?? await (await ensureBrowser(log)).chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let state: unknown = null, timer: ReturnType<typeof setTimeout> | null = null, saves = 0;
  // Reading the storage state touches the page; doing it while someone types steals focus (a Keycloak
  // form lost its password field to a 1.5 s timer). So: only once a page has finished loading, after it
  // has been quiet for a moment, and once more at the end. Never on a timer while the page sits idle.
  const save = async () => { try { state = await context.storageState({ indexedDB: Boolean(opts.indexedDB) }); saves++; opts.onSave?.(saves); } catch { /* closing */ } };
  const later = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; void save(); }, opts.debounceMs ?? 2000); };
  page.on('load', later);
  page.on('framenavigated', (f: any) => { if (f === page.mainFrame()) later(); });
  await page.goto(url).catch(() => { /* the person can still navigate */ });
  log('Sign in in the browser window. When the site shows you signed in, press Enter here or close the window.');
  await (opts.until ?? new Promise<void>(done => {
    const finish = () => { process.stdin.pause(); done(); };
    browser.on('disconnected', finish);
    page.on('close', finish);
    if (process.stdin.isTTY) { process.stdin.resume(); process.stdin.once('data', finish); }
  }));
  if (timer) clearTimeout(timer);
  await save();
  await browser.close().catch(() => {});
  if (!state) throw new Error('No session was saved: the window closed before the page loaded.');
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.writeFileSync(out, JSON.stringify(state, null, 1), { mode: 0o600 });
}

export interface LoginOptions {
  /** Keep the site's IndexedDB in the saved session (some apps keep their sign-in there). Off: it's large and rarely needed. */
  indexedDB?: boolean;
  /** For tests: the browser to use, when to finish, how long a page must be quiet before a save, and each save. */
  browser?: any; until?: Promise<void>; debounceMs?: number; onSave?: (n: number) => void;
}

const firstLine = (e: any) => String(e?.message ?? e).split('\n')[0];

function printShots(r: Awaited<ReturnType<typeof shotsAndEvidence>>, label: string, log: (m: string) => void) {
  for (const a of r.shots.apps) {
    log(a.skipped ? `  ${a.target}: skipped — ${a.skipped}` : a.signIn ? `  ${a.target}: every page asked for sign-in. Run \`dsa login ${a.url}\` and set live.apps["${a.target}"].auth.` : a.url ? `  ${a.target}: ${a.captured} new screenshots via ${a.how ?? a.url} (${a.routes} routes)` : `  ${a.target}: ${a.cached} cached, nothing new`);
    if (a.needsValue?.length) log(`  ${a.target}: ${a.needsValue.length} route${a.needsValue.length === 1 ? ' needs' : 's need'} a value to open (${a.needsValue.slice(0, 6).join(', ')}${a.needsValue.length > 6 ? ', …' : ''}). List real ones in apps["${a.target}"].routes.`);
  }
  if (r.shots.apps.length && r.shots.apps.every(a => a.signIn || a.skipped)) log(`${r.shots.captured} screenshots: no page could be seen without signing in.`);
  else log(`${r.shots.captured} screenshots; ${r.shots.missing} examples not found (${r.shots.pages} pages). On each page the crawler opened menus, popovers, and disclosures, switched tabs and views, hovered rows, and followed what those revealed (shots.maxDepth deep); what's left needs a specific flow (a selected record, a filled form) or a route to list in apps["name"].routes.`);
  const ev = r.evidence;
  if (ev.measured) log(`Rendered evidence: ${ev.measured} elements measured against ${label} in the browser · ${ev.confirmed} confirmed · ${ev.switched} variant switched (sent to a human).`);
}

export default defineAddon({
  name: '@snds/dsa-review',
  afterRun: [
    {
      id: 'Screenshots',
      order: 10,
      async run({ kind, ctx, options, notes, log }) {
        const { root, config, dataDir } = ctx;
        if (kind === 'reevaluate') { await applyRenderedEvidence(dataDir, config.review?.threshold ?? 0.9); return; }
        // Screenshots ride along when setup turned them on (or --shots asks); the report then embeds them.
        if (options.shots === false || !(options.shots || config.shots?.auto)) return;
        try { await renderIfStale(root, config, dataDir, log); } catch (e) {
          notes.push(`rendered signatures skipped: ${firstLine(e)}`);
          logEvent(dataDir, { level: 'warning', source: 'Rendered signatures', message: 'Storybook measurements were skipped.', detail: firstLine(e) });
        }
        try { await renderProposals({ root, config, dataDir, log }); } catch (e) {
          notes.push(`proposed components not rendered: ${firstLine(e)}`);
          logEvent(dataDir, { level: 'warning', source: 'Rendered signatures', message: 'Proposed components were not rendered with their props.', detail: firstLine(e) });
        }
        try { printShots(await shotsAndEvidence(ctx, {}, log), ctx.profile.label, log); } catch (e) {
          notes.push(`screenshots skipped: ${firstLine(e)}`);
          logEvent(dataDir, { level: 'warning', source: 'Screenshots', message: 'Screenshots were skipped.', detail: firstLine(e) });
        }
        // Again, now that photos recorded each element's own content and the evidence may have changed a
        // pick: draw what the cards will propose. Everything already drawn is reused.
        try { await renderProposals({ root, config, dataDir, log }); } catch (e) { notes.push(`proposed components not rendered: ${firstLine(e)}`); }
        // What can now be seen decides how sure each recommendation may be.
        await capByEvidence(dataDir, config.review?.threshold ?? 0.9).catch(() => {});
      },
    },
  ],
  commands(program: Command, api: AddonApi) {
    const run = program.commands.find(c => c.name() === 'run');
    run?.option('--shots', 'take example screenshots after this run');
    run?.option('--no-shots', "don't take screenshots this run (when shots.auto is on)");

    program
      .command('shots')
      .description('screenshot example elements: starts each app itself (vite, next, a dev script…) on a free port, crawls its routes, and stops it; --url skips that')
      .option('--target <name>', 'one app')
      .option('--url <url>', 'a running app')
      .option('--routes <a,b>', 'pages to visit')
      .option('--per-group <n>', 'examples per recommendation group')
      .option('--fresh', 'ignore cached screenshots')
      .option('--retry-missing', 'try again for elements not found last time')
      .option('--allow-unreleased', "take them even when the checkout isn't the live revision (labelled)")
      .action(async (o: { target?: string; url?: string; routes?: string; perGroup?: string; fresh?: boolean; retryMissing?: boolean; allowUnreleased?: boolean }, cmd: Command) => {
        const ctx = await api.context(cmd);
        await api.requireStore('shots');
        await liveGate(api.cwd, ctx, o, api.out);
        const r = await shotsAndEvidence(ctx, { url: o.url, routes: o.routes?.split(','), target: o.target, fresh: o.fresh, retryMissing: o.retryMissing, perGroup: o.perGroup ? Number(o.perGroup) : undefined }, api.out);
        printShots(r, ctx.profile.label, api.out);
      });

    program
      .command('render')
      .description("measure the system's components in its Storybook (computed height, padding, radius, colors, border, type per variant × size), and render each proposed replacement with its props")
      .option('--force', 're-measure every story')
      .option('--allow-unreleased', "measure even when the checkout isn't the live revision (labelled)")
      .action(async (o: { force?: boolean; allowUnreleased?: boolean }, cmd: Command) => {
        const ctx = await api.context(cmd);
        await liveGate(api.cwd, ctx, o, api.out);
        const r = await renderSignatures({ root: ctx.root, config: ctx.config, dataDir: ctx.dataDir, force: Boolean(o.force), log: api.out });
        for (const n of r.notes.slice(0, 5)) api.out(`note: ${n}`);
        await renderProposals({ root: ctx.root, config: ctx.config, dataDir: ctx.dataDir, force: Boolean(o.force), log: api.out });
        await capByEvidence(ctx.dataDir, ctx.config.review?.threshold ?? 0.9);
      });

    program
      .command('login')
      .argument('<url>', 'the live site (or Storybook) to sign in to')
      .description('sign in to a private live site once, in a visible browser, and save the session for screenshots and renderings (live.app.auth, live.storybook.auth)')
      .option('--out <file>', 'where to save it (default <data>/auth/<host>.json)')
      .option('--indexeddb', "keep the site's IndexedDB in the saved session (for apps that keep their sign-in there)")
      .action(async (url: string, o: { out?: string; indexeddb?: boolean }, cmd: Command) => {
        const ctx = await api.context(cmd);
        const out = o.out ? path.resolve(api.cwd, o.out) : path.join(ctx.dataDir, 'auth', `${new URL(url).hostname}.json`);
        await login(url, out, api.out, { indexedDB: Boolean(o.indexeddb) });
        const rel = path.relative(ctx.root, out);
        api.out(`Saved ${out}. Point live.app.auth (or live.storybook.auth) at "${rel}". It holds your session: keep it out of git and out of shared folders.`);
        if (spawnSync('git', ['-C', ctx.root, 'check-ignore', '-q', out]).status === 1) api.out(`warning: ${rel} is not ignored by git. Add it to .gitignore.`);
      });

    program
      .command('setup')
      .description('one time: install the headless browser and the app dependencies screenshots need, and turn screenshots on for every run')
      .action(async (_o: unknown, cmd: Command) => setup(await api.context(cmd), api.out));
  },
});
