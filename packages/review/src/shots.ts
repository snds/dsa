/// <reference lib="dom" />
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LEDGER_RUNTIME, fileOfTag, tagPath } from '@snds/dsa/tag';
import { renderTests } from './testTier.js';
import { addToLedger, contentHash, readLedger, readLedgerLines, recordsFor, type LedgerRec } from './ledger.js';
import { BLANK_INSET, appUses, notProductRule, buildGraph, cardPicks, federate, lookRules, decodePng, groupKey, isBlank, latestEvals, materializeRemotes, resolveTargets, targetRelative, walk, type Config, type ElementEval } from '@snds/dsa/engine';
import { appSurface, openSurface } from '@snds/dsa';

import { detectApp, discoverRoutes, ensureBrowser, linkCoreForChild, routeConfig, startApp, tagPlan } from './apps.js';

import { READ_STYLE } from './rendered.js';
import { NO_SIZE, SHOW_MARKUP, forceGates, hookValue, itemAliases, nullRead, propsPassedAt, typedProp, markupOf, mountProps, parentComponent, holdsInitially, readSource, stateSets, stateValues, whatItNeeded, type StateSet } from './drawn.js';
import { needsValue, patternTest, routeFiles, routesReaching } from './routes.js';
import { describeNetwork, flowProblems, guardNetwork, routeUrl, runFlow, type Flow, type GuardStats } from './flows.js';

/**
 * Example screenshots for the element review. Not every instance: a few per recommendation
 * group, plus the ones that need a human (people decide faster when they can see the thing).
 *
 * Needs a running app (dev server or preview). On a page with source tags (`data-dsa-src`, from
 * @snds/dsa/tag) an element is found by the file:line:col that made it: exact. Elsewhere it's found by
 * what the static scan knows (tag, classes, text, aria-label), so each capture carries a match score:
 * a weak match is labelled as such instead of being passed off as the element.
 */

export interface ShotResult {
  captured: number; missing: number; pages: number;
  apps: {
    target: string; url?: string; how?: string; routes?: number; captured?: number; cached?: number; skipped?: string;
    /** Every page asked for sign-in (a login route, another host, a password form): where it sent the crawler. */
    signIn?: string;
    /** The app didn't render on any page (it threw, its modules failed, or nothing showed): the first error. */
    broken?: string;
    /** Routes the app declares that need a value (a :param, a splat): to open, list one in apps["name"].routes. */
    needsValue?: string[];
    /** The share of pages visited that carried source tags (0 to 1). */
    tagged?: number;
    /** Elements drawn direct from code, because they couldn't be photographed. */
    drawn?: number;
    /** How each element looked for was reached: live (a photo), drawn (mounted, markup), or not at all, and why. */
    reach?: { live: number; mounted: number; markup: number; unreachable: number; why: Record<string, number> };
  }[];
}

/**
 * Runs in the page: what an app that rendered shows. A blank page (an app that threw before it drew, or
 * whose modules failed) has no visible text and nothing to interact with.
 */
const RENDERED = `() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const text = (document.body && document.body.innerText || '').trim().length;
  const controls = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [tabindex]')).filter(vis).length;
  return { text, controls };
}`;

/**
 * Runs in the page: is this a sign-in wall? A login-like path (login, signin, sso, auth, an OpenID
 * realm), or a visible password field.
 */
const SIGN_IN = `() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const path = location.pathname + location.hash;
  return /\\/(log-?in|sign-?in|signon|sso|auth|oauth2?|openid|realms\\/[^/]+\\/protocol)(\\b|\\/|$)/i.test(path) || Array.from(document.querySelectorAll('input[type=password]')).some(vis);
}`;

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
const CRAWLER = 10;

interface Target { id: string; e: ElementEval; /** What was tried to reveal it, in plain words (kept with its miss). */ tried?: string[]; m: ElementEval['match']; /** Its source tag: file:line:col, as the scanner and the tagger write it. */ src: string; steps?: { label: string; event: 'click' | 'dblclick' | 'type' | 'choose'; value?: string | undefined; /** The control's own source line ("file:line:"), to find it by its tag. */ src?: string | undefined }[]; /** The routes whose component renders its file (routes.ts); empty: none does. */ routes?: string[]; hints: string[]; where: string[] }

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
/** Words in an element's file path (orders/OrderRow.tsx → orders, order, row): a page whose route has them is likely its page. */
export function pathWords(file: string): string[] {
  const out = new Set<string>();
  for (const part of file.replace(/\.[\w]+$/, '').split(/[\/._-]+/)) for (const w of part.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/)) { const x = w.toLowerCase(); if (x.length >= 4 && !PATH_STOP.test(x)) out.add(x); }
  return [...out];
}
const PATH_STOP = /^(apps?|src|lib|components?|views?|pages?|index|main|shared|common|features?|modules?|packages?|tsx|jsx|vue|html)$/;
const STOP = /^(open|opened|show|shown|visible|true|false|null|undefined|mode|view|state|active|current|selected|editing|edit|value|props|items|item|length|setup|takeover|demo|route|hide|chrome|that|this|with|from|when|page|kind|type|enabled|disabled|dialog|popover)$/;

/**
 * Screenshots without a manual dev server: for each app with evaluations, start it (apps.ts),
 * crawl its routes in headless Chromium, capture examples, stop it. --url still works for an app
 * that's already running somewhere.
 */
export async function takeShots(given: { root: string; dataDir: string; config: Config; url?: string; routes?: string[]; perGroup?: number; target?: string; fresh?: boolean; /** Try every example not found last time again (screenshots already taken stay cached). */ retryMissing?: boolean; log?: (m: string) => void }): Promise<ShotResult> {
  // Each app's own dsa.config.json merged in (its routes, flows); an `apps` key naming no app stops the run.
  const fed = federate(given.root, given.config);
  if (fed.unmatched.length) throw new Error(`apps ${fed.unmatched.map(k => `"${k}"`).join(', ')} in the config name${fed.unmatched.length === 1 ? 's' : ''} no app here. Apps found: ${resolveTargets(given.root, given.config).filter(t => t.role !== 'core').map(t => t.name).join(', ') || 'none'}. Key each by its folder or package name.`);
  const opts = { ...given, config: fed.config };
  const log = opts.log ?? (() => {});
  if (fed.merged.length) log(`Using the app's own dsa.config.json for ${fed.merged.join(', ')}.`);
  const pw = await ensureBrowser(log);
  const { evals } = await latestEvals(opts.dataDir);
  const dir = path.join(opts.dataDir, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const idxFile = path.join(dir, 'index.json');
  const index: { shots: Record<string, any>; missing: string[]; pages: string[]; takenAt: string; misses?: Record<string, any>; run?: RunStamp; uses?: Record<string, any>; useMisses?: Record<string, any>; usesOpened?: Record<string, { setup: string; at: string; pages: string[] }>; ledgerCoverage?: Record<string, { own: number; component: number; file: number; none: number; tests: number }>; ledgerGaps?: Record<string, unknown[]>; drawCauses?: Record<string, unknown>; drawChanges?: Record<string, { gained: string[]; live: string[]; lost: string[]; lostLive: string[] }> } = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : { shots: {}, missing: [], pages: [], takenAt: '' };
  index.missing = []; index.pages = [];
  // The run before this one: what it counted is what a rerun on unchanged code must keep, no more and no less.
  const lastRun = index.run?.id;
  // This run: an id each new photo carries, the source it was taken from (its commit, or "worktree" when the
  // checkout has changes), and when. Cached photos keep their own stamp, so a report can tell an old one apart.
  index.run = { id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, ref: sourceRef(opts.root), at: new Date().toISOString() };
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
  // A photo without placement predates it (crawler 4): take it again once, so every example says where it sits. A drawing has no page position to record.
  const fresh = (entry: any, e: ElementEval) => !opts.fresh && entry && entry.fileHash === hashOf(e) && Date.now() - Date.parse(entry.at ?? 0) < maxAge && (entry.file && !entry.drawn ? 'placement' in entry : true)
    // A photo that didn't record what its element holds besides words: taken again once.
    && !(entry.file && !entry.drawn && entry.content && !('inner' in entry.content))
    // Taken before copies kept what sits on top of what, and before a field's words were recorded: taken again once.
    && !(entry.file && !entry.drawn && entry.content && entry.content.v !== OWN_CAPTURE && (entry.content.inner || FIELD_TAG.test(e.snippet ?? '')));
  // A "not found" is only worth reusing if nothing about how we'd look for it changed: the crawler
  // itself (CRAWLER) and the reveal steps traced for this element. Otherwise a fix never gets a retry.
  const stepsKey = (e: ElementEval) => (e.reach?.steps ?? []).map(x => x.event + ':' + x.label).join('|');
  // …nor how the app is reached: its start, routes, flows, live surface and sign-in, and the build it serves.
  // Fixing the app's setup retries its misses on the next run, no flag needed.
  const setupKey = (target: string) => {
    const surface: any = appSurface(opts.config.live, target);
    const built = surface?.dir ? (() => { try { return fs.statSync(path.join(path.resolve(opts.root, surface.dir), 'index.html')).mtimeMs; } catch { return 0; } })() : 0;
    const auth = surface?.auth ? (() => { try { return fs.statSync(path.resolve(opts.root, surface.auth)).mtimeMs; } catch { return 0; } })() : 0;
    return crypto.createHash('sha1').update(JSON.stringify([opts.config.apps?.[target] ?? null, surface ?? null, opts.config.shots?.routes ?? null, opts.url ?? null, built, auth, installOf(all.find(x => x.name === target)?.dir)])).digest('hex').slice(0, 12);
  };
  // The app's dependencies: its lockfile's contents and when node_modules was last installed (the app's
  // own folder, then up to the root). Installing a missing package retries what a broken app hid.
  const installOf = (dir?: string) => {
    if (!dir) return null;
    const out: (string | number)[] = [];
    for (let d = path.resolve(dir); ; d = path.dirname(d)) {
      for (const f of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) { try { out.push(f, crypto.createHash('sha1').update(fs.readFileSync(path.join(d, f))).digest('hex').slice(0, 12)); } catch { /* none here */ } }
      for (const f of ['node_modules/.package-lock.json', 'node_modules/.modules.yaml', 'node_modules/.yarn-state.yml']) { try { out.push(f, fs.statSync(path.join(d, f)).mtimeMs); } catch { /* none here */ } }
      if (d === path.resolve(opts.root) || d === path.dirname(d)) break;
    }
    return out;
  };
  const setups = new Map<string, string>();
  const setupOf = (target: string) => { if (!setups.has(target)) setups.set(target, setupKey(target)); return setups.get(target)!; };
  const freshMiss = (entry: any, e: ElementEval) => !opts.retryMissing && fresh(entry, e) && entry.crawler === CRAWLER && (entry.steps ?? '') === stepsKey(e) && entry.setup === setupOf(e.target);
  index.misses ??= {};
  const misses = index.misses;
  // Did the last run count this shot? One it set aside as old stays set aside: a rerun mustn't bring it back.
  const counted = (s: any) => Boolean(lastRun) && (s?.run === lastRun || s?.confirmed === lastRun);
  const plan = (mine: ElementEval[]) => {
    // A drawing isn't a photo: it stays until its miss is tried again (a changed file or setup).
    const cached = new Set(mine.filter(e => fresh(index.shots[e.id], e) && counted(index.shots[e.id]) && !index.shots[e.id].drawn && fs.existsSync(path.join(dir, index.shots[e.id].file))).map(e => e.id));
    const picked = pickExamples(mine, perGroup, cached, opts.config.shots?.perQuestion ?? 40);
    const need = picked.filter(e => !cached.has(e.id) && !freshMiss(misses[e.id], e));
    return { picked, need, cached: picked.filter(e => cached.has(e.id)).length };
  };

  /**
   * What to photograph of how the app already uses the components its cards propose. Read from its source, so
   * a use through a local file that re-exports the system counts (the scan's own list doesn't follow those).
   * A photo or a miss stands while its file is unchanged, so a normal run retakes nothing.
   */
  const notProduct = notProductRule(cfg.shots?.notProduct);
  const usesPlan = (name: string): UsesPlan => {
    const none: UsesPlan = { want: [], have: { looks: {}, components: {}, total: 0, pages: {} }, keys: [], asks: {}, opened: [] };
    const t = all.find(x => x.name === name);
    if (!t || t.role === 'core') return none;
    const mine = evals.filter(e => e.target === name && !e.exception);
    const wanted = new Set<string>();
    let system: any[] = [];
    try { system = JSON.parse(fs.readFileSync(path.join(opts.dataDir, 'signatures.json'), 'utf8')); } catch { /* no system list: every prop that isn't about behaviour counts */ }
    const rules = lookRules(system);
    const picks = new Map<string, any>();
    try { for (const c of cardPicks(opts.dataDir, mine, opts.config.review?.threshold)) for (const id of c.ids) { picks.set(id, c.auto); if (c.auto?.use) wanted.add(c.auto.use); } } catch { /* no cards: the elements themselves say */ }
    // How much each look is asked for: a card a person must decide counts whole; one that may only come up in the audit counts for its tenth.
    const asks: Record<string, number> = {};
    for (const e of mine) {
      for (const r of [e, e.decided?.decision, ...(e.alternatives ?? [])]) if ((r as any)?.use) wanted.add((r as any).use);
      if (e.reach?.status === 'unused' || e.verdict === 'ignore') continue;
      const pick: any = picks.get(e.id) ?? e.decided?.decision ?? e;
      const about: any = pick?.use ? pick : (e.alternatives ?? []).find((a: any) => a?.use);
      if (about?.use) { const k = rules.key(about.use, about.props); asks[k] = (asks[k] ?? 0) + (e.needsHuman && !e.decided ? 1 : 0.1); }
    }
    if (!wanted.size) return none;
    let uses: ReturnType<typeof appUses>['uses'];
    try { uses = appUses(opts.root, cfg, t, wanted).uses; } catch { return none; }
    const hash = new Map<string, string>();
    const hashAt = (f: string) => { if (!hash.has(f)) hash.set(f, contentHash(f) ?? ''); return hash.get(f)!; };
    const out: UsesPlan = { ...none, have: { looks: {}, components: {}, total: 0, pages: {} }, keys: uses.map(u => u.key), asks };
    const newEnough = (x: any) => Date.now() - Date.parse(x?.at ?? 0) < maxAge;
    const list: UsesPlan['want'] = [];
    for (const u of uses) {
      const look = rules.unknown(u.component, u.dynamic) ? `${u.component} ?` : rules.key(u.component, u.props);
      const need = asks[look] ?? 0;
      const lab = notProduct.file(targetRelative(opts.root, u.shown, t.dir));
      const photo = index.uses?.[u.key];
      const stands = photo && photo.fileHash === hashAt(u.file) && newEnough(photo) && fs.existsSync(path.join(dir, photo.file));
      if (photo && !stands && !opts.fresh) delete index.uses![u.key];
      if (stands && !opts.fresh) {
        countUse(out.have, { look, component: u.component, need, lab: lab || notProduct.page(photo.page) }, photo.page);
        continue;
      }
      // A lab's use is worth a photo only for a look a card asks for.
      if (lab && !need) continue;
      const miss = index.useMisses?.[u.key];
      if (!opts.fresh && !opts.retryMissing && miss && miss.fileHash === hashAt(u.file) && newEnough(miss) && miss.setup === setupOf(name) && miss.why !== 'out-of-time') continue;
      list.push({ key: u.key, component: u.component, look, file: u.shown, fileHash: hashAt(u.file), need, ...(lab ? { lab } : {}) });
    }
    // Pages an earlier run opened and looked at needn't be opened again while nothing about them changed:
    // the same uses wouldn't show. A use that's new, or in a changed file, could be on any of them.
    const memory = index.usesOpened?.[name];
    const allSame = list.every(x => { const m = index.useMisses?.[x.key]; return m && m.fileHash === x.fileHash; });
    if (memory && !opts.fresh && !opts.retryMissing && memory.setup === setupOf(name) && newEnough(memory) && allSame) out.opened = memory.pages;
    // The looks the cards ask for most first; a look set in the code, which could be anything, last.
    out.want = list.filter(x => usesUnderCap(out.have, x)).sort((a, b) => Number(Boolean(a.lab)) - Number(Boolean(b.lab)) || b.need - a.need || Number(a.look.endsWith(' ?')) - Number(b.look.endsWith(' ?')));
    return out;
  };
  const usesOf = new Map<string, UsesPlan>();
  const usesFor = (name: string) => { if (!usesOf.has(name)) usesOf.set(name, usesPlan(name)); return usesOf.get(name)!; };

  // Routes the app declares that need a value to open: listed in the result, so a person can name one.
  const needs = (target: string) => { const t = all.find(x => x.name === target); const v = t ? routeConfig(t.dir).needsValue : []; return v.length ? { needsValue: v } : {}; };
  const sessions: { target: string; url: string; routes: string[]; first?: string[]; flows?: Flow[]; crawl: boolean; stop?: () => void; how?: string; need: ElementEval[]; storageState?: string | undefined; readApi?: boolean; readPaths?: string[] | undefined; signIn?: SignIn | undefined; draw?: DrawWith; reach?: ReachPlan | undefined; routeSource?: RouteSource | undefined; profiles?: Profile[] | undefined; appDir?: string | undefined; manifest?: ReachFile | undefined }[] = [];
  // Which routes render each element's file, from the scan's import graph and the routes in the source
  // (routes.ts): no config. Undefined when the app declares no routes we can read.
  const reachFor = (t: (typeof all)[number] | undefined, need: ElementEval[]): ReachPlan | undefined => {
    if (!t) return undefined;
    try {
      const routes = routeFiles(t.dir, t.exclude ?? []);
      const g = buildGraph(t.dir, t.exclude ?? [], (t as any).aliases);
      const byId: Record<string, string[]> = {};
      // The files a page must show for it to render each element: its own file and what imports it, three
      // steps up, as source tags name them. Read off the page itself, so it holds when the routes don't say.
      const near: Record<string, string[]> = {};
      // As the tagger names them: under the root, else "<app folder>/<path>" for an app outside it.
      const tagOf = (f: string) => tagPath(f, opts.root, t.dir);
      for (const e of need) {
        const file = path.resolve(t.dir, targetRelative(opts.root, e.file, t.dir));
        if (routes.length) byId[e.id] = routesReaching(routes, g, file);
        const up = new Set([file]);
        let wave = [file];
        for (let k = 0; k < 3; k++) { const next: string[] = []; for (const f of wave) for (const i of g.importers.get(f) ?? []) if (!up.has(i)) { up.add(i); next.push(i); } wave = next; }
        near[e.id] = [...up].map(tagOf).filter((x): x is string => Boolean(x));
      }
      return { byId, near, patterns: [...new Set(routes.map(r => r.path).filter(needsValue))] };
    } catch { return undefined; }
  };
  // Elements that can't be photographed are drawn from the code (shots.draw: false turns it off).
  const drawOn = opts.config.shots?.draw !== false;
  // The app's own route list and starting profiles (apps[name].routeSource, .profiles).
  const reachOwn = (name: string, dir: string) => {
    const a: any = opts.config.apps?.[name] ?? {};
    // The app's own reach manifest file (docs/reach-manifest.md): its routes, and named states as profiles.
    let manifest: ReachFile | undefined;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'dsa.reach.json'), 'utf8')); } catch { /* none */ }
    const fromFile: Profile[] = (manifest?.states ?? []).filter(x => x && x.name && x.route).map(x => ({ name: x.name, route: x.route!, storage: x.storage, session: x.session }));
    return { appDir: dir, routeSource: a.routeSource as RouteSource | undefined, profiles: [...((a.profiles as Profile[] | undefined) ?? []), ...fromFile], manifest };
  };
  const drawFor = (dir?: string, mount?: boolean): DrawWith | undefined => (drawOn ? { root: opts.root, dir, mount } : undefined);
  const evalTargets = [...new Set(evals.filter(e => !e.exception).map(e => e.target))].filter(t => !opts.target || t === opts.target);
  if (opts.url) {
    const p = plan(evals.filter(e => !opts.target || e.target === opts.target));
    // An app already running elsewhere: still crawl the routes its source declares, when we know which app it is.
    const t = opts.target ? all.find(x => x.name === opts.target) : undefined;
    const routes = opts.routes ?? opts.config.shots?.routes ?? (t ? ['', ...discoverRoutes(t.dir, t.exclude ?? [])] : ['']);
    sessions.push({ target: opts.target ?? '*', url: opts.url, routes, crawl: !opts.routes, need: p.need, draw: drawFor(t?.dir), reach: reachFor(t, p.need) });
  } else {
    for (const name of evalTargets) {
      const t = all.find(x => x.name === name);
      if (!t) continue;
      if (opts.config.apps?.[name]?.screenshots === false) { result.apps.push({ target: name, skipped: 'screenshots off for this app' }); continue; }
      const p = plan(evals.filter(e => e.target === name));
      if (!p.need.length && !usesFor(name).want.length) { log(`${name}: all ${p.picked.length} examples cached (sources unchanged); not starting the app.`); result.apps.push({ target: name, captured: 0, cached: p.cached }); continue; }
      log(`${name}: ${p.need.length} examples to capture, ${p.cached} cached${usesFor(name).want.length ? `; ${usesFor(name).want.length} of the app's own uses to look for` : ''}.`);
      const configured = opts.routes ?? opts.config.apps?.[name]?.routes;
      const extra = opts.routes ? [] : (opts.config.apps?.[name]?.extraRoutes ?? []);
      const routesFor = () => [...new Set([...extra, ...(configured ?? ['', ...discoverRoutes(t.dir, (t.exclude ?? []))])])];
      // What is live: the deployed site (signed in) or the built folder that ships, instead of a dev server.
      // A live surface is one with somewhere to open (url or dir). An entry with only settings (readPaths,
      // readApi, auth, signIn) adds them to the app dsa starts itself.
      const entry: any = appSurface(opts.config.live, name);
      const surface = entry && (entry.url || entry.dir) ? entry : undefined;
      const extra2 = entry && !surface ? { readApi: entry.readApi, readPaths: entry.readPaths, signIn: entry.signIn, storageState: entry.auth ? path.resolve(opts.root, entry.auth) : undefined } : {};
      if (surface) {
        try {
          const open = await openSurface(surface, opts.root);
          const routes = routesFor();
          log(`  ${open.how} · ${routes.length} route${routes.length === 1 ? '' : 's'} ${configured ? 'from config' : 'found in the source'}`);
          sessions.push({ target: name, url: open.url, routes, first: extra, flows: opts.config.apps?.[name]?.flows as Flow[] | undefined, crawl: true, stop: open.stop, how: open.how, need: p.need, storageState: open.storageState, readApi: open.readApi, readPaths: open.readPaths, signIn: open.signIn, draw: drawFor(t.dir), reach: reachFor(t, p.need), ...reachOwn(name, t.dir) });
          if (open.signIn && !open.storageState) log(`  live.apps["${name}"].signIn needs a saved sign-in: run \`dsa login ${open.url}\` and set live.apps["${name}"].auth.`);
        } catch (e: any) { result.apps.push({ target: name, skipped: e.message.split('\n')[0] }); log(`  ${e.message}`); }
        continue;
      }
      if (t.role === 'child') linkCoreForChild(t.dir, opts.root, opts.config.designSystem.core.packages, log);
      const found = detectApp(t, opts.config);
      if ('reason' in found) { result.apps.push({ target: name, skipped: found.reason }); continue; }
      // Source tags, so each element is matched by the line that made it (apps[name].tag: false leaves them off).
      const ap = tagPlan(found, { root: opts.root, dir: t.dir, off: opts.config.apps?.[name]?.tag === false });
      log(`Starting ${name} (${ap.how}${ap.tag === 'injected' ? ', with source tags added' : ap.tag === 'env' ? ', DSA_TAG=1 set' : ''})…`);
      try {
        const app = await startApp(ap);
        const routes = routesFor();
        log(`  ${app.url} · ${routes.length} route${routes.length === 1 ? '' : 's'} ${configured ? 'from config' : 'found in the source'}${extra.length ? ` (${extra.length} extra, visited first)` : ''}`);
        sessions.push({ target: name, url: app.url, routes, first: extra, flows: opts.config.apps?.[name]?.flows as Flow[] | undefined, crawl: true, stop: app.stop, how: ap.how, need: p.need, draw: drawFor(t.dir, ap.tag === 'injected'), reach: reachFor(t, p.need), ...reachOwn(name, t.dir), ...extra2 });
        if (extra2.readPaths?.length || extra2.readApi) log(`  reads allowed besides its pages: ${[...(extra2.readApi ? ['/api/**'] : []), ...(extra2.readPaths ?? [])].join(', ')}`);
      } catch (e: any) { result.apps.push({ target: name, skipped: e.message.split('\n')[0] }); log(`  ${e.message}`); }
    }
  }

  // Elements this run looked for again. A drawing of one that wasn't drawn again doesn't stand.
  const looked = new Set<string>();
  for (const s of sessions) {
    try {
      const usesPlanned = s.target === '*' ? (opts.target ? usesFor(opts.target) : undefined) : usesFor(s.target);
      if (!s.need.length && !usesPlanned?.want.length) { log('Nothing new to capture.'); continue; }
      log(`${s.target === '*' ? '' : s.target + ': '}${s.need.length} examples to find across ${new Set(s.need.map(e => groupKey(e))).size} groups.`);
      const sh = opts.config.shots ?? {};
      // The evidence ledger: what earlier runs (and a dev server with DSA_LEDGER) saw each element render with.
      const ledgerFile = path.join(dir, 'ledger.json');
      const at0 = { root: opts.root, dir: s.appDir ?? s.draw?.dir };
      const ledgerHash = (f: string) => contentHash(absOfTag(at0, f));
      // Records from `dsa record` (its default file), a configured file, or DSA_LEDGER.
      const lines = (sh as any).ledger ?? process.env.DSA_LEDGER ?? (fs.existsSync(path.join(dir, 'ledger-lines.jsonl')) ? path.join(dir, 'ledger-lines.jsonl') : undefined);
      if (lines) { const n = addToLedger(ledgerFile, readLedgerLines(path.resolve(opts.root, lines)), ledgerHash); if (n) log(`  ledger: ${n} record${n === 1 ? '' : 's'} added from ${lines}`); }
      // The app's own component tests, rendered with tags and the ledger on (testTier.ts): states the crawler can't reach.
      const rt = (sh as any).renderTests as boolean | { maxMinutes?: number; include?: string[] } | undefined ?? (process.env.DSA_RENDER_TESTS === '1' ? true : undefined);
      if (rt && at0.dir) {
        const out = path.join(dir, 'ledger-tests.jsonl');
        const t = await renderTests({ appDir: at0.dir, root: opts.root, dir: at0.dir, out, maxMinutes: typeof rt === 'object' ? rt.maxMinutes : undefined, include: typeof rt === 'object' ? rt.include : undefined, log });
        if (t.records) {
          const n = addToLedger(ledgerFile, readLedgerLines(out), ledgerHash);
          log(`  tests: the app's own tests rendered ${t.records} tagged element${t.records === 1 ? '' : 's'} in ${t.files} file${t.files === 1 ? '' : 's'} (${t.seconds}s${t.tests ? `; test files: ${t.tests}` : ''}${t.why ? `; ${t.why}` : ''}); ${n} new in the ledger`);
        } else log(`  tests: the app's own tests added nothing to the ledger: ${t.why ?? 'no reason given'} (${t.seconds}s)`);
        if (t.browser) log(`  tests: not in a browser: ${t.browser}`);
      }
      const ledger = readLedger(ledgerFile, ledgerHash);
      const r: Awaited<ReturnType<typeof session>> & { signIn?: string; expired?: boolean; broken?: string } = await session(pw, { ledger, uses: usesPlanned?.want, usesHave: usesPlanned?.have, usesOpened: usesPlanned?.opened, usesLabPage: notProduct.page, reach: s.reach, draw: s.draw, url: s.url, routes: s.routes, first: s.first, flows: s.flows, crawl: s.crawl, examples: s.need, dir, storageState: s.storageState, readApi: s.readApi, readPaths: s.readPaths, signIn: s.signIn, maxPages: sh.maxPages ?? 90, pagesSet: sh.maxPages !== undefined, waitMs: sh.waitMs ?? 600, log, reveal: sh.reveal, maxActions: sh.maxActions ?? sh.maxTriggers, maxDepth: sh.maxDepth, maxMinutes: sh.maxMinutes, routeSource: s.routeSource, profiles: s.profiles, appDir: s.appDir, manifest: s.manifest, coverage: (sh as any).coverage });
      const at = new Date().toISOString();
      // Per app: of what wasn't reached live, how much the ledger knows (its element, its component, its file, nothing).
      if (r.ledgerCover) (index.ledgerCoverage ??= {})[s.target] = r.ledgerCover;
      if (r.ledgerGaps) (index.ledgerGaps ??= {})[s.target] = r.ledgerGaps;
      if (r.drawCauses) (index.drawCauses ??= {})[s.target] = r.drawCauses;
      if (Object.keys(r.uses ?? {}).length) { index.uses ??= {}; for (const [k, v] of Object.entries<any>(r.uses)) { index.uses[k] = { ...v, run: index.run!.id, at }; if (index.useMisses) delete index.useMisses[k]; } }
      if (r.usesReport) {
        const u = r.usesReport;
        const app = s.target === '*' ? opts.target : s.target;
        // What this run opened, added to what it was told not to open again. It ages from the first of them.
        if (app) (index.usesOpened ??= {})[app] = { setup: setupOf(app), at: usesPlanned?.opened.length ? index.usesOpened?.[app]?.at ?? at : at, pages: u.opened };
        // What couldn't be found stands until its file or the app's setup changes. A pass cut short proves nothing: looked for again next run, and said so.
        for (const [k, m] of Object.entries(u.missed)) (index.useMisses ??= {})[k] = { ...m, ...(m.why === 'not-seen' && u.cutShort ? { why: 'out-of-time' } : {}), at, setup: s.target === '*' ? '' : setupOf(s.target) };
        const whyN = (w: string) => Object.values(u.missed).filter(m => m.why === w).length;
        // The honest measure: of the looks the cards propose, how many have a photo now, and how many cards that is.
        const asked = Object.entries(usesPlanned?.asks ?? {});
        const hasLook = new Set<string>(Object.entries(usesPlanned?.have.looks ?? {}).filter(([, n]) => n > 0).map(([l]) => l));
        for (const v of Object.values<any>(r.uses ?? {})) if (!v.lab) hasLook.add(v.look);
        const shown = asked.filter(([l]) => hasLook.has(l));
        const round = (rows: [string, number][]) => Math.round(rows.reduce((sum, [, n]) => sum + n, 0));
        if (asked.length) log(`  looks the cards propose: ${shown.length} of ${asked.length} have a photo, for about ${round(shown)} of ${round(asked)} cards`);
        log(`  the app's own uses: ${Object.keys(r.uses ?? {}).length} photographed as examples (${Math.round(u.ms / 1000)}s, ${u.pages} extra page${u.pages === 1 ? '' : 's'}); not photographed: ${whyN('hidden')} hidden, ${whyN('covered')} covered, ${whyN('blank')} blank, ${whyN('repeat')} the same look on a page already photographed, ${u.cutShort ? `${whyN('not-seen')} not reached before the time limit` : `${whyN('not-seen')} on no page opened`}`);
      }
      if (r.ledger?.length) { const n = addToLedger(ledgerFile, r.ledger, ledgerHash); log(`  ledger: ${r.ledger.length} element${r.ledger.length === 1 ? '' : 's'} recorded rendering, ${n} new`); }
      const byId = new Map(s.need.map(e => [e.id, e]));
      if (r.signIn && !Object.keys(r.shots).length) {
        // A sign-in wall isn't "not found": nothing was looked at. Say so, and remember no misses.
        const name = s.target === '*' ? 'name' : s.target;
        if (r.expired) log(`  The saved sign-in expired. Run \`dsa login ${s.url}\` again.`);
        else if (s.signIn) log(`  Every page asked for sign-in, and clicking “${s.signIn.click}” on ${s.signIn.path} didn't sign in. Check live.apps["${name}"].signIn and the saved sign-in (\`dsa login ${s.url}\`).`);
        else log(`  Every page asked for sign-in. Run \`dsa login ${s.url}\` and set live.apps["${name}"].auth to the file it saves. (Pages went to ${r.signIn.replace(/[?#].*$/, '')}. If the app keeps its sign-in in memory and its sign-in page has one button, also set live.apps["${name}"].signIn to { "path": …, "click": … }.)`);
        result.apps.push({ target: s.target, url: s.url, how: s.how, routes: s.routes.length, captured: 0, signIn: r.signIn, ...needs(s.target) });
        continue;
      }
      if (r.broken && !Object.keys(r.shots).length) {
        // An app that didn't render hides every element: they weren't looked for, so none is "not found".
        log(`  The app didn't render: ${r.broken}. Fix the app's install, then run again.`);
        result.apps.push({ target: s.target, url: s.url, how: s.how, routes: s.routes.length, captured: 0, broken: r.broken, ...needs(s.target) });
        continue;
      }
      for (const e of s.need) looked.add(e.id);
      // What changed since the last run, element by element: one fix can move many drawings at once, so a
      // regression shows straight away (drawn from the code then, not now).
      {
        const was = (id: string) => index.shots[id]?.drawn === 'mount' ? 'mount' : index.shots[id] && !index.shots[id].drawn ? 'live' : 'other';
        const now = (id: string) => r.shots[id]?.drawn === 'mount' ? 'mount' : r.shots[id] && !r.shots[id].drawn ? 'live' : 'other';
        const ids = s.need.map(e => e.id).filter(id => index.shots[id] || r.shots[id]);
        const gained = ids.filter(id => now(id) === 'mount' && was(id) === 'other');
        const live = ids.filter(id => now(id) === 'live' && was(id) !== 'live');
        const lost = ids.filter(id => was(id) === 'mount' && now(id) === 'other');
        const lostLive = ids.filter(id => was(id) === 'live' && now(id) !== 'live');
        if (gained.length || live.length || lost.length || lostLive.length) {
          const list = (x: string[]) => x.length ? ` (${x.slice(0, 12).join(', ')}${x.length > 12 ? `, +${x.length - 12}` : ''})` : '';
          log(`  drawings changed since the last run: +${gained.length} now drawn from the app's code${list(gained)}, +${live.length} now found live${list(live)}, −${lost.length} no longer drawn from the code${list(lost)}, −${lostLive.length} no longer found live${list(lostLive)}`);
        } else log('  drawings changed since the last run: none');
        (index.drawChanges ??= {})[s.target] = { gained, live, lost, lostLive };
      }
      // Drawn from the code: kept beside the element's "not found", which still stands.
      for (const [id, v] of Object.entries<any>(r.shots)) { index.shots[id] = { ...v, at, run: index.run!.id, fileHash: hashOf(byId.get(id)!) }; if (!v.drawn) delete misses[id]; }
      // How much of the app carried source tags: matches there are exact, the rest are the crawler's best guess.
      const tagged = r.tagged.of ? Math.round((100 * r.tagged.pages) / r.tagged.of) / 100 : undefined;
      if (tagged !== undefined) log(`  ${s.target === '*' ? 'this app' : s.target}: ${Math.round(tagged * 100)}% of pages tagged${tagged === 0 ? '; add dsaTag to its dev build for exact matches' : tagged < 1 ? ' (exact matches there, a best guess elsewhere)' : ' (every match exact)'}`);
      for (const id of r.missing) misses[id] = { at, fileHash: hashOf(byId.get(id)!), crawler: CRAWLER, steps: stepsKey(byId.get(id)!), setup: setupOf(byId.get(id)!.target), ...(r.why[id] ? { why: r.why[id] } : {}), ...tracedFor(id) };
      // What the scan looked for (each gate's setter and the control found) and what the crawler then tried.
      function tracedFor(id: string) { const t = [...(byId.get(id)!.reach?.looked ?? []), ...(r.tried[id] ?? [])]; return t.length ? { tried: t } : {}; }
      const gated = r.missing.map(id => byId.get(id)!).filter(e => e.reach?.status === 'gated');
      const noSetter = gated.filter(e => (e.reach?.looked ?? []).length && (e.reach!.looked!).every(l => /no control found|no state setter/.test(l))).length;
      const usedNoLuck = gated.filter(e => (r.tried[e.id] ?? []).some(t => /still not shown/.test(t))).length;
      if (gated.length) log(`  ${gated.length} behind a state: ${noSetter} with no control found that sets it, ${usedNoLuck} where a control was used but it stayed hidden (each miss lists what was tried)`);
      // How each element looked for was reached, and why the rest weren't, by reason.
      const vals = Object.values<any>(r.shots);
      const reasons: Record<string, number> = {};
      for (const id of r.missing) if (r.why[id]) reasons[r.why[id]!] = (reasons[r.why[id]!] ?? 0) + 1;
      const reach = { live: vals.filter(v => !v.drawn).length, mounted: vals.filter(v => v.drawn === 'mount').length, markup: vals.filter(v => v.drawn === 'markup').length, unreachable: 0, why: reasons };
      reach.unreachable = r.missing.length - reach.mounted - reach.markup;
      log(`  ${s.target === '*' ? 'this app' : s.target}: ${reach.live} reached live, ${reach.mounted} drawn from the app's code, ${reach.markup} markup only, ${reach.unreachable} not shown at all; why the ${r.missing.length} not reached live weren't${Object.keys(reasons).length ? ':' : ''}`);
      for (const [w, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) log(`    ${n} · ${w}`);
      // Each one not reached live, on its own line: why, its conditions (and the component each is in), the routes that render it.
      if (r.missing.length) log(`  not reached live, one by one:`);
      for (const id of r.missing) {
        const e = byId.get(id);
        if (!e) continue;
        const gates = (e.reach?.gates ?? []).map((g: any) => `${g.component ? g.component + ': ' : ''}${g.negated ? 'not ' : ''}“${String(g.test).slice(0, 60)}”`).join(', ');
        const rs = s.reach?.byId[id];
        const on = r.fileOn?.[id];
        log(`    ${id} (${e.file}:${e.line}) · ${r.why[id] ?? (r.shots[id]?.drawn ? `drawn (${r.shots[id].drawn})` : 'no reason recorded')}${gates ? ` · when ${gates}` : ''}${on === undefined ? '' : on ? ` · its file showed on ${on}` : ' · its file showed on no page visited'} · ${rs === undefined ? 'routes unknown' : rs.length ? `routes ${rs.slice(0, 4).join(', ')}${rs.length > 4 ? ` +${rs.length - 4}` : ''}` : 'no route renders its file'}`);
      }
      index.missing.push(...r.missing);
      index.pages.push(...r.pages);
      result.apps.push({ target: s.target, url: s.url, how: s.how, routes: s.routes.length, captured: Object.values<any>(r.shots).filter(v => !v.drawn).length, ...(r.drawn ? { drawn: r.drawn } : {}), reach, ...(tagged !== undefined ? { tagged } : {}), ...needs(s.target) });
    } finally { s.stop?.(); }
  }
  // Report "not found" for every cached miss too, so the review can say why there's no picture.
  for (const [id, m] of Object.entries<any>(misses)) if (!index.missing.includes(id) && evals.some(e => e.id === id && freshMiss(m, e))) index.missing.push(id);
  // What the last run counted and this run didn't retake still stands, photo or drawing: nothing about it has changed.
  for (const e of evals) {
    const s = index.shots[e.id];
    if (s && s.run !== index.run.id && counted(s) && fresh(s, e) && s.file && fs.existsSync(path.join(dir, s.file)) && !(s.drawn && looked.has(e.id))) s.confirmed = index.run.id;
  }
  index.takenAt = new Date().toISOString();
  fs.writeFileSync(idxFile, JSON.stringify(index, null, 2));
  result.captured = result.apps.reduce((a, x) => a + (x.captured ?? 0), 0);
  result.missing = index.missing.length;
  result.pages = index.pages.length;
  return result;
}

/** How to sign in an app that keeps its tokens in memory (live.apps[name].signIn). */
type SignIn = { path: string; click: string; idp?: string | undefined };

/**
 * A saved sign-in from \`dsa login\`: Playwright's storage state, and the app's session storage beside it
 * (Playwright keeps none). Read here so nothing in it is ever logged.
 */
export function readAuth(file: string): { state: { cookies: any[]; origins: any[] }; sessionStorage: Record<string, Record<string, string>> } | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { state: { cookies: j.cookies ?? [], origins: j.origins ?? [] }, sessionStorage: j.sessionStorage ?? {} };
  } catch { return null; }
}

