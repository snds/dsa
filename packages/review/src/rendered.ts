import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { latestEvals, lookProps, proposalKey, readProposals, readRendered, resolveTargets, type Config, type Proposal, type RenderedSet, type Styles } from '@snds/dsa/engine';

import { cookiesFor, openSurface, serveStatic } from '@snds/dsa';
import { detectApp, ensureBrowser, startApp } from './apps.js';

/**
 * Rendered signatures: what each system component × variant × size actually looks like in a browser,
 * read from the design system's own Storybook. Static signatures (signatures.ts) say which classes a
 * variant applies; rendered ones say what they compute to — height, padding, radius, colors, border,
 * type — after tokens, density, and cascade. Prototype elements are measured the same way during
 * screenshots, so the two can be compared property by property, and side by side as images.
 */

/** Runs in the page: computed visual properties of one element. Source text so bundler helpers don't leak in. */
export const READ_STYLE = `(el) => {
  const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
  return {
    height: Math.round(r.height), width: Math.round(r.width),
    paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
    borderRadius: cs.borderTopLeftRadius, backgroundColor: cs.backgroundColor, color: cs.color,
    borderWidth: cs.borderTopWidth, borderColor: cs.borderTopColor, borderStyle: cs.borderTopStyle,
    fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, textDecoration: cs.textDecorationLine,
    boxShadow: cs.boxShadow === 'none' ? 'none' : 'shadow', gap: cs.columnGap,
  };
}`;

interface StoryCache { hash: string; files: string[]; results: { component: string; key: string; styles: Styles; shot?: string }[] }

const sha = (s: string | Buffer) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const readOr = (f: string) => { try { return fs.readFileSync(f); } catch { return Buffer.from(''); } };
const hashFiles = (files: string[], extra = '') => sha(Buffer.concat([...files.map(f => Buffer.concat([Buffer.from(f + '\0'), readOr(f)])), Buffer.from(extra)]));

/** Every token/CSS file in the core packages: a token change re-measures every story. */
function tokensHash(root: string, config: Config) {
  const dirs = resolveTargets(root, config).filter(t => t.role === 'core').map(t => t.dir);
  const css: string[] = [];
  const walk = (d: string, depth = 0) => { if (depth > 4 || !fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (e.name.endsWith('.css')) css.push(p); } };
  for (const d of dirs) walk(d);
  return hashFiles(css.sort());
}

/** Story files on disk in the core packages (a new or deleted story file means re-measuring). */
function storyFiles(root: string, config: Config) {
  const out: string[] = [];
  for (const t of resolveTargets(root, config).filter(t => t.role === 'core')) {
    const walk = (d: string, depth = 0) => { if (depth > 5 || !fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'vendor') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (/\.stories\.tsx?$/.test(e.name)) out.push(p); } };
    walk(path.join(t.dir, 'src'));
  }
  return out.sort();
}

/** The files a story's rendering depends on: the story, the component file, its vendored stock layer. */
function storyInputs(storyFile: string, compFiles: string[]) {
  const stock = compFiles.map(f => path.join(path.dirname(f), 'vendor', 'shadcn', path.basename(f))).filter(f => fs.existsSync(f));
  return [storyFile, ...compFiles, ...stock];
}

/**
 * Measure the system's components in its Storybook. Each story is cached by a hash of its inputs (story file,
 * component source, vendored stock layer, every token CSS file): unchanged stories are reused, so a run
 * only opens the stories that changed, and skips starting Storybook when none did.
 */
