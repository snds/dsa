/// <reference lib="dom" />
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { groupKey, latestEvals, materializeRemotes, resolveTargets, targetRelative, type Config, type ElementEval } from '@snds/dsa/engine';

import { detectApp, discoverRoutes, ensureBrowser, linkCoreForChild, startApp } from './apps.js';

import { READ_STYLE } from './rendered.js';
import { flowProblems, guardNetwork, runFlow, type Flow } from './flows.js';

/**
 * Example screenshots for the element review. Not every instance: a few per recommendation
 * group, plus the ones that need a human (people decide faster when they can see the thing).
 *
 * Needs a running app (dev server or preview). Elements are found by what the static scan
 * knows (tag, classes, text, aria-label), so each capture carries a match score: a weak match
 * is labelled as such instead of being passed off as the element.
 */

export interface ShotResult { captured: number; missing: number; pages: number; apps: { target: string; url?: string; how?: string; routes?: number; captured?: number; cached?: number; skipped?: string }[] }

/**
 * Run a fixed in-page function with data as its argument. The function source is one of this file's
 * constants (never built from data), and the data crosses as a structured value, not as code text.
 */
async function inPage<T = any>(page: any, src: string, arg?: unknown): Promise<T> {
  const fn = await page.evaluateHandle(src);
  try { return await page.evaluate(([f, a]: [any, unknown]) => f(a), [fn, arg]); }
  finally { await fn.dispose().catch(() => {}); }
}

/** Bump when finding or revealing elements changes, so earlier misses get another try. */
const CRAWLER = 6;

interface Target { id: string; m: ElementEval['match']; steps?: { label: string; event: 'click' | 'dblclick' }[]; hints: string[] }

/**
 * Words that point at the UI state an element needs: string literals in its gates (`viewMode === 'gallery'`,
 * `activeNav === "Partners"`), flags split into words (openColour → colour, drawerOpen → drawer), and the
 * components on its render chain (PartnersView → partners). The explorer tries matching controls first, and
 * routes whose path mentions them are visited sooner.
 */
export function hintsOf(e: ElementEval): string[] {
  const out = new Set<string>();
  const add = (w: string) => { const x = w.toLowerCase().trim(); if (x.length >= 4 && !STOP.test(x)) out.add(x); };
  for (const g of e.reach?.gates ?? []) {
    for (const m of g.test.matchAll(/['"]([^'"]{3,30})['"]/g)) add(m[1]);
    for (const id of g.ids ?? []) for (const w of id.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s_]+/)) add(w);
    if (g.overlay) add(g.overlay);
  }
  for (const c of e.reach?.via ?? []) for (const w of c.replace(/(View|Panel|Section|Page|Modal|Drawer|Sheet|Lab)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/)) add(w);
  return [...out].slice(0, 12);
}
const STOP = /^(open|opened|show|shown|visible|true|false|null|undefined|mode|view|state|active|current|selected|editing|edit|value|props|items|item|length|setup|takeover|demo|route|hide|chrome|that|this|with|from|when|page|kind|type|enabled|disabled|dialog|popover)$/;

/**
 * Screenshots without a manual dev server: for each app with evaluations, start it (apps.ts),
 * crawl its routes in headless Chromium, capture examples, stop it. --url still works for an app
 * that's already running somewhere.
 */