/**
 * Runs in each page before its scripts: the app's saved session storage, on its own origin, where not
 * already set. Source text (bundler helpers don't exist in the page); the data goes in as a JSON literal.
 */
const RESTORE_SESSION = `(d) => { if (location.origin !== d.origin) return; for (const [k, v] of Object.entries(d.items)) if (sessionStorage.getItem(k) == null) sessionStorage.setItem(k, v); }`;

/** One interaction the explorer can take: click, hover, or right-click a control on the page. */
interface Act { n: number; key: string; kind: 'click' | 'hover' | 'context' | 'choose'; label: string; why: string; prio: number; /** The source line that made it (its source tag), when tagged. */ src?: string; /** For choose: the option to pick in a select. */ value?: string }

/**
 * How to draw what can't be photographed (drawn.ts): the scan root (to read each element's source), its
 * app's folder, and whether the app runs on dsa's own Vite runner (which serves /@dsa/mount).
 */
/** shots/index.json's `run`: this run's id, the source it photographed (commit, or "worktree" when changed), and when. */
export interface RunStamp { id: string; ref: string; at: string }

/**
 * The scan root's commit, "worktree" when a tracked file's content differs from it, "" outside git. Read
 * only: `git status` and `git diff` rewrite the index of a checkout dsa may only read, so this uses the
 * plumbing `diff-index` (which never writes) and checks each file it names by content hash, since a file
 * only touched (a new mtime) is listed too.
 */
export function sourceRef(root: string): string {
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  let head: string;
  try { head = git(['rev-parse', 'HEAD']); } catch { return ''; }
  try {
    const top = git(['rev-parse', '--show-toplevel']);
    const named = git(['diff-index', '--name-only', 'HEAD', '--']).split('\n').filter(Boolean);
    if (named.length > 50) return 'worktree';
    for (const f of named) {
      let now = '';
      try { now = git(['hash-object', '--', path.join(top, f)]); } catch { return 'worktree'; }
      let then = '';
      try { then = git(['rev-parse', `HEAD:${f}`]); } catch { return 'worktree'; }
      if (now !== then) return 'worktree';
    }
    return head;
  } catch { return 'worktree'; }
}

interface DrawWith { root: string; dir?: string | undefined; mount?: boolean | undefined; max?: number | undefined; maxMinutes?: number | undefined }

/**
 * A file as source tags name it (tagPath): under the scan root, else "<app folder>/<path>" for an app outside
 * it, as the scanner shows them. Null outside both. Every path compared with a tag goes through this.
 */
function tagOfFile(d: { root: string; dir?: string | undefined }, f: string): string | null { return tagPath(path.resolve(d.root, f), d.root, d.dir); }
/** The file a tag path names (fileOfTag), else the path under the root. */
function absOfTag(d: { root: string; dir?: string | undefined }, rel: string): string { return (path.isAbsolute(rel) ? rel : fileOfTag(rel, d.root, d.dir)) ?? path.resolve(d.root, rel); }

/** Where each provider and hook is declared (`XProvider`, `useX`), read once per app: the first file for each name. */
const declIndex = new WeakMap<DrawWith, Map<string, string>>();
function declaredIn(d: DrawWith, name: string): string | undefined {
  let idx = declIndex.get(d);
  if (!idx) {
    idx = new Map();
    // Every file, not a first few thousand: a large app's provider can sit anywhere. Tests and stories last,
    // so a mock of a provider never stands in for the real one.
    const files = walk(d.dir ?? d.root, new Set(['.tsx', '.jsx', '.ts', '.js']), [], true);
    const mock = (f: string) => /\.(test|spec|stories)\.|__(tests|mocks)__/.test(f);
    declCount.set(d, files.length);
    for (const f of [...files.filter(f => !mock(f)), ...files.filter(mock)]) {
      let src = '';
      try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const m of src.matchAll(/\b(?:function|const|let|class)\s+([A-Z][\w$]*Provider|use[A-Z][\w$]*)\b/g)) if (!idx.has(m[1]!)) idx.set(m[1]!, f);
    }
    declIndex.set(d, idx);
  }
  return idx.get(name);
}

/**
 * The provider a component that threw needs and the page doesn't have: the one its error names ("must be
 * used inside CanvasChromeProvider"), else the one declared beside the hook it needed (useCanvasChrome's
 * file declares CanvasChromeProvider). Only inside the scan root.
 */
export function providerFor(d: DrawWith, message: string, need: string, from: string, why: string[] = []): { name: string; file: string; context?: boolean } | null {
  const declares = (src: string, n: string) => new RegExp(`\\b(?:function|const|let|class)\\s+${n.replace(/\$/g, '\\$')}\\b`).test(src);
  const read = (f?: string) => { try { return f ? fs.readFileSync(f, 'utf8') : ''; } catch { return ''; } };
  // The component's own imports first (two levels): the hook and its provider usually sit in a file beside it.
  const near = importsNear(d, from, 2);
  const find = (n: string) => near.find(f => declares(read(f), n)) ?? declaredIn(d, n);
  const inRoot = (f: string) => tagOfFile(d, f) !== null;
  const short = (f?: string) => f ? tagOfFile(d, f) ?? path.relative(d.root, f).split(path.sep).join('/') : '';
  // What it looked at, for the log when nothing is found: the imports followed, and where each name was.
  why.push(`followed ${near.length} import${near.length === 1 ? '' : 's'} from ${short(from)}${near.length ? ` (${near.slice(0, 3).map(short).join(', ')}${near.length > 3 ? ', …' : ''})` : ''}`);
  let name = message.match(/\b([A-Z][\w$]*Provider)\b/)?.[1];
  let file = name ? find(name) : undefined;
  if (name) why.push(file ? `${name} in ${short(file)}` : `no declaration of ${name} in the app's ${declaredCount(d)} files`);
  const hook = need.match(/what (use[A-Z][\w$]*) reads/)?.[1] ?? message.match(/\b(use[A-Z][\w$]*)\b/)?.[1];
  if (!file && hook) {
    const hf = find(hook);
    why.push(hf ? `${hook} in ${short(hf)}` : `no declaration of ${hook}`);
    const src = read(hf);
    const pn = src.match(/\b(?:function|const|class)\s+([A-Z][\w$]*Provider)\b/)?.[1];
    if (pn) { name = pn; file = declares(src, pn) ? hf : find(pn); }
    // No provider component: the context the hook reads, given a value (the mount reaches it even unexported).
    else {
      const ctx = src.match(/\b(?:const|let)\s+([A-Z][\w$]*)\s*(?::[^=]+)?=\s*(?:React\.)?createContext\b/)?.[1];
      if (ctx && hf && inRoot(hf)) return { name: ctx, file: hf, context: true };
      if (hf) why.push(`no provider or createContext in ${short(hf)}`);
    }
  }
  // Read straight off a context (`useContext(StoreCtx)`): that context, given a value.
  const direct = need.match(/a provider for ([A-Z][\w$]*)/)?.[1];
  if (!file && !hook && direct) {
    const cf = find(direct);
    if (cf && inRoot(cf) && new RegExp(`\\b${direct.replace(/\$/g, '\\$')}\\s*(?::[^=]+)?=\\s*(?:React\\.)?createContext\\b`).test(read(cf))) return { name: direct, file: cf, context: true };
    why.push(cf ? `${direct} in ${short(cf)} isn't made by createContext there` : `no declaration of ${direct}`);
  }
  if (!name || !file) return null;
  if (!inRoot(file)) { why.push(`${short(file)} is outside the scan root`); return null; }
  return { name, file };
}

/** How many files the provider index read (for the log). */
function declaredCount(d: DrawWith): number { declaredIn(d, ''); return declCount.get(d) ?? 0; }
const declCount = new WeakMap<DrawWith, number>();

/** Files a file imports, followed this many levels: relative paths and the "@/" or "~/" shortcut for src. */
function importsNear(d: DrawWith, from: string, levels: number): string[] {
  const exts = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];
  const base = d.dir ?? d.root;
  const resolve = (dir: string, spec: string): string | null => {
    const roots = spec.startsWith('.') ? [path.resolve(dir, spec)] : /^[@~]\//.test(spec) ? [path.join(base, 'src', spec.slice(2)), path.join(base, spec.slice(2))] : [];
    for (const r of roots) for (const e of exts) { const f = r + e; try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ } }
    return null;
  };
  const seen = new Set<string>([from]);
  let wave = [from];
  for (let l = 0; l < levels && seen.size < 80; l++) {
    const next: string[] = [];
    for (const f of wave) {
      let src = '';
      try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
        const r = resolve(path.dirname(f), (m[1] ?? m[2])!);
        if (r && !seen.has(r)) { seen.add(r); next.push(r); }
      }
    }
    wave = next;
  }
  seen.delete(from);
  return [...seen];
}

/** A value at a path inside props, making the objects on the way. */
function setPath(o: Record<string, unknown>, at: string[], v: unknown) {
  let cur: any = o;
  for (const k of at.slice(0, -1)) { if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k]; }
  const last = at[at.length - 1]!;
  if (cur[last] == null || (Array.isArray(cur[last]) && !cur[last].length)) cur[last] = v;
  else if (v && typeof v === 'object' && !Array.isArray(v) && typeof cur[last] === 'object') Object.assign(cur[last], v);
}

/** The app's source files with their text, read once: where a hook or function's callers are looked for. */
const textIndex = new WeakMap<DrawWith, [string, string][]>();
/**
 * Components in the app that call `name(` (a hook, or a function that returns JSX), outside its own file, six
 * at most: by its name, or by the name a file imports it under (`import { useX as useY }`). A barrel or a
 * re-export keeps the name, so callers through one are found the same way. With how many files were read.
 */
function callersOfFn(d: DrawWith, name: string, own: string): { found: { abs: string; name: string; code: string }[]; read: number } {
  let idx = textIndex.get(d);
  if (!idx) {
    idx = [];
    for (const f of walk(d.dir ?? d.root, new Set(['.tsx', '.jsx']), [], true).slice(0, 6000)) {
      if (/\.(test|spec|stories)\./.test(f)) continue;
      try { idx.push([f, fs.readFileSync(f, 'utf8')]); } catch { /* moved */ }
    }
    textIndex.set(d, idx);
  }
  const esc = name.replace(/[$]/g, '\\$');
  const found: { abs: string; name: string; code: string }[] = [];
  for (const [f, code] of idx) {
    if (f === own || !code.includes(name)) continue;
    const local = code.match(new RegExp(`\\b${esc}\\s+as\\s+([\\w$]+)`))?.[1] ?? name;
    if (!new RegExp(`\\b${local.replace(/[$]/g, '\\$')}\\s*\\(`).test(code)) continue;
    const c = parentComponent(code, local, 0);
    if (c && !found.some(x => x.name === c && x.abs === f)) found.push({ abs: f, name: c, code });
    if (found.length >= 6) break;
  }
  return { found, read: idx.length };
}

/** An app's tests and stories, read once: each file's path and what it imports, by name without its extension. */
const checkIndex = new WeakMap<DrawWith, { file: string; story: boolean; imports: string[] }[]>();
/**
 * The test and the story nearest a file: one beside it with its name (Panel.test.tsx), else one that imports it
 * (by its path, or by its name through an alias). Null when there's none.
 */
function nearestChecks(d: DrawWith, abs: string): { test: string | null; story: string | null } {
  let idx = checkIndex.get(d);
  if (!idx) {
    idx = [];
    for (const f of walk(d.dir ?? d.root, new Set(['.tsx', '.jsx', '.ts', '.js', '.mjs']), [], true)) {
      if (!/\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(f)) continue;
      let src = '';
      try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
      idx.push({ file: f, story: /\.stories\./.test(f), imports: [...src.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map(m => m[1]!.startsWith('.') ? path.resolve(path.dirname(f), m[1]!) : m[1]!) });
      if (idx.length > 3000) break;
    }
    checkIndex.set(d, idx);
  }
  const bare = abs.replace(/\.[cm]?[jt]sx?$/, '');
  const base = path.basename(bare);
  const rel = (f: string) => path.relative(d.dir ?? d.root, f).split(path.sep).join('/');
  const pick = (story: boolean) => {
    const mine = idx!.filter(x => x.story === story);
    const beside = mine.find(x => x.file.replace(/\.(test|spec|stories)\.[cm]?[jt]sx?$/, '') === bare);
    if (beside) return rel(beside.file);
    const imp = mine.filter(x => x.imports.some(i => i === bare || i === `${bare}/index` || (!path.isAbsolute(i) && (i.endsWith(`/${base}`) || i === base))));
    imp.sort((a, b) => path.relative(path.dirname(abs), a.file).length - path.relative(path.dirname(abs), b.file).length);
    return imp[0] ? rel(imp[0].file) : null;
  };
  return { test: pick(false), story: pick(true) };
}

/** The files that render `<Name …>`, its own first, read once per app: where a component's literal props come from. */
const callerIndex = new WeakMap<DrawWith, Map<string, string[]>>();
function callersOf(d: DrawWith, name: string, own: string): string[] {
  let idx = callerIndex.get(d);
  if (!idx) {
    idx = new Map();
    for (const f of walk(d.dir ?? d.root, new Set(['.tsx', '.jsx', '.ts', '.js']), [], true).slice(0, 6000)) {
      let src = '';
      try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const m of new Set([...src.matchAll(/<([A-Z][\w$]*)[\s/>]/g)].map(x => x[1]!))) { const l = idx.get(m) ?? []; if (l.length < 4) idx.set(m, [...l, f]); }
    }
    callerIndex.set(d, idx);
  }
  return (idx.get(name) ?? []).filter(f => f !== own).map(f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } });
}