export async function renderSignatures(opts: { root: string; config: Config; dataDir: string; log?: (m: string) => void; force?: boolean }): Promise<RenderedSet> {
  const log = opts.log ?? (() => {});
  const sigFile = path.join(opts.dataDir, 'signatures.json');
  if (!fs.existsSync(sigFile)) throw new Error('No signatures yet. Run "dsa run" first.');
  const sigs: any[] = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
  const byStem = new Map<string, any[]>();
  for (const c of sigs) if (c.slot && c.file) { const stem = path.basename(c.file).replace(/\.tsx$/, ''); byStem.set(stem, [...(byStem.get(stem) ?? []), c]); }
  const prev: any = opts.force ? null : readRendered(opts.dataDir);
  const prevStories: Record<string, StoryCache> = prev?.stories ?? {};
  const tHash = tokensHash(opts.root, opts.config);

  const { url, stop, source, dir: sbDir, storageState, cookie } = await startStorybook(opts.root, opts.config, log);
  const out: any = { takenAt: new Date().toISOString(), source, components: {}, notes: [], stories: {}, storyFiles: storyFiles(opts.root, opts.config), tokensHash: tHash };
  const dir = path.join(opts.dataDir, 'rendered');
  fs.mkdirSync(dir, { recursive: true });
  let reused = 0, measured = 0;
  try {
    const index: any = await storyIndex(url, cookie);
    const stories = Object.values<any>(index.entries ?? index.stories ?? {}).filter(s => s.type !== 'docs' && s.importPath);
    // Stories that show many combinations first (All Variants, All Sizes…), then the rest; a few per component is enough.
    const rank = (s: any) => (/all|variant|size|matrix|gallery|overview/i.test(s.name) ? 0 : /default|primary|basic/i.test(s.name) ? 1 : 2);
    const perStem = new Map<string, number>();
    const wanted = stories
      .filter(s => byStem.has(path.basename(s.importPath).replace(/\.stories\.tsx?$/, '')))
      .sort((a, b) => rank(a) - rank(b))
      .filter(s => { const k = s.importPath; const n = perStem.get(k) ?? 0; perStem.set(k, n + 1); return n < (opts.config.rendered?.storiesPerComponent ?? 6); });
    const inputsOf = (s: any) => storyInputs(path.resolve(sbDir ?? opts.root, s.importPath), byStem.get(path.basename(s.importPath).replace(/\.stories\.tsx?$/, ''))!.map((c: any) => c.file));
    const todo = wanted.filter(s => { const files = inputsOf(s); const h = hashFiles(files, tHash); const c = prevStories[s.id]; if (c && c.hash === h) { out.stories[s.id] = c; reused++; return false; } return true; });
    log(`Storybook (${source}): ${stories.length} stories, ${wanted.length} cover components with signatures · ${reused} unchanged (cached) · ${todo.length} to measure.`);
    if (todo.length) {
      const pw = await ensureBrowser(log);
      const browser = await pw.chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, ...(storageState ? { storageState } : {}) });
      try {
        const started = Date.now();
        const budget = (opts.config.rendered?.maxMinutes ?? 8) * 60000;
        let n = 0;
        for (const s of todo) {
          n++;
          if (Date.now() - started > budget) { out.notes.push(`Stopped after ${n - 1} of ${todo.length} stories (rendered.maxMinutes); the rest are measured next run.`); log(`  time budget reached after ${n - 1} stories`); break; }
          if (n === 1 || n % 10 === 0 || n === todo.length) log(`  measuring stories ${n}/${todo.length}…`);
          const comps = byStem.get(path.basename(s.importPath).replace(/\.stories\.tsx?$/, ''))!;
          try {
            // Storybook dev keeps connections open (HMR), so "network idle" never comes: wait for the story to render instead.
            await page.goto(new URL(`iframe.html?id=${encodeURIComponent(s.id)}&viewMode=story`, url).toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForFunction(`(() => { const r = document.querySelector('#storybook-root, #root'); return r && r.children.length > 0; })()`, null, { timeout: n === 1 ? 90000 : 20000 });
            await page.waitForTimeout(250);
          } catch (e: any) { out.notes.push(`${s.id}: ${String(e.message).split('\n')[0]}`); continue; }
          const results: StoryCache['results'] = [];
          for (const c of comps) {
            const found: { key: string; styles: Styles; idx: number }[] = await page.evaluate(`(() => {
              const read = ${READ_STYLE};
              const els = Array.from(document.querySelectorAll('[data-slot="${c.slot}"]'));
              const seen = new Set(); const out = [];
              els.forEach((el, idx) => {
                const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
                if (el.matches(':disabled,[aria-disabled="true"],[data-disabled]')) return;
                const key = (el.getAttribute('data-variant') || '${c.defaults?.variant ?? 'default'}') + '/' + (el.getAttribute('data-size') || '${c.defaults?.size ?? 'default'}');
                if (seen.has(key)) return; seen.add(key);
                el.setAttribute('data-dsa-r', String(idx));
                out.push({ key, styles: read(el), idx });
              });
              return out;
            })()`);
            for (const f of found) {
              const file = `${c.component}-${f.key.replace(/[^\w-]+/g, '_')}-${sha(s.id).slice(0, 6)}.png`;
              const shot = await shoot(page, `[data-dsa-r="${f.idx}"][data-slot="${c.slot}"]`, path.join(dir, file));
              results.push({ component: c.component, key: f.key, styles: f.styles, shot: shot ? file : undefined });
            }
          }
          out.stories[s.id] = { hash: hashFiles(inputsOf(s), tHash), files: inputsOf(s), results };
          measured++;
        }
      } finally { await browser.close(); }
    }
    // Assemble: stories in rank order, first story that shows a combination wins.
    for (const s of wanted) for (const r of out.stories[s.id]?.results ?? []) {
      const slot = (out.components[r.component] ??= {});
      if (!slot[r.key]) slot[r.key] = { styles: r.styles, shot: r.shot, story: s.id };
    }
  } finally { stop(); }
  const n = Object.values<any>(out.components).reduce((a: number, c: any) => a + Object.keys(c).length, 0);
  log(`Rendered ${n} variant × size combinations across ${Object.keys(out.components).length} components (${measured} stories measured, ${reused} reused).`);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(out, null, 1));
  return out;
}