export async function takeShots(opts: { root: string; dataDir: string; config: Config; url?: string; routes?: string[]; perGroup?: number; target?: string; fresh?: boolean; /** Try every example not found last time again (screenshots already taken stay cached). */ retryMissing?: boolean; log?: (m: string) => void }): Promise<ShotResult> {
  const log = opts.log ?? (() => {});
  const pw = await ensureBrowser(log);
  const { evals } = await latestEvals(opts.dataDir);
  const dir = path.join(opts.dataDir, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const idxFile = path.join(dir, 'index.json');
  const index: { shots: Record<string, any>; missing: string[]; pages: string[]; takenAt: string; misses?: Record<string, any> } = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : { shots: {}, missing: [], pages: [], takenAt: '' };
  index.missing = []; index.pages = [];
  const result: ShotResult = { captured: 0, missing: 0, pages: 0, apps: [] };
  const perGroup = opts.perGroup ?? 3;

  // Cache: a screenshot (or a "not found") stays valid while the element's source file is unchanged,
  // up to shots.maxAgeDays (default 7; global CSS changes are caught by that expiry or --fresh).
  const maxAge = (opts.config.shots?.maxAgeDays ?? 7) * 864e5;
  const { config: cfg } = materializeRemotes(opts.config, opts.root, opts.dataDir, false, () => {});
  const all = resolveTargets(opts.root, cfg);
  const fileHash = (e: ElementEval) => {
    const t = all.find(x => x.name === e.target);
    const candidates = [path.resolve(opts.root, e.file), ...(t ? [path.join(t.dir, targetRelative(opts.root, e.file, t.dir))] : [])];
    const f = candidates.find(c => fs.existsSync(c));
    return f ? crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12) : '';
  };
  const hashes = new Map<string, string>();
  const hashOf = (e: ElementEval) => { if (!hashes.has(e.file)) hashes.set(e.file, fileHash(e)); return hashes.get(e.file)!; };
  // A shot without placement predates it (crawler 4): take it again once, so every example says where it sits.
  const fresh = (entry: any, e: ElementEval) => !opts.fresh && entry && entry.fileHash === hashOf(e) && Date.now() - Date.parse(entry.at ?? 0) < maxAge && (entry.file ? 'placement' in entry : true);
  // A "not found" is only worth reusing if nothing about how we'd look for it changed: the crawler
  // itself (CRAWLER) and the reveal steps traced for this element. Otherwise a fix never gets a retry.
  const stepsKey = (e: ElementEval) => (e.reach?.steps ?? []).map(x => x.event + ':' + x.label).join('|');
  const freshMiss = (entry: any, e: ElementEval) => !opts.retryMissing && fresh(entry, e) && entry.crawler === CRAWLER && (entry.steps ?? '') === stepsKey(e);
  index.misses ??= {};
  const misses = index.misses;
  const plan = (mine: ElementEval[]) => {
    const cached = new Set(mine.filter(e => fresh(index.shots[e.id], e) && fs.existsSync(path.join(dir, index.shots[e.id].file))).map(e => e.id));
    const picked = pickExamples(mine, perGroup, cached, opts.config.shots?.perQuestion ?? 40);
    const need = picked.filter(e => !cached.has(e.id) && !freshMiss(misses[e.id], e));
    return { picked, need, cached: picked.filter(e => cached.has(e.id)).length };
  };

  const sessions: { target: string; url: string; routes: string[]; first?: string[]; flows?: Flow[]; crawl: boolean; stop?: () => void; how?: string; need: ElementEval[] }[] = [];
  const evalTargets = [...new Set(evals.filter(e => !e.exception).map(e => e.target))].filter(t => !opts.target || t === opts.target);
  if (opts.url) {
    const p = plan(evals.filter(e => !opts.target || e.target === opts.target));
    // An app already running elsewhere: still crawl the routes its source declares, when we know which app it is.
    const t = opts.target ? all.find(x => x.name === opts.target) : undefined;
    const routes = opts.routes ?? opts.config.shots?.routes ?? (t ? ['', ...discoverRoutes(t.dir, t.exclude ?? [])] : ['']);
    sessions.push({ target: opts.target ?? '*', url: opts.url, routes, crawl: !opts.routes, need: p.need });
  } else {
    for (const name of evalTargets) {
      const t = all.find(x => x.name === name);
      if (!t) continue;
      if (opts.config.apps?.[name]?.screenshots === false) { result.apps.push({ target: name, skipped: 'screenshots off for this app' }); continue; }
      const p = plan(evals.filter(e => e.target === name));
      if (!p.need.length) { log(`${name}: all ${p.picked.length} examples cached (sources unchanged); not starting the app.`); result.apps.push({ target: name, captured: 0, cached: p.cached }); continue; }
      log(`${name}: ${p.need.length} examples to capture, ${p.cached} cached.`);
      if (t.role === 'child') linkCoreForChild(t.dir, opts.root, opts.config.designSystem.core.packages, log);
      const ap = detectApp(t, opts.config);
      if ('reason' in ap) { result.apps.push({ target: name, skipped: ap.reason }); continue; }
      log(`Starting ${name} (${ap.how})…`);
      try {
        const app = await startApp(ap);
        const configured = opts.routes ?? opts.config.apps?.[name]?.routes;
        const extra = opts.routes ? [] : (opts.config.apps?.[name]?.extraRoutes ?? []);
        const routes = [...new Set([...extra, ...(configured ?? ['', ...discoverRoutes(t.dir, (t.exclude ?? []))])])];
        log(`  ${app.url} · ${routes.length} route${routes.length === 1 ? '' : 's'} ${configured ? 'from config' : 'found in the source'}${extra.length ? ` (${extra.length} extra, visited first)` : ''}`);
        sessions.push({ target: name, url: app.url, routes, first: extra, flows: opts.config.apps?.[name]?.flows as Flow[] | undefined, crawl: true, stop: app.stop, how: ap.how, need: p.need });
      } catch (e: any) { result.apps.push({ target: name, skipped: e.message.split('\n')[0] }); log(`  ${e.message}`); }
    }
  }

  for (const s of sessions) {
    try {
      if (!s.need.length) { log('Nothing new to capture.'); continue; }
      log(`${s.target === '*' ? '' : s.target + ': '}${s.need.length} examples to find across ${new Set(s.need.map(e => groupKey(e))).size} groups.`);
      const sh = opts.config.shots ?? {};
      const r = await session(pw, { url: s.url, routes: s.routes, first: s.first, flows: s.flows, crawl: s.crawl, examples: s.need, dir, maxPages: sh.maxPages ?? 90, waitMs: sh.waitMs ?? 600, log, reveal: sh.reveal, maxActions: sh.maxActions ?? sh.maxTriggers, maxDepth: sh.maxDepth, maxMinutes: sh.maxMinutes });
      const at = new Date().toISOString();
      const byId = new Map(s.need.map(e => [e.id, e]));
      for (const [id, v] of Object.entries<any>(r.shots)) { index.shots[id] = { ...v, at, fileHash: hashOf(byId.get(id)!) }; delete misses[id]; }
      for (const id of r.missing) misses[id] = { at, fileHash: hashOf(byId.get(id)!), crawler: CRAWLER, steps: stepsKey(byId.get(id)!) };
      index.missing.push(...r.missing);
      index.pages.push(...r.pages);
      result.apps.push({ target: s.target, url: s.url, how: s.how, routes: s.routes.length, captured: Object.keys(r.shots).length });
    } finally { s.stop?.(); }
  }
  // Report "not found" for every cached miss too, so the review can say why there's no picture.
  for (const [id, m] of Object.entries<any>(misses)) if (!index.missing.includes(id) && evals.some(e => e.id === id && freshMiss(m, e))) index.missing.push(id);
  index.takenAt = new Date().toISOString();
  fs.writeFileSync(idxFile, JSON.stringify(index, null, 2));
  result.captured = result.apps.reduce((a, x) => a + (x.captured ?? 0), 0);
  result.missing = index.missing.length;
  result.pages = index.pages.length;
  return result;
}