/** What the scan knows about reaching each element (routes.ts): the routes that render its file, and the patterns that need a value. */
interface ReachPlan { byId: Record<string, string[]>; patterns: string[]; /** Per element: its file and its importers three steps up, as tag paths. */ near?: Record<string, string[]> }

/**
 * How many photos of how the app uses a component. A look a card proposes: this many, each from another page.
 * Any other look is only ever a nearest match, so one of each, and a limit per component and per app; those
 * limits can't crowd out a look a card asks for.
 */
const USES_PER_LOOK = 3, USES_PER_OTHER_LOOK = 1, USES_PER_COMPONENT = 15, USES_TOTAL = 300;
/** At most this long on looking for the app's own uses once the crawl is done. */
const USES_MINUTES = 5;
/** Of that, how much may go on opening pages nothing says hold a look the cards ask for, before the other looks get their turn. */
const USES_UNSEEN_SHARE = 0.7;
interface UsesCount { looks: Record<string, number>; components: Record<string, number>; total: number; /** The pages each look has a photo from. */ pages: Record<string, string[]>; /** Photos from pages that aren't the product. They use up no room a product photo could have. */ labLooks?: Record<string, number> }
interface UsesWant { key: string; component: string; look: string; file: string; fileHash: string; /** How many cards ask for this look; 0 when none does. */ need: number; /** In a lab, specimen or demo file, not the product. */ lab?: boolean }
interface UsesPlan { want: UsesWant[]; have: UsesCount; keys: string[]; asks: Record<string, number>; /** Pages an earlier run already looked at, still good to skip. */ opened: string[] }
const usesUnderCap = (c: UsesCount, x: { look: string; component: string; need: number; lab?: boolean | undefined }) => x.lab ? !c.looks[x.look] && !c.labLooks?.[x.look] : (x.need > 0 ? (c.looks[x.look] ?? 0) < USES_PER_LOOK : (c.looks[x.look] ?? 0) < USES_PER_OTHER_LOOK && (c.components[x.component] ?? 0) < USES_PER_COMPONENT && c.total < USES_TOTAL);
const countUse = (c: UsesCount, x: { look: string; component: string; need: number; lab?: boolean | undefined }, page: string | undefined) => {
  if (x.lab) { (c.labLooks ??= {})[x.look] = (c.labLooks[x.look] ?? 0) + 1; return; }
  c.looks[x.look] = (c.looks[x.look] ?? 0) + 1;
  if (page) (c.pages[x.look] ??= []).push(page);
  if (x.need > 0) return;
  c.components[x.component] = (c.components[x.component] ?? 0) + 1;
  c.total++;
};
/**
 * How much a page is worth opening for, from the uses left in the files it renders: each look once. A look with
 * no photo counts for the cards asking for it, one with a photo from another page for a fifth of that, a look no
 * card asks for barely at all. A look already looked for and not found counts for less each time, since rendering
 * its file doesn't mean rendering that line.
 */
export function usesPlaceWorth(place: { u: string; files: ReadonlySet<string>; lab?: boolean }, left: readonly UsesWant[], have: UsesCount, tried: ReadonlyMap<string, number>): number {
  const looks = new Map<string, number>();
  for (const w of left) {
    if (!place.files.has(w.file) || have.pages[w.look]?.includes(place.u) || (place.lab && !w.lab)) continue;
    const v = w.lab ? USES_LAB_WORTH : w.need > 0 ? ((have.looks[w.look] ?? 0) ? w.need * 0.2 : w.need) : USES_OTHER_WORTH;
    if (v > (looks.get(w.look) ?? 0)) looks.set(w.look, v);
  }
  let sum = 0;
  for (const [look, v] of looks) sum += v / (1 + (tried.get(look) ?? 0));
  return sum;
}
const USES_OTHER_WORTH = 0.0001;
/** Below the bar for a first visit: a lab page waits until every product page has had its turn. */
const USES_LAB_WORTH = 0.001;