/** Every component and look props the review proposes: each recommendation, each scored alternative, each decision. */
export async function wantedProposals(dataDir: string): Promise<Map<string, { use: string; props: Record<string, string> }>> {
  const { evals } = await latestEvals(dataDir);
  const out = new Map<string, { use: string; props: Record<string, string> }>();
  for (const e of evals) {
    for (const r of [e, e.decided?.decision, ...(e.alternatives ?? [])] as any[]) {
      if (r?.verdict === 'replace' && r.use) out.set(proposalKey(r.use, r.props), { use: r.use, props: lookProps(r.props) });
    }
  }
  return out;
}

/** Storybook URL args: `variant:ghost;size:sm`. Storybook drops values outside letters, digits, space, - and _, so those are left out. */
export const argsParam = (props: Record<string, string>) => Object.entries(props).filter(([, v]) => /^[\w -]+$/.test(v)).map(([k, v]) => `${k}:${v}`).join(';');

/**
 * Render each proposed replacement with its props set: open a story of the component with those props
 * as Storybook args and photograph the element. The element's data attributes (data-variant,
 * data-size…) confirm the props took; a story that ignores args yields its nearest rendering, marked
 * closest. Cached per proposal by the component's source and the token CSS, like rendered signatures.
 */
export async function renderProposals(opts: { root: string; config: Config; dataDir: string; log?: (m: string) => void; force?: boolean; storybook?: { url: string; dir?: string | undefined; storageState?: string | undefined; cookie?: string | undefined } }): Promise<{ rendered: number; reused: number; exact: number }> {
  const log = opts.log ?? (() => {});
  const sigFile = path.join(opts.dataDir, 'signatures.json');
  if (!fs.existsSync(sigFile)) throw new Error('No signatures yet. Run "dsa run" first.');
  const sigs: any[] = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
  const sigOf = (use: string) => sigs.find(c => c.component === use && c.slot && c.file);
  const want = await wantedProposals(opts.dataDir);
  const prev = opts.force ? {} : readProposals(opts.dataDir);
  const tHash = tokensHash(opts.root, opts.config);
  const hashOf = (use: string) => { const s = sigOf(use); return s ? hashFiles([s.file], tHash) : `none:${tHash}`; };
  const items: Record<string, Proposal> = {};
  const todo: [string, { use: string; props: Record<string, string> }][] = [];
  for (const [k, p] of want) {
    const c = prev[k];
    if (c && c.hash === hashOf(p.use) && (!c.shot || fs.existsSync(path.join(opts.dataDir, 'rendered', c.shot)))) items[k] = c; else todo.push([k, p]);
  }
  const reused = Object.keys(items).length;
  const write = () => {
    fs.mkdirSync(path.join(opts.dataDir, 'rendered'), { recursive: true });
    fs.writeFileSync(path.join(opts.dataDir, 'rendered', 'proposals.json'), JSON.stringify({ takenAt: new Date().toISOString(), items }, null, 1));
  };
  const exactCount = () => Object.values(items).filter(p => p.check === 'exact').length;
  if (!todo.length) { write(); log(`Proposed components: ${reused} rendered with their props (all cached).`); return { rendered: 0, reused, exact: exactCount() }; }

  let sb = opts.storybook, stop = () => {};
  if (!sb) { const started = await startStorybook(opts.root, opts.config, log); sb = started; stop = started.stop; }
  const dir = path.join(opts.dataDir, 'rendered');
  fs.mkdirSync(dir, { recursive: true });
  let rendered = 0;
  try {
    const index: any = await storyIndex(sb.url, sb.cookie);
    const stories = Object.values<any>(index.entries ?? index.stories ?? {}).filter(s => s.type !== 'docs' && s.importPath);
    // Args-driven stories (Default, Playground), then ones showing many combinations, then the rest.
    const rank = (s: any) => (/default|playground|basic|primary/i.test(s.name) ? 0 : /all|variant|size|matrix|gallery|overview/i.test(s.name) ? 1 : 2);
    const stemOf = (f: string) => path.basename(f).split('.')[0]!.toLowerCase();
    log(`Proposed components: ${todo.length} to render with their props, ${reused} cached.`);
    const pw = await ensureBrowser(log);
    const browser = await pw.chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, ...(sb.storageState ? { storageState: sb.storageState } : {}) });
    const order: Record<Proposal['check'], number> = { exact: 0, unverified: 1, closest: 2, none: 3 };
    try {
      for (const [k, p] of todo) {
        const s = sigOf(p.use);
        if (!s) { items[k] = { ...p, check: 'none', note: `No ${p.use} signature with a data-slot to find it by in Storybook.`, hash: hashOf(p.use) }; continue; }
        const candidates = stories.filter(x => stemOf(x.importPath) === stemOf(s.file)).sort((a, b) => rank(a) - rank(b)).slice(0, 8);
        if (!candidates.length) { items[k] = { ...p, check: 'none', note: `No story for ${p.use} (${path.basename(s.file)}).`, hash: hashOf(p.use) }; continue; }
        const args = argsParam(p.props);
        const hasProps = Object.keys(p.props).length > 0;
        // First every story as its authors wrote it: one that already shows these props shows them with real content
        // (an icon in an icon button). Then the args-driven stories with the props set, whose content is the story default.
        const attempts = [...candidates.map(st => ({ st, set: false })), ...(hasProps ? candidates.filter(st => rank(st) === 0).map(st => ({ st, set: true })) : [])];
        let best: Proposal | null = null;
        // An icon-size proposal set through args holds the story's default label; give it the system's own icon, taken from any story where this component holds one.
        const iconSize = /icon/i.test(p.props.size ?? '');
        let icon: { html: string; story: string } | null = null;
        for (const { st, set } of attempts) {
          try {
            await page.goto(new URL(`iframe.html?id=${encodeURIComponent(st.id)}&viewMode=story${set && args ? `&args=${encodeURIComponent(args)}` : ''}`, sb.url).toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForFunction(`(() => { const r = document.querySelector('#storybook-root, #root'); return r && r.children.length > 0; })()`, null, { timeout: rendered === 0 ? 90000 : 20000 });
            // Storybook 8+ ignores URL args inside the preview frame; its channel (what Controls uses) sets them on any version.
            if (set) {
              await page.evaluate(`window.__STORYBOOK_ADDONS_CHANNEL__ && window.__STORYBOOK_ADDONS_CHANNEL__.emit('updateStoryArgs', { storyId: ${JSON.stringify(st.id)}, updatedArgs: ${JSON.stringify(p.props)} })`);
              await page.waitForTimeout(600);
            }
            await page.waitForTimeout(250);
          } catch { continue; }
          // Every visible element of the component, scored by how many props its data attributes confirm.
          const scan = (): Promise<{ idx: number; confirmed: number; contradicted: number; unknown: number; actual: Record<string, string>; styles: Styles }[]> => page.evaluate(`(() => {
            const read = ${READ_STYLE};
            const want = ${JSON.stringify(p.props)};
            return Array.from(document.querySelectorAll('[data-slot="${s.slot}"]')).map((el, idx) => {
              const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null;
              let confirmed = 0, contradicted = 0, unknown = 0; const actual = {};
              for (const [k, v] of Object.entries(want)) {
                const a = el.getAttribute('data-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()));
                if (a == null) unknown++; else if (a === v) confirmed++; else { contradicted++; actual[k] = a; }
              }
              el.setAttribute('data-dsa-p', String(idx));
              return { idx, confirmed, contradicted, unknown, actual, styles: read(el) };
            }).filter(Boolean);
          })()`);
          if (iconSize && !icon) {
            const html: string | null = await page.evaluate(`(() => { const i = document.querySelector('[data-slot="${s.slot}"] [data-slot=icon], [data-slot="${s.slot}"] svg'); return i ? i.outerHTML : null; })()`);
            if (html) icon = { html, story: st.id };
          }
          if (set && iconSize && icon) await page.evaluate(`(() => { for (const el of document.querySelectorAll('[data-slot="${s.slot}"]')) if (!el.querySelector('svg, [data-slot=icon]')) el.innerHTML = ${JSON.stringify(icon.html)}; })()`);
          let found = await scan();
          // A menu item or popover part renders only once its overlay is open: open the story's trigger and look again.
          if (!found.length) {
            const trigger = page.locator('[data-slot$="-trigger"]:visible').first();
            if (await trigger.count()) { await trigger.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(500); found = await scan(); }
          }
          // Where the component shows its props as attributes, an element that shows none is something else (a stock copy, a wrapper).
          const exposing = found.filter(f => f.confirmed + f.contradicted > 0);
          const top = (exposing.length ? exposing : found).sort((a, b) => a.contradicted - b.contradicted || b.confirmed - a.confirmed)[0];
          if (!top) continue;
          const check: Proposal['check'] = top.contradicted ? 'closest' : top.unknown ? 'unverified' : 'exact';
          if (best && order[best.check] <= order[check]) continue;
          const file = `proposal-${sha(k).slice(0, 12)}.png`;
          const shot = await shoot(page, `[data-dsa-p="${top.idx}"][data-slot="${s.slot}"]`, path.join(dir, file));
          const content = set ? (iconSize && icon ? `icon from ${icon.story}` : 'story default') : undefined;
          best = { ...p, check, shot: shot ? file : undefined, styles: top.styles, story: st.id, ...(content ? { content } : {}), ...(top.contradicted ? { actual: top.actual } : {}), hash: hashOf(p.use) };
          if (check === 'exact') break;
        }
        items[k] = best ?? { ...p, check: 'none', note: `${p.use} isn't visible in its stories (it may sit inside a closed overlay).`, hash: hashOf(p.use) };
        rendered++;
        if (rendered % 10 === 0) log(`  rendered ${rendered}/${todo.length}…`);
      }
    } finally { await browser.close(); }
  } finally { stop(); }
  write();
  log(`Proposed components: ${Object.keys(items).length} rendered with their props · ${exactCount()} exact (confirmed by the element's attributes).`);
  return { rendered, reused, exact: exactCount() };
}