/** One interaction the explorer can take: click, hover, or right-click a control on the page. */
interface Act { n: number; key: string; kind: 'click' | 'hover' | 'context'; label: string; why: string; prio: number }

async function session(pw: any, o: { url: string; routes: string[]; first?: string[]; flows?: Flow[]; crawl: boolean; examples: ElementEval[]; dir: string; maxPages: number; waitMs: number; log: (m: string) => void; reveal?: boolean; maxActions?: number; maxDepth?: number; maxMinutes?: number; maxReplays?: number }) {
  const shots: Record<string, any> = {};
  const pages: string[] = [];
  let browser: any, page: any;
  const base = new URL(o.url);
  let net = { blocked: 0, last: [] as string[] };
  const launch = async () => {
    browser = await pw.chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    // alert/confirm/prompt: dismiss, so nothing the explorer opens can confirm an action.
    page.on('dialog', (d: any) => d.dismiss().catch(() => {}));
    // Reads only: no writes, nothing under /api/, nothing to another host but images, fonts, and styles (flows.ts).
    net = await guardNetwork(page, base.origin);
  };
  await launch();
  // A page can crash or close under the crawler (a heavy view, a control that closes the window):
  // start a fresh browser and carry on with the next page instead of losing the whole pass.
  const relaunch = async () => {
    try { await browser.close(); } catch { /* already gone */ }
    await launch();
  };
  const queue: string[] = o.routes.map(r => new URL(r, base).toString());
  const firstUrls = new Set((o.first ?? []).map(r => new URL(r, base).toString()));
  const seen = new Set<string>();
  let remaining: Target[] = o.examples.map(e => ({ id: e.id, m: e.match, steps: e.reach?.steps?.map(x => ({ label: x.label, event: x.event })), hints: hintsOf(e) }));
  const replayed = new Set<string>();
  let replays = 0;
  const deadline = Date.now() + (o.maxMinutes ?? 12) * 60_000;
  // Interactions tried at the top of a page, per app: the same toolbar on every page opens the same things.
  const triedApp = new Set<string>();
  const traced = () => [...new Set(remaining.flatMap(r => r.steps?.map(s => s.label) ?? []))];
  const hints = () => [...new Set(remaining.flatMap(r => r.hints))];
  // Routes that mention what's still missing go first (stable: ties keep the source order).
  const rank = () => {
    const h = hints();
    if (!h.length) return;
    // Configured extra routes stay ahead of everything the hints rank.
    const score = (u: string) => { const s = decodeURIComponent(u).toLowerCase(); return (firstUrls.has(u) ? 1000 : 0) + h.filter(w => s.includes(w)).length; };
    queue.sort((a, b) => score(b) - score(a));
  };
  const sweeper = (u: string) => async (revealedBy?: string) => {
    const found: { id: string; score: number; ties: number }[] = await inPage(page, FIND_IN_PAGE, remaining);
    for (const f of found) {
      f.score = matchConfidence(f.score, f.ties);
      const file = `${f.id}.png`;
      // Measure before capturing (capture clears the marker): the same properties rendered signatures record,
      // and where it sits (landmarks, live ARIA, geometry) for the next evaluation.
      const styles = await inPage(page, `(id) => { const el = document.querySelector('[data-dsa-shot="' + CSS.escape(id) + '"]'); return el ? (${READ_STYLE})(el) : null; }`, f.id).catch(() => null);
      const placement = await inPage(page, `(id) => { const el = document.querySelector('[data-dsa-shot="' + CSS.escape(id) + '"]'); return el ? (${PLACE_IN_PAGE})(el) : null; }`, f.id).catch(() => null);
      const cap = await capture(page, f.id, path.join(o.dir, file));
      if (!cap) continue;
      shots[f.id] = { file, page: u, matchScore: Math.round(f.score * 100) / 100, ties: f.ties, styles, placement, box: cap.box, revealedBy };
      o.log(`  ${f.id} on ${u.replace(base.origin, '')}${revealedBy ? ` after ${revealedBy}` : ''} (match ${Math.round(f.score * 100)}%${f.ties > 1 ? `, a guess among ${f.ties} similar elements on the page` : ''})`);
    }
    remaining = remaining.filter(r => !shots[r.id]);
  };
  // Pass 1 (quick): every route, look, replay traced controls, and note how much of what's missing each page mentions.
  // Pass 2 (deep): explore the most promising pages with the time left.
  // Flows first: each is written for elements nothing else reaches, so it's the best use of the time.
  for (const f of o.flows ?? []) {
    if (!remaining.length || Date.now() >= deadline) break;
    const problems = flowProblems(f);
    if (problems.length) { o.log(`  flow “${f?.name ?? '?'}” skipped: ${problems.join('; ')}`); continue; }
    if (f.reveals?.length && !f.reveals.some(id => remaining.some(r => r.id === id))) continue;
    try {
      const before = remaining.length;
      const r = await runFlow(page, f, { base, waitMs: o.waitMs, inPage: (src, arg) => inPage(page, src, arg), sweep: sweeper(new URL(f.route, base).toString()), log: o.log });
      o.log(`  flow “${f.name}”: ${r.done ? 'ran' : `stopped at step ${(r.at ?? 0) + 1} (${r.why})`}, ${before - remaining.length} found`);
    } catch (e: any) {
      o.log(`  flow “${f.name}” failed: ${String(e?.message ?? e).split('\n')[0]}`);
      if (/closed|crash|Target/i.test(String(e?.message))) await relaunch();
    }
  }
  const phase1End = Date.now() + (deadline - Date.now()) * 0.45;
  const promising: { u: string; score: number }[] = [];
  try {
    while (queue.length && seen.size < o.maxPages && remaining.length && Date.now() < phase1End) {
      rank();
      const u = queue.shift()!;
      if (seen.has(u)) continue;
      seen.add(u);
      try {
      try {
        // Dev servers can hold connections open; don't wait forever for "idle".
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(o.waitMs);
      } catch (e: any) {
        o.log(`  skip ${u}: ${e.message.split('\n')[0]}`);
        if (/closed|crash/i.test(String(e?.message))) await relaunch();
        continue;
      }
      pages.push(u);
      if (o.crawl) {
        const links: string[] = await page.evaluate(`Array.from(document.querySelectorAll('a[href]')).map(a => a.href)`);
        for (const l of links) {
          try { const lu = new URL(l); if (lu.origin === base.origin && !seen.has(lu.toString())) queue.push(lu.toString()); } catch { /* ignore */ }
        }
      }
      const sweep = sweeper(u);
      await sweep();
      // How much of what's still missing this page mentions (hint words and traced labels in its text): pass 2 goes there first.
      if (remaining.length && o.reveal !== false) {
        const words = [...hints(), ...traced().map(t => t.toLowerCase())];
        const score: number = await inPage(page, `(w) => { const t = (document.body.innerText || '').toLowerCase(); return w.filter(x => t.includes(x)).length; }`, words).catch(() => 0);
        promising.push({ u, score });
      }
      // Traced reveals: the source says which control opens the element's modal, drawer, or edit mode
      // (reach.ts). Replay those clicks where the first control is on this page, look, then reload.
      if (remaining.length && o.reveal !== false) {
        const seqs = new Map<string, Target['steps']>();
        for (const r of remaining) if (r.steps?.length) seqs.set(r.steps.map(x => x.event + ':' + x.label).join(' › '), r.steps);
        for (const [key, steps] of seqs) {
          if (!remaining.length || replays >= (o.maxReplays ?? 40)) break;
          if (replayed.has(key) || !remaining.some(r => r.steps && r.steps.map(x => x.event + ':' + x.label).join(' › ') === key)) continue;
          let done = 0;
          for (const st of steps!) {
            const hit = await inPage(page, FIND_CONTROL, st.label).catch(() => false);
            if (!hit) break;
            try {
              const loc = page.locator('[data-dsa-step]').first();
              if (st.event === 'dblclick') await loc.dblclick({ timeout: 2000 }); else await loc.click({ timeout: 2000 });
              done++;
              await page.waitForTimeout(400);
            } catch { break; }
            finally { await page.evaluate(`document.querySelectorAll('[data-dsa-step]').forEach(e => e.removeAttribute('data-dsa-step'))`).catch(() => {}); }
          }
          if (!done) continue;
          replays++;
          if (done === steps!.length) replayed.add(key);
          await sweep(`opening ${steps!.slice(0, done).map(x => `“${x.label}”`).join(' › ')}`);
          // Reset whatever the clicks opened or switched on.
          await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(o.waitMs);
        }
      }
      } catch (e: any) {
        if (!/closed|crash|Target/i.test(String(e?.message))) throw e;
        o.log(`  the page closed on ${u.replace(base.origin, '')}; restarting the browser and moving on`);
        await relaunch();
      }
    }
    // Pass 2: explore pages, most promising first (re-scored as elements are found), until time runs out.
    const done2 = new Set<string>();
    while (remaining.length && Date.now() < deadline && o.reveal !== false) {
      const words = [...hints(), ...traced().map(t => t.toLowerCase())];
      const next = promising.filter(p => !done2.has(p.u)).sort((a, b) => b.score - a.score)[0];
      if (!next || !words.length && done2.size >= 20) break;
      done2.add(next.u);
      try {
        await page.goto(next.u, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(o.waitMs);
        const sweep = sweeper(next.u);
        await sweep();
        if (remaining.length) await explore(next.u, sweep);
      } catch (e: any) {
        // One page that won't load (an aborted navigation, a timeout) costs that page, not the run's screenshots.
        if (!/closed|crash|Target/i.test(String(e?.message))) { o.log(`  skip ${next.u}: ${String(e?.message).split('\n')[0]}`); continue; }
        await relaunch();
      }
    }
    if (net.blocked) o.log(`  network guard blocked ${net.blocked} request(s) (last: ${net.last.join(', ')})`);
    if (remaining.length && Date.now() >= deadline) o.log(`  time budget (shots.maxMinutes) used up with ${remaining.length} still to find.`);
  } finally {
    await browser.close().catch(() => {});
  }
  return { shots, pages, missing: remaining.map(r => r.id) };

  /**
   * Explore one page as a tree of UI states. From the loaded page, try each interaction (best first:
   * the control the source traced, then ones whose label matches what the missing elements need, then
   * tabs and segments that swap content, popups and disclosures, reveal words, hovers, and a right-click
   * on a grid cell). After each one, look for the missing elements; then try the controls that
   * interaction revealed, up to shots.maxDepth deep. Return to the parent state with Escape, or by
   * reloading and replaying the path. Never anything that deletes, saves, submits, sends, or closes.
   */
  async function explore(u: string, sweep: (revealedBy?: string) => Promise<void>) {
    let budget = o.maxActions ?? 20;
    const maxDepth = o.maxDepth ?? 3;
    const pageStop = Math.min(deadline, Date.now() + 45_000);
    const load = async () => { await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); await page.waitForTimeout(o.waitMs); };
    const sig = (): Promise<string> => page.evaluate(SIGNATURE).catch(() => '');
    const mark = (level: number) => inPage(page, MARK_SEEN, level).catch(() => {});
    const list = (level: number): Promise<Act[]> => inPage<Act[]>(page, CANDIDATES, { traced: traced(), hints: hints(), level, max: 50 }).catch(() => []);
    const left = () => { const now = page.url(); return now.split('#')[0] !== u.split('#')[0] || (u.includes('#') && now !== u && !now.startsWith(u)); };
    const perform = async (a: Act) => {
      const loc = page.locator(`[data-dsa-act="${a.n}"]`).first();
      if (a.kind === 'hover') await loc.hover({ timeout: 2000, force: true });
      else if (a.kind === 'context') await loc.click({ button: 'right', timeout: 2000 });
      else await loc.click({ timeout: 2000 });
      await page.waitForTimeout(a.kind === 'hover' ? 250 : 400);
    };
    // Back to the state after `path`: reload, then redo each step (each found again by its key).
    const replay = async (path: Act[]) => {
      await load();
      for (let i = 0; i < path.length; i++) {
        await mark(i);
        const m = (await list(i)).find(x => x.key === path[i].key);
        if (!m) return false;
        try { await perform(m); } catch { return false; }
        if (left()) return false;
      }
      return true;
    };
    const describe = (path: Act[]) => path.map(a => `${a.kind === 'hover' ? 'hovering' : a.kind === 'context' ? 'right-clicking' : 'opening'} “${a.label}”`).join(' › ');

    const walk = async (path: Act[], level: number, before: string): Promise<boolean> => {
      // At the top, every control on the page; below it, only what the last interaction revealed.
      const keys = (await list(level)).map(a => a.key);
      for (const key of keys) {
        if (!remaining.length || budget <= 0 || Date.now() > pageStop) return true;
        const a = (await list(level)).find(x => x.key === key);
        if (!a) continue;
        const appKey = `${a.kind}|${a.label.toLowerCase()}`;
        // The same top-level control on another page usually opens the same thing; unless it's what the source points at.
        if (level === 0 && a.prio < 100 && triedApp.has(appKey)) continue;
        if (level === 0) triedApp.add(appKey);
        await mark(level);
        try { await perform(a); } catch { continue; }
        budget--;
        if (left()) { if (!(await replay(path))) return false; continue; }
        const after = await sig();
        if (after !== before) {
          await sweep(describe([...path, a]));
          if (!remaining.length) return true;
          if (level + 1 < maxDepth && a.kind !== 'hover') {
            const ok = await walk([...path, a], level + 1, after);
            if (!ok) { if (!(await replay(path))) return false; continue; }
          }
        }
        // Back to this level's state: Escape closes what opened; otherwise reload and replay the path.
        if (a.kind === 'hover') await page.mouse.move(0, 0).catch(() => {});
        else { await page.keyboard.press('Escape').catch(() => {}); await page.keyboard.press('Escape').catch(() => {}); }
        await page.waitForTimeout(150);
        if ((await sig()) !== before && !(await replay(path))) return false;
      }
      return true;
    };
    await walk([], 0, await sig());
    if (budget <= 0) o.log(`  interaction budget (shots.maxActions) used on ${u.replace(base.origin, '')}`);
  }
}