async function session(pw: any, o: { uses?: UsesWant[] | undefined; usesHave?: UsesCount | undefined; usesOpened?: string[] | undefined; usesLabPage?: ((u: string) => boolean) | undefined; reach?: ReachPlan | undefined; draw?: DrawWith | undefined; url: string; routes: string[]; first?: string[]; flows?: Flow[]; crawl: boolean; examples: ElementEval[]; dir: string; storageState?: string | undefined; readApi?: boolean | undefined; readPaths?: string[] | undefined; signIn?: SignIn | undefined; maxPages: number; waitMs: number; log: (m: string) => void; reveal?: boolean; maxActions?: number; maxDepth?: number; maxMinutes?: number; maxReplays?: number; routeSource?: RouteSource | undefined; appDir?: string | undefined; profiles?: Profile[] | undefined; pagesSet?: boolean | undefined; ledger?: Record<string, LedgerRec[]> | undefined; manifest?: ReachFile | undefined; coverage?: boolean | undefined }) {
  const shots: Record<string, any> = {};
  const pages: string[] = [];
  let taggedPages = 0;
  const drawnIds: string[] = [];
  // What was tried for each element, in plain words, kept with its miss (no duplicates, capped).
  const note = (r: Target, t: string) => { r.tried ??= []; if (!r.tried.includes(t) && r.tried.length < 12) r.tried.push(t); };
  const stepName = (x: { label: string; event: string; value?: string | undefined }) => (x.event === 'choose' && x.value ? `“${x.value}” in ${x.label ? `“${x.label}”` : 'a list'}` : x.label ? `“${x.label}”` : 'an unlabelled control');
  const why: Record<string, string> = {};
  const tiny = new Map<string, number>();
  const setAside: string[] = [];
  const gateCode = new Map<string, string>();
  const readGateFile = (f: string) => { if (!gateCode.has(f)) gateCode.set(f, (o.draw ? readSource(o.draw.root, f, o.draw.dir) : (() => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } })()) ?? ''); return gateCode.get(f)!; };
  const fileOn: Record<string, string> = {};
  const reasonOf = (r: Target): string => {
    const rs = r.routes;
    if (rs && !rs.length) return 'no route reaches its file';
    if (rs?.length && rs.every(needsValue) && !rs.some(p => filled.get(p)?.size)) return `its page needs a value (${rs[0]}) and no page visited linked to one`;
    if (rs?.length && !rs.some(p => needsValue(p) ? filled.get(p)?.size : seen.has(routeUrl(p, base)) || seen.has(routeUrl('#' + p, base)))) return 'its route was not visited in the time budget';
    // The first condition that doesn't already hold with its state's initial values: blaming one that
    // holds by default ("not setupTakeover" when it starts false) points at the wrong step.
    const gs = r.e.reach?.status === 'gated' ? r.e.reach.gates : [];
    const g = gs.find((x: any) => x.overlay || !x.file || !holdsInitially(x, readGateFile(x.file))) ?? gs[0];
    if (g) return `it shows only after a step the crawler couldn't take (${g.overlay ? `opening ${g.overlay}` : `when ${g.negated ? 'not ' : ''}“${g.test.slice(0, 40)}”`})`;
    if (Date.now() >= deadline) return 'not reached in the time budget';
    return 'not on the pages that render it';
  };
  let browser: any, page: any;
  const base = new URL(o.url);
  // A traced control's own line, as its source tag reads ("apps/ledger/src/Bar.tsx:12:"), when it's inside the scan root.
  const stepSrc = (file: string, line: number, col?: number) => { if (!o.draw?.root || !file) return undefined; const rel = tagOfFile(o.draw, file); return rel ? `${rel}:${line}:${col ?? ''}` : undefined; };
  let net: GuardStats = { blocked: 0, last: [], allowed: {}, denied: {}, idp: new Set() };
  // The saved sign-in: cookies and local storage for Playwright, and the app's session storage, which
  // Playwright doesn't keep (dsa login saves it; it's put back before the app's own scripts run).
  const saved = o.storageState ? readAuth(o.storageState) : null;
  // Signing in an app that keeps its tokens in memory (live.apps[name].signIn): once per browser.
  const auth = { done: false, signing: false, attempts: 0, expired: false };
  const launch = async () => {
    browser = await pw.chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...(saved ? { storageState: saved.state } : {}) });
    const items = saved?.sessionStorage?.[base.origin];
    if (items && Object.keys(items).length) await page.addInitScript({ content: `(${RESTORE_SESSION})(${JSON.stringify({ origin: base.origin, items })});` });
    // alert/confirm/prompt: dismiss, so nothing the explorer opens can confirm an action.
    page.on('dialog', (d: any) => d.dismiss().catch(() => {}));
    // URLs the app writes itself (pushState, replaceState, a new hash): real routes, kept for the queue.
    await page.addInitScript({ content: WRITTEN_URLS });
    // The ledger runtime: every tagged element the app renders, with its URL, its owner's props and the state
    // above it, handed here as it commits (kept across page loads, unlike anything in the page).
    await page.exposeBinding('__dsaLedgerPut', (_: unknown, batch: LedgerRec[]) => { if (Array.isArray(batch) && recorded.length < 50_000) recorded.push(...batch); }).catch(() => {});
    await page.addInitScript({ content: LEDGER_RUNTIME });
    // Reads only: no writes, nothing under /api/ (or readPaths), nothing to another host but images, fonts,
    // and styles, and the identity provider while signing in (flows.ts).
    net = await guardNetwork(page, base.origin, { readApi: Boolean(o.readApi), readPaths: o.readPaths, idp: o.signIn?.idp, signingIn: () => auth.signing });
    auth.done = false;
    watchPage?.(page);
  };
  let watchPage: ((pg: any) => void) | null = null;
  const recorded: LedgerRec[] = [];
  let ledgerCover: { own: number; component: number; file: number; none: number; tests: number } | null = null;
  let ledgerGaps: { file: string; elements: number; test: string | null; story: string | null; when?: string; unused?: boolean }[] | null = null;
  let drawCauses: { threw: [string, number, string[]][]; unmet: [string, number][] } | null = null;
  // Photos of the app's own uses of system components (shots/index.json "uses"), a few of each look.
  const usesShot: Record<string, any> = {};
  const usesCount: UsesCount = { looks: { ...(o.usesHave?.looks ?? {}) }, components: { ...(o.usesHave?.components ?? {}) }, total: o.usesHave?.total ?? 0, pages: Object.fromEntries(Object.entries(o.usesHave?.pages ?? {}).map(([k, v]) => [k, [...v]])), labLooks: { ...(o.usesHave?.labLooks ?? {}) } };
  const usesUnder = (x: UsesWant) => usesUnderCap(usesCount, x);
  const useWhy = new Map<string, 'hidden' | 'covered' | 'blank' | 'repeat'>();
  const useFails = new Map<string, number>();
  const usesTime = { ms: 0, pages: 0, cutShort: false };
  // Without the port: an app started again gets another one.
  const pageKey = (u: string) => u.startsWith(base.origin) ? u.slice(base.origin.length) : u;
  const placeKey = (u: string, sets: unknown[]) => `${pageKey(u)} ${JSON.stringify(sets)}`;
  const usesOpened = new Set(o.usesOpened ?? []);
  const usesLeft = () => (o.uses ?? []).filter(x => !usesShot[x.key] && (useFails.get(x.key) ?? 0) < 2 && usesUnder(x));
  const photographUses = async (u: string) => {
    const want = usesLeft();
    if (!want.length) return;
    const t0 = Date.now();
    const seen = await inPage<{ marked: { key: string; id: string }[]; hidden: string[] }>(page, MARK_USES, want.map(x => x.key)).catch(() => ({ marked: [], hidden: [] }));
    for (const k of seen.hidden) if (!useWhy.has(k)) useWhy.set(k, 'hidden');
    const wanted = new Map(want.map(x => [x.key, x]));
    const labPage = Boolean(o.usesLabPage?.(u));
    for (const m of seen.marked.sort((a, b) => wanted.get(b.key)!.need - wanted.get(a.key)!.need)) {
      const w = wanted.get(m.key)!;
      if (!usesUnder(w)) continue;
      // A product file shown on a lab page says nothing about the product: left for a product page.
      if (labPage && !w.lab) continue;
      // The same look on the same page says nothing new: another page's might.
      if (usesCount.pages[w.look]?.includes(u)) { useWhy.set(m.key, 'repeat'); continue; }
      const file = `${m.id}.png`;
      const cap = await capture(page, m.id, path.join(o.dir, file)).catch(() => null);
      if (!cap || cap.blank || cap.covered) {
        useFails.set(m.key, (useFails.get(m.key) ?? 0) + 1);
        useWhy.set(m.key, cap?.covered ? 'covered' : 'blank');
        continue;
      }
      usesShot[m.key] = { file, page: u, box: cap.box, ...(cap.context ? { context: cap.context } : {}), matchScore: 1, tagged: true, component: w.component, look: w.look, fileHash: w.fileHash, ...(w.lab ? { lab: true } : {}) };
      useWhy.delete(m.key);
      countUse(usesCount, w, u);
    }
    usesTime.ms += Date.now() - t0;
  };
  // Code run while exploring, in missing elements' files (covGain): kept across pages, so only new code counts.
  const cov = { on: false, seen: new Set<string>(), page: 0, best: '', bestN: 0 };
  await launch();
  // A page can crash or close under the crawler (a heavy view, a control that closes the window):
  // start a fresh browser and carry on with the next page instead of losing the whole pass.
  const relaunch = async () => {
    try { await browser.close(); } catch { /* already gone */ }
    await launch();
  };
  const queue: string[] = o.routes.map(r => routeUrl(r, base));
  // Every route the scan says renders a missing element, even one the source scan of paths missed.
  const hashed = o.routes.some(r => r.startsWith('#'));
  for (const p of new Set(Object.values(o.reach?.byId ?? {}).flat())) if (!needsValue(p)) { const u = routeUrl(hashed ? '#' + p : p, base); if (!queue.includes(u)) queue.push(u); }
  // Values for routes like /orders/:id, from links on the pages visited (up to 3 per pattern).
  const harvest = (urls: string[]) => {
    const want = wantRoute();
    for (const pat of o.reach?.patterns ?? []) {
      if (!want.get(pat)) continue;
      const got = filled.get(pat) ?? new Set<string>();
      const t = patternTest(pat);
      for (const l of urls) {
        if (got.size >= 3) break;
        try { const lu = new URL(l); if (lu.origin !== base.origin) continue; const at = routeOf(lu.toString()); if (t.test(at) && !got.has(at)) { got.add(at); const s = lu.toString(); if (!seen.has(s) && !queue.includes(s)) queue.unshift(s); } } catch { /* ignore */ }
      }
      filled.set(pat, got);
    }
  };
  const unfilled = () => (o.reach?.patterns ?? []).some(p => wantRoute().get(p) && (filled.get(p)?.size ?? 0) < 3);
  // The URLs the app wrote since the last look, into the queue: same origin, not seen, each once.
  const written = async () => {
    const urls: string[] = await page.evaluate(`(window.__dsaUrls || []).splice(0)`).catch(() => []);
    let n = 0;
    for (const l of urls) { try { const lu = new URL(l); if (lu.origin === base.origin && !seen.has(lu.toString()) && !queue.includes(lu.toString())) { queue.push(lu.toString()); n++; } } catch { /* ignore */ } }
    if (urls.length) harvest(urls);
    return n;
  };
  /** The app's route list from its own module, or why not. */
  const routesFromApp = async (rs: RouteSource): Promise<string[] | string> => {
    const abs = path.resolve(o.appDir ?? o.draw?.root ?? '.', rs.module);
    const rel = o.appDir ? path.relative(o.appDir, abs).split(path.sep).join('/') : rs.module.replace(/^\.?\//, '');
    const files = [...(rel.startsWith('..') ? [] : [new URL('/' + rel, base).toString()]), new URL('/@fs' + abs.split(path.sep).join('/'), base).toString()];
    try { await page.goto(base.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch { /* the import may still work */ }
    const r = await inPage<string[] | { error: string }>(page, ROUTES_FROM_MODULE, { files, name: rs.export }).catch((e: any) => ({ error: String(e?.message ?? e).split('\n')[0]! }));
    return Array.isArray(r) ? r : `couldn't list routes from ${rs.module} (${rs.export}): ${r.error}`;
  };
  const firstUrls = new Set((o.first ?? []).map(r => routeUrl(r, base)));
  const seen = new Set<string>();
  // Pages that asked for sign-in instead of showing the app, out of the pages tried.
  const wall = { tried: 0, walled: 0, at: '' };
  const signedOut = () => wall.tried >= 1 && wall.walled === wall.tried;
  // Pages where the app itself didn't render, out of the pages tried, and why: its errors and its own module requests.
  const broken = { pages: 0, first: '' };
  const pageErrors: string[] = [];
  const modules = { total: 0, failed: 0, first: '' };
  const isBroken = () => wall.tried >= 1 && broken.pages === wall.tried;
  // The app's own data requests still on their way (fetch, XHR): a page isn't looked at until they're back.
  const inflight = new Set<any>();
  const asked = new Map<string, number>();
  const watch = (pg: any) => {
    const data = (q: any) => { try { return new URL(q.url()).origin === base.origin && /^(fetch|xhr)$/.test(q.resourceType()); } catch { return false; } };
    // A request seen three times is a poll: it's always somewhere in flight, so it's not waited for.
    pg.on('request', (q: any) => { if (!data(q)) return; const k = new URL(q.url()).pathname; const n = (asked.get(k) ?? 0) + 1; asked.set(k, n); if (n < 3) inflight.add(q); });
    pg.on('requestfinished', (q: any) => inflight.delete(q));
    pg.on('requestfailed', (q: any) => inflight.delete(q));
    pg.on('pageerror', (e: any) => { pageErrors.push(String(e?.message ?? e).split('\n')[0]!); });
    const own = (r: any) => { try { return new URL(r.url()).origin === base.origin && r.resourceType() === 'script'; } catch { return false; } };
    pg.on('response', (r: any) => { if (!own(r.request())) return; modules.total++; if (r.status() >= 400) { modules.failed++; modules.first ||= `${new URL(r.url()).pathname} answered ${r.status()}`; } });
    // A request the browser dropped because the page moved on (ERR_ABORTED) is not a failed module.
    pg.on('requestfailed', (q: any) => { if (!own(q) || /ABORTED|cancel/i.test(q.failure()?.errorText ?? '')) return; modules.total++; modules.failed++; modules.first ||= `${new URL(q.url()).pathname} failed (${q.failure()?.errorText ?? 'no answer'})`; });
  };
  watchPage = watch;
  watch(page);
  /** After a page loads: did the app render? Nothing to use on it, and its own modules mostly failed or it showed no text. */
  const didntRender = async (errorsBefore: number, mods: { total: number; failed: number }) => {
    const seen = await inPage<{ text: number; controls: number }>(page, RENDERED).catch(() => ({ text: 1, controls: 1 }));
    const total = modules.total - mods.total, failed = modules.failed - mods.failed;
    const threw = pageErrors.length > errorsBefore;
    // A page with something to use or read rendered, whatever else failed or threw: it's swept like any other.
    const bad = seen.controls === 0 && ((total > 0 && failed * 2 > total) || seen.text === 0);
    if (bad && !broken.first) broken.first = (threw ? pageErrors[errorsBefore] : '') || modules.first || 'the page stayed blank';
    return bad;
  };
  // Wait until the page stops changing (no DOM change for 250 ms), up to `max`: a slow page and a fast
  // one are looked at in the same state, so the same run reaches the same elements.
  // Its own data requests too: a spinner waiting on a fetch changes nothing in the DOM until the answer comes.
  // A poll that's always in flight only costs `max`.
  const settle = async (max = 4000) => {
    const until = Date.now() + max;
    for (;;) {
      await inPage(page, SETTLE, Math.max(250, until - Date.now())).catch(() => {});
      if (!inflight.size || Date.now() >= until) return;
      await page.waitForTimeout(100);
    }
  };
  // A redirect may still be on its way (a meta refresh, a script): let it land before looking.
  const signInWall = async () => {
    for (let i = 0; i < 2; i++) {
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
      try { return await inPage<boolean>(page, SIGN_IN); } catch { await page.waitForTimeout(500); }
    }
    return false;
  };
  const onSignInPage = () => { if (!o.signIn) return false; try { const u = new URL(page.url()); return u.origin === base.origin && (u.pathname === o.signIn.path || u.pathname.startsWith(o.signIn.path.replace(/\/?$/, '/'))); } catch { return false; } };
  /**
   * Sign in by clicking the sign-in button: with the identity provider's saved session, that comes back
   * signed in without a password. Done once per browser; after it the crawler moves inside the app
   * (pushState), so tokens kept in memory survive. A password form at the provider: the session expired.
   */
  const signInOnce = async (): Promise<'ok' | 'expired' | 'failed'> => {
    if (!o.signIn || auth.attempts >= 4) return 'failed';
    auth.attempts++;
    auth.signing = true;
    try {
      const name = o.signIn.click;
      const target = [page.getByRole('button', { name, exact: true }), page.getByRole('link', { name, exact: true }), page.getByText(name, { exact: true })];
      let clicked = false;
      for (const t of target) { if (await t.count().catch(() => 0)) { await t.first().click({ timeout: 5000 }).catch(() => {}); clicked = true; break; } }
      if (!clicked) { o.log(`  sign-in: no “${name}” on ${o.signIn.path}`); return 'failed'; }
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        await page.waitForTimeout(250);
        let here: URL; try { here = new URL(page.url()); } catch { continue; }
        if (here.origin !== base.origin) {
          // At the identity provider, asked for a password: the saved session is gone.
          if (await inPage<boolean>(page, SIGN_IN).catch(() => false)) { auth.expired = true; return 'expired'; }
          continue;
        }
        if (!onSignInPage() && !/\/(auth\/)?callback\b/.test(here.pathname)) { await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {}); auth.done = true; return 'ok'; }
      }
      return 'failed';
    } finally { auth.signing = false; }
  };
  /** Inside the app, without reloading it: history.pushState and popstate, as the app's own links do. */
  const within = async (u: string) => {
    await inPage(page, `(to) => { history.pushState(history.state, '', to); dispatchEvent(new PopStateEvent('popstate', { state: history.state })); }`, u);
    await page.waitForTimeout(o.waitMs); await settle();
  };
  /**
   * Open a route. Signed in with signIn, move inside the app (a reload would drop tokens kept in
   * memory); landed on the sign-in page, sign in once and go on to the route wanted.
   */
  // An app whose page rewrites its own URL as it loads (a home that sets a hash, a redirect by pushState)
  // aborts the navigation that brought it there; it still loaded. Aborted, but on this app's origin with
  // its document past loading, counts as arrived.
  const gotoApp = async (u: string, timeout = 30000) => {
    try { await page.goto(u, { waitUntil: 'domcontentloaded', timeout }); }
    catch (e: any) {
      if (!/ERR_ABORTED|interrupted by another navigation/i.test(String(e?.message))) throw e;
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      const there = (() => { try { return new URL(page.url()).origin === base.origin; } catch { return false; } })();
      if (!there) throw e;
    }
  };
  // Where each page visited ended up (an app can rewrite its URL as it loads): drawings go to the real one.
  const landed = new Map<string, string>();
  const open = async (u: string, timeout = 60000, firstVisit = false) => {
    const inApp = (() => { try { return new URL(page.url()).origin === base.origin; } catch { return false; } })();
    if (o.signIn && auth.done && inApp) await within(u);
    else {
      // Already there (the app wrote this URL itself): going there again wouldn't load it, so reload.
      const here = page.url() === u;
      await gotoApp(u, timeout);
      if (here) await page.reload({ waitUntil: 'domcontentloaded', timeout });
      // Only a route's first visit waits for the network to go quiet (up to 8s): reloads while exploring
      // don't, so an app that keeps polling doesn't spend the explore budget waiting.
      if (firstVisit) await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(o.waitMs); await settle();
    }
    if (o.signIn && onSignInPage() && !auth.expired) {
      const r = await signInOnce();
      if (r === 'ok') await within(u);
    }
  };
  let remaining: Target[] = o.examples.map(e => ({ id: e.id, e, m: e.match, src: `${e.file}:${e.line}:${e.col}`, steps: e.reach?.steps?.map(x => ({ label: x.label, event: x.event, value: x.value, src: stepSrc(x.file, x.line, x.col) })), routes: o.reach?.byId[e.id], hints: hintsOf(e), where: pathWords(e.file) }));
  const everyone = [...remaining];
  const replayed = new Set<string>();
  const tries = new Map<string, number>();
  const deadline = Date.now() + (o.maxMinutes ?? 12) * 60_000;
  // Interactions tried at the top of a page, per app: the same toolbar on every page opens the same things.
  const triedApp = new Set<string>();
  const traced = () => [...new Set(remaining.flatMap(r => r.steps?.map(s => s.label) ?? []))];
  const hints = () => [...new Set(remaining.flatMap(r => r.hints))];
  // Routes that mention what's still missing go first (stable: ties keep the source order).
  // Routes whose component renders what's still missing, by how many: where the misses are densest.
  const wantRoute = () => { const n = new Map<string, number>(); for (const r of remaining) for (const p of r.routes ?? []) n.set(p, (n.get(p) ?? 0) + 1); return n; };
  const routeOf = (u: string) => { const x = new URL(u); return (x.hash.startsWith('#/') ? x.hash.slice(1) : x.pathname).replace(/(.)\/$/, '$1') || '/'; };
  const filled = new Map<string, Set<string>>();
  // The files each visited page showed (by their source tags).
  const shown = new Map<string, Set<string>>();
  /**
   * How many still-missing elements a page renders: by the scan's routes (any depth of the route's import
   * tree), or because the page shows the element's file or a file importing it (three steps up).
   */
  const owns = (u: string) => {
    const h = routeOf(u), files = shown.get(u);
    let n = 0;
    for (const r of remaining) {
      if ((r.routes ?? []).some(p => needsValue(p) ? patternTest(p).test(h) : p === h)) { n++; continue; }
      const near = o.reach?.near?.[r.id];
      if (files && near?.some(f => files.has(f))) n++;
    }
    return n;
  };
  const rank = () => {
    const h = hints();
    const want = wantRoute();
    if (!h.length && !want.size) return;
    // Configured extra routes stay ahead of everything the hints rank.
    const byPattern = (path: string) => { let n = want.get(path) ?? 0; for (const [p, k] of want) if (needsValue(p) && filled.get(p)?.has(path)) n += k; return n; };
    const score = (u: string) => { const s = decodeURIComponent(u).toLowerCase(); return (firstUrls.has(u) ? 1000 : 0) + 10 * byPattern(routeOf(u)) + h.filter(w => s.includes(w)).length; };
    queue.sort((a, b) => score(b) - score(a));
  };
  const sweeper = (u: string) => async (revealedBy?: string) => {
    const found: { id: string; score: number; ties: number; alike: number; with: string[]; tagged?: true }[] = await inPage(page, FIND_IN_PAGE, remaining.map(({ e: _, ...t }) => t));
    // Which line is which, when several want the same controls: the page's route names one of them, or it's a guess.
    const onRoute = (id: string) => { const t = remaining.find(r => r.id === id); const at = decodeURIComponent(new URL(u).pathname + new URL(u).hash).toLowerCase(); return Boolean(t?.where.some(w => at.includes(w))); };
    for (const f of found) {
      // Matched by its source tag: exact. Several nodes from one line (a .map() list) each stand for it.
      const claim = [f.id, ...f.with];
      const named = claim.filter(onRoute);
      const claimants = f.tagged ? 1 : named.length === 1 ? (named[0] === f.id ? 1 : claim.length) : claim.length;
      if (!f.tagged) f.score = matchConfidence(f.score, f.ties, f.alike, claimants);
      (f as any).claimants = claimants;
      const file = `${f.id}.png`;
      // Measure before capturing (capture clears the marker): the same properties rendered signatures record,
      // and where it sits (landmarks, live ARIA, geometry) for the next evaluation.
      const styles = await inPage(page, `(id) => { const el = document.querySelector('[data-dsa-shot="' + CSS.escape(id) + '"]'); return el ? (${READ_STYLE})(el) : null; }`, f.id).catch(() => null);
      const placement = await inPage(page, `(id) => { const el = document.querySelector('[data-dsa-shot="' + CSS.escape(id) + '"]'); return el ? (${PLACE_IN_PAGE})(el) : null; }`, f.id).catch(() => null);
      const content = await inPage(page, OWN_CONTENT, f.id).catch(() => null);
      const cap = await capture(page, f.id, path.join(o.dir, file));
      if (!cap) {
        // Under 2px each way on every node its line drew, twice: set aside with why, not measured on every look.
        const n = (tiny.get(f.id) ?? 0) + 1;
        tiny.set(f.id, n);
        if (n >= 2) { remaining = remaining.filter(x => x.id !== f.id); setAside.push(f.id); why[f.id] = `it renders under 2px wide or tall (on ${routeOf(u)}, each node its line drew)`; }
        continue;
      }
      shots[f.id] = { file, page: u, matchScore: Math.round(f.score * 100) / 100, ties: f.ties, alike: f.alike, ...(f.tagged ? { tagged: true } : {}), ...((f as any).claimants > 1 ? { shared: (f as any).claimants } : {}), styles, placement, box: cap.box, ...(cap.context ? { context: cap.context } : {}), revealedBy, content, ...(cap.blank ? { blank: true } : {}), ...(cap.covered ? { covered: true } : {}), ...(cap.uncovered ? { uncovered: cap.uncovered } : {}), ...(cap.via ? { via: cap.via } : {}) };
      o.log(`  ${f.id} on ${u.replace(base.origin, '')}${revealedBy ? ` after ${revealedBy}` : ''} (${f.tagged ? `matched by source tag${f.ties > 1 ? `, one of ${f.ties} rendered by this line` : ''}` : `match ${Math.round(f.score * 100)}%`}${f.tagged ? '' : (f as any).claimants > 1 ? `, ${(f as any).claimants} source lines want the same control` : f.ties > 1 ? (f.alike >= f.ties ? `, one of ${f.ties} alike on the page` : `, a guess among ${f.ties} similar elements on the page`) : ''})${cap.blank ? ' · captured but blank' : cap.covered ? ' · covered by another layer' : cap.uncovered ? ` · ${cap.uncovered} covering layer${cap.uncovered > 1 ? 's' : ''} hidden` : cap.via ? ` · shows on ${cap.via}` : ''}`);
    }
    remaining = remaining.filter(r => !shots[r.id]);
    // Wherever the crawler has got to (a menu it opened, a tab, a state it set), the app's own uses show too.
    await photographUses(u);
  };
  // Pass 1 (quick): every route, look, replay traced controls, and note how much of what's missing each page mentions.
  // Pass 2 (deep): explore the most promising pages with the time left.
  // The app's own route list (apps[name].routeSource): a module of the app, loaded through its build, that
  // lists every route (its route formatter over its registries). Those go first, and the page cap grows to fit.
  if (o.routeSource) {
    const got = await routesFromApp(o.routeSource);
    if (Array.isArray(got)) {
      const add = got.map(r => { try { return /^https?:/.test(r) ? (new URL(r).origin === base.origin ? r : '') : routeUrl(r, base); } catch { return ''; } }).filter(Boolean);
      const fresh = add.filter(u => !queue.includes(u));
      queue.unshift(...fresh);
      for (const u of fresh) firstUrls.add(u);
      o.log(`  ${got.length} route${got.length === 1 ? '' : 's'} from ${o.routeSource.module} (${o.routeSource.export}), ${fresh.length} new`);
    } else o.log(`  apps.routeSource: ${got}`);
  }
  // The app's reach manifest: routes from its file, then whatever its dev build's window.__DSA__ declares.
  for (const r of o.manifest?.routes ?? []) { const u = routeUrl(r, base); if (!queue.includes(u)) { queue.unshift(u); firstUrls.add(u); } }
  if (remaining.length) await fromManifest();
  // The ledger first: elements an earlier run, a test or a person saw render, opened where they rendered,
  // with the state recorded above them set back.
  if (o.ledger && Object.keys(o.ledger).length && remaining.length && o.reveal !== false && !(o.signIn && auth.done)) await replayLedger();
  if (!o.pagesSet && queue.length > o.maxPages) { o.log(`  ${queue.length} routes known: visiting up to all of them (shots.maxPages sets a cap)`); o.maxPages = queue.length + 20; }
  // Profiles (apps[name].profiles): a route opened with storage seeded first, no clicking (a wizard step, a flag).
  for (const pf of o.profiles ?? []) {
    if (!remaining.length || Date.now() >= deadline) break;
    const u = routeUrl(pf.route, base);
    try {
      await page.goto(base.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await inPage(page, SEED_STORAGE, { local: pf.storage ?? {}, session: pf.session ?? {} });
      const same = page.url().split('#')[0] === u.split('#')[0];
      await gotoApp(u);
      if (same) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(o.waitMs); await settle();
      const before = remaining.length;
      await sweeper(u)(`profile “${pf.name}”`);
      await written();
      o.log(`  profile “${pf.name}” on ${routeOf(u)}: ${before - remaining.length} found`);
      await inPage(page, SEED_STORAGE, { local: Object.fromEntries(Object.keys(pf.storage ?? {}).map(k => [k, null])), session: Object.fromEntries(Object.keys(pf.session ?? {}).map(k => [k, null])) });
    } catch (e: any) {
      o.log(`  profile “${pf.name}” failed: ${String(e?.message ?? e).split('\n')[0]}`);
      if (/closed|crash|Target/i.test(String(e?.message))) await relaunch();
    }
  }
  // Flows first: each is written for elements nothing else reaches, so it's the best use of the time.
  for (const f of o.flows ?? []) {
    if (!remaining.length || Date.now() >= deadline) break;
    const problems = flowProblems(f);
    if (problems.length) { o.log(`  flow “${f?.name ?? '?'}” skipped: ${problems.join('; ')}`); continue; }
    if (f.reveals?.length && !f.reveals.some(id => remaining.some(r => r.id === id))) continue;
    try {
      const before = remaining.length;
      const r = await runFlow(page, f, { base, waitMs: o.waitMs, inPage: (src, arg) => inPage(page, src, arg), sweep: sweeper(routeUrl(f.route, base)), log: o.log });
      o.log(`  flow “${f.name}”: ${r.done ? 'ran' : `stopped at step ${(r.at ?? 0) + 1} (${r.why})`}, ${before - remaining.length} found`);
    } catch (e: any) {
      o.log(`  flow “${f.name}” failed: ${String(e?.message ?? e).split('\n')[0]}`);
      if (/closed|crash|Target/i.test(String(e?.message))) await relaunch();
    }
  }
  const phase1End = Date.now() + (deadline - Date.now()) * 0.45;
  // How long each pass took, for the log at the end: where the run's time went.
  const took: [string, number][] = [];
  let lap = Date.now();
  const mark = (name: string) => { took.push([name, Date.now() - lap]); lap = Date.now(); };
  const promising: { u: string; score: number }[] = [];
  try {
    while (queue.length && seen.size < o.maxPages && remaining.length && Date.now() < phase1End) {
      rank();
      const u = queue.shift()!;
      if (seen.has(u)) continue;
      seen.add(u);
      try {
      wall.tried++;
      const errorsBefore = pageErrors.length, mods = { total: modules.total, failed: modules.failed };
      try {
        // Dev servers can hold connections open; don't wait forever for "idle".
        await open(u, 60000, true);
        if (auth.expired) break;
      } catch (e: any) {
        // Sent to another host to sign in: the network guard stops the page there.
        const away = net.last.at(-1)?.match(/^GET (https?:\/\/[^/\s]+)(\S*)/);
        if (/blocked/i.test(String(e?.message)) && away && away[1] !== base.origin) { wall.walled++; wall.at = away[1]! + away[2]; }
        else o.log(`  skip ${u}: ${e.message.split('\n')[0]}`);
        if (/closed|crash/i.test(String(e?.message))) await relaunch();
        if (signedOut() && wall.tried >= 3) break;
        continue;
      }
      if (new URL(page.url()).origin !== base.origin || await signInWall()) {
        wall.walled++; wall.at = page.url();
        // Three pages in, all of them sign-in: the rest will be too.
        if (signedOut() && wall.tried >= 3) break;
        continue;
      }
      if (await didntRender(errorsBefore, mods)) {
        broken.pages++;
        // Three pages in and the app drew none of them: it's the app, not the pages.
        if (isBroken() && wall.tried >= 3) break;
        continue;
      }
      pages.push(u);
      landed.set(u, page.url());
      shown.set(u, new Set<string>(await page.evaluate(SHOWN_FILES).catch(() => [])));
      if (await page.evaluate(`Boolean(document.querySelector('[data-dsa-src]'))`).catch(() => false)) taggedPages++;
      const links: string[] = await page.evaluate(`Array.from(document.querySelectorAll('a[href]')).map(a => a.href)`).catch(() => []);
      await written();
      if (o.crawl) {
        for (const l of links) {
          try { const lu = new URL(l); if (lu.origin === base.origin && !seen.has(lu.toString())) queue.push(lu.toString()); } catch { /* ignore */ }
        }
      }
      harvest(links);
      // A table row that opens a record (no link, a click handler): click up to two, note where they go, come back.
      if (unfilled()) {
        const rows: number = await page.evaluate(ROW_MARK).catch(() => 0);
        for (let i = 0; i < Math.min(rows, 2); i++) {
          try {
            await page.locator(`[data-dsa-row="${i}"]`).first().click({ timeout: 2000 });
            await page.waitForTimeout(500);
            if (page.url() !== u) { harvest([page.url()]); await gotoApp(u); await page.waitForTimeout(o.waitMs); await settle(); await page.evaluate(ROW_MARK).catch(() => 0); }
          } catch { /* not clickable */ }
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
        const seqKey = (st: NonNullable<Target['steps']>) => st.map(x => `${x.event}:${x.label}:${x.src ?? ''}:${x.value ?? ''}`).join(' › ');
        for (const r of remaining) if (r.steps?.length) seqs.set(seqKey(r.steps), r.steps);
        // A budget per page, not per run: which pages come first depends on what's still missing, so a run-wide
        // budget could run out before the page whose opener reveals the most. Openers that reveal more go first.
        const order = [...seqs].map(([key, steps]) => ({ key, steps, n: remaining.filter(r => r.steps && seqKey(r.steps) === key).length })).sort((a, b) => b.n - a.n);
        let pageReplays = 0;
        const said: string[] = [];
        let absent = 0;
        for (const { key, steps } of order) {
          if (!remaining.length || pageReplays >= (o.maxReplays ?? 12) || Date.now() >= phase1End) break;
          const mine = remaining.filter(r => r.steps && seqKey(r.steps) === key);
          if (replayed.has(key) || (tries.get(key) ?? 0) >= 3 || !mine.length) continue;
          let done = 0, stuck = '', byTag = true;
          for (const st of steps!) {
            const hit = await inPage<string | false>(page, FIND_CONTROL, { label: st.label, src: st.src }).catch(() => false);
            if (!hit) { stuck = `${stepName(st)} isn't on ${routeOf(u)}`; if (!done) absent++; break; }
            if (typeof hit !== 'string' || !hit.startsWith('tag ')) byTag = false;
            try {
              const loc = page.locator('[data-dsa-step]').first();
              if (st.event === 'dblclick') await loc.dblclick({ timeout: 2000 });
              else if (st.event === 'type') await loc.fill('a', { timeout: 2000 });
              else if (st.event === 'choose' && st.value) await loc.selectOption(st.value, { timeout: 2000 });
              else await loc.click({ timeout: 2000 });
              done++;
              await page.waitForTimeout(400); await settle(1500);
            } catch (e: any) { stuck = `${stepName(st)} couldn't be used (${String(e?.message ?? e).split('\n')[0]!.slice(0, 60)})`; break; }
            finally { await page.evaluate(`document.querySelectorAll('[data-dsa-step]').forEach(e => e.removeAttribute('data-dsa-step'))`).catch(() => {}); }
          }
          if (!done) { if (stuck) for (const r of mine) note(r, stuck); continue; }
          pageReplays++;
          tries.set(key, (tries.get(key) ?? 0) + 1);
          await sweep(`opening ${steps!.slice(0, done).map(x => stepName(x)).join(' › ')}`);
          // Done for good only when its own controls (by their source tags) were used: one matched by its
          // words alone ("Add") may be another page's, so it's tried again where the next page has it.
          if (done === steps!.length && byTag) replayed.add(key);
          const found = mine.length - mine.filter(r => remaining.includes(r)).length;
          said.push(`${steps!.slice(0, done).map(x => stepName(x)).join(' › ')}${byTag ? '' : ' (by its words)'} ${found ? `found ${found}` : 'found none'}${done < steps!.length ? `, stopped: ${stuck}` : ''}`);
          for (const r of mine) if (remaining.includes(r)) note(r, `${steps!.slice(0, done).map(x => `${x.event === 'type' ? 'typed in' : x.event === 'choose' ? 'chose' : 'clicked'} ${stepName(x)}${x.src ? ' (found by its line)' : ''}`).join(', then ')} on ${routeOf(u)}: still not shown${stuck ? `; then ${stuck}` : ''}`);
          // Reset whatever the clicks opened or switched on: one load (a reload when still on the route).
          if (o.signIn && auth.done) await open(u).catch(() => {});
          else {
            // Same document (only the hash differs): going there doesn't load it, so reload. Else going there does.
            const same = page.url().split('#')[0] === u.split('#')[0];
            await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            if (same) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(o.waitMs); await settle();
          }
        }
        // Each traced opener tried here, and what it found: so a miss behind one says whether it ran.
        if (said.length) o.log(`  openers on ${u.replace(base.origin, '')}: ${said.join('; ')}${absent ? `; ${absent} other opener${absent === 1 ? '' : 's'} not on this page` : ''}`);
      }
      await written();
      } catch (e: any) {
        if (!/closed|crash|Target/i.test(String(e?.message))) throw e;
        o.log(`  the page closed on ${u.replace(base.origin, '')}; restarting the browser and moving on`);
        await relaunch();
      }
    }
    if (queue.some(q => !seen.has(q)) && Date.now() >= phase1End && seen.size < o.maxPages && remaining.length) o.log(`  pass 1 stopped by its time share with ${queue.filter(q => !seen.has(q)).length} pages not yet visited: results can differ between runs; raise shots.maxMinutes to visit them all`);
    mark('pass 1 (routes, openers)');
    // State the source says hides what's still missing, set through React: after the route crawl had its share,
    // each combination once (not when signed in by memory: a reload would sign out).
    if (remaining.length && o.reveal !== false && !(o.signIn && auth.done) && !signedOut() && !isBroken()) await stateReveal();
    mark('state');
    // Pass 2: explore pages, most promising first (re-scored as elements are found), until time runs out, or
    // until 8 pages in a row found nothing: by then the controls left aren't what shows the rest.
    const done2 = new Set<string>();
    let dry = 0;
    while (dry < 8 && remaining.length && Date.now() < deadline && o.reveal !== false && !signedOut() && !auth.expired && !isBroken()) {
      const words = [...hints(), ...traced().map(t => t.toLowerCase())];
      // Pages that render what's still missing first (by how much), then by the words they mention.
      const next = promising.filter(p => !done2.has(p.u)).map(p => ({ ...p, own: owns(p.u) })).sort((a, b) => b.own - a.own || b.score - a.score)[0];
      if (!next || !words.length && done2.size >= 20) break;
      done2.add(next.u);
      const before2 = remaining.length;
      try {
        await open(next.u);
        const sweep = sweeper(next.u);
        await sweep();
        if (remaining.length) await explore(next.u, sweep);
        dry = remaining.length < before2 ? 0 : dry + 1;
      } catch (e: any) {
        // One page that won't load (an aborted navigation, a timeout) costs that page, not the run's screenshots.
        if (!/closed|crash|Target/i.test(String(e?.message))) { o.log(`  skip ${next.u}: ${String(e?.message).split('\n')[0]}`); continue; }
        await relaunch();
      }
    }
    if (dry >= 8) o.log(`  pass 2 stopped after ${dry} pages in a row found nothing (${done2.size} explored)`);
    mark('pass 2 (explore)');
    // Saved state and URL search state the source reads: a first visit, or a search with something in it.
    if (remaining.length && !signedOut() && !isBroken()) await stateAndSearch();
    mark('saved and search state');
    if (!signedOut() && !isBroken()) await photographRest();
    mark("the app's own uses");
    // Why each one still missing wasn't photographed, in plain words, before any is drawn.
    for (const r of remaining) why[r.id] = reasonOf(r);
    // Whether its own file showed on a page visited: a miss on a page reached, or one on a page never reached.
    for (const r of remaining) fileOn[r.id] = pages.find(u => shown.get(u)?.has(r.e.file)) ?? '';
    if (remaining.length && o.draw && pages.length && !signedOut() && !isBroken()) await drawRest(o.draw, home());
    mark('drawings');
    const mins = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 6000) / 10}m` : `${Math.round(ms / 1000)}s`;
    o.log(`  time: ${took.filter(([, ms]) => ms >= 1000).map(([n, ms]) => `${n} ${mins(ms)}`).join(', ')}`);
    if ((net.blocked || Object.keys(net.allowed).length) && !signedOut() && !isBroken()) o.log(`  network: ${describeNetwork(net, base.origin)}`);
    if (remaining.length && Date.now() >= deadline) o.log(`  time budget (shots.maxMinutes) used up with ${remaining.length} still to find: results can differ between runs; raise shots.maxMinutes for the same result each time.`);
  } finally {
    await browser.close().catch(() => {});
  }
  return { ledger: recorded, ...(ledgerCover ? { ledgerCover } : {}), ...(ledgerGaps ? { ledgerGaps } : {}), ...(drawCauses ? { drawCauses } : {}), uses: usesShot, ...(o.uses?.length ? { usesReport: { ms: usesTime.ms, pages: usesTime.pages, cutShort: usesTime.cutShort, opened: [...new Set([...usesOpened, ...[...seen].map(pageKey)])], missed: Object.fromEntries(o.uses.filter(x => !usesShot[x.key] && (useWhy.has(x.key) || usesUnder(x))).map(x => [x.key, { why: useWhy.get(x.key) ?? 'not-seen' as const, component: x.component, fileHash: x.fileHash }])) } } : {}), shots, pages, missing: [...remaining.map(r => r.id), ...setAside, ...drawnIds], drawn: drawnIds.length, why, fileOn: Object.fromEntries(Object.entries(fileOn).map(([k, u]) => [k, u && routeOf(u)])), tried: Object.fromEntries(everyone.filter(r => r.tried?.length).map(r => [r.id, r.tried!])), tagged: { pages: taggedPages, of: pages.length }, ...(signedOut() || auth.expired ? { signIn: wall.at || o.url } : {}), ...(auth.expired ? { expired: true } : {}), ...(isBroken() ? { broken: broken.first } : {}) };

  /**
   * The app's own reach manifest, when its dev build declares one (`window.__DSA__`, docs/reach-manifest.md):
   * its routes go first in the queue, and each named state is put on (`go(name)`, after `seed()` when it has
   * one) and looked at, those that say they show a missing element's file first. Up to 60, in a fifth of
   * the time. Reaching an element is then a lookup, not a search.
   */
  async function fromManifest() {
    await go(base.toString());
    const m = await inPage<{ routes: string[]; states: { name: string; reveals: string[] }[] } | null>(page, READ_MANIFEST, null).catch(() => null);
    if (!m) return;
    let fresh = 0;
    for (const r of m.routes) { const u = routeUrl(r, base); if (!queue.includes(u)) { queue.unshift(u); firstUrls.add(u); fresh++; } }
    const stop = Date.now() + (deadline - Date.now()) * 0.2;
    const wants = (st: { reveals: string[] }) => remaining.filter(r => st.reveals.some(f => r.e.file === f || r.e.file.endsWith('/' + f) || r.e.file.startsWith(f.replace(/\*\*?$/, '')))).length;
    const order = [...m.states].sort((a, b) => wants(b) - wants(a)).slice(0, 60);
    let tried = 0;
    const before = remaining.length;
    for (const st of order) {
      if (!remaining.length || Date.now() >= stop) break;
      await go(base.toString());
      const ok = await inPage<boolean>(page, GO_MANIFEST, st.name).catch(() => false);
      if (!ok) { o.log(`  manifest: go("${st.name}") failed`); continue; }
      tried++;
      await page.waitForTimeout(o.waitMs); await settle();
      await sweeper(page.url())(`the app's manifest state “${st.name}”`);
    }
    o.log(`  manifest: ${m.routes.length} route${m.routes.length === 1 ? '' : 's'} (${fresh} new), ${tried} of ${m.states.length} state${m.states.length === 1 ? '' : 's'} put on, ${before - remaining.length} found`);
  }

  /**
   * The uses the crawl didn't pass. First the looks the cards ask for: the places the ledger saw their files
   * render (with the state it recorded), the one that helps the most cards next each time, then the routes not
   * opened yet. Then the same for every other look. It only looks: it opens nothing new. It stops at its time
   * limit, or when there's enough of each look.
   */
  async function photographRest() {
    if (!usesLeft().length) return;
    const t0 = Date.now(), stop = t0 + USES_MINUTES * 60_000;
    const inFile = new Map<string, { line: number; rec: LedgerRec }[]>();
    for (const [src, recs] of Object.entries(o.ledger ?? {})) {
      const f = src.replace(/:\d+:\d*$/, ''), line = Number(/:(\d+):\d*$/.exec(src)?.[1] ?? 0);
      let list = inFile.get(f);
      if (!list) inFile.set(f, list = []);
      for (const rec of recs) if (!rec.url.startsWith('test:')) list.push({ line, rec });
    }
    const labPage = (u: string) => Boolean(o.usesLabPage?.(u));
    const places = new Map<string, { u: string; sets: StateSet[]; files: Set<string>; lab: boolean }>();
    for (const w of usesLeft()) {
      // A big file renders on every page, so for a look a card asks for: what rendered nearest its line, likeliest the same part of the screen.
      const at = Number(w.key.split(':').pop());
      const all = inFile.get(w.file) ?? [];
      for (const { rec } of (w.need > 0 ? [...all].sort((a, b) => Math.abs(a.line - at) - Math.abs(b.line - at)) : all).slice(0, 6)) {
        let u = '';
        try { const x = new URL(rec.url); u = x.origin === base.origin ? rec.url : new URL(x.pathname + x.search + x.hash, base).toString(); } catch { continue; }
        const sets = statesOf(rec), k = u + ' ' + JSON.stringify(sets);
        const p = places.get(k) ?? places.set(k, { u, sets, files: new Set(), lab: labPage(u) }).get(k)!;
        p.files.add(w.file);
      }
    }
    const open = async (u: string) => { usesTime.pages++; await go(u); await photographUses(u); };
    // A page or place an earlier run looked at shows the same uses again: only one nobody has opened can add a photo.
    const already = (p: { u: string; sets: StateSet[] }) => usesOpened.has(placeKey(p.u, p.sets)) || (!p.sets.length && usesOpened.has(pageKey(p.u)));
    const unvisited = [...places.values()].filter(p => !already(p));
    const skipped = places.size - unvisited.length + queue.filter(q => !seen.has(q) && usesOpened.has(pageKey(q))).length;
    if (skipped) o.log(`  the app's own uses: ${skipped} page${skipped === 1 ? '' : 's'} an earlier run already looked at not opened again`);
    const tried = new Map<string, number>();
    // The best place left, worked out afresh each time: what the last page found changes what the next is worth.
    const visitPlaces = async (enough: number) => {
      while (unvisited.length) {
        if (Date.now() >= stop) { usesTime.cutShort = true; return; }
        const left = usesLeft();
        if (!left.length) return;
        let best = -1, worth = 0;
        unvisited.forEach((p, i) => { const v = usesPlaceWorth(p, left, usesCount, tried); if (v > worth) { worth = v; best = i; } });
        if (best < 0 || worth < enough) return;
        const p = unvisited.splice(best, 1)[0]!;
        const lookedFor = new Set(left.filter(w => p.files.has(w.file)).map(w => w.look));
        usesOpened.add(placeKey(p.u, p.sets));
        await open(p.u);
        for (const one of p.sets) {
          if (Date.now() >= stop || !usesLeft().some(w => p.files.has(w.file))) break;
          const r = await inPage<SetResult>(page, SET_STATE, { sets: [one] }).catch(() => NONE_SET);
          if (!r.set) continue;
          await page.waitForTimeout(o.waitMs); await settle();
          await photographUses(p.u);
        }
        for (const l of lookedFor) tried.set(l, (tried.get(l) ?? 0) + 1);
      }
    };
    const visitQueue = async (more: () => boolean, until: number, labToo = false) => {
      // Product pages first; a lab page only once they've all been opened.
      const pagesLeft = queue.filter(q => !seen.has(q) && !usesOpened.has(pageKey(q)) && (labToo || !labPage(q))).sort((a, b) => Number(labPage(a)) - Number(labPage(b)));
      for (const u of pagesLeft) {
        if (!more()) return;
        if (Date.now() >= until) { if (until >= stop) usesTime.cutShort = true; return; }
        seen.add(u);
        await open(u);
      }
    };
    // A look no card asks for is worth so little that even many of them come after any look one does.
    await visitPlaces(0.01);
    await visitQueue(() => usesLeft().some(w => w.need > 0 && !w.lab), t0 + USES_MINUTES * 60_000 * USES_UNSEEN_SHARE);
    await visitPlaces(0);
    await visitQueue(() => usesLeft().length > 0, stop, true);
    if (usesLeft().length && Date.now() >= stop) usesTime.cutShort = true;
    usesTime.ms = Math.max(usesTime.ms, Date.now() - t0);
  }

  /** Open a page; reload when only its hash differs (going there wouldn't load it). */
  async function go(u: string) {
    const same = page.url().split('#')[0] === u.split('#')[0];
    await gotoApp(u).catch(() => {});
    if (same) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(o.waitMs); await settle();
  }

  /**
   * Elements the ledger saw render: each recorded URL opened (on this server, if it was another), looked at;
   * then the state recorded in each component above it set back, outermost first, and looked at again. Only
   * values copied whole and holding no functions are set: a cut copy set back would be a guess, not a record.
   * Up to 60 tries, in a fifth of the time.
   */
  async function replayLedger() {
    const stop = Date.now() + (deadline - Date.now()) * 0.2;
    const groups = new Map<string, { u: string; sets: StateSet[]; mine: Target[] }>();
    for (const r of remaining) {
      // Records from the app's tests ("test:") name a test, not a page: nothing to open.
      for (const rec of recordsFor(o.ledger!, r.src).filter(x => !x.url.startsWith('test:')).slice(0, 2)) {
        let u = '';
        try { const x = new URL(rec.url); u = x.origin === base.origin ? rec.url : new URL(x.pathname + x.search + x.hash, base).toString(); } catch { continue; }
        const sets = statesOf(rec);
        const k = u + ' ' + JSON.stringify(sets);
        const g = groups.get(k) ?? { u, sets, mine: [] };
        g.mine.push(r);
        groups.set(k, g);
      }
    }
    if (!groups.size) return;
    let tries = 0;
    const before = remaining.length;
    for (const g of [...groups.values()].sort((a, b) => b.mine.length - a.mine.length)) {
      if (!remaining.length || Date.now() >= stop || tries >= 60) break;
      if (!g.mine.some(r => remaining.includes(r))) continue;
      tries++;
      await go(g.u);
      const sweep = sweeper(g.u);
      await sweep('opening it where the ledger saw it');
      const done: string[] = [];
      for (const one of g.sets) {
        if (!g.mine.some(r => remaining.includes(r))) break;
        const r = await inPage<SetResult>(page, SET_STATE, { sets: [one] }).catch(() => NONE_SET);
        if (!r.set) continue;
        done.push(one.component);
        await page.waitForTimeout(o.waitMs); await settle();
        await sweep(`setting the state the ledger recorded in ${done.join(' › ')}`);
      }
      for (const r of g.mine) if (remaining.includes(r)) note(r, `opened ${routeOf(g.u)} as the ledger recorded it${done.length ? `, with ${done.join(' › ')}'s recorded state` : ''}: still not shown`);
    }
    o.log(`  ledger: ${tries} recorded place${tries === 1 ? '' : 's'} opened, ${before - remaining.length} found`);
  }

  /** A record's state, as sets SET_STATE takes: each component above the element, outermost first, with the hooks safe to set back. */
  function statesOf(rec: LedgerRec): StateSet[] {
    const safe = (v: unknown): boolean => {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return true;
      const j = JSON.stringify(v);
      return j.length < 2000 && !j.includes('"__dsa":"fn"');
    };
    return rec.ancestors
      .map(a => ({ file: '', component: a.name, slots: a.hooks.map((h, i) => ({ index: i, name: h.name ?? `#${i}`, value: cleanRecorded(h.value, undefined, false) as any, ok: !h.cut && safe(h.value) })).filter(x => x.ok).map(({ ok: _, ...x }) => x) }))
      .filter(x => x.slots.length);
  }

  /** A page that renders this element: a route the scan says renders its file (one with a value found, if it needs one), else the first page. */
  function pageFor(r: Target): string | undefined {
    for (const p of r.routes ?? []) {
      if (needsValue(p)) { const v = [...(filled.get(p) ?? [])][0]; if (v) return routeUrl(hashed ? '#' + v : v, base); }
      else return routeUrl(hashed ? '#' + p : p, base);
    }
    return home();
  }
  /** The app's home page when it was visited, else the first page: a plain page to draw on, not a deep one with a dialog open. */
  function home(): string {
    const h = pages.find(u => { const x = new URL(u); return x.pathname === base.pathname && (x.hash === '' || x.hash === '#' || x.hash === '#/') && !x.search; }) ?? pages[0]!;
    return (h && landed.get(h)) || h;
  }

  /**
   * Elements hidden by saved state (a dismissed onboarding, a "set up" flag kept in localStorage) or by URL
   * search state (?q=): clear the keys the source reads, or open the page with a value in the parameter,
   * and look again. Never keys that look like sign-in.
   */
  async function stateAndSearch() {
    const stop = Date.now() + 2 * 60_000;
    const SECRET = /token|auth|session|user|jwt|cred|account|login|csrf|key|secret/i;
    const groups = new Map<string, Target[]>();
    for (const r of remaining) {
      if (!(r.e.reach?.storage?.length || r.e.reach?.params?.length)) continue;
      const at = pageFor(r);
      if (at) groups.set(at, [...(groups.get(at) ?? []), r]);
    }
    for (const [at, rs] of groups) {
      if (Date.now() > stop || !remaining.length) break;
      const keys = [...new Set(rs.flatMap(r => r.e.reach?.storage ?? []))].filter(k => !SECRET.test(k));
      try {
        if (keys.length) {
          await page.goto(at, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await inPage(page, CLEAR_KEYS, keys);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(o.waitMs); await settle();
          await sweeper(at)(`clearing saved state (${keys.join(', ')})`);
          for (const r of rs) if (remaining.includes(r)) note(r, `cleared saved state (${keys.join(', ')}) on ${routeOf(at)}: still not shown`);
        }
        for (const k of [...new Set(rs.flatMap(r => r.e.reach?.params ?? []))]) {
          if (!rs.some(r => remaining.includes(r))) break;
          const u2 = new URL(at); u2.searchParams.set(k, 'a');
          await page.goto(u2.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(o.waitMs); await settle();
          await sweeper(u2.toString())(`with ?${k}=a`);
          for (const r of rs) if (remaining.includes(r)) note(r, `opened ${routeOf(at)} with ?${k}=a: still not shown`);
        }
      } catch (e: any) {
        if (/closed|crash|Target/i.test(String(e?.message))) await relaunch();
      }
    }
  }

  /**
   * What's still missing after both passes, drawn direct from code on one of the app's pages, so its style
   * sheets apply: its component mounted through the app's Vite build (with the live app's providers and
   * props filled in, found by its source tag), else its own JSX as static markup. Each is labelled a
   * drawing, never a photo, and stays "not found" in the app. Every one gets a line saying what it became,
   * and why it wasn't mounted when it wasn't: none is dropped without a reason.
   */
  /** The component state that would show this element, from its traced conditions (empty without a source). */
  function stateFor(r: Target): StateSet[] {
    if (!o.draw?.root) return [];
    const d = o.draw;
    const gates = (r.e.reach?.gates ?? []).map((g: any) => ({ ...g, file: g.file && path.isAbsolute(g.file) ? tagOfFile(d, g.file) ?? g.file : g.file }));
    // A custom hook's own hooks are counted from its source (the file itself, its imports, then the app).
    const hookCode = (name: string, from: string) => {
      const abs = absOfTag(d, from);
      const read = (f?: string) => { try { return f ? fs.readFileSync(f, 'utf8') : ''; } catch { return ''; } };
      const own = read(abs);
      const decl = new RegExp(`\\b(?:function|const|let)\\s+${name}\\b`);
      if (decl.test(own)) return own;
      const f = importsNear(d, abs, 2).find(x => decl.test(read(x))) ?? declaredIn(d, name);
      return f ? read(f) : null;
    };
    let sets: StateSet[] = [];
    try { sets = stateSets(gates, (f) => readSource(d.root, f, d.dir), hookCode); } catch { return []; }
    // A value the app really held in that state (the ledger, by the component and the hook's name) over one
    // made from its type: a list with items, a truthy value where truth is wanted; a whole copy only.
    const fits = (want: unknown, v: unknown) => Array.isArray(want) ? Array.isArray(v) && (want.length === 0 ? v.length === 0 : v.length > 0) : want === true ? Boolean(v) : want === false ? !v : typeof want === 'object' && want ? Boolean(v) && typeof v === 'object' && Object.entries(want as object).every(([k, x]) => typeof x !== 'string' || (v as any)[k] === x || x === '') : JSON.stringify(v) === JSON.stringify(want);
    for (const set of sets) for (const sl of set.slots) {
      if (!sl.name || sl.name.startsWith('#')) continue;
      for (const list of Object.values(o.ledger ?? {})) {
        const h = list.flatMap(x => x.ancestors).filter(a => a.name === set.component).flatMap(a => a.hooks).find(h => h.name === sl.name && !h.cut && h.value != null && fits(sl.value, h.value));
        if (h) { sl.value = cleanRecorded(h.value, undefined, false) as any; (sl as any).recorded = true; break; }
      }
    }
    return sets;
  }
  function describeSets(sets: StateSet[]) { return sets.flatMap(x => x.slots.map(sl => `${sl.name} = ${JSON.stringify(sl.value)}`.slice(0, 40))).join(', '); }

  /**
   * Live, after pass 1: elements behind a component's own state ("when openColour", "mode === 'current'") are
   * shown by setting that state through React, level by level, outermost first, and looked for. Pages that
   * show the missing elements' own files (or files near them) go first, then the outermost component's. A
   * combination set in full on a page that finds nothing gets up to 3 more pages; one whose component isn't
   * on any page waits until the others ran, then is tried after the state that first showed its component's
   * file (a root nav value that renders the view it's in), in one go. Its own time share (half of what's
   * left), so the route crawl comes first.
   */
  async function stateReveal() {
    if (!o.draw?.root || !pages.length) return;
    const stop = Date.now() + (deadline - Date.now()) * 0.5;
    const groups = new Map<string, { sets: StateSet[]; mine: Target[] }>();
    for (const r of remaining) {
      const sets = stateFor(r);
      if (!sets.length) continue;
      const k = JSON.stringify(sets);
      const g = groups.get(k) ?? { sets, mine: [] };
      g.mine.push(r);
      groups.set(k, g);
    }
    if (!groups.size) return;
    const said = new Map<string, string[]>();
    const say = (u: string, m: string) => said.set(u, [...(said.get(u) ?? []), m]);
    const reverted = new Set<string>();
    // Files a set showed that its page didn't: the state that renders a component, for one whose component wasn't on any page.
    const opens = new Map<string, { u: string; sets: StateSet[] }>();
    const visit = async (u: string) => {
      const same = page.url().split('#')[0] === u.split('#')[0];
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      if (same) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(o.waitMs); await settle();
    };
    // How many values the last setAll changed: none when each already held (a default), so there's nothing new to look at.
    let changed = 0;
    const setAll = async (sets: StateSet[], sweep: (by?: string) => Promise<void>, before: StateSet[] = []) => {
      const done: StateSet[] = [];
      changed = 0;
      for (const one of sets) {
        const r = await inPage<SetResult>(page, SET_STATE, { sets: [one] }).catch(() => NONE_SET);
        if (!r.found) break;
        done.push(one);
        // Already holding (a default): nothing to wait for or look at again.
        if (!r.set) continue;
        changed += r.set;
        await page.waitForTimeout(o.waitMs); await settle();
        // The app can undo an edit (an effect that syncs state from the URL): read it back.
        const back = await inPage<SetResult>(page, SET_STATE, { sets: [one], check: true }).catch(() => NONE_SET);
        for (const n of back.off) reverted.add(`${one.component}.${n}`);
        if (before.length + sets.length > 1) await sweep(`setting ${describeSets([...before, ...done])}`);
      }
      return done;
    };
    const learn = async (u: string, done: StateSet[]) => {
      const now: string[] = await page.evaluate(SHOWN_FILES).catch(() => []);
      const had = shown.get(u);
      for (const f of now) if (!had?.has(f) && !opens.has(f)) opens.set(f, { u, sets: done });
    };
    const near = (r: Target) => [r.e.file, ...(o.reach?.near?.[r.id] ?? [])];
    let combos = 0, absent = 0;
    const later: { sets: StateSet[]; mine: Target[]; at: string[] }[] = [];
    for (const g of [...groups.values()].sort((a, b) => b.mine.length - a.mine.length)) {
      if (!remaining.length || Date.now() >= stop) break;
      if (!g.mine.some(r => remaining.includes(r))) continue;
      const what = describeSets(g.sets);
      const first = g.sets[0]!.file;
      const score = (u: string) => {
        const f = shown.get(u);
        if (!f) return 0;
        return 2 * g.mine.filter(r => remaining.includes(r) && near(r).some(x => f.has(x))).length + (f.has(first) ? 1 : 0);
      };
      // Two pages when none showed its outermost component: likely not there; it waits for the state that shows it.
      const anyShows = pages.some(u => shown.get(u)?.has(first));
      const at = pages.map((u, i) => ({ u, i, s: score(u) })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.u).slice(0, anyShows ? 8 : 2);
      let reached = false, full = 0;
      combos++;
      for (const u of at) {
        if (Date.now() >= stop || full >= 4 || !g.mine.some(r => remaining.includes(r))) break;
        await visit(u);
        const sweep = sweeper(u);
        const before = g.mine.filter(r => remaining.includes(r)).length;
        const done = await setAll(g.sets, sweep);
        if (!done.length) continue;
        reached = true;
        // Every value already held: this page as pass 1 saw it. Not counted as a try.
        if (!changed) { say(u, `${what}: already so`); break; }
        if (g.sets.length === 1) await sweep(`setting ${what}`);
        await learn(u, done);
        const missed = g.sets.slice(done.length).map(x => x.component);
        const found = before - g.mine.filter(r => remaining.includes(r)).length;
        say(u, `${what}: found ${found}${missed.length ? ` (${missed.join(' › ')} didn't show after the levels above were set)` : ''}`);
        for (const r of g.mine) if (remaining.includes(r)) note(r, `set ${what} on ${routeOf(u)}: still not shown`);
        // Every level set and something found: another page shows the same. Found none: up to 3 more pages.
        if (!missed.length && (found || ++full >= 4)) break;
      }
      if (!reached) later.push({ ...g, at });
    }
    // Still no state showed their component: the root's nav state (a string the outermost level sets) set to
    // each value its source names, by itself, keeping that level's other values (a setup flag off), to see
    // which files each shows. Most-used outermost level first; up to 60 values.
    const unseen = () => later.some(g => g.mine.some(r => remaining.includes(r)) && !opens.has(g.sets[0]!.file));
    if (unseen()) {
      const bases = new Map<string, { set: StateSet; n: number }>();
      for (const g of groups.values()) {
        const b = g.sets[0]!, k = `${b.file}#${b.component}`;
        const had = bases.get(k);
        bases.set(k, { set: had?.set ?? b, n: (had?.n ?? 0) + g.mine.length });
      }
      let swept = 0;
      const showed: string[] = [];
      for (const { set: b } of [...bases.values()].sort((x, y) => y.n - x.n)) {
        const code = readSource(o.draw.root, b.file, o.draw.dir);
        const u = pages.find(p => shown.get(p)?.has(b.file)) ?? pages[0]!;
        if (!code) continue;
        // The files it imports (two levels: its route module, its registries) can hold the values too.
        const near = importsNear(o.draw, absOfTag(o.draw, b.file), 2).slice(0, 40).map(f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } });
        for (const sl of b.slots) {
          if (typeof sl.value !== 'string') continue;
          const values = stateValues(code, sl.name, near);
          o.log(`  state: ${b.component}.${sl.name} can be ${values.length} value${values.length === 1 ? '' : 's'} by its source${values.length ? ` (${values.slice(0, 8).map(x => JSON.stringify(x)).join(', ')}${values.length > 8 ? ', …' : ''})` : ''}`);
          for (const v of values) {
            if (Date.now() >= stop || swept >= 60 || !unseen()) break;
            const one: StateSet = { ...b, slots: b.slots.map(x => (x === sl ? { ...x, value: v } : x)) };
            await visit(u);
            const sweep = sweeper(u);
            if (!(await inPage<SetResult>(page, SET_STATE, { sets: [one] }).catch(() => NONE_SET)).set) continue;
            swept++;
            await page.waitForTimeout(o.waitMs); await settle();
            await sweep(`setting ${describeSets([one])}`);
            const had = opens.size;
            await learn(u, [one]);
            if (opens.size > had) showed.push(`${sl.name} = ${JSON.stringify(v)}`);
          }
        }
      }
      if (swept) o.log(`  state: set ${swept} nav value${swept === 1 ? '' : 's'} by itself to see what each shows${showed.length ? `; new files after ${showed.join(', ')}` : '; none showed a new file'}`);
    }
    // Its component on no page tried: after the state that first showed that component's file, in one go.
    for (const g of later) {
      if (!remaining.length || Date.now() >= stop) break;
      if (!g.mine.some(r => remaining.includes(r))) continue;
      const what = describeSets(g.sets);
      const { component, file } = g.sets[0]!;
      const via = opens.get(file);
      if (!via) {
        absent++;
        o.log(`  state: ${component} (${file}) showed on no page visited and after no state set, so ${what} wasn't set`);
        for (const r of g.mine) if (remaining.includes(r)) note(r, `set ${what}: ${component} wasn't on any page tried (${g.at.map(routeOf).join(', ')}) nor shown by any state set`);
        continue;
      }
      await visit(via.u);
      const sweep = sweeper(via.u);
      const pre = await setAll(via.sets, sweep);
      if (pre.length < via.sets.length) { absent++; continue; }
      const done = await setAll(g.sets, sweep, pre);
      const all = describeSets([...pre, ...g.sets]);
      if (!done.length) { absent++; say(via.u, `${all}: ${component} didn't show`); continue; }
      const found = g.mine.length - g.mine.filter(r => remaining.includes(r)).length;
      say(via.u, `${all} (${component} shows after ${describeSets(pre)}): found ${found}${done.length < g.sets.length ? ` (${g.sets.slice(done.length).map(x => x.component).join(' › ')} didn't show)` : ''}`);
      for (const r of g.mine) if (remaining.includes(r)) note(r, `set ${all} on ${routeOf(via.u)}: still not shown`);
    }
    for (const [u, m] of said) o.log(`  state on ${u.replace(base.origin, '')}: ${m.join('; ')}`);
    if (reverted.size) o.log(`  state: the app reverted ${[...reverted].slice(0, 8).join(', ')}${reverted.size > 8 ? ` +${reverted.size - 8}` : ''} after it was set (an effect that keeps it in step with the URL or a store)`);
    o.log(`  state: ${combos} combination${combos === 1 ? '' : 's'} tried${later.length ? `, ${later.length} whose component wasn't on the pages tried (${later.length - absent} set after the state that shows it)` : ''}${groups.size > combos ? `, ${groups.size - combos} not tried (its time share ran out)` : ''}`);
  }

  /**
   * An element its mounted component didn't show: click what the scan traced as opening it, then each of the
   * drawing's own toggles, tabs and menus (never one that saves, deletes or leaves), looking after each.
   */
  async function revealInMount(r: Target, find: () => Promise<any>, remount: () => Promise<Mounted>): Promise<{ hit: any; after: string; tried: string; reverted?: string[] }> {
    const names: string[] = [];
    // State set in the drawing that the component then set back (a popover's onOpenChange, an effect).
    let reverted: string[] = [];
    // Last, on a fresh drawing (the clicks below changed this one): its conditions on the drawing's own
    // state, set through React, level by level.
    const byState = async () => {
      const sets = stateFor(r);
      if (!sets.length) return null;
      const again = await remount();
      if (!again.ok) return null;
      let set = 0;
      for (const one of sets) { set += (await inPage<SetResult>(page, SET_STATE, { sets: [one], within: '#dsa-mount' }).catch(() => NONE_SET)).found; await settle(1500); }
      if (!set) return null;
      const what = `setting ${describeSets(sets)}`;
      names.push(what);
      const hit = await find();
      if (!hit) reverted = (await inPage<SetResult>(page, SET_STATE, { sets, within: '#dsa-mount', check: true }).catch(() => NONE_SET)).off.filter(Boolean);
      return hit ? { hit, after: what, tried: '' } : null;
    };
    // A few seconds per element: drawing every element left must not cost more than the live pass did.
    const until = Date.now() + 8000;
    const use = async (event: string, value?: string) => {
      const loc = page.locator('[data-dsa-step], [data-dsa-mc]').first();
      try {
        if (event === 'dblclick') await loc.dblclick({ timeout: 800 });
        else if (event === 'type') await loc.fill('a', { timeout: 800 });
        else if (event === 'choose' && value) await loc.selectOption(value, { timeout: 800 });
        else await loc.click({ timeout: 800 });
      } catch { /* gone, or not usable */ }
      await page.waitForTimeout(200);
    };
    const clear = () => page.evaluate(`document.querySelectorAll('[data-dsa-step],[data-dsa-mc]').forEach(e => { e.removeAttribute('data-dsa-step'); e.removeAttribute('data-dsa-mc'); })`).catch(() => {});
    for (const st of r.steps ?? []) {
      const ok = await inPage<string | false>(page, FIND_CONTROL, { label: st.label, src: st.src }).catch(() => false);
      if (!ok) continue;
      await use(st.event, st.value);
      await clear();
      names.push(stepName(st));
      const hit = await find();
      if (hit) return { hit, after: names.join(' › '), tried: '' };
    }
    const labels = await inPage<string[]>(page, MOUNT_CONTROLS).catch((): string[] => []);
    await clear();
    for (let i = 0; i < labels.length && Date.now() < until; i++) {
      // Marked again each time: a click can redraw the controls.
      const again = await inPage<string[]>(page, MOUNT_CONTROLS).catch((): string[] => []);
      const at = again.indexOf(labels[i]!);
      if (at < 0) continue;
      await page.evaluate(`document.querySelectorAll('[data-dsa-mc]').forEach(e => { if (e.getAttribute('data-dsa-mc') !== '${at}') e.removeAttribute('data-dsa-mc'); })`).catch(() => {});
      await use('click');
      await clear();
      const name = labels[i] ? `“${labels[i]}”` : 'an unlabelled control';
      names.push(name);
      const hit = await find();
      if (hit) return { hit, after: name, tried: '' };
    }
    const st = await byState();
    if (st) return st;
    return { hit: null, after: '', tried: names.slice(0, 6).join(', ') + (names.length > 6 ? ', …' : ''), ...(reverted.length ? { reverted } : {}) };
  }

  async function drawRest(d: DrawWith, at: string) {
    // Earlier runs' records, and this run's: an element can render and still not be photographed.
    const ledgerNow: Record<string, LedgerRec[]> = { ...(o.ledger ?? {}) };
    for (const rec of recorded) (ledgerNow[rec.src] ??= []).push(rec);
    const fileOfSrc = (s: string) => s.replace(/:\d+:\d*$/, '');
    // Records by the component that owns them: its props, recorded as it rendered any of its elements.
    const byOwner = new Map<string, LedgerRec[]>();
    const recFiles = new Set<string>();
    for (const list of Object.values(ledgerNow)) for (const x of list) {
      recFiles.add(fileOfSrc(x.src));
      if (x.owner?.name && x.owner.props && typeof x.owner.props === 'object') (byOwner.get(x.owner.name) ?? byOwner.set(x.owner.name, []).get(x.owner.name)!).push(x);
    }
    // One with a size on the page and whole props first.
    const bestOf = (l: LedgerRec[]) => l.slice().sort((a, b) => Number(b.w > 0 && !b.owner?.cut) - Number(a.w > 0 && !a.owner?.cut))[0];
    // The props a component was recorded with: the element's own record, else any of the component's, its own file's first.
    const recordOf = (r: Target, name: string): LedgerRec | undefined => {
      const own = recordsFor(ledgerNow, r.src).find(x => x.owner?.name === name && x.owner.props && typeof x.owner.props === 'object');
      if (own) return own;
      const all = byOwner.get(name) ?? [];
      const here = all.filter(x => fileOfSrc(x.src) === fileOfSrc(r.src));
      return here.length ? bestOf(here) : all.length ? bestOf(all) : undefined;
    };
    // A component's recorded props, gaps filled: each prop from the first of its records that has a value (a copy
    // that was cut, or held a node, leaves null), then, at every depth, from the props shaped from its source.
    const recordedProps = (name: string, first: LedgerRec, shaped: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      let cut = false;
      for (const x of [first, ...(byOwner.get(name) ?? [])]) {
        const p = x.owner?.props as Record<string, unknown> | null;
        if (p && typeof p === 'object') for (const [k, v] of Object.entries(p)) if (out[k] == null && v != null) { out[k] = v; cut ||= Boolean(x.owner?.cut); }
      }
      return cleanRecorded(fillProps(shaped, out), shaped, cut) as Record<string, unknown>;
    };
    // The values context providers gave, by the context's tagged name ("file#Name"): a whole copy first.
    const ctxValues = new Map<string, { value: unknown; cut: boolean }>();
    for (const list of Object.values(ledgerNow)) for (const x of list) for (const c of x.contexts ?? []) {
      const have = ctxValues.get(c.name);
      if (!have || (have.cut && !c.cut)) ctxValues.set(c.name, { value: c.value, cut: c.cut });
    }
    // A list prop's item, from any record of the component where that list had one.
    const itemOf = (name: string) => (prop: string) => {
      // A whole one: from a copy that was cut, only an item with no null in it.
      for (const x of byOwner.get(name) ?? []) { const v = (x.owner!.props as any)?.[prop]; const it = Array.isArray(v) ? v.find(y => y != null && !(x.owner!.cut && hasNull(y))) : undefined; if (it !== undefined) return cleanRecorded(it, undefined, false); }
      return undefined;
    };
    // How much of what wasn't reached live the ledger knows: its element, its component, its file, or nothing.
    const cover = { own: 0, component: 0, file: 0, none: 0, tests: 0 };
    const noneByFile = new Map<string, Target[]>();
    // What the crawl and people recorded, without the app's tests: what only the tests cover.
    const live = (x: LedgerRec) => !x.url.startsWith('test:');
    const liveFiles = new Set(Object.values(ledgerNow).flat().filter(live).map(x => fileOfSrc(x.src)));
    for (const r of remaining) {
      const known = Boolean(ledgerNow[r.src]?.length || (r.e.within && recordOf(r, r.e.within)) || recFiles.has(fileOfSrc(r.src)));
      const knownLive = Boolean(ledgerNow[r.src]?.some(live) || (r.e.within && byOwner.get(r.e.within)?.some(live)) || liveFiles.has(fileOfSrc(r.src)));
      if (known && !knownLive) cover.tests++;
      // Its own tag exactly: another node's on the same line doesn't count as the element having rendered.
      if (ledgerNow[r.src]?.length) cover.own++;
      else if (r.e.within && recordOf(r, r.e.within)) cover.component++;
      else if (recFiles.has(fileOfSrc(r.src))) cover.file++;
      else { cover.none++; (noneByFile.get(r.e.file) ?? noneByFile.set(r.e.file, []).get(r.e.file)!).push(r); }
    }
    // The ones nothing ever rendered, by file, with the nearest test and story: dead code, a flow to add, or a test.
    if (noneByFile.size) {
      const rows = [...noneByFile].sort((a, b) => b[1].length - a[1].length).map(([file, rs]) => {
        const near = d.root ? nearestChecks(d, absOfTag(d, file)) : { test: null, story: null };
        const gate = rs.flatMap(x => x.e.reach?.gates ?? []).map(g => `${g.negated ? 'not ' : ''}“${g.test.slice(0, 40)}”`)[0];
        const unused = rs.every(x => x.e.reach?.status === 'unused');
        return { file, elements: rs.length, test: near.test, story: near.story, ...(gate ? { when: gate } : {}), ...(unused ? { unused: true } : {}) };
      });
      ledgerGaps = rows;
      o.log(`  ledger gaps: ${cover.none} never rendered by the crawl, a person or a test, in ${rows.length} file${rows.length === 1 ? '' : 's'}${rows.filter(x => !x.test && !x.story).length ? ` (${rows.filter(x => !x.test && !x.story).length} with no test or story near them)` : ''}:`);
      for (const x of rows.slice(0, 40)) o.log(`    ${x.file} · ${x.elements} element${x.elements === 1 ? '' : 's'} · test: ${x.test ? `${x.test} (rendered none of them)` : 'none'} · story: ${x.story ?? 'none'}${x.when ? ` · first condition: ${x.when}` : ''}${x.unused ? ' · the scan found nothing that imports it' : ''}`);
      if (rows.length > 40) o.log(`    +${rows.length - 40} more files (all in index.json, ledgerGaps)`);
    }
    o.log(`  ledger coverage: of ${remaining.length} not reached live, ${cover.own} recorded themselves, ${cover.component} whose component is recorded, ${cover.file} whose file is recorded, ${cover.none} neither${cover.tests ? `; ${cover.tests} of these known only from the app's tests` : ''}`);
    ledgerCover = cover;
    const stop = Date.now() + (d.maxMinutes ?? 10) * 60_000;
    const max = d.max ?? Infinity;
    let n = 0;
    // Drawing from the app's code needs /@dsa/mount: dsa's own Vite runner, or any Vite dev build with dsaTag on.
    let canMount = Boolean(d.mount);
    if (!canMount) {
      await open(at, 30000).catch(() => {});
      canMount = await inPage<boolean>(page, MOUNT_PROBE).catch(() => false);
    }
    o.log(`  drawing ${remaining.length} not reached live: ${canMount ? "from the app's code where its component can be mounted, else as markup" : "as markup only (this build doesn't serve /@dsa/mount; add dsaTag to its Vite dev build to draw from the app's code)"}`);
    const tally = new Map<string, number>();
    const causes = { threw: new Map<string, number>(), unmet: new Map<string, number>(), at: new Map<string, Map<string, number>>() };
    // The same, for elements with a record of their own (a test or a person saw them render): why each that
    // was recorded still wasn't drawn from the app's code.
    const ownTally = new Map<string, number>();
    let ownNow = false, ownCount = 0, ownIsolated = 0;
    const count = (k: string) => { tally.set(k, (tally.get(k) ?? 0) + 1); if (ownNow) ownTally.set(k, (ownTally.get(k) ?? 0) + 1); };
    // A reason without its specifics, for the summary: "its component failed to render", "no element at its line…".
    const short = (u: string) => u.replace(/\b\d+:\d+\b/g, 'its line').replace(/^[\w$.]+(?=: | mounted)(: )?/, '').replace(/ with \d+ of the app's providers/, '').replace(/\s*\(.*$/, '').replace(/:.*$/, '').trim();
    const where = (r: Target) => `${r.id} (${r.e.file}:${r.e.line})`;
    const SECRET = /token|auth|session|user|jwt|cred|account|login|csrf|key|secret/i;
    // The page each is drawn on: one that renders its file, so the live providers there are its own.
    const queue = [...remaining].map(r => ({ r, u: pageFor(r) ?? at })).sort((a, b) => a.u.localeCompare(b.u));
    // The page loaded for (the route wanted) and where it landed; reloaded when either changes.
    let loaded = '', loadedFor = '';
    // The crawler's own open: inside a signed-in app it moves without reloading, so its tokens survive.
    const visit = async (u: string) => {
      if (loadedFor === u && page.url() === loaded) return;
      await open(u, 30000);
      loaded = page.url(); loadedFor = u;
    };
    // Every element's first try before any retry: a retry (a caller further on, a recorded context, a value
    // filled after a throw, the nearest recorded component above it) never costs another element its first
    // try. Retries get only the time left; what's left after that is drawn as markup from its first try.
    const later: { r: Target; u: string }[] = [];
    const firstWhy = new Map<string, string>();
    const drawOne = async ({ r, u }: { r: Target; u: string }, mode0: 'first' | 'retry' | 'final') => {
      const mode = mode0 === 'retry' && Date.now() > stop ? 'final' : mode0;
      const retry = mode === 'retry';
      // A retry this element could use, held for the second pass on its first try.
      let wantsRetry = false;
      ownNow = Boolean(ledgerNow[r.src]?.length);
      if (ownNow && mode0 !== 'retry') ownCount++;
      const out = (msg: string) => { note(r, msg); count(`not drawn (${short(msg.replace(/^not drawn: /, '').replace(/; not mounted.*$/, ''))})`); o.log(`  ${where(r)} ${msg}`); };
      if (n >= max || (mode === 'first' && Date.now() > stop)) { out(`not drawn: ${n >= max ? `over the ${max} drawings per app` : 'out of time for drawings'}`); return; }
      const code = readSource(d.root, r.e.file, d.dir);
      if (!code) { out(`not drawn: its source file wasn't found (${r.e.file})`); return; }
      let how: 'mount' | 'markup' | null = null;
      let isolated = false;
      // The conditions set on its props to draw it (`open = true`), said with the drawing.
      let forced: string[] = [];
      // A value filled after the component read a field off nothing (`rows = []`), said with the drawing.
      let filled = '';
      // Where its component threw, for the causes table.
      let threwAt = '';
      // Contexts given the value the app gave them (recorded), said with the drawing.
      const ctxFrom: string[] = [];
      // State the component set back after the drawing set it.
      let setBack: string[] = [];
      let exact = false;
      let unmounted = '';
      let providers = 0;
      let revealed = '', drawnBy = '', wrapped = '';
      try {
        if (!canMount) unmounted = "this build doesn't serve /@dsa/mount";
        else if (mode === 'final') unmounted = `${firstWhy.get(r.id) ?? 'not mounted'} (no time left for a retry)`;
        else if (!r.e.within) unmounted = 'the scan found no component around it';
        else {
          await visit(u);
          // A first visit's saved state, so state read from storage starts as the component's default.
          const keys = (r.e.reach?.storage ?? []).filter(k => !SECRET.test(k));
          if (keys.length) await inPage(page, CLEAR_KEYS, keys);
          const abs = absOfTag(d, r.e.file);
          // The mount asks the app's server where it serves the file (/@dsa/where); these are the fallbacks.
          const files = [...(d.dir && !path.relative(d.dir, abs).startsWith('..') ? ['/' + path.relative(d.dir, abs).split(path.sep).join('/')] : []), '/@fs' + abs.split(path.sep).join('/')];
          // Mount one of the file's components and look for the element in what it drew.
          const filesOf = (f: string) => [...(d.dir && !path.relative(d.dir, f).startsWith('..') ? ['/' + path.relative(d.dir, f).split(path.sep).join('/')] : []), '/@fs' + f.split(path.sep).join('/')];
          const wraps: { files: string[]; file: string; name: string; props: unknown; context?: boolean }[] = [];
          // The app's own providers first; every context the page provides only when that fails or doesn't show it.
          let scope: 'app' | 'all' = 'app';
          // The props the app really passed the component mounted, from the ledger (this element's record, or
          // any of its component's): an isolated render, instead of props guessed from the source. Either way
          // the element's conditions on those props are made to hold (forceGates).
          let withRecorded = false;
          // The record whose state is set in the drawing: the element's own (the test or page it rendered in),
          // else the one whose props it was mounted with.
          let stateRec: LedgerRec | undefined;
          // Where the component mounted lives: the element's file, unless its function is a hook or a plain
          // function and the component that calls it is in another file.
          let host = { files, file: r.e.file, code, abs };
          // Values filled after a read off nothing (nullRead), by path from the props: one retry.
          const patches: { path: string[]; value: unknown }[] = [];
          const propsFor = (name: string) => {
            const shaped = mountProps({ ...r.e, within: name }, host.code, callersOf(d, name, host.abs));
            const rec = recordOf(r, name);
            withRecorded = Boolean(rec);
            stateRec = ledgerNow[r.src]?.[0] ?? rec;
            const f = forceGates(r.e, name, rec ? recordedProps(name, rec, shaped) : shaped, shaped, itemOf(name), itemAliases(host.code));
            forced = f.forced;
            for (const p of patches) setPath(f.props, p.path, p.value);
            return f.props;
          };
          const mountAs = (name: string) => inPage<Mounted>(page, MOUNT_IN_PAGE, [host.files, name, propsFor(name), host.file, wraps, scope])
            .catch((e: any): Mounted => ({ ok: false, why: `the page failed while mounting (${String(e?.message ?? e).split('\n')[0]!.slice(0, 80)})` }));
          const find = async () => ((await inPage<any[]>(page, FIND_IN_PAGE, [{ ...r, e: undefined }]).catch(() => [])) ?? [])[0] ?? null;
          // A hook (useCellComments) or a plain function (buildColumns) isn't a component: React can't draw what it
          // returns. The component that calls it is mounted instead: one in its own file, else one in the app.
          let parent = '', hostNote = '';
          if (/^use[A-Z]/.test(r.e.within) || !/^[A-Z]/.test(r.e.within)) {
            const p = parentComponent(code, r.e.within, r.e.line);
            if (p) parent = p;
            else {
              // Callers the ledger recorded first (their props are real), then the rest; the first that mounts.
              const { found, read } = callersOfFn(d, r.e.within, abs);
              const order = [...found.filter(c => byOwner.has(c.name)), ...found.filter(c => !byOwner.has(c.name))];
              const failed: string[] = [];
              for (const c of order.slice(0, 2)) {
                host = { files: filesOf(c.abs), file: tagOfFile(d, c.abs) ?? r.e.file, code: c.code, abs: c.abs };
                parent = c.name;
                hostNote = `, which calls ${r.e.within}, in ${host.file}${byOwner.has(c.name) ? ', with its recorded props' : ''}`;
                const probe = await mountAs(c.name);
                if (probe.ok) break;
                failed.push(`${c.name} (${host.file}): ${(probe.why ?? 'not mounted').slice(0, 80)}`);
              }
              if (!order.length) hostNote = `; no component calls ${r.e.within} (searched ${read} files of the app by its name and by names it's imported under)`;
              else if (failed.length === Math.min(order.length, 2)) hostNote += `; callers tried: ${failed.join('; ')}`;
            }
          }
          const first = parent || r.e.within;
          let said = await mountAs(first);
          // Found with the app's own providers: kept (a look marks what it finds, so it isn't looked for twice).
          let early: any = said.ok ? await find() : null;
          if (!early) { scope = 'all'; said = await mountAs(first); }
          // A render helper (cellFor, renderBody) or a function inside a component: the component around it draws it.
          if (!said.ok && /is not in its file as built/.test(said.why ?? '')) {
            const p = parentComponent(code, r.e.within, r.e.line);
            if (p) { const again = await mountAs(p); if (!/is not in its file as built/.test(again.why ?? '')) { said = again; parent = p; } }
          }
          // Needs a provider the page doesn't have: found in the source, wrapped around it, tried again (two at most).
          let need = '';
          const searched: string[] = [];
          for (let i = 0; i < 2 && !said.ok && said.threw; i++) {
            need = whatItNeeded(sourceOfThrow(d, said.threw, code, parent || r.e.within), said.threw.component || parent || r.e.within, said.threw.message);
            const looked: string[] = [];
            const pv = providerFor(d, said.threw.message, need, sourceFileOfThrow(d, said.threw, abs, parent || r.e.within), looked);
            if (!pv && /Provider|\buse[A-Z]/.test(said.threw.message + need)) searched.push(...looked);
            if (!pv || wraps.some(w => w.name === pv.name)) break;
            let pcode = '';
            try { pcode = fs.readFileSync(pv.file, 'utf8'); } catch { break; }
            const hook = need.match(/what (use[A-Z][\w$]*) reads/)?.[1] ?? said.threw.message.match(/\b(use[A-Z][\w$]*)\b/)?.[1] ?? '';
            // A bare context: its value shaped by how the component reads what the hook returns.
            // A bare context: the value a provider gave it in the app (the ledger), over one shaped by how the
            // component reads what the hook returns.
            const shapedCtx = pv.context ? hookValue(sourceOfThrow(d, said.threw, code, parent || r.e.within), said.threw.component || parent || r.e.within, hook) ?? {} : null;
            const recCtx = pv.context ? ctxValues.get(`${tagOfFile(d, pv.file) ?? ''}#${pv.name}`) : undefined;
            const props = pv.context ? { value: recCtx ? cleanRecorded(fillProps(shapedCtx, recCtx.value), shapedCtx, recCtx.cut) : shapedCtx } : mountProps({ ...r.e, within: pv.name, reach: undefined } as any, pcode);
            if (recCtx) ctxFrom.push(pv.name);
            wraps.push({ files: filesOf(pv.file), file: tagOfFile(d, pv.file) ?? path.relative(d.root, pv.file).split(path.sep).join('/'), name: pv.name, props, ...(pv.context ? { context: true } : {}) });
            said = await mountAs(parent || r.e.within);
          }
          // Still throwing, and its record lists the providers above it: each wrapped around it with the value
          // the app gave it (contexts the tagger named), once.
          if (!said.ok && said.threw && stateRec?.contexts?.length && !retry) wantsRetry = true;
          else if (!said.ok && said.threw && stateRec?.contexts?.length) {
            const add = stateRec.contexts.filter(c => !wraps.some(w => w.context && `${w.file}#${w.name}` === c.name)).slice(0, 6);
            for (const c of add) {
              const [cf, cn] = [c.name.slice(0, c.name.lastIndexOf('#')), c.name.slice(c.name.lastIndexOf('#') + 1)];
              const ca = absOfTag(d, cf);
              if (ca && cn) { wraps.push({ files: filesOf(ca), file: cf, name: cn, props: { value: cleanRecorded(c.value, undefined, c.cut) }, context: true }); ctxFrom.push(cn); }
            }
            if (add.length) { const again = await mountAs(parent || r.e.within); if (again.ok || again.threw?.message !== said.threw.message) said = again; }
          }
          // A read off nothing in its own props: that value filled with the kind the read needs, and one more try.
          if (!said.ok && said.threw && !host.abs.includes('node_modules') && !retry) wantsRetry = true;
          else if (!said.ok && said.threw && !host.abs.includes('node_modules')) {
            const who = said.threw.component || parent || r.e.within;
            const nr = nullRead(sourceOfThrow(d, said.threw, host.code, who), who, said.threw.message);
            if (nr && who === (parent || r.e.within)) {
              patches.push(nr);
              const again = await mountAs(parent || r.e.within);
              if (again.ok) { said = again; filled = `${nr.path.join('.')} = ${JSON.stringify(nr.value)}`; }
            }
            // Thrown in a helper of the app's (a data function) the component handed its props to: the
            // component's own line in the stack names the call; those props, empty or missing, filled from
            // their type (a list with one typed item), and one more try.
            else if (!said.ok && said.threw) {
              const own = (said.threw.frames ?? []).map(f => f.match(/^(.*):(\d+)$/)).find(m => m && host.files.includes(m[1]!));
              // Lines as served run a few below the source's (a refresh preamble): the nearest call above it.
              let pp: ReturnType<typeof propsPassedAt> = null;
              for (let k = 0; own && !pp && k <= 8; k++) pp = propsPassedAt(host.code, who, Number(own[2]) - k);
              if (pp && who === (parent || r.e.within)) {
                const shaped = mountProps({ ...r.e, within: who }, host.code, callersOf(d, who, host.abs)) as Record<string, unknown>;
                const cur = propsFor(who);
                const empty = (v: unknown) => v == null || (Array.isArray(v) && !v.length);
                const readAbs = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
                const typed = (p: string) => typedProp(host.code, who, p, host.abs, readAbs) ?? shaped[p];
                const fill = pp.props.filter(p => empty(cur[p]) && !empty(typed(p)));
                for (const p of fill) patches.push({ path: [p], value: typed(p) });
                if (fill.length) {
                  const again = await mountAs(parent || r.e.within);
                  if (again.ok) { said = again; filled = `${fill.join(', ')}, which it passes to ${pp.helper}`; }
                }
              }
            }
          }
          providers = said.providers ?? 0;
          const label = parent ? `${r.e.within} (drawn by ${parent}, ${hostNote ? `the component${hostNote}` : 'the component around it'})` : `${r.e.within}${hostNote}`;
          if (said.ok) {
            let hit = early ?? await find();
            // The state recorded with it, set in the drawing, before its controls are tried.
            if (!hit && stateRec) {
              let set = 0;
              for (const one of statesOf(stateRec)) set += (await inPage<SetResult>(page, SET_STATE, { sets: [one], within: '#dsa-mount' }).catch(() => NONE_SET)).set;
              if (set) { await settle(1500); hit = await find(); if (hit) revealed = `setting the state recorded with it (${set} value${set === 1 ? '' : 's'})`; }
            }
            // Behind a state inside it: the clicks the scan traced, then the drawing's own toggles, tabs and menus.
            let tried = '';
            let back: string[] = [];
            if (!hit) { const rv = await revealInMount(r, find, () => mountAs(parent || r.e.within!)); hit = rv.hit; revealed = rv.after; tried = rv.tried; back = rv.reverted ?? []; }
            if (hit) { how = 'mount'; exact = Boolean(hit.exact); drawnBy = parent; wrapped = wraps.map(w => w.name).join(', '); isolated = withRecorded && exact; }
            else {
              unmounted = `${label} mounted${providers ? ` with ${providers} of the app's providers` : ''}, but the element wasn't in what it drew (a condition inside it wasn't met${tried ? `; clicked ${tried} in it` : ''})${back.length ? `; ${back.join(', ')} ${back.length === 1 ? 'was' : 'were'} set, then set back by the component: it opens and closes itself (its onOpenChange or an effect)` : ''}`;
              setBack = back;
            }
          } else {
            if (said.threw) need = whatItNeeded(sourceOfThrow(d, said.threw, code, parent || r.e.within), said.threw.component || parent || r.e.within, said.threw.message);
            // "X is not defined" where its own file never declares or imports X: the app's code, not a missing value.
            threwAt = said.threw?.frame ?? '';
            const undef = (said.why ?? '').match(/\b([A-Za-z_$][\w$]*) is not defined\b/)?.[1];
            if (undef && !new RegExp(`\\bimport\\b[^;]*\\b${undef}\\b|\\b(?:const|let|var|function|class)\\s+${undef}\\b|[{,]\\s*${undef}\\s*[,}=]`).test(code)) said.why = `${said.why} (${r.e.file} uses ${undef} but never declares or imports it: a bug in the app's code, not a value dsa can give it)`;
            unmounted = `${label}: ${said.why ?? 'no reason given'}${need ? `; it needed ${need}` : ''}${wraps.length ? ` (wrapped in ${wraps.map(w => w.name).join(', ')} from the source)` : ''}${searched.length ? `; provider search: ${searched.join('; ')}` : ''}`;
          }
          // Its component never recorded: the nearest component above it that was, mounted from its own file
          // with the props it was recorded with, the conditions on the way forced, then the state set.
          if (!how && !recordOf(r, r.e.within) && !retry && (r.e.reach?.via ?? []).some(nm => nm !== r.e.within && byOwner.has(nm))) wantsRetry = true;
          else if (!how && !recordOf(r, r.e.within)) {
            const anc = [...(r.e.reach?.via ?? [])].reverse().find(nm => nm !== r.e.within && byOwner.has(nm));
            const rec = anc ? bestOf(byOwner.get(anc)!) : undefined;
            const af = rec ? absOfTag(d, fileOfSrc(rec.src)) : '';
            let acode = '';
            try { acode = af ? fs.readFileSync(af, 'utf8') : ''; } catch { /* moved */ }
            if (anc && rec && acode) {
              const ancMount = () => {
                const shaped = mountProps({ ...r.e, within: anc } as ElementEval, acode);
                const f = forceGates(r.e, anc, recordedProps(anc, rec, shaped), shaped, itemOf(anc));
                forced = f.forced;
                return inPage<Mounted>(page, MOUNT_IN_PAGE, [filesOf(af), anc, f.props, fileOfSrc(rec.src), [], 'all'])
                  .catch((e: any): Mounted => ({ ok: false, why: `the page failed while mounting (${String(e?.message ?? e).split('\n')[0]!.slice(0, 80)})` }));
              };
              const m = await ancMount();
              if (m.ok) {
                let hit = await find();
                if (!hit) { const rv = await revealInMount(r, find, ancMount); hit = rv.hit; revealed = rv.after; }
                if (hit) { how = 'mount'; exact = Boolean(hit.exact); drawnBy = anc; isolated = exact; providers = m.providers ?? 0; }
                else unmounted += `; ${anc}, the nearest component above it the ledger recorded, mounted with its recorded props, but the element wasn't in what it drew`;
              } else unmounted += `; ${anc}, the nearest component above it the ledger recorded: ${m.why ?? 'not mounted'}`;
            }
          }
          // Counted once: on the try that decides it (not a first try held for its retry).
          if (!how && !(mode === 'first' && wantsRetry)) {
            note(r, `not mounted: ${unmounted}`);
            // Why, grouped: what its component threw, or the condition inside it the drawing didn't meet.
            const threw = unmounted.match(/failed to render: ([^;]*)/)?.[1];
            if (threw) {
              const k = threw.replace(/\s+/g, ' ').slice(0, 120);
              causes.threw.set(k, (causes.threw.get(k) ?? 0) + 1);
              if (threwAt) { const at = causes.at.get(k) ?? causes.at.set(k, new Map()).get(k)!; at.set(threwAt, (at.get(threwAt) ?? 0) + 1); }
            }
            else if (/wasn't in what it drew/.test(unmounted)) {
              const own = (r.e.reach?.gates ?? []).filter((g: any) => !g.component || g.component === r.e.within);
              const g = own[own.length - 1] ?? (r.e.reach?.gates ?? []).slice(-1)[0];
              const k = (g ? `${g.negated ? 'not ' : ''}“${g.test.slice(0, 60)}”${(g as any).component ? ` in ${(g as any).component}` : ''}` : 'no condition traced') + (setBack.length ? ` (set, then set back: it opens and closes itself)` : '');
              causes.unmet.set(k, (causes.unmet.get(k) ?? 0) + 1);
            }
          }
        }
        if (!how && mode === 'first' && wantsRetry) { firstWhy.set(r.id, unmounted); later.push({ r, u }); return; }
        if (!how) {
          const html = markupOf(code, r.e, r.id);
          if (!html) { out(`not drawn: no element at ${r.e.line}:${r.e.col} in its file as it is now${unmounted ? `; not mounted: ${unmounted}` : ''}`); return; }
          if (!loaded) await visit(u);
          if (await inPage<boolean>(page, SHOW_MARKUP, html)) {
            await inPage(page, MARK_DRAWN, r.id);
            how = 'markup';
          }
        }
        if (!how) { out(`not drawn: its markup didn't show on the page; not mounted: ${unmounted}`); return; }
        const file = `${r.id}.png`;
        const content = await inPage(page, OWN_CONTENT, r.id).catch(() => null);
        let cap = await capture(page, r.id, path.join(o.dir, file));
        // Drawn at 0×0: say why, and show it outlined at a small size so the picture still says what and where.
        let placeholder = '';
        if (!cap) {
          // The capture let go of its mark: mark it again (the mount's element by its tag, the markup by its id).
          if (how === 'mount') await inPage(page, FIND_IN_PAGE, [{ ...r, e: undefined }]).catch(() => {});
          else await inPage(page, MARK_DRAWN, r.id).catch(() => {});
          placeholder = (await inPage<string | null>(page, NO_SIZE, r.id).catch(() => null)) ?? '';
          if (placeholder) cap = await capture(page, r.id, path.join(o.dir, file));
        }
        if (!cap) { out(`not drawn: the drawing had no size to photograph (${placeholder || "it wasn't on the page"})${unmounted ? `; not mounted: ${unmounted}` : ''}`); return; }
        // A mount found by its exact source tag, and not blank, counts as seeing the element (seenInApp).
        shots[r.id] = { file, page: u, matchScore: 1, drawn: how, ...(how === 'mount' && exact ? { exact: true } : {}), box: cap.box, content, ...(cap.blank ? { blank: true } : {}), ...(placeholder ? { placeholder } : {}), ...(isolated ? { source: 'isolated' } : {}), ...(how === 'mount' && forced.length ? { forced } : {}) };
        drawnIds.push(r.id);
        remaining = remaining.filter(x => x.id !== r.id);
        n++;
        if (ownNow && isolated) ownIsolated++;
        const msg = how === 'mount' ? `drawn from the app's code${filled ? ` (after filling ${filled}, which it read a field off)` : ''}${ctxFrom.length ? ` (with the recorded value of ${[...new Set(ctxFrom)].join(', ')})` : ''}${isolated ? ` with the props the app passed it (recorded): an isolated render${forced.length ? ` (recorded props, condition forced: ${forced.join(', ')})` : ''}` : forced.length ? ` (condition forced: ${forced.join(', ')})` : ''} (${drawnBy ? `${drawnBy}, the component around it` : 'its component'}, in the app's build${providers ? `, with ${providers} of its providers` : ''}${wrapped ? `, ${wrapped} found in the source` : ''}${revealed ? `, after ${revealed.startsWith('setting ') ? revealed : `clicking ${revealed}`} in it` : ''})` : `drawn as markup only; not mounted: ${unmounted}`;
        count(placeholder ? `shown outlined (no size: ${short(placeholder)})` : how === 'mount' ? "drawn from the app's code" : `markup only (not mounted: ${short(unmounted)})`);
        o.log(`  ${where(r)} ${msg}${placeholder ? ` · shown outlined, it had no size: ${placeholder}` : ''}${cap.blank ? ' · blank' : ''}`);
      } catch (e: any) {
        loaded = '';
        out(`not drawn: the page failed while drawing (${String(e?.message ?? e).split('\n')[0]!.slice(0, 80)})${unmounted ? `; not mounted: ${unmounted}` : ''}`);
        if (/closed|crash|Target/i.test(String(e?.message))) await relaunch();
      }
    };
    const t0 = Date.now();
    for (const q of queue) await drawOne(q, 'first');
    const firstMs = Date.now() - t0, t1 = Date.now();
    for (const q of later) await drawOne(q, 'retry');
    const secs = (ms: number) => `${Math.round(ms / 100) / 10}s`;
    o.log(`  drawing time: ${secs(firstMs)} on ${queue.length} first tries, ${secs(Date.now() - t1)} on ${later.length} held for a retry${Date.now() > stop && later.length ? ' (out of time: the rest drawn as markup from their first try)' : ''}`);
    if (tally.size) o.log(`  drawings: ${[...tally].sort((a, b) => b[1] - a[1]).map(([w, k]) => `${k} ${w}`).join('; ')}`);
    const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 10);
    // Each thrown cause with where it was thrown (the first frame in the app's code): a store, a context, a hook.
    const atOf = (w: string) => [...(causes.at.get(w) ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
    if (causes.threw.size) o.log(`  drawings, its component failed to render (top ${Math.min(10, causes.threw.size)} of ${causes.threw.size} causes): ${top(causes.threw).map(([w, k]) => `${k} × ${w}${atOf(w).length ? ` (thrown at ${atOf(w).join(', ')})` : ''}`).join(' | ')}`);
    if (causes.unmet.size) o.log(`  drawings, mounted but the element wasn't in what it drew (top ${Math.min(10, causes.unmet.size)} of ${causes.unmet.size} conditions): ${top(causes.unmet).map(([w, k]) => `${k} × ${w}`).join(' | ')}`);
    drawCauses = { threw: top(causes.threw).map(([w, k]) => [w, k, atOf(w)] as [string, number, string[]]), unmet: top(causes.unmet) };
    if (ownCount) o.log(`  ledger: of ${ownCount} with a record of their own, ${ownIsolated} drawn as isolated renders; all: ${[...ownTally].sort((a, b) => b[1] - a[1]).map(([w, k]) => `${k} ${w}`).join('; ')}`);
    // Known only from the app's tests: drawn from the code with what the tests gave them, never live (a test names no page).
    if (ledgerCover?.tests) o.log(`  ledger: ${ledgerCover.tests} known only from the app's tests: drawn isolated where they could be, not live (a test's record names no page to open)`);
  }

  /**
   * Explore one page as a tree of UI states. From the loaded page, try each interaction (best first:
   * the control the source traced, then ones whose label matches what the missing elements need, then
   * tabs and segments that swap content, popups and disclosures, reveal words, hovers, and a right-click
   * on a grid cell). After each one, look for the missing elements; then try the controls that
   * interaction revealed, up to shots.maxDepth deep. Return to the parent state with Escape, or by
   * reloading and replaying the path. Never anything that deletes, saves, submits, sends, or closes.
   */
  /**
   * JS coverage while exploring (Chromium): which code each interaction ran for the first time in the files
   * of what's still missing (their own and the files near them). Off with shots.coverage: false, or when the
   * browser has no coverage.
   */
  async function covStart() {
    cov.page = 0; cov.best = ''; cov.bestN = 0;
    if (o.coverage === false || !page.coverage) { cov.on = false; return; }
    try { await page.coverage.startJSCoverage({ resetOnNavigation: false }); cov.on = true; } catch { cov.on = false; }
  }
  async function covStop() { if (cov.on) { try { await page.coverage.stopJSCoverage(); } catch { /* closed */ } } }
  async function covGain(what: string): Promise<number> {
    if (!cov.on) return 0;
    let entries: any[] = [];
    try { entries = await page.coverage.stopJSCoverage(); await page.coverage.startJSCoverage({ resetOnNavigation: false }); } catch { cov.on = false; return 0; }
    const want = new Set<string>();
    for (const r of remaining) { want.add(r.e.file); for (const f of o.reach?.near?.[r.id] ?? []) want.add(f); }
    let n = 0;
    for (const e of entries) {
      let p = '';
      try { p = decodeURIComponent(new URL(e.url).pathname).replace(/^\/@fs/, ''); } catch { continue; }
      if (!p || ![...want].some(f => p.endsWith('/' + f) || f.endsWith(p.replace(/^\//, '')))) continue;
      for (const fn of e.functions ?? []) for (const r of fn.ranges ?? []) {
        if (!r.count) continue;
        const k = `${p}:${r.startOffset}:${r.endOffset}`;
        if (!cov.seen.has(k)) { cov.seen.add(k); n++; }
      }
    }
    cov.page += n;
    if (n > cov.bestN) { cov.bestN = n; cov.best = what; }
    return n;
  }

  async function explore(u: string, sweep: (revealedBy?: string) => Promise<void>) {
    // A page that renders what's missing: twice the interactions and time, and every control tried.
    const own = owns(u) > 0;
    let budget = (o.maxActions ?? 20) * (own ? 2 : 1);
    const startCount = remaining.length;
    const maxDepth = o.maxDepth ?? 3;
    // A safety limit, rarely reached: the interaction budget (a count) is what normally ends a page, so the
    // same page gets the same exploring on a slow run and a fast one.
    const pageStop = Math.min(deadline, Date.now() + (own ? 240_000 : 120_000));
    const load = async () => { await open(u, 30000).catch(() => {}); };
    const sig = (): Promise<string> => page.evaluate(SIGNATURE).catch(() => '');
    const mark = (level: number) => inPage(page, MARK_SEEN, level).catch(() => {});
    const list = (level: number): Promise<Act[]> => inPage<Act[]>(page, CANDIDATES, { traced: traced(), hints: hints(), level, max: 50 }).catch(() => []);
    const left = () => { const now = page.url(); return now.split('#')[0] !== u.split('#')[0] || (u.includes('#') && now !== u && !now.startsWith(u)); };
    const perform = async (a: Act) => {
      const loc = page.locator(`[data-dsa-act="${a.n}"]`).first();
      if (a.kind === 'hover') await loc.hover({ timeout: 2000, force: true });
      else if (a.kind === 'choose') await loc.selectOption(a.value!, { timeout: 2000 });
      else if (a.kind === 'context') await loc.click({ button: 'right', timeout: 2000 });
      else await loc.click({ timeout: 2000 });
      await page.waitForTimeout(a.kind === 'hover' ? 250 : 400); await settle(1500);
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
    const describe = (path: Act[]) => path.map(a => `${a.kind === 'hover' ? 'hovering' : a.kind === 'context' ? 'right-clicking' : a.kind === 'choose' ? 'choosing' : 'opening'} “${a.label}”`).join(' › ');

    const walk = async (path: Act[], level: number, before: string): Promise<boolean> => {
      // At the top, every control on the page; below it, only what the last interaction revealed.
      const keys = (await list(level)).map(a => a.key);
      for (const key of keys) {
        if (!remaining.length || budget <= 0 || Date.now() > pageStop) return true;
        const a = (await list(level)).find(x => x.key === key);
        if (!a) continue;
        // The same top-level control on another page usually opens the same thing; unless it's what the source
        // points at. "The same" is the same source line when tagged: an "Edit Image" on another page is another control.
        const appKey = `${a.kind}|${a.label.toLowerCase()}|${a.src ?? ''}`;
        // Never on a page the source says renders something still missing: there, every control is worth a try.
        if (level === 0 && a.prio < 100 && !own && triedApp.has(appKey)) continue;
        if (level === 0) triedApp.add(appKey);
        await mark(level);
        try { await perform(a); } catch { continue; }
        budget--;
        if (left()) { if (!(await replay(path))) return false; continue; }
        const after = await sig();
        // What it ran: new code in the files of what's still missing. Below the top, only a control that ran
        // some is followed further; "found" is almost always 0, so it can't tell a promising path from a dead one.
        const gain = await covGain(describe([...path, a]));
        if (after !== before) {
          await sweep(describe([...path, a]));
          if (!remaining.length) return true;
          if (level + 1 < maxDepth && a.kind !== 'hover' && (level === 0 || !cov.on || gain > 0)) {
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
    await covStart();
    await walk([], 0, await sig());
    await covStop();
    const used = (o.maxActions ?? 20) * (own ? 2 : 1) - budget;
    o.log(`  explored ${u.replace(base.origin, '')}: ${used} interaction${used === 1 ? '' : 's'}, ${startCount - remaining.length} found${cov.on ? `, ${cov.page} new code block${cov.page === 1 ? '' : 's'} run in missing elements' files${cov.best ? ` (most by ${cov.best})` : ''}` : ''}${own ? ' (a page that renders what is missing: every control tried)' : ''}${budget <= 0 ? '; interaction budget (shots.maxActions) used' : Date.now() > pageStop ? '; out of time for this page' : ''}`);
  }
}

/**
 * Runs in the page: set component state through React, so an element its conditions hide shows. For each
 * set, the component's fibers are found from elements its file draws (or any tagged element, walking up),
 * and each named state hook (by the name the tagger gave its setter, else by its place among the hooks that keep state) is read first: one that already
 * holds the value (or, for true, any truthy value; for false, any falsy one) is left alone, so a default
 * isn't set again. Inside the mounted drawing only when `within` is given. With `check`, nothing is set:
 * it only reads. Returns the slots found, how many it set, and the names of those not holding their value.
 */
const SET_STATE = `({ sets, within, check }) => {
  const fiberOf = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); return k ? el[k] : null; };
  const nameOf = (t) => !t ? '' : typeof t === 'function' ? (t.displayName || t.name || '') : (t.displayName || nameOf(t.render) || nameOf(t.type));
  const revive = (v) => Array.isArray(v) ? v.map(revive) : v && typeof v === 'object' ? (v.__dsa === 'fn' ? () => {} : v.__dsa === 'set' ? new Set() : v.__dsa === 'map' ? new Map() : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]))) : v;
  const holds = (cur, want) => want === true ? Boolean(cur) : want === false ? !cur : (() => { try { return JSON.stringify(cur) === JSON.stringify(want); } catch { return false; } })();
  const out = { found: 0, set: 0, named: 0, off: [] };
  const scope = within ? document.querySelector(within) : document;
  if (!scope) return out;
  // Inside the drawing: its elements, and those it put in a portal elsewhere on the page (a dialog's content),
  // told apart from the live page's by the React root they belong to.
  const rootOf = (el) => { let f = fiberOf(el); while (f && f.return) f = f.return; return f && f.stateNode && f.stateNode.containerInfo; };
  const tagged = within
    ? Array.from(document.querySelectorAll('[data-dsa-src]')).filter((el) => scope.contains(el) || (!el.closest('#dsa-markup') && (() => { const c = rootOf(el); return c && scope.contains(c); })()))
    : Array.from(scope.querySelectorAll('[data-dsa-src]')).filter((el) => !el.closest('#dsa-mount, #dsa-markup'));
  for (const s of sets) {
    const own = tagged.filter((el) => el.getAttribute('data-dsa-src').startsWith(s.file + ':'));
    const from = own.length ? own : tagged.slice(0, 600);
    const seen = new Set();
    for (const el of from) {
      let f = fiberOf(el);
      while (f && nameOf(f.type) !== s.component) f = f.return;
      if (!f || seen.has(f) || seen.has(f.alternate)) continue;
      seen.add(f);
      const hooks = [];
      for (let h = f.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) if (h.queue && typeof h.queue.dispatch === 'function') hooks.push(h);
      // By name when the tagger named its hooks (exact), else by its place among them.
      const names = window.__dsaStateNames;
      for (const sl of s.slots) {
        const byName = names && sl.name && sl.name[0] !== '#' ? hooks.find((x) => (names.get(x.queue.dispatch) || {}).name === sl.name) : null;
        const h = byName || hooks[sl.index];
        if (!h) continue;
        if (byName) out.named++;
        out.found++;
        if (holds(h.memoizedState, sl.value)) continue;
        if (check) { out.off.push(sl.name); continue; }
        try { h.queue.dispatch(revive(sl.value)); out.set++; } catch {}
      }
      if (own.length === 0) break;
    }
  }
  return out;
}`;

/** Runs in the page: resolve once nothing in the DOM has changed for 250 ms, or after `max` ms. */
/** dsa.reach.json beside the app (docs/reach-manifest.md): routes, and named states as a route with storage seeded. */
export interface ReachFile { routes?: string[]; states?: { name: string; route?: string; storage?: Record<string, string | null>; session?: Record<string, string | null> }[] }

/** Runs in the page: the app's window.__DSA__ manifest, its routes and its states (each a name, or { name, reveals }). */
const READ_MANIFEST = `async () => {
  const m = window.__DSA__;
  if (!m || typeof m !== 'object') return null;
  const call = async (f) => { try { return typeof f === 'function' ? await f() : f; } catch { return null; } };
  const routes = (await call(m.routes)) || [];
  const states = (await call(m.states)) || [];
  return {
    routes: Array.isArray(routes) ? routes.filter((r) => typeof r === 'string').slice(0, 2000) : [],
    states: Array.isArray(states) ? states.map((s) => typeof s === 'string' ? { name: s, reveals: [] } : s && typeof s.name === 'string' ? { name: s.name, reveals: Array.isArray(s.reveals) ? s.reveals.filter((x) => typeof x === 'string') : [] } : null).filter(Boolean).slice(0, 500) : [],
  };
}`;

/** Runs in the page: seed the app's data (when it says how), then put one of its named states on. */
const GO_MANIFEST = `async (name) => {
  const m = window.__DSA__;
  if (!m || typeof m.go !== 'function') return false;
  try { if (typeof m.seed === 'function') await m.seed(); await m.go(name); return true; } catch { return false; }
}`;

/** apps[name].routeSource: a module of the app (path from its folder) and the export that lists its routes. */
export interface RouteSource { module: string; export: string }
/** apps[name].profiles: a route opened with local (and session) storage seeded first. null removes a key. */
export interface Profile { name: string; route: string; storage?: Record<string, string | null> | undefined; session?: Record<string, string | null> | undefined }

/** Runs before the app's scripts: keep each URL the app writes (pushState, replaceState, a hash change), up to 200. */
const WRITTEN_URLS = `(() => {
  const out = (window.__dsaUrls = window.__dsaUrls || []);
  const keep = (u) => { try { const x = new URL(u, location.href).href; if (out.length < 200 && !out.includes(x)) out.push(x); } catch {} };
  for (const k of ['pushState', 'replaceState']) { const f = history[k]; history[k] = function (s, t, u) { if (u != null) keep(u); return f.apply(this, arguments); }; }
  window.addEventListener('hashchange', () => keep(location.href));
})();`;

/** Runs in the page: import a module of the app through its own server (the first URL that loads), and list its routes. */
const ROUTES_FROM_MODULE = `async ({ files, name }) => {
  const imp = new Function('u', 'return import(u)');
  let last = 'not loaded';
  for (const f of files) {
    try {
      const m = await imp(f);
      let v = m[name];
      if (typeof v === 'function') v = await v();
      if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').slice(0, 2000);
      return { error: name + (v === undefined ? ' is not exported' : ' is not a list of routes or a function that returns one') };
    } catch (e) { last = String(e && e.message || e).split('\\n')[0]; }
  }
  return { error: last };
}`;

/** Runs in the page: set (or, for null, remove) local and session storage keys. */
const SEED_STORAGE = `({ local, session }) => {
  for (const [k, v] of Object.entries(local)) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
  for (const [k, v] of Object.entries(session)) { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} }
}`;

/** Runs in the page: mark one visible node for each component use wanted (by "file:line"), for a photo. */
const MARK_USES = `(keys) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const st = getComputedStyle(el); return st.visibility !== 'hidden' && st.display !== 'none'; };
  const byKey = new Map();
  for (const el of document.querySelectorAll('[data-dsa-use]')) {
    if (el.closest('#dsa-mount, #dsa-markup')) continue;
    const k = el.getAttribute('data-dsa-use').replace(/:\\d+$/, '');
    (byKey.get(k) || byKey.set(k, []).get(k)).push(el);
  }
  const marked = [], hidden = [];
  for (const k of keys) {
    const els = byKey.get(k);
    if (!els) continue;
    const el = els.find(vis);
    if (!el) { hidden.push(k); continue; }
    if (el.hasAttribute('data-dsa-shot')) continue;
    const id = 'use-' + k.replace(/[^\\w]+/g, '-').slice(-60);
    el.setAttribute('data-dsa-shot', id);
    marked.push({ key: k, id });
  }
  return { marked, hidden };
}`;

interface SetResult { found: number; set: number; named?: number; off: string[] }
const NONE_SET: SetResult = { found: 0, set: 0, off: [] };

const SETTLE = `(max) => new Promise((done) => {
  let t = 0;
  const end = () => { obs.disconnect(); clearTimeout(t); done(true); };
  const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(end, 250); });
  obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  t = setTimeout(end, 250);
  setTimeout(end, max);
})`;

/** Runs in the page: the files its source tags name ("apps/x/src/A.tsx"), each once. */
const SHOWN_FILES = `Array.from(new Set(Array.from(document.querySelectorAll('[data-dsa-src]')).map((e) => e.getAttribute('data-dsa-src').replace(/:\\d+:\\d*$/, ''))))`;

/** Runs in the page: a short fingerprint of what's visible (URL, open overlays, visible controls, text size). */
const SIGNATURE = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const ctrls = Array.from(document.querySelectorAll('button,[role=button],a[href],input,select,textarea,[role=tab],[role=menuitem],[role=option],[role=gridcell]')).filter(vis).length;
  const overlays = document.querySelectorAll('[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-state=open],[aria-expanded=true],[aria-selected=true]').length;
  return location.href + '|' + overlays + '|' + ctrls + '|' + ((document.body && document.body.innerText.length) >> 5);
})()`;

/** Runs in the page: mark up to five table rows that may open a record (no destructive control in them). */
const ROW_MARK = `(() => {
  document.querySelectorAll('[data-dsa-row]').forEach(e => e.removeAttribute('data-dsa-row'));
  const bad = /delete|remove|archive|discard|approve|reject|pay|send/i;
  const rows = Array.from(document.querySelectorAll('tbody tr, [role=row]')).filter(r => { const b = r.getBoundingClientRect(); return b.width && b.height && !r.querySelector('th') && !bad.test(r.textContent || '') && !r.closest('thead'); }).slice(0, 5);
  rows.forEach((r, i) => r.setAttribute('data-dsa-row', String(i)));
  return rows.length;
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
    const t = el.closest('[data-dsa-src]');
    out.push({ el, key: base + '|' + (counts[base] - 1), kind, label: label || role, why, prio: p, src: t ? t.getAttribute('data-dsa-src') : '' });
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
  // Forms: a choice can reveal fields (a payment type, "other"). Pick each option of a select, tick a box or
  // a radio; never submit (the guard blocks writes too).
  let picks = 0;
  q('select', el => {
    if (picks >= 12 || !vis(el) || el.disabled) return;
    const name = norm(el.getAttribute('aria-label') || el.name || (el.labels && el.labels[0] && el.labels[0].textContent) || 'select').slice(0, 30);
    Array.from(el.options).slice(0, 6).forEach((opt) => {
      if (opt.selected || opt.disabled || picks >= 12) return;
      const l = norm(opt.textContent).slice(0, 30), lo = l.toLowerCase();
      const p = 18 + (hints.some(h => lo.includes(h)) ? 30 : 0);
      if (prev && el.hasAttribute(prev)) return;
      out.push({ el, key: 'choose|select|' + name.toLowerCase() + '|' + opt.value, kind: 'choose', label: name + ': ' + l, why: 'form', prio: p, value: opt.value });
      picks++;
    });
  });
  q('input[type=checkbox]:not(:checked), input[type=radio]:not(:checked), [role=checkbox][aria-checked="false"], [role=switch][aria-checked="false"]', el => push(el, 'click', 'form', 16));
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
  return keep.map((x, i) => ({ n: i, key: x.key, kind: x.kind, label: x.label, why: x.why, prio: x.prio, value: x.value }));
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
const FIND_CONTROL = `({ label, src }) => {
  // On a tagged page, the control the source traced is the one its own place made: no guessing by its words.
  // With a column, exactly that element; with only a line, an interactive one on it first (not its wrapper).
  if (src && document.querySelector('[data-dsa-src]')) {
    const exact = /:\\d+$/.test(src);
    const onLine = Array.from(document.querySelectorAll('[data-dsa-src]')).filter((el) => exact ? el.getAttribute('data-dsa-src') === src : el.getAttribute('data-dsa-src').startsWith(src));
    const live = 'button, a, input, select, textarea, summary, option, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=radio], [tabindex]';
    onLine.sort((a, b) => Number(b.matches(live)) - Number(a.matches(live)));
    for (const el of onLine) {
      // An option is picked through its list.
      const c = el.tagName === 'OPTION' ? el.closest('select') : el;
      if (!c) continue;
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height || c.closest(':disabled,[aria-disabled="true"]')) continue;
      c.setAttribute('data-dsa-step', '1');
      return 'tag ' + c.tagName.toLowerCase() + ' ' + el.getAttribute('data-dsa-src');
    }
  }
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').replace(/\\(\\s*\\)/g, '').trim().toLowerCase();
  const want = norm(label);
  // No words and no tag to go by: nothing to find.
  if (!want) return false;
  // A button's words without its icons: icon fonts render their name as text ("add Colour").
  const words = (el) => { const c = el.cloneNode(true); c.querySelectorAll('[data-slot=icon], .material-symbols-outlined, .material-symbols-rounded, .material-icons, svg, [aria-hidden=true]').forEach(x => x.remove()); return c.textContent || ''; };

  const bad = /delete|remove|discard|archive|sign ?out|log ?out|reset|submit|save|send|publish|approve|reject|confirm/i;
  const sel = 'button, [role=button], a, [role=menuitem], [role=tab], [role=switch], [role=checkbox], summary, [aria-haspopup], [data-slot$="-trigger"], [tabindex], input, select, textarea';
  let best = null;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest(':disabled,[aria-disabled="true"]')) continue;
    const names = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('placeholder'), /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? '' : el.textContent, words(el)].map(norm);
    if (!names.includes(want)) continue;
    if (bad.test(names.join(' '))) continue;
    best = el; break;
  }
  if (!best) return false;
  best.setAttribute('data-dsa-step', '1');
  return 'label';
}`;

/**
 * How sure a match is. The page scores every candidate; when several score within 0.05 of the best, the
 * pick among them is a guess.
 *
 * - `alike` of the `ties` look the same (same tag and classes): whichever was picked, the photo shows how
 *   the element looks, so a tie among look-alikes costs a little, not a cap. (Capping it at 1/ties hid
 *   most correct-looking photos behind the review's 80% cut-off.)
 * - Ties that look different cap it at a guess among the different ones: right about 1 time in that many.
 * - `claimants` source lines want the same candidates (identical controls in two files): which line is which
 *   is a guess, right 1 time in that many, unless the page's route names one (the caller passes 1 then).
 *
 * Below PLACEMENT_MIN_MATCH a shot is still taken, but its placement doesn't feed the next evaluation.
 */
export function matchConfidence(score: number, ties: number, alike = 1, claimants = 1): number {
  const distinct = Math.max(1, ties - Math.max(1, alike) + 1);
  const looks = ties <= 1 ? score : distinct === 1 ? score * 0.95 : Math.min(score * 0.85, 1 / distinct);
  return claimants > 1 ? Math.min(looks, 1 / claimants) : looks;
}

/**
 * Runs in the page. Scores every element with the right tag against what the scan knows.
 * Kept as source text: tsx/esbuild wrap functions with helpers (__name) that don't exist in the page.
 */
const FIND_IN_PAGE = `(targets) => {
  const out = [];
  // Source tags on the page (data-dsa-src="file:line:col"): each element is the node its own line made, or
  // it isn't on this page. No guessing from look-alikes, and no ties with other lines.
  if (document.querySelector('[data-dsa-src]')) {
    const tagged = Array.from(document.querySelectorAll('[data-dsa-src]'));
    const shown = (el) => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const st = getComputedStyle(el); return st.display !== 'none' && (st.visibility !== 'hidden' || Boolean(el.closest('[class*="group"]'))); };
    for (const t of targets) {
      const line = t.src.slice(0, t.src.lastIndexOf(':') + 1);
      const onLine = tagged.filter(el => el.getAttribute('data-dsa-src').startsWith(line));
      // The column tells apart two elements on one line; one from this line with the right tag is it.
      const exact = onLine.filter(el => el.getAttribute('data-dsa-src') === t.src);
      const pool = (exact.length ? exact : onLine.filter(el => el.tagName.toLowerCase() === t.m.tag)).filter(shown);
      const pick = pool.find(el => !el.closest('[data-dsa-shot]'));
      if (!pick) continue;
      pick.setAttribute('data-dsa-shot', t.id);
      out.push({ id: t.id, score: 1, ties: pool.length, alike: pool.length, with: [], tagged: true, exact: exact.length > 0 });
    }
    return out;
  }
  const norm = (s) => s.replace(/\\s+/g, ' ').trim();
  // A button's words without its icons: icon fonts render their name as text ("add Colour").
  const words = (el) => { const c = el.cloneNode(true); c.querySelectorAll('[data-slot=icon], .material-symbols-outlined, .material-symbols-rounded, .material-icons, svg, [aria-hidden=true]').forEach(x => x.remove()); return c.textContent || ''; };
  const look = (el) => el.tagName + '|' + Array.from(el.classList).sort().join(' ');

  // Every candidate scored for every target, the ones already photographed included: a control matched by
  // one source line still counts as a tie for the next, so two identical lines don't each read as certain.
  const all = targets.map((t) => {
    const scored = [];
    for (const el of document.querySelectorAll(t.m.tag)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
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
    scored.sort((a, b) => b.s - a.s);
    const tied = scored.length ? scored.filter(x => scored[0].s - x.s < 0.05) : [];
    return { t, scored, tied };
  });
  for (const a of all) {
    if (!a.tied.length) continue;
    // The best not already taken (by this sweep, or photographed before); a taken one only when nothing else matches.
    const pick = a.tied.find(x => !x.el.closest('[data-dsa-shot]')) || a.scored.find(x => !x.el.closest('[data-dsa-shot]'));
    if (!pick) continue;
    const alike = a.tied.filter(x => look(x.el) === look(pick.el)).length;
    // Other source lines whose best candidates overlap this one's: they want the same controls.
    const others = all.filter(b => b !== a && b.tied.some(x => a.tied.some(y => y.el === x.el))).map(b => b.t.id);
    pick.el.setAttribute('data-dsa-shot', a.t.id);
    out.push({ id: a.t.id, score: pick.s, ties: a.tied.length, alike, with: others });
  }
  return out;
}`;

/**
 * Runs in the page: the element's own content, so its proposal can be drawn with it instead of a story's
 * sample: its words (icons left out), its aria-label, and its icon's markup. The icon keeps its shape and
 * takes the system's colour (currentColor); scripts, foreignObject, event handlers and javascript: URLs
 * are stripped, and a large icon is left out.
 */
const OWN_CAPTURE = 2;
/** An element whose words are a field's value, not its text. */
const FIELD_TAG = /^<(input|textarea|select)\b/i;
const OWN_CONTENT = `(id) => {
  const el = document.querySelector('[data-dsa-shot="' + CSS.escape(id) + '"]');
  if (!el) return null;
  const c = el.cloneNode(true);
  c.querySelectorAll('svg, [data-slot=icon], .material-symbols-outlined, .material-symbols-rounded, .material-icons, [aria-hidden=true]').forEach(x => x.remove());
  const isField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  const text = el.tagName === 'SELECT' ? '' : (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  // A field shows its value, or its placeholder; a password's value is never kept, and a tick box has no words.
  const field = !isField ? null : {
    value: /^(password|hidden|file|checkbox|radio)$/i.test(el.type || '') ? null : ((el.tagName === 'SELECT' ? (el.selectedOptions[0] ? el.selectedOptions[0].textContent : '') : el.value) || '').trim().slice(0, 200) || null,
    placeholder: el.getAttribute('placeholder') || null,
  };
  const svg = el.querySelector('svg');
  let icon = null;
  if (svg) {
    const s = svg.cloneNode(true);
    s.querySelectorAll('script, foreignObject').forEach(x => x.remove());
    for (const n of [s, ...s.querySelectorAll('*')]) for (const a of Array.from(n.attributes)) if (/^on/i.test(a.name) || /javascript:/i.test(a.value) || a.name === 'class' || a.name === 'style') n.removeAttribute(a.name);
    const cs = getComputedStyle(svg), r = svg.getBoundingClientRect();
    s.setAttribute('width', String(Math.round(r.width))); s.setAttribute('height', String(Math.round(r.height)));
    s.setAttribute('fill', cs.fill === 'none' ? 'none' : 'currentColor');
    s.setAttribute('stroke', cs.stroke === 'none' ? 'none' : 'currentColor');
    if (cs.stroke !== 'none') s.setAttribute('stroke-width', cs.strokeWidth);
    s.setAttribute('data-slot', 'icon');
    // Icon sets draw detailed paths: kept up to 20 KB, so the proposal is drawn with this icon, not a stand-in.
    icon = s.outerHTML.length <= 20000 ? s.outerHTML : null;
  }
  // What it holds besides its words: marks (an inline shape, a picture, an icon-font glyph, a painted empty
  // element) and separate blocks of text. A copy of those, with only what paints or lays them out, so the
  // proposal can be drawn holding them. No classes, handlers or links: its tags, styles, words and shapes.
  const inner = (() => {
    if (/^(TABLE|INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return null;
    const root = getComputedStyle(el);
    const clear = (v) => !v || v === 'transparent' || /^rgba\\(.*,\\s*0\\)$/.test(v);
    const ICON_FONT = /material|symbols|icons?\\b|phosphor|awesome/i;
    let marks = 0, blocks = 0, lost = 0, svgs = 0;
    const put = (to, cs, names) => { for (const [k, css] of names) { const v = cs[k]; if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px') to.style[css] = v; } };
    const copy = (n) => {
      if (n.nodeType === 3) return (n.nodeValue || '').trim() ? document.createTextNode(n.nodeValue) : null;
      if (n.nodeType !== 1) return null;
      const cs = getComputedStyle(n), r = n.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden' || (r.width <= 1 && r.height <= 1)) return null;
      const tag = n.tagName.toLowerCase();
      const mark = (to) => { marks++; to.setAttribute('data-dsa-mark', String(Math.round(r.width))); return to; };
      if (tag === 'svg') {
        const c = n.cloneNode(true);
        c.querySelectorAll('script, foreignObject').forEach(x => x.remove());
        for (const x of [c, ...c.querySelectorAll('*')]) for (const a of Array.from(x.attributes)) if (/^on/i.test(a.name) || /javascript:/i.test(a.value) || a.name === 'class' || a.name === 'style') x.removeAttribute(a.name);
        c.setAttribute('width', String(Math.round(r.width))); c.setAttribute('height', String(Math.round(r.height)));
        if (cs.fill !== 'none') c.setAttribute('fill', cs.fill);
        if (cs.stroke !== 'none') { c.setAttribute('stroke', cs.stroke); c.setAttribute('stroke-width', cs.strokeWidth); }
        svgs++;
        return mark(c);
      }
      if (tag === 'img' || tag === 'canvas') {
        let url = null;
        try {
          if (tag === 'canvas') url = n.toDataURL();
          else { const k = document.createElement('canvas'); const most = Math.min(256, Math.ceil(Math.max(r.width, r.height) * 2)); k.width = Math.min(n.naturalWidth || r.width, most); k.height = Math.min(n.naturalHeight || r.height, most); k.getContext('2d').drawImage(n, 0, 0, k.width, k.height); url = k.toDataURL('image/png'); }
        } catch { /* from elsewhere: it can't be copied */ }
        if (!url) { lost++; return null; }
        const i = document.createElement('img');
        i.src = url; i.alt = ''; i.style.width = r.width + 'px'; i.style.height = r.height + 'px'; i.style.objectFit = cs.objectFit; i.style.borderRadius = cs.borderTopLeftRadius;
        return mark(i);
      }
      const to = document.createElement(cs.display === 'inline' ? 'span' : 'div');
      put(to, cs, [['display', 'display'], ['flexDirection', 'flex-direction'], ['flexWrap', 'flex-wrap'], ['flexGrow', 'flex-grow'], ['alignItems', 'align-items'], ['justifyContent', 'justify-content'], ['columnGap', 'column-gap'], ['rowGap', 'row-gap'], ['marginTop', 'margin-top'], ['marginRight', 'margin-right'], ['marginBottom', 'margin-bottom'], ['marginLeft', 'margin-left'], ['paddingTop', 'padding-top'], ['paddingRight', 'padding-right'], ['paddingBottom', 'padding-bottom'], ['paddingLeft', 'padding-left'], ['borderRadius', 'border-radius'], ['clipPath', 'clip-path'], ['transform', 'transform']]);
      if (!clear(cs.backgroundColor)) to.style.backgroundColor = cs.backgroundColor;
      if (cs.backgroundImage !== 'none' && !/url\\(/.test(cs.backgroundImage)) { to.style.backgroundImage = cs.backgroundImage; to.style.backgroundSize = cs.backgroundSize; to.style.backgroundPosition = cs.backgroundPosition; }
      // What sits on top of something stays on top of it.
      if (cs.position === 'relative') to.style.position = 'relative';
      if (cs.position === 'absolute') { to.style.position = 'absolute'; for (const side of ['top', 'right', 'bottom', 'left', 'width', 'height', 'zIndex']) to.style[side] = cs[side]; }
      if (cs.opacity !== '1') to.style.opacity = cs.opacity;
      let bordered = false;
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const w = cs['border' + side + 'Width'], st = cs['border' + side + 'Style'], col = cs['border' + side + 'Color'];
        if (parseFloat(w) > 0 && st !== 'none') { to.style['border' + side] = w + ' ' + st + ' ' + col; if (!clear(col)) bordered = true; }
      }
      for (const [k, css] of [['fontSize', 'font-size'], ['fontWeight', 'font-weight'], ['color', 'color'], ['textTransform', 'text-transform'], ['letterSpacing', 'letter-spacing']]) if (cs[k] !== root[k]) to.style[css] = cs[k];
      const words = Array.from(n.childNodes).filter(x => x.nodeType === 3 && (x.nodeValue || '').trim());
      const glyph = ICON_FONT.test(cs.fontFamily) && !n.children.length && words.length > 0;
      if (glyph) { to.style.fontFamily = cs.fontFamily; to.style.fontSize = cs.fontSize; to.style.fontVariationSettings = cs.fontVariationSettings; to.style.fontFeatureSettings = cs.fontFeatureSettings; to.style.lineHeight = cs.lineHeight; to.textContent = n.textContent; to.setAttribute('aria-hidden', 'true'); return mark(to); }
      if (words.length) blocks++;
      for (const k of Array.from(n.childNodes)) { const c = copy(k); if (c) to.append(c); }
      // Nothing inside it, yet it paints: a swatch, a dot, a triangle made of borders.
      if (!to.childNodes.length && (bordered || !clear(cs.backgroundColor) || cs.backgroundImage !== 'none' || cs.clipPath !== 'none')) { to.style.width = cs.width; to.style.height = cs.height; to.style.flexShrink = '0'; return mark(to); }
      return to.childNodes.length ? to : null;
    };
    const box = document.createElement('div');
    const direct = Array.from(el.childNodes).filter(x => x.nodeType === 3 && (x.nodeValue || '').trim());
    if (direct.length) blocks++;
    for (const k of Array.from(el.childNodes)) { const c = copy(k); if (c) box.append(c); }
    // Its words alone, or its words and one inline icon, are carried without a copy.
    if (!lost && (!marks || (marks === svgs && marks === 1 && icon)) && blocks <= 1) return null;
    const html = box.innerHTML;
    return { html: html.length <= 40000 ? html : null, marks, blocks, lost };
  })();
  return { v: ${OWN_CAPTURE}, text: text || null, ariaLabel: el.getAttribute('aria-label'), icon, inner, ...(field || {}) };
}`;
/** For tests: the in-page capture of an element's own content. */
export const __ownContent = OWN_CONTENT;

/**
 * Runs in the page: is the element what shows at its centre? It is when the topmost element there is it,
 * inside it, or holds it (a label span over a button). Covered by another layer (a toast, a sticky bar,
 * an overlay's scrim), a screenshot of its box shows something else.
 */
const TOP_AT_CENTER = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
}`;

export interface Captured {
  box: { x: number; y: number; w: number; h: number; cw: number; ch: number };
  /** Nothing painted inside the box, after hover and focus were tried: the photo shows an empty box. */
  blank?: true;
  /** Another layer sits over its centre: the photo shows that, not the element. */
  covered?: true;
  /** What made it paint: hovering or focusing it. */
  via?: 'hover' | 'focus';
  /** Layers hidden because they covered it (a toast, a sticky bar): the photo is still the app's page. */
  uncovered?: number;
  /** A wider photo of the page around it (about 800 × 500), and where it sits in that photo. */
  context?: { file: string; box: { x: number; y: number; w: number; h: number; cw: number; ch: number } };
}

/**
 * Capture one marked element with context around it, and check the photo shows it. Fonts load first (an
 * icon font draws nothing until then). The element must be the top layer at its centre, and its box must
 * have painted pixels; if not, hover it, then focus it, and look again. What still fails is recorded
 * (blank, covered), so the review says "captured but blank" instead of showing an empty box as evidence.
 * The image is left untouched (no outline drawn into it); the element's box within the crop is returned,
 * and the report draws a thin highlight from it.
 */
async function capture(page: any, id: string, file: string): Promise<Captured | null> {
  const sel = `[data-dsa-shot="${id}"]`;
  // One line can render many nodes (a .map() list): one that's zero-sized, blank or covered gives way to the
  // next from the same line, up to four more; the first clean photo wins, else the first one taken.
  let first: Captured | null = null;
  try {
    for (let i = 0; i < 5; i++) {
      const got = await captureNode(page, sel, file + (i ? `.${i}` : ''));
      const ctx = file.replace(/\.png$/, '.ctx.png');
      const keep = () => { if (!i) return; fs.renameSync(file + `.${i}`, file); if (fs.existsSync(ctx + `.${i}`)) fs.renameSync(ctx + `.${i}`, ctx); };
      if (got && !got.blank && !got.covered) { keep(); return got; }
      if (got && !first) { first = got; keep(); }
      else if (got && i) { fs.rmSync(file + `.${i}`, { force: true }); fs.rmSync(ctx + `.${i}`, { force: true }); }
      if (!await inPage<boolean>(page, NEXT_NODE, sel).catch(() => false)) break;
    }
    return first;
  } finally {
    await inPage(page, `(sel) => { const el = document.querySelector(sel); if (el) el.removeAttribute('data-dsa-shot'); }`, sel).catch(() => {});
    await page.evaluate(`document.querySelectorAll('[data-dsa-tried]').forEach(e => e.removeAttribute('data-dsa-tried'))`).catch(() => {});
  }
}

/** Runs in the page: move the photo mark to another node the same source line rendered, at least 2px each way. */
const NEXT_NODE = `(sel) => {
  const el = document.querySelector(sel);
  const src = el && el.getAttribute('data-dsa-src');
  if (!src) return false;
  el.setAttribute('data-dsa-tried', '');
  const next = Array.from(document.querySelectorAll('[data-dsa-src]')).find((x) => x.getAttribute('data-dsa-src') === src && !x.hasAttribute('data-dsa-tried') && (() => { const r = x.getBoundingClientRect(); return r.width >= 2 && r.height >= 2; })());
  if (!next) return false;
  next.setAttribute('data-dsa-shot', el.getAttribute('data-dsa-shot'));
  el.removeAttribute('data-dsa-shot');
  return true;
}`;

async function captureNode(page: any, sel: string, file: string): Promise<Captured | null> {
  try {
    // Center it, reveal hover-only controls (row actions fade in on hover), and let layout settle.
    await inPage(page, `(sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'center', inline: 'center' }); }`, sel);
    await page.evaluate(`document.fonts ? Promise.race([document.fonts.ready.then(() => true), new Promise(r => setTimeout(r, 3000))]) : true`).catch(() => {});
    const hidden = await inPage<boolean>(page, `(sel) => { let el = document.querySelector(sel); if (el && getComputedStyle(el).visibility === 'hidden') return true; let o = 1; while (el && el !== document.body) { o *= Number(getComputedStyle(el).opacity); el = el.parentElement; } return o < 0.3; }`, sel);
    let via: Captured['via'];
    if (hidden) { await page.locator(sel).first().hover({ force: true, timeout: 2000 }).catch(() => {}); via = 'hover'; }
    const settle = async () => {
      let box: any = null;
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(i ? 120 : 200);
        const b = await page.locator(sel).first().boundingBox();
        if (b && box && Math.abs(b.x - box.x) < 0.5 && Math.abs(b.y - box.y) < 0.5 && Math.abs(b.width - box.width) < 0.5) { box = b; break; }
        box = b;
      }
      return box;
    };
    const box = await settle();
    if (!box || box.width < 2 || box.height < 2) return null;
    const vp = page.viewportSize();
    // Context scales with the element; small controls still get enough surroundings to recognize them.
    const pad = Math.max(24, Math.min(96, Math.round(Math.max(box.width, box.height) * 0.6)));
    let cw = Math.max(box.width + pad * 2, 240), ch = Math.max(box.height + pad * 2, 120);
    cw = Math.min(cw, vp.width); ch = Math.min(ch, vp.height);
    let cx = box.x + box.width / 2 - cw / 2, cy = box.y + box.height / 2 - ch / 2;
    cx = Math.max(0, Math.min(cx, vp.width - cw)); cy = Math.max(0, Math.min(cy, vp.height - ch));
    const r = (n: number) => Math.round(n * 10) / 10;
    const rel = { x: r(box.x - cx), y: r(box.y - cy), w: r(box.width), h: r(box.height), cw: r(cw), ch: r(ch) };
    const shoot = async () => {
      const buf: Buffer = await page.screenshot({ clip: { x: cx, y: cy, width: cw, height: ch } });
      let blank = false;
      try { blank = isBlank(decodePng(buf), rel, 2, BLANK_INSET); } catch { /* an image we can't read: keep it */ }
      const top = await inPage<boolean>(page, TOP_AT_CENTER, sel).catch(() => true);
      return { buf, blank, top };
    };
    let shot = await shoot();
    // Hover-only content, then focus-only (a focus ring, a revealed label): one try each.
    for (const how of ['hover', 'focus'] as const) {
      if (!shot.blank && shot.top) break;
      if (how === 'hover') await page.locator(sel).first().hover({ force: true, timeout: 2000 }).catch(() => {});
      else await page.locator(sel).first().focus({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(250);
      const again = await shoot();
      if ((!again.blank && again.top) || (shot.blank && !again.blank)) { shot = again; via = how; }
    }
    // Still under another layer (a toast, a sticky bar, a scrim): hide that layer, up to three, and look
    // again. The page, its styles and its layout are the app's own; only what covered it is gone.
    let uncovered = 0;
    while (!shot.top && uncovered < 3 && await inPage<boolean>(page, HIDE_COVER, sel).catch(() => false)) {
      uncovered++;
      await page.waitForTimeout(150);
      shot = await shoot();
    }
    fs.writeFileSync(file, shot.buf);
    // The page around it, for a person deciding: where it sits and what's near it.
    let context: Captured['context'];
    try {
      const W = Math.min(800, vp.width), H = Math.min(500, vp.height);
      const x0 = Math.max(0, Math.min(box.x + box.width / 2 - W / 2, vp.width - W)), y0 = Math.max(0, Math.min(box.y + box.height / 2 - H / 2, vp.height - H));
      const ctxFile = file.replace(/\.png(\.\d+)?$/, '.ctx.png$1');
      fs.writeFileSync(ctxFile, await page.screenshot({ clip: { x: x0, y: y0, width: W, height: H } }));
      context = { file: path.basename(ctxFile).replace(/\.\d+$/, ''), box: { x: r(box.x - x0), y: r(box.y - y0), w: r(box.width), h: r(box.height), cw: W, ch: H } };
    } catch { /* the photo stands without it */ }
    return { box: rel, ...(context ? { context } : {}), ...(shot.blank ? { blank: true as const } : {}), ...(!shot.top ? { covered: true as const } : uncovered ? { uncovered } : {}), ...(via ? { via } : {}) };
  } catch { return null; }
  finally {
    await page.evaluate(RESTORE_COVER).catch(() => {});
    await page.mouse.move(0, 0).catch(() => {});
    await page.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`).catch(() => {});
  }
}

/**
 * Runs in the page: hide the layer over the element's centre (the outermost box that holds what's on top
 * and not the element), so a photo shows the element. Restored by RESTORE_COVER after the capture.
 */
const HIDE_COVER = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return false;
  let layer = hit;
  while (layer.parentElement && layer.parentElement !== document.body && !layer.parentElement.contains(el)) layer = layer.parentElement;
  if (layer === document.body || layer === document.documentElement || layer.contains(el)) return false;
  layer.setAttribute('data-dsa-hid', layer.getAttribute('style') || '');
  layer.style.setProperty('visibility', 'hidden', 'important');
  layer.style.setProperty('opacity', '0', 'important');
  layer.style.setProperty('pointer-events', 'none', 'important');
  return true;
}`;
const RESTORE_COVER = `document.querySelectorAll('[data-dsa-hid]').forEach((x) => { const s = x.getAttribute('data-dsa-hid'); if (s) x.setAttribute('style', s); else x.removeAttribute('style'); x.removeAttribute('data-dsa-hid'); })`;

/** What /@dsa/mount answers (tag/index.ts). */
type Mounted = { ok: boolean; why?: string; providers?: number; threw?: { message: string; component: string; src?: string; /** The first stack frame in the app's own code, "/path:line" as served. */ frame?: string; /** Its first frames in the app's own code. */ frames?: string[] } };

/**
 * Recorded values over shaped ones, never a null where the shape has a value: objects merged key by key, a
 * list's items each filled from the shape's first item. Exported for tests.
 */
export function fillProps(shaped: unknown, rec: unknown): unknown {
  const plain = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && !('__dsa' in (v as object));
  if (rec == null) return shaped;
  if (Array.isArray(rec)) { const item = Array.isArray(shaped) ? shaped[0] : undefined; return item === undefined ? rec : rec.map(x => fillProps(item, x)); }
  if (plain(rec) && plain(shaped)) { const out: Record<string, unknown> = { ...shaped }; for (const [k, v] of Object.entries(rec)) out[k] = fillProps(shaped[k], v); return out; }
  return rec;
}

const hasNull = (x: unknown): boolean => x === null || (Array.isArray(x) ? x.some(hasNull) : Boolean(x) && typeof x === 'object' && !('__dsa' in (x as object)) && Object.values(x as object).some(hasNull));
/**
 * A recorded value made safe to mount: no null item in any list, ever. Where the copy was cut (a limit left
 * nulls in it), each list item's gaps are filled from the shape's item (its type), and a list whose items
 * still hold a null is left empty: no item at all beats one a helper reads a field off nothing in. A whole
 * copy is used as recorded. Exported for tests.
 */
export function cleanRecorded(v: unknown, shaped: unknown, cut: boolean): unknown {
  if (Array.isArray(v)) {
    const item = Array.isArray(shaped) ? shaped[0] : undefined;
    const items = v.filter(x => x != null).map(x => cleanRecorded(item !== undefined && cut ? fillProps(item, x) : x, item, cut));
    return cut && items.some(hasNull) ? [] : items;
  }
  if (v && typeof v === 'object' && !('__dsa' in (v as object))) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = cleanRecorded(x, shaped && typeof shaped === 'object' ? (shaped as any)[k] : undefined, cut);
    return out;
  }
  return v;
}

/** The file of the component that threw: its own when the stack names one inside the scan root, else the element's. */
function sourceFileOfThrow(d: DrawWith, threw: NonNullable<Mounted['threw']>, abs: string, name: string): string {
  if (!threw.src || !threw.component || threw.component === name) return abs;
  let p = '';
  try { p = decodeURIComponent(new URL(threw.src).pathname); } catch { return abs; }
  const at = p.indexOf('/@fs/');
  for (const f of at >= 0 ? [p.slice(at + 4)] : [path.join(d.dir ?? d.root, p), path.join(d.root, p)]) {
    if (tagOfFile(d, f) !== null && fs.existsSync(f)) return f;
  }
  return abs;
}

/**
 * The source of the component that threw, for whatItNeeded: its own file when the stack names one the app's
 * server serves inside the scan root, else the element's file.
 */
function sourceOfThrow(d: DrawWith, threw: NonNullable<Mounted['threw']>, code: string, name: string): string {
  if (!threw.src || !threw.component || threw.component === name) return code;
  let p = '';
  try { p = decodeURIComponent(new URL(threw.src).pathname); } catch { return code; }
  const at = p.indexOf('/@fs/');
  const candidates = at >= 0 ? [p.slice(at + 4)] : [path.join(d.dir ?? d.root, p), path.join(d.root, p)];
  for (const f of candidates) {
    if (tagOfFile(d, f) === null) continue;
    try { return fs.readFileSync(f, 'utf8'); } catch { /* not this one */ }
  }
  return code;
}

/**
 * Runs in the page: mark the mounted drawing's own toggles, tabs, menus and disclosures (data-dsa-mc), up to
 * 8, and return their names. Never one that saves, deletes, submits or leaves.
 */
const MOUNT_CONTROLS = `() => {
  const host = document.getElementById('dsa-mount');
  if (!host) return [];
  const bad = /delete|remove|discard|archive|sign ?out|log ?out|reset|submit|save|send|publish|approve|reject|confirm|close|cancel/i;
  const sel = 'button, [role=button], [role=tab], [role=switch], [role=checkbox], [role=radio], summary, [aria-haspopup], [aria-expanded], input[type=checkbox], input[type=radio]';
  const out = [];
  for (const el of host.querySelectorAll(sel)) {
    if (out.length >= 8) break;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest(':disabled,[aria-disabled="true"]') || el.closest('a[href]') || (el.type === 'submit' && el.form)) continue;
    const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    if (bad.test(name)) continue;
    el.setAttribute('data-dsa-mc', String(out.length));
    out.push(name);
  }
  return out;
}`;

/** Runs in the page: mark the markup drawn for this id as the one to photograph. */
const MARK_DRAWN = `(id) => { const el = document.querySelector('[data-dsa-drawn="' + CSS.escape(id) + '"]'); if (el) el.setAttribute('data-dsa-shot', id); }`;
/** The dev server's base ("/", or the config's base): where it serves /@vite/client from. */
const VITE_BASE = `(() => { const s = Array.from(document.scripts).map((x) => x.src).find((u) => /\\/@vite\\/client$/.test(u)); return s ? new URL(s).pathname.replace(/@vite\\/client$/, '') : '/'; })()`;
/** Runs in the page: load /@dsa/mount from the app's own Vite server and mount one component (drawn.ts), trying each file URL. */
const MOUNT_IN_PAGE = `async ([files, name, props, file, wraps, scope]) => { await import(${VITE_BASE} + '@dsa/mount'); return window.__dsaMount(files, name, props, file, wraps, scope); }`;
/** Runs in the page: does this build serve /@dsa/mount (dsa's runner, or dsaTag on)? */
const MOUNT_PROBE = `async () => { try { await import(${VITE_BASE} + '@dsa/mount'); return typeof window.__dsaMount === 'function'; } catch { return false; } }`;
/** Runs in the page: forget these saved-state keys, as on a first visit. */
const CLEAR_KEYS = `(keys) => { for (const k of keys) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} } return true; }`;

/** For tests: the in-page scripts and the helper that runs them. */
export const __test = { inPage, FIND_IN_PAGE, FIND_CONTROL, CANDIDATES, MARK_SEEN, PLACE_IN_PAGE, TOP_AT_CENTER, OWN_CONTENT, HIDE_COVER, capture };

/** One headless capture pass over a running app (the workbench's before/after uses it on two copies of the app). */
export const captureSession = session;