async function shoot(page: any, sel: string, file: string) {
  try {
    const loc = page.locator(sel).first();
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
    const b = await loc.boundingBox();
    if (!b) return false;
    const pad = 6, vp = page.viewportSize(); // tight: Storybook grids put other variants right next to it
    const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
    await page.screenshot({ path: file, clip: { x, y, width: Math.min(vp.width - x, b.width + pad * 2), height: Math.min(vp.height - y, b.height + pad * 2) } });
    return true;
  } catch { return false; }
}

/** Storybook's story index, signed in when the live Storybook needs it. */
async function storyIndex(url: string, cookie?: string): Promise<any> {
  const r = await fetch(new URL('index.json', url), { headers: cookie ? { Cookie: cookie } : {} });
  if (!r.ok) throw new Error(`Storybook's index.json answered ${r.status} at ${url}${r.status === 401 || r.status === 403 || r.status === 404 ? ' (a private site needs live.storybook.auth from dsa login)' : ''}.`);
  return r.json();
}

export interface StartedStorybook { url: string; stop: () => void; source: string; dir?: string; storageState?: string | undefined; cookie?: string | undefined }

/**
 * Find the design system's Storybook. With live.storybook set, that one: the deployed URL (signed in
 * with its saved state) or the built folder that gets deployed. Otherwise from the host repo: run it
 * (fresh) or serve its static build.
 */