/** Runs in the page: a short fingerprint of what's visible (URL, open overlays, visible controls, text size). */
const SIGNATURE = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const ctrls = Array.from(document.querySelectorAll('button,[role=button],a[href],input,select,textarea,[role=tab],[role=menuitem],[role=option],[role=gridcell]')).filter(vis).length;
  const overlays = document.querySelectorAll('[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-state=open],[aria-expanded=true],[aria-selected=true]').length;
  return location.href + '|' + overlays + '|' + ctrls + '|' + ((document.body && document.body.innerText.length) >> 5);
})()`;

/** Runs in the page: mark every element present now, so the next level only tries what an interaction revealed. */
const MARK_SEEN = `(level) => { const a = 'data-dsa-seen-' + level; document.body.querySelectorAll('*').forEach(el => el.setAttribute(a, '')); }`;

/**
 * Runs in the page: the interactions worth trying, best first, each marked data-dsa-act=<n> and keyed
 * (kind | role | label | nth) so it can be found again after a reload. Below the top level, only controls
 * the last interaction revealed. Destructive, closing, and leaving controls are never offered.
 */
const CANDIDATES = `(o) => {
  document.querySelectorAll('[data-dsa-act]').forEach(e => e.removeAttribute('data-dsa-act'));
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  // A control's words without its icons: icon fonts render their name as text ("add Colour").
  const words = (el) => { const c = el.cloneNode(true); c.querySelectorAll('[data-slot=icon], .material-symbols-outlined, .material-symbols-rounded, .material-icons, svg, [aria-hidden=true]').forEach(x => x.remove()); return c.textContent || ''; };
  const labelOf = (el) => norm(el.getAttribute('aria-label') || words(el) || el.getAttribute('title') || '').slice(0, 40);
  const bad = /delete|remove|discard|archive|sign ?out|log ?out|reset|clear all|submit|save|send|publish|approve|reject|confirm|download|export|print|upload|import|share|invite|pay|purchase|buy|checkout|deactivate|close|cancel|dismiss|undo|duplicate/i;
  const prev = o.level > 0 ? 'data-dsa-seen-' + (o.level - 1) : null;
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const st = getComputedStyle(el); return st.visibility !== 'hidden' && st.display !== 'none'; };
  const traced = o.traced.map(t => t.toLowerCase()), hints = o.hints;
  const out = [], counts = {};
  const push = (el, kind, why, prio) => {
    if (!vis(el) || el.closest(':disabled,[aria-disabled="true"]')) return;
    if (prev && el.hasAttribute(prev)) return;
    if (el.matches('a[href]:not([href^="#"]):not([role])')) return;
    if (el.matches('[type=submit]') && el.closest('form')) return;
    if (el.matches('input[type=file]') || el.querySelector('input[type=file]')) return;
    const label = labelOf(el);
    if (kind !== 'hover' && bad.test(label)) return;
    if (out.some(x => x.el === el && x.kind === kind)) return;
    const l = label.toLowerCase();
    let p = prio;
    if (l && traced.includes(l)) p += 100;
    else if (l && hints.some(h => l.includes(h) || (l.length >= 4 && h.includes(l)))) p += 30;
    if (p <= 0) return;
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const base = kind + '|' + role + '|' + l;
    counts[base] = (counts[base] || 0) + 1;
    out.push({ el, key: base + '|' + (counts[base] - 1), kind, label: label || role, why, prio: p });
  };
  const q = (sel, f) => document.querySelectorAll(sel).forEach(f);
  // Content swaps: the tab, segment, or option not showing yet.
  q('[role=tab][aria-selected="false"], [data-slot="tabs-trigger"][data-state="inactive"]', el => push(el, 'click', 'tab', 40));
  q('[role=radio][aria-checked="false"], [aria-pressed="false"], [data-slot="toggle-group-item"][data-state="off"], [role=menuitemradio][aria-checked="false"]', el => push(el, 'click', 'choice', 38));
  // Things that open: menus, popovers, sheets, disclosures.
  q('[aria-haspopup]:not([aria-haspopup="false"]), [aria-expanded="false"], [data-state="closed"][data-slot$="trigger"], details:not([open]) > summary', el => push(el, 'click', 'opens', 35));
  q('[role=menuitem][aria-haspopup], [data-slot$="sub-trigger"]', el => push(el, 'click', 'submenu', 34));
  // Hand-built sets with no ARIA state: members of a group, toolbar, or tab list.
  q('[role=group] > button, [role=toolbar] button, [role=tablist] > button, [role=radiogroup] > button', el => push(el, 'click', 'set member', 28));
  // Words that reveal more (never the destructive ones above).
  const reveal = /^(show|see|view|load) (more|all|details|less)$|\\b(more|expand|details|edit|add|new|open|preview|compare|filters?|options|settings|customi[sz]e|configure|manage|comments?|history|activity|annotate|colou?rs?)\\b/i;
  q('button, [role=button], [role=menuitem]', el => { if (reveal.test(labelOf(el))) push(el, 'click', 'reveal', 22); });
  // Any control whose label the source traced or the gates hint at (prio 0 unless it matches).
  if (traced.length || hints.length) q('button, [role=button], [role=menuitem], [role=option], [role=tab], a[href^="#"], [tabindex="0"]', el => push(el, 'click', 'hint', 0));
  // Hover: tooltips, hover cards, and rows or cards whose actions appear on hover.
  q('[data-slot="tooltip-trigger"], [data-slot="hover-card-trigger"]', el => push(el, 'hover', 'hover', 10));
  let rows = 0;
  q('tr, [role=row], li, [class*="group"]', el => {
    if (rows >= 6) return;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (!/(^|\\s)group(\\/[\\w-]+)?(\\s|$)/.test(cls) && !/^(TR|LI)$/.test(el.tagName) && el.getAttribute('role') !== 'row') return;
    if (!el.querySelector('[class*="group-hover:"], [class*="opacity-0"], [class*="invisible"]')) return;
    rows++; push(el, 'hover', 'row actions', 14);
  });
  // A grid cell: its context menu, and selecting it (floating toolbars and editors appear on a selected cell).
  let cells = 0;
  q('[role=gridcell], td', el => { if (cells >= 2 || !vis(el)) return; cells++; push(el, 'context', 'cell menu', 9); push(el, 'click', 'cell', 7); });
  const keep = out.sort((a, b) => b.prio - a.prio).slice(0, o.max);
  keep.forEach((x, i) => x.el.setAttribute('data-dsa-act', String(i)));
  return keep.map((x, i) => ({ n: i, key: x.key, kind: x.kind, label: x.label, why: x.why, prio: x.prio }));
}`;

/**
 * Runs in the page on a found element: where it sits. Landmark and ARIA ancestors, design system parts
 * (data-slot, data-sidebar), live ARIA state on the element, look-alike siblings, and geometry: a narrow
 * full-height column at the window edge is a sidebar, a full-width strip at the top is the header.
 */
const PLACE_IN_PAGE = `(el) => {
  const vw = innerWidth, vh = innerHeight;
  const regions = [], geometry = [];
  const add = (r) => { if (!regions.includes(r)) regions.push(r); };
  let parentRole, depth = 0, cell = false;
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement, depth++) {
    const t = a.tagName.toLowerCase(), role = a.getAttribute('role') || '', slot = a.getAttribute('data-slot') || '';
    if (!parentRole && depth < 4 && /^(group|radiogroup|toolbar|tablist|listbox|menu|menubar|navigation)$/.test(role)) parentRole = role;
    if (a.hasAttribute('data-sidebar') || /^sidebar/.test(slot)) add('sidebar');
    else if (t === 'aside' || role === 'complementary') add('aside');
    if (t === 'nav' || role === 'navigation') add('nav');
    if (t === 'header' || role === 'banner') add('header');
    if (t === 'footer' || role === 'contentinfo') add('footer');
    if (role === 'toolbar' || role === 'menubar') add('toolbar');
    if (t === 'dialog' || role === 'dialog' || role === 'alertdialog' || /^(dialog|sheet|drawer|alert-dialog)-content$/.test(slot)) add('dialog');
    if (/^(popover|hover-card)-content$/.test(slot)) add('popover');
    if (role === 'menu' || role === 'listbox' || /menu-content$/.test(slot)) add('menu');
    if (role === 'tablist') add('tablist');
    if (t === 'table' || role === 'grid' || role === 'table') add('table');
    if (t === 'td' || t === 'th' || role === 'gridcell') cell = true;
    if (t === 'ul' || t === 'ol' || role === 'list') add('list');
    if (t === 'form') add('form');
    const r = a.getBoundingClientRect();
    if (!regions.includes('sidebar') && r.width >= 48 && r.width <= 380 && r.height >= vh * 0.6 && (r.left <= 4 || r.right >= vw - 4)) {
      add('sidebar'); geometry.push('in the ' + (r.left <= 4 ? 'left' : 'right') + ' rail (a ' + Math.round(r.width) + '×' + Math.round(r.height) + ' column at the window edge)');
    }
    if (!regions.includes('header') && r.top <= 4 && r.height <= 96 && r.height >= 24 && r.width >= vw * 0.7) { add('header'); geometry.push('in the top bar (' + Math.round(r.width) + '×' + Math.round(r.height) + ')'); }
  }
  if (cell) geometry.push('in a table cell');
  const attrs = {};
  for (const k of ['aria-expanded', 'aria-current', 'aria-pressed', 'aria-selected', 'aria-checked', 'aria-haspopup', 'aria-controls', 'role', 'data-state']) { const v = el.getAttribute(k); if (v !== null) attrs[k] = v; }
  const p = el.parentElement;
  // Look-alikes only: same tag and most of the same classes (Cancel beside Save isn't a set).
  const mine = new Set(Array.from(el.classList));
  const like = (c) => { const o = Array.from(c.classList); if (!mine.size && !o.length) return true; const shared = o.filter(x => mine.has(x)).length; return shared / Math.max(mine.size, o.length) >= 0.6; };
  const siblings = p ? Array.from(p.children).filter(c => c !== el && c.tagName === el.tagName && like(c)).length : 0;
  return { regions, attrs, parentRole, siblings, geometry };
}`;

/**
 * Which elements to photograph. A group that needs a human decision gets every case (up to perQuestion), so
 * the reviewer can see they really look the same before one answer covers them all. A group the scanner is
 * already sure of gets a few, spread across files.
 */
export function pickExamples(evals: ElementEval[], perGroup: number, prefer: Set<string> = new Set(), perQuestion = 40): ElementEval[] {
  const groups = new Map<string, ElementEval[]>();
  for (const e of evals.filter(x => !x.exception)) groups.set(groupKey(e), [...(groups.get(groupKey(e)) ?? []), e]);
  const out: ElementEval[] = [];
  for (const items of groups.values()) {
    const cap = items.some(e => e.needsHuman) ? Math.max(perGroup, perQuestion) : perGroup;
    // Findable first (text or aria-label), needs-human first, then one per file.
    const sorted = [...items].sort((a, b) => Number(prefer.has(b.id)) - Number(prefer.has(a.id)) || Number(b.needsHuman) - Number(a.needsHuman) || Number(Boolean(b.match.text || b.match.ariaLabel)) - Number(Boolean(a.match.text || a.match.ariaLabel)));
    // One example per look first (elements with the same classes render the same), so the review can show
    // every distinct look in a group; then fill up to perGroup, spread across files.
    const looks = new Set<string>();
    for (const e of sorted) {
      const k = e.styleSig ?? e.styleKey ?? e.id;
      if (looks.has(k)) continue;
      if (looks.size >= cap + 5) break;
      looks.add(k);
      out.push(e);
    }
    const files = new Set<string>(out.filter(o => groupKey(o) === groupKey(sorted[0])).map(o => o.file));
    for (const e of sorted) {
      if (out.includes(e)) continue;
      if (out.filter(o => groupKey(o) === groupKey(e)).length >= cap) break;
      if (files.has(e.file) && sorted.some(x => !files.has(x.file) && !out.includes(x))) continue;
      files.add(e.file);
      out.push(e);
    }
    // Spreading across files skips cases in a file already shown; a group a human decides gets them too.
    if (cap > perGroup) {
      let n = out.filter(o => groupKey(o) === groupKey(sorted[0]!)).length;
      for (const e of sorted) { if (n >= cap) break; if (!out.includes(e)) { out.push(e); n++; } }
    }
  }
  return out;
}

/** Runs in the page: mark the visible, enabled control with this label (exact text, aria-label, or title). */
const FIND_CONTROL = `(label) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').replace(/\\(\\s*\\)/g, '').trim().toLowerCase();
  const want = norm(label);
  // A button's words without its icons: icon fonts render their name as text ("add Colour").
  const words = (el) => { const c = el.cloneNode(true); c.querySelectorAll('[data-slot=icon], .material-symbols-outlined, .material-symbols-rounded, .material-icons, svg, [aria-hidden=true]').forEach(x => x.remove()); return c.textContent || ''; };

  const bad = /delete|remove|discard|archive|sign ?out|log ?out|reset|submit|save|send|publish|approve|reject|confirm/i;
  const sel = 'button, [role=button], a, [role=menuitem], [role=tab], [role=switch], [role=checkbox], summary, [aria-haspopup], [data-slot$="-trigger"], [tabindex]';
  let best = null;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest(':disabled,[aria-disabled="true"]')) continue;
    const names = [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent, words(el)].map(norm);
    if (!names.includes(want)) continue;
    if (bad.test(names.join(' '))) continue;
    best = el; break;
  }
  if (!best) return false;
  best.setAttribute('data-dsa-step', '1');
  return true;
}`;

/**
 * How sure a match is. The page scores every candidate; when several score within 0.05 of the best, the pick
 * among them is a guess, right about one time in `ties`, so the confidence is capped there. Below
 * PLACEMENT_MIN_MATCH a shot is still shown, but its placement doesn't feed the next evaluation.
 */
export function matchConfidence(score: number, ties: number): number {
  return ties > 1 ? Math.min(score * 0.85, 1 / ties) : score;
}

/**
 * Runs in the page. Scores every element with the right tag against what the scan knows.
 * Kept as source text: tsx/esbuild wrap functions with helpers (__name) that don't exist in the page.
 */
const FIND_IN_PAGE = `(targets) => {
  const out = [];
  const norm = (s) => s.replace(/\\s+/g, ' ').trim();
  // A button's words without its icons: icon fonts render their name as text ("add Colour").
  const words = (el) => { const c = el.cloneNode(true); c.querySelectorAll('[data-slot=icon], .material-symbols-outlined, .material-symbols-rounded, .material-icons, svg, [aria-hidden=true]').forEach(x => x.remove()); return c.textContent || ''; };

  for (const t of targets) {
    const els = Array.from(document.querySelectorAll(t.m.tag));
    const scored = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.closest('[data-dsa-shot]')) continue;
      const st = getComputedStyle(el);
      // Hidden until hover (row actions: invisible group-hover:visible) still counts; capture hovers it in.
      if (st.display === 'none' || (st.visibility === 'hidden' && !el.closest('[class*="group"]'))) continue;
      let s = 0, w = 0;
      if (t.m.classes.length) { w += 0.45; s += 0.45 * (t.m.classes.filter(c => el.classList.contains(c)).length / t.m.classes.length); }
      if (t.m.text) { w += 0.35; const txt = norm(words(el)), all = norm(el.textContent || ''); s += txt === t.m.text || all === t.m.text ? 0.35 : txt.includes(t.m.text) || all.includes(t.m.text) ? 0.25 : 0; }
      if (t.m.ariaLabel) { w += 0.3; s += el.getAttribute('aria-label') === t.m.ariaLabel ? 0.3 : 0; }
      if (t.m.title) { w += 0.15; s += el.getAttribute('title') === t.m.title ? 0.15 : 0; }
      if (t.m.role) { w += 0.1; s += el.getAttribute('role') === t.m.role ? 0.1 : 0; }
      if (t.m.type) { w += 0.1; s += el.getAttribute('type') === t.m.type ? 0.1 : 0; }
      const score = w ? s / w : 0;
      if (score >= 0.6) scored.push({ el, s: score });
    }
    if (!scored.length) continue;
    scored.sort((a, b) => b.s - a.s);
    const best = scored[0];
    const ties = scored.filter(x => best.s - x.s < 0.05).length;
    best.el.setAttribute('data-dsa-shot', t.id);
    out.push({ id: t.id, score: best.s, ties });
  }
  return out;
}`;

/**
 * Capture one marked element with context around it. The image is left untouched (no outline drawn
 * into it, so shadows, focus rings, and other effects stay visible); the element's box within the
 * crop is returned, and the report draws a thin highlight from it.
 */
async function capture(page: any, id: string, file: string): Promise<{ box: { x: number; y: number; w: number; h: number; cw: number; ch: number } } | null> {
  const sel = `[data-dsa-shot="${id}"]`;
  try {
    // Center it, reveal hover-only controls (row actions fade in on hover), and let layout settle.
    await inPage(page, `(sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'center', inline: 'center' }); }`, sel);
    const hidden = await inPage<boolean>(page, `(sel) => { let el = document.querySelector(sel); if (el && getComputedStyle(el).visibility === 'hidden') return true; let o = 1; while (el && el !== document.body) { o *= Number(getComputedStyle(el).opacity); el = el.parentElement; } return o < 0.3; }`, sel);
    if (hidden) await page.locator(sel).first().hover({ force: true, timeout: 2000 }).catch(() => {});
    let box: any = null;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(i ? 120 : 200);
      const b = await page.locator(sel).first().boundingBox();
      if (b && box && Math.abs(b.x - box.x) < 0.5 && Math.abs(b.y - box.y) < 0.5 && Math.abs(b.width - box.width) < 0.5) { box = b; break; }
      box = b;
    }
    if (!box || box.width < 2 || box.height < 2) return null;
    const vp = page.viewportSize();
    // Context scales with the element; small controls still get enough surroundings to recognize them.
    const pad = Math.max(24, Math.min(96, Math.round(Math.max(box.width, box.height) * 0.6)));
    let cw = Math.max(box.width + pad * 2, 240), ch = Math.max(box.height + pad * 2, 120);
    cw = Math.min(cw, vp.width); ch = Math.min(ch, vp.height);
    let cx = box.x + box.width / 2 - cw / 2, cy = box.y + box.height / 2 - ch / 2;
    cx = Math.max(0, Math.min(cx, vp.width - cw)); cy = Math.max(0, Math.min(cy, vp.height - ch));
    await page.screenshot({ path: file, clip: { x: cx, y: cy, width: cw, height: ch } });
    const r = (n: number) => Math.round(n * 10) / 10;
    return { box: { x: r(box.x - cx), y: r(box.y - cy), w: r(box.width), h: r(box.height), cw: r(cw), ch: r(ch) } };
  } catch { return null; }
  finally {
    await inPage(page, `(sel) => { const el = document.querySelector(sel); if (el) el.removeAttribute('data-dsa-shot'); }`, sel).catch(() => {});
    await page.mouse.move(0, 0).catch(() => {});
  }
}

/** For tests: the in-page scripts and the helper that runs them. */
export const __test = { inPage, FIND_IN_PAGE, CANDIDATES, MARK_SEEN, PLACE_IN_PAGE };

/** One headless capture pass over a running app (the workbench's before/after uses it on two copies of the app). */
export const captureSession = session;