export async function startStorybook(root: string, config: Config, log: (m: string) => void): Promise<StartedStorybook> {
  const live = config.live?.storybook;
  if (live) {
    const s = await openSurface(live, root);
    log(`Storybook: ${s.how}.`);
    const cookie = s.deployed && s.storageState ? cookiesFor(s.url, [s.storageState]) : undefined;
    return { url: s.url, stop: s.stop, source: s.how, storageState: s.storageState, cookie };
  }
  const targets = resolveTargets(root, config);
  const sb = targets.find(t => /storybook/.test(JSON.stringify(readPkg(t.dir)?.scripts ?? {})) && /storybook dev/.test(readPkg(t.dir)?.scripts?.dev ?? readPkg(t.dir)?.scripts?.storybook ?? ''));
  const staticDir = sb ? path.join(sb.dir, 'storybook-static') : null;
  if (config.rendered?.useStatic && staticDir && fs.existsSync(path.join(staticDir, 'index.json'))) return { ...(await serveStatic(staticDir)), source: 'static build', dir: sb!.dir };
  if (sb) {
    const plan = detectApp(sb, config);
    if (!('reason' in plan)) {
      try {
        log(`Starting ${sb.name} (${plan.how}) for rendered signatures…`);
        const app = await startApp(plan, 180000);
        return { url: app.url, stop: app.stop, source: 'storybook dev', dir: sb.dir };
      } catch (e: any) { log(`  ${String(e.message).split('\n')[0]}`); }
    }
  }
  if (staticDir && fs.existsSync(path.join(staticDir, 'index.json'))) {
    const age = Math.round((Date.now() - fs.statSync(path.join(staticDir, 'index.json')).mtimeMs) / 864e5);
    log(`Using the static Storybook build (${age} day${age === 1 ? '' : 's'} old); rebuild it for current styles.`);
    const s = await serveStatic(staticDir);
    return { ...s, source: `static build, ${age} days old`, dir: sb!.dir };
  }
  throw new Error('No Storybook found in the host repo (a workspace with a "storybook dev" script, or a storybook-static build). Set live.storybook to a deployed URL or a built folder.');
}

const readPkg = (dir: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } };

/**
 * Re-measure only what changed. Without starting Storybook: if no story file was added or removed and
 * every cached story's inputs (story, component, stock layer, token CSS) hash the same, skip entirely.
 */
export async function renderIfStale(root: string, config: Config, dataDir: string, log: (m: string) => void = () => {}) {
  const prev: any = readRendered(dataDir);
  if (prev?.stories && prev.storyFiles) {
    const tHash = tokensHash(root, config);
    const filesNow = storyFiles(root, config);
    const sameFiles = JSON.stringify(filesNow) === JSON.stringify(prev.storyFiles);
    const changed = Object.entries<any>(prev.stories).filter(([, c]) => hashFiles(c.files, tHash) !== c.hash).length;
    if (sameFiles && !changed && prev.tokensHash === tHash) { log(`Storybook measurements up to date (${Object.keys(prev.stories).length} stories cached).`); return; }
    log(`Storybook: ${changed} changed stor${changed === 1 ? 'y' : 'ies'}${sameFiles ? '' : ', story files added or removed'}${prev.tokensHash !== tHash ? ', token CSS changed' : ''}; re-measuring those.`);
  }
  await renderSignatures({ root, config, dataDir, log });
}
