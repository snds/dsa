import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BLANK_INSET, capByEvidence, cardPicks, decodePng, isBlank, latestEvals, lookProps, ownKey, ownOf, ownText, proposalKey, readProposals, readRendered, resolveTargets, type Config, type OwnContent, type Proposal, type RenderedSet, type Styles } from '@snds/dsa/engine';

import { cookiesFor, openSurface, serveStatic } from '@snds/dsa';
import { detectApp, ensureBrowser, startApp } from './apps.js';
import { harnessUrlFor, iconFile, openHarness, staleDeps, startHarness, type Harness } from './harness.js';

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
    fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, textDecoration: cs.textDecorationLine,
    boxShadow: cs.boxShadow === 'none' ? 'none' : 'shadow', gap: cs.columnGap,
    surface: (() => { for (let p = el.parentElement; p; p = p.parentElement) { const b = getComputedStyle(p).backgroundColor; const m = b.match(/[\\d.]+/g); if (m && (m.length < 4 || Number(m[3]) > 0.98)) return b; } return ''; })(),
  };
}`;

/** How long one drawing may take before its page counts as stuck (`rendered.drawSeconds`). */
const DRAW_SECONDS = 30;
/** The first drawing on a page also waits for its server to build what it needs, so it gets this many times as long. */
const FIRST_DRAW = 5;
/** A page that's opening has limits on each step, but not on the calls between them. */
const OPEN_MS = 300_000;
const CLOSE_MS = 5_000;
const SAVE_EVERY = 10;
/** Raised when what a drawing must get right changes, so old drawings are looked at again. */
const CHECKED = 5;
/** What a whole structure says when it's drawn empty, or as its story wrote it, instead of with an element's content. */
const DRAWN_EMPTY = "its rows come from data the scan couldn't read, so it's drawn empty";
const EXAMPLE = "an example of the component, not this element's content";
/** A drawing holding these is a whole structure: one element's words or icon can't stand in for what's inside it. */
const STRUCTURE = 'table, thead, tbody, tr, ul, ol, dl, [role=grid], [role=tree], [role=tablist], [role=menu], [role=listbox]';

/** What `withinLimit` gives back when the work didn't finish in time. */
export const STUCK = Symbol('stuck');

/**
 * The work's answer, or STUCK if it's still going after `ms`. Playwright's `page.evaluate` has no timeout, so a
 * page looping forever would otherwise hold the run forever. The late work stops when its page closes.
 */
export async function withinLimit<T>(work: () => Promise<T>, ms: number): Promise<T | typeof STUCK> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof STUCK>(r => { timer = setTimeout(() => r(STUCK), ms); });
  try { return await Promise.race([work(), late]); } finally { clearTimeout(timer); }
}

/** Close something that may be stuck. False only if it never answered: a close that fails left nothing open. */
async function closed(close: () => Promise<unknown>, ms = CLOSE_MS): Promise<boolean> {
  return (await withinLimit(close, ms).catch(() => undefined)) !== STUCK;
}

/**
 * Get a clean page in place of a stuck one. A stuck renderer may not answer a close, so that has a limit too;
 * then the whole browser goes, and every page it held is opened again.
 */
export async function replaceStuck<B extends { close: () => Promise<unknown> }>(o: { page: { close: (a?: any) => Promise<unknown> } | null | undefined; browser: B; launch: () => Promise<B>; open: (b: B) => Promise<void>; openAll: (b: B) => Promise<void>; log: (m: string) => void; closeMs?: number }): Promise<B> {
  if (!o.page || await closed(() => o.page!.close({ runBeforeUnload: false }), o.closeMs)) {
    try { await o.open(o.browser); return o.browser; } catch { /* the browser itself has gone: a new one */ }
  }
  o.log("  A stuck page wouldn't close, so the browser was restarted.");
  if (!(await closed(() => o.browser.close(), o.closeMs))) o.log("  The old browser wouldn't close either, so it was left behind. It goes when this run ends.");
  const browser = await o.launch();
  await o.openAll(browser);
  return browser;
}

/** A drawing stopped for taking too long, named in the render log. */
export interface StuckDraw { key: string; use: string; where: string[]; from: string; seconds: number }

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
      let browser = await pw.chromium.launch();
      const openPage = (b: any) => b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, ...(storageState ? { storageState } : {}) });
      let page = await openPage(browser);
      const limit = (opts.config.rendered?.drawSeconds ?? DRAW_SECONDS) * 1000;
      try {
        const started = Date.now();
        const budget = (opts.config.rendered?.maxMinutes ?? 8) * 60000;
        let n = 0;
        for (const s of todo) {
          n++;
          if (Date.now() - started > budget) { out.notes.push(`Stopped after ${n - 1} of ${todo.length} stories (rendered.maxMinutes); the rest are measured next run.`); log(`  time budget reached after ${n - 1} stories`); break; }
          if (n === 1 || n % 10 === 0 || n === todo.length) log(`  measuring stories ${n}/${todo.length}…`);
          const comps = byStem.get(path.basename(s.importPath).replace(/\.stories\.tsx?$/, ''))!;
          const storyPage = page;
          const ms = limit * (n === 1 ? FIRST_DRAW : 2);
          const measuredStory = await withinLimit(async () => {
            const page = storyPage;
            try {
              // Storybook dev keeps connections open (HMR), so "network idle" never comes: wait for the story to render instead.
              await page.goto(new URL(`iframe.html?id=${encodeURIComponent(s.id)}&viewMode=story`, url).toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
              await page.waitForFunction(`(() => { const r = document.querySelector('#storybook-root, #root'); return r && r.children.length > 0; })()`, null, { timeout: n === 1 ? 90000 : 20000 });
              await page.waitForTimeout(250);
            } catch (e: any) { out.notes.push(`${s.id}: ${String(e.message).split('\n')[0]}`); return null; }
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
            return results;
          }, ms);
          if (measuredStory === STUCK) {
            out.notes.push(`${s.id}: stopped after ${ms / 1000} seconds. It may be stuck in a loop.`);
            log(`  Stopped after ${ms / 1000} seconds, so not measured: story ${s.id}.`);
            let fresh: any = null;
            browser = await replaceStuck({ page, browser, launch: () => pw.chromium.launch(), open: async b => { fresh = await openPage(b); }, openAll: async b => { fresh = await openPage(b); }, log });
            page = fresh;
            continue;
          }
          if (!measuredStory) continue;
          out.stories[s.id] = { hash: hashFiles(inputsOf(s), tHash), files: inputsOf(s), results: measuredStory };
          measured++;
        }
      } finally { await closed(() => browser.close()); }
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

/**
 * Every component and look props the review proposes: each card's own pick (with the size it auto-picks,
 * which may be one no evaluation named), each recommendation, each scored alternative, each decision.
 * The card's pick is also wanted with each element's own content (its words, accessible name and icon),
 * keyed by that content, so the proposal shows the element as it would be, not a story's sample.
 */
/**
 * What a render says about its drawings, every time, zero included: how many the system's styles didn't
 * reach and how many miss what their element holds, each with the elements it caught.
 */
export function drawingReport(items: Record<string, Proposal>, want: Map<string, Wanted>, source?: { failed: number; first?: string | undefined; reloads?: number | undefined; stuck?: StuckDraw[] | undefined } | null): string[] {
  const name = (k: string) => { const p = items[k]!, w = want.get(k); const props = Object.entries(p.props ?? {}).map(([a, b]) => `${a}=${b}`).join(' '); return `${p.use}${props ? ` ${props}` : ''} (${(w?.where ?? []).slice(0, 2).join(', ') || 'no element'})`; };
  const named = (keys: string[]) => (keys.length ? `: ${keys.slice(0, 8).map(name).join('; ')}${keys.length > 8 ? `; and ${keys.length - 8} more` : ''}` : '');
  const keys = Object.keys(items);
  const measured = keys.filter(k => items[k]!.styles);
  const bare = keys.filter(k => items[k]!.unstyled);
  const lost = keys.filter(k => items[k]!.innerLost);
  const carried = keys.filter(k => items[k]!.inner);
  return [
    `  Without the system's styles (unstyled): ${bare.length} of ${measured.length} drawings${named(bare)}.${bare.length ? " They need evidence, not a decision. Check the system's Storybook preview loads its stylesheet." : ''}`,
    `  Inner content: ${carried.length} drawn with what their element holds besides its words, ${lost.length} without it${named(lost)}.${lost.length ? ' Those need evidence, not a decision.' : ''}`,
    ...(source?.failed ? [`  From the system's source: ${source.failed} couldn't be drawn, so stories were tried. First reason: ${source.first ?? 'none given'}`] : []),
    ...(source?.reloads ? [`  The drawing page was reloaded ${source.reloads} time${source.reloads === 1 ? '' : 's'} because Vite rebuilt its dependencies during the run.`] : []),
    ...failureReasons(items),
    `  Stopped for taking too long: ${source?.stuck?.length ?? 0} drawing${source?.stuck?.length === 1 ? '' : 's'}.${source?.stuck?.length ? ' Each one may be stuck in a loop:' : ''}`,
    ...(source?.stuck ?? []).map(d => `    ${d.key} · ${d.use} · from ${d.from}, after ${d.seconds} seconds · ${items[d.key]?.shot ? 'drawn another way' : 'not drawn'}${d.where.length ? ` · ${d.where.slice(0, 2).join(', ')}` : ''}`),
  ];
}

/** Why the proposals with no picture have none, most common first, each reason with its count. */
function failureReasons(items: Record<string, Proposal>): string[] {
  const counts = new Map<string, number>();
  for (const p of Object.values(items)) {
    if (p.shot) continue;
    const why = (p.note ?? 'no reason given').split(p.use).join('It');
    counts.set(why, (counts.get(why) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([why, n]) => `  No picture (${n}): ${why}`);
}

/** The summary of a render: how many proposals there are, and how many of them were actually drawn. */
export function drawnSummary(items: Record<string, Proposal>): string {
  const all = Object.values(items);
  const drawn = all.filter(p => p.shot).length;
  const exact = all.filter(p => p.shot && p.check === 'exact').length;
  const fromSource = all.filter(p => p.shot && p.via === 'source' && p.check === 'exact').length;
  return `Proposed components: ${drawn} of ${all.length} drawn with their props · ${all.length - drawn} with no picture · ${exact} exact (confirmed by the element's attributes or classes)${fromSource ? ` · ${fromSource} drawn from the system's source` : ''}`;
}

/**
 * Did the system's stylesheet reach this drawing? A browser's defaults mean it didn't: a serif page font,
 * or a button's stock outset border and 13.33 px Arial.
 */
export function unstyledLook(s: Styles | undefined): boolean {
  if (!s) return false;
  const font = String((s as any).fontFamily ?? '').replace(/["']/g, '').split(',')[0]!.trim().toLowerCase();
  return /^(times|times new roman|serif|ui-serif)$/.test(font) || (s as any).borderStyle === 'outset' || (font === 'arial' && (s as any).fontSize === '13.3333px');
}

/**
 * A cached drawing can stand: its inputs hash the same, and, drawn with the element's own content, it
 * says which words it drew and they are the element's now. One made before drawings recorded their words
 * (no `text`) is drawn again, so the review can tell its words are the element's own.
 */
export function reusable(c: Proposal, p: Wanted, hash: string): boolean {
  if (c.hash !== hash) return false;
  // A drawing that failed is tried again: what failed may have been passing. The exception is a component
  // that isn't in the system's source, where nothing can change until its hash does.
  if (!c.shot && !c.hash.startsWith('none:')) return false;
  // A picture nobody looked at may be blank or hold another element's words: looked at first, by drawing again.
  if (c.shot && c.checked !== CHECKED) return false;
  // Drawn before drawings recorded their font, or without the system's styles: drawn again.
  if (c.styles && !c.styles.fontFamily) return false;
  if (c.unstyled || c.innerLost) return false;
  // Filling its container, and not yet drawn at the width of an element it's for.
  if (c.sizes && drawWidths(p.widths).some(w => !c.sizes!.some(s => s.for === w))) return false;
  return !(c.own && p.own && c.text !== ownText(p.own));
}

export interface Wanted { /** The elements it's drawn for, as file:line. */ where?: string[] | undefined; use: string; props: Record<string, string>; own?: OwnContent; /** The file the element's icon component comes from (when only its name is known), to draw that icon. */ iconFile?: string | undefined; /** How wide the elements it's drawn for are in their photos, in CSS px. */ widths?: number[] | undefined }

/** Widths within this many px of each other share a drawing. */
const WIDTH_NEAR = 4;
/** No more drawings than this of one component. */
const MAX_WIDTHS = 12;
/** Drawn at this width when no element says how wide it should be. */
const PLAIN_WIDTH = 320;
/** The widths to draw at, the typical one first: that one is the drawing's main picture. */
export function drawWidths(widths: number[] | undefined): number[] {
  const merged: number[] = [];
  for (const w of [...new Set(widths ?? [])].sort((a, b) => a - b)) if (!merged.length || w - merged[merged.length - 1]! > WIDTH_NEAR) merged.push(w);
  const kept = merged.length <= MAX_WIDTHS ? merged : Array.from({ length: MAX_WIDTHS }, (_, i) => merged[Math.round((i * (merged.length - 1)) / (MAX_WIDTHS - 1))]!);
  const typical = kept[Math.floor(kept.length / 2)];
  return typical === undefined ? [] : [typical, ...kept.filter(w => w !== typical)];
}

export async function wantedProposals(dataDir: string, threshold?: number, root?: string): Promise<Map<string, Wanted>> {
  const { evals } = await latestEvals(dataDir);
  let shots: Record<string, any> = {};
  try { shots = JSON.parse(fs.readFileSync(path.join(dataDir, 'shots', 'index.json'), 'utf8')).shots ?? {}; } catch { /* no screenshots yet */ }
  // What each card proposes depends on the confidence cap (a held element joins a question, and a question's
  // auto-pick depends on who is in it), and the cap depends on what's drawn. Want both states' picks: as the
  // elements stand now, and with every cap lifted, which is where drawing them all leads.
  const picks = new Map<string, any[]>();
  const uncapped = evals.map((e: any) => (e.evidenceCap ? { ...e, confidence: e.evidenceCap.from, needsHuman: false } : e));
  for (const list of [evals, uncapped]) for (const c of cardPicks(dataDir, list, threshold)) for (const id of c.ids) picks.set(id, [...(picks.get(id) ?? []), c.auto]);
  const out = new Map<string, Wanted>();
  let icon: string | undefined;
  let at: string | undefined;
  let width: number | undefined;
  const add = (r: any, own?: OwnContent | null) => {
    if (r?.verdict !== 'replace' || !r.use) return;
    const put = (k: string, w: Wanted) => {
      const widths = [...new Set([...(out.get(k)?.widths ?? []), ...(width ? [width] : [])])];
      out.set(k, { ...w, where: [...new Set([...(out.get(k)?.where ?? []), ...(at ? [at] : [])])], ...(widths.length ? { widths } : {}) });
    };
    if (!out.has(proposalKey(r.use, r.props))) put(proposalKey(r.use, r.props), { use: r.use, props: lookProps(r.props) });
    else put(proposalKey(r.use, r.props), out.get(proposalKey(r.use, r.props))!);
    if (own) put(ownKey(r.use, r.props, own), { use: r.use, props: lookProps(r.props), own, ...(icon ? { iconFile: icon } : {}) });
  };
  for (const e of evals) {
    if (e.exception) continue;
    const own = ownOf(e, shots[e.id]);
    at = `${e.file}:${e.line}`;
    // A photo that shows nothing says nothing about how wide the element is.
    width = !shots[e.id]?.blank && shots[e.id]?.box?.w >= 1 ? Math.round(shots[e.id].box.w) : undefined;
    icon = own?.iconName && root ? iconFile(root, e.file, own.iconName) ?? undefined : undefined;
    for (const p of picks.get(e.id) ?? []) add(p, own);
    // With no clear proposal, its candidates are what a person judges: drawn with its own content too.
    // So is the part a whole's copy holds: one small button of a host's sidebar is compared with that part.
    const noProposal = e.verdict !== 'replace' || (picks.get(e.id) ?? []).some((p: any) => p?.verdict !== 'replace');
    for (const r of [e, e.decided?.decision, ...(e.alternatives ?? [])] as any[]) add(r, r === e || r === e.decided?.decision || noProposal || e.role === 'host-copy' ? own : null);
  }
  return out;
}

/**
 * Draw until what the cards propose is drawn. Drawing changes the evidence, the evidence changes the cap, and
 * the cap changes which question an element is in, so what its card proposes: one render before the last
 * cap left cards pointing at proposals never drawn with their element's own content (they showed the
 * story's sample instead). Cap, then draw what's newly wanted, until nothing is (at most `rounds` times).
 * Drawings are cached, so a settled run opens nothing. Returns the rounds that drew something.
 */
export async function settleProposals(opts: Parameters<typeof renderProposals>[0], deps: { render?: (o: Parameters<typeof renderProposals>[0]) => Promise<unknown>; cap?: (dataDir: string, threshold: number) => Promise<number>; want?: typeof wantedProposals; rounds?: number } = {}): Promise<number> {
  const render = deps.render ?? renderProposals;
  const cap = deps.cap ?? capByEvidence;
  const wanted = deps.want ?? wantedProposals;
  const th = opts.config.review?.threshold ?? 0.9;
  let drew = 0;
  for (let i = 0; i < (deps.rounds ?? 4); i++) {
    await cap(opts.dataDir, th);
    const want = await wanted(opts.dataDir, opts.config.review?.threshold);
    const have = readProposals(opts.dataDir);
    if ([...want.keys()].every(k => have[k])) return drew;
    await render(opts);
    drew++;
  }
  await cap(opts.dataDir, th);
  return drew;
}

/** Storybook URL args: `variant:ghost;size:sm`. Storybook drops values outside letters, digits, space, - and _, so those are left out. */
export const argsParam = (props: Record<string, string>) => Object.entries(props).filter(([, v]) => /^[\w -]+$/.test(v)).map(([k, v]) => `${k}:${v}`).join(';');

/**
 * Draw each proposed replacement with its props set and the element's own content.
 *
 * From the system's own source first (harness.ts): its component mounted with the proposal's props and the
 * element's words and icon, inside what its Storybook preview adds (its CSS, providers). No story needed.
 * Then, for what that doesn't draw exactly, from its stories: one already showing these props, or one
 * driven by args. Either way the props are confirmed on the drawn element: its data attributes (data-variant,
 * data-size), else the classes its cva adds for each value. A drawing that ignores the props is the
 * closest; one whose props can't be read either way is unverified. Cached per proposal by the component's
 * source and the token CSS, like rendered signatures.
 */
export async function renderProposals(opts: { root: string; config: Config; dataDir: string; log?: (m: string) => void; force?: boolean; storybook?: { url: string; dir?: string | undefined; storageState?: string | undefined; cookie?: string | undefined } }): Promise<{ rendered: number; reused: number; exact: number }> {
  const log = opts.log ?? (() => {});
  const sigFile = path.join(opts.dataDir, 'signatures.json');
  if (!fs.existsSync(sigFile)) throw new Error('No signatures yet. Run "dsa run" first.');
  const sigs: any[] = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
  const sigOf = (use: string) => sigs.find(c => c.component === use && c.slot && c.file);
  const want = await wantedProposals(opts.dataDir, opts.config.review?.threshold, opts.root);
  const prev = opts.force ? {} : readProposals(opts.dataDir);
  const tHash = tokensHash(opts.root, opts.config);
  const hashOf = (use: string) => { const s = sigOf(use); return s ? hashFiles([s.file], tHash) : `none:${tHash}`; };
  const items: Record<string, Proposal> = {};
  const todo: [string, Wanted][] = [];
  for (const [k, p] of want) {
    const c = prev[k];
    if (c && reusable(c, p, hashOf(p.use)) && (!c.shot || fs.existsSync(path.join(opts.dataDir, 'rendered', c.shot)))) items[k] = c; else todo.push([k, p]);
  }
  const reused = Object.keys(items).length;
  const write = () => {
    fs.mkdirSync(path.join(opts.dataDir, 'rendered'), { recursive: true });
    // Whole or not at all: a run killed mid-save keeps the last save, and the next run picks up from it.
    const file = path.join(opts.dataDir, 'rendered', 'proposals.json');
    fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify({ takenAt: new Date().toISOString(), items }, null, 1));
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
  };
  const exactCount = () => Object.values(items).filter(p => p.check === 'exact').length;
  if (!todo.length) { write(); log(`${drawnSummary(items)} (all cached).`); for (const l of drawingReport(items, want)) log(l); return { rendered: 0, reused, exact: exactCount() }; }

  const dir = path.join(opts.dataDir, 'rendered');
  fs.mkdirSync(dir, { recursive: true });
  log(`Proposed components: ${todo.length} to render with their props, ${reused} cached.`);
  const pw = await ensureBrowser(log);
  let browser = await pw.chromium.launch();
  let rendered = 0;
  const limit = (opts.config.rendered?.drawSeconds ?? DRAW_SECONDS) * 1000;
  // The system's own source: started once, when something needs drawing.
  let harness: Harness | null = null, hpage: any = null, harnessTried = false, sourceWarm = false;
  const dropHarness = async (why: string) => { log(why); await withinLimit(() => (harness as Harness | null)?.stop() ?? Promise.resolve(), CLOSE_MS).catch(() => {}); harness = null; hpage = null; };
  const openSource = async (b: any) => {
    hpage = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    if ((await withinLimit(() => openHarness(hpage, harness!), OPEN_MS)) !== true) { await closed(() => hpage.close({ runBeforeUnload: false })); await dropHarness("  Proposals: the drawing page didn't load; drawing from its stories."); }
  };
  const source = async () => {
    if (harnessTried) return harness;
    harnessTried = true;
    try { harness = await startHarness(opts.root, opts.config, sigs.filter(c => c.file).map(c => c.file), log); } catch (e: any) { log(`  Proposals: the system's source didn't start for drawing (${String(e?.message ?? e).split('\n')[0]}); drawing from its stories.`); harness = null; }
    if (harness) await openSource(browser);
    return harness;
  };
  // Its stories: started only when the source didn't draw something exactly.
  let sbs: { url: string; stories: any[]; page: any; stop: () => void; open: (b: any) => Promise<any>; warm: boolean } | null = null, sbWhy: string | null = null;
  const storybook = async () => {
    if (sbs || sbWhy) return sbs;
    try {
      let sb = opts.storybook, stop = () => {};
      if (!sb) { const started = await startStorybook(opts.root, opts.config, log); sb = started; stop = started.stop; }
      const index: any = await storyIndex(sb.url, sb.cookie);
      const stories = Object.values<any>(index.entries ?? index.stories ?? {}).filter(st => st.type !== 'docs' && st.importPath);
      const open = (b: any) => b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, ...(sb!.storageState ? { storageState: sb!.storageState } : {}) });
      sbs = { url: sb.url, stories, page: await open(browser), stop, open, warm: false };
    } catch (e: any) { sbWhy = String(e?.message ?? e).split('\n')[0]!; log(`  Proposals: no stories to draw from (${sbWhy}).`); }
    return sbs;
  };
  let srcFailed = 0, srcFirst: string | undefined;
  const fresh: FreshDraw = { reloads: 0, gaveUp: new Set() };
  const stuck: StuckDraw[] = [];
  // A clean page in place of one that stopped answering: the rest of the run carries on with it.
  const renew = async (which: 'source' | 'story') => {
    const s0 = sbs as NonNullable<typeof sbs> | null;
    browser = await replaceStuck({
      page: which === 'source' ? hpage : s0?.page, browser, launch: () => pw.chromium.launch(), log,
      open: async b => { if (which === 'source') await openSource(b); else s0!.page = await s0!.open(b); },
      openAll: async b => { if (harness) await openSource(b); if (s0) s0.page = await s0.open(b); },
    });
  };
  const stopped = async (which: 'source' | 'story', k: string, p: Wanted, from: string, ms: number) => {
    stuck.push({ key: k, use: p.use, where: p.where ?? [], from, seconds: ms / 1000 });
    log(`  Stopped after ${ms / 1000} seconds: ${k} (${p.use}) from ${from}. It may be stuck in a loop.`);
    await renew(which);
    write();
  };
  const brokePage = (p: Wanted, via: Proposal['via'], e: any, hash: string): Proposal => ({ ...noOwn(p), check: 'none', via, note: `${p.use} couldn't be drawn: its page stopped working (${String(e?.message ?? e).split('\n')[0]}).`, hash });
  try {
    let n = 0;
    for (const [k, p] of todo) {
      if (++n % SAVE_EVERY === 0) write();
      const s = sigOf(p.use);
      if (!s) { items[k] = { ...noOwn(p), check: 'none', noSource: true, note: `${p.use} isn't a component dsa found in the design system's source, so it can't be drawn.`, hash: hashOf(p.use) }; continue; }
      const hash = hashOf(p.use);
      let best: Proposal | null = null;
      if (await source()) {
        const ms = sourceWarm ? limit : limit * FIRST_DRAW;
        sourceWarm = true;
        try {
          const drawn = await withinLimit(() => fromSource(hpage, harness!, fresh, s, p, k, dir, hash), ms);
          if (drawn === STUCK) {
            await stopped('source', k, p, "the system's source", ms);
            best = { ...noOwn(p), check: 'none', via: 'source', note: `${p.use} took longer than ${ms / 1000} seconds to draw from the system's source, so it was stopped. It may be stuck in a loop.`, hash };
          } else best = drawn;
        } catch (e) { await renew('source'); best = brokePage(p, 'source', e, hash); }
      }
      if (best && best.check === 'none') { srcFailed++; srcFirst ??= best.note; }
      // Done: exact, with the element's own content, or (with none of its own) without a stand-in label.
      // Drawn with its own content and saying which words: one drawn before renders kept their text is drawn again.
      const done = (b: Proposal | null) => Boolean(b && b.check === 'exact' && b.shot && (p.own ? b.own && typeof b.text === 'string' : !b.content) && !b.unstyled && !b.innerLost && !b.cut);
      if (!done(best) && (await storybook())) {
        const sb = sbs!, first = !sb.warm;
        sb.warm = true;
        try { best = pickBetter(best, await fromStories(sb, s, p, k, dir, hash, first, { ms: limit, stopped: (from, ms) => stopped('story', k, p, from, ms) })); }
        catch (e) { await renew('story'); best = pickBetter(best, brokePage(p, 'story', e, hash)); }
      }
      items[k] = best ?? { ...noOwn(p), check: 'none', ...(sbWhy ? { noSource: true } : {}), note: `${p.use} couldn't be drawn${sbWhy ? `: there's no Storybook to draw it from (${sbWhy})` : ''}.`, hash };
      rendered++;
      if (rendered % 10 === 0) log(`  rendered ${rendered}/${todo.length}…`);
    }
  } finally {
    write();
    await closed(() => browser.close());
    await withinLimit(() => (harness as Harness | null)?.stop() ?? Promise.resolve(), CLOSE_MS).catch(() => {});
    (sbs as { stop: () => void } | null)?.stop();
  }
  log(`${drawnSummary(items)}.`);
  for (const l of drawingReport(items, want, { failed: srcFailed, first: srcFirst, reloads: fresh.reloads, stuck })) log(l);
  return { rendered, reused, exact: exactCount() };
}

const ORDER: Record<Proposal['check'], number> = { exact: 0, unverified: 1, closest: 2, none: 3 };
/** What there is to look at: a drawing, else the component's story as written, else nothing. */
const picture = (p: Proposal) => (p.shot ? 0 : p.fallback ? 1 : 2);
/**
 * The better of two drawings. First, one with a picture: a flawed drawing says what's wrong with it and can
 * still be looked at, and one that failed has nothing to show. Then the styles and inner content, the surer
 * props, the element's own content, and no stand-in content.
 */
function pickBetter(a: Proposal | null, b: Proposal | null): Proposal | null {
  if (!a || !b) return a ?? b;
  const d = picture(a) - picture(b) || Number(a.content === DRAWN_EMPTY) - Number(b.content === DRAWN_EMPTY) || Number(Boolean(a.unstyled)) - Number(Boolean(b.unstyled)) || Number(Boolean(a.innerLost)) - Number(Boolean(b.innerLost)) || Number(Boolean(a.cut)) - Number(Boolean(b.cut)) || ORDER[a.check] - ORDER[b.check] || Number(Boolean(b.own)) - Number(Boolean(a.own)) || Number(Boolean(a.content)) - Number(Boolean(b.content));
  return d > 0 ? b : a;
}

/** Tags whose own words can't go inside them as text (rows come from data). */
const DATA_TAGS = /^(table|thead|tbody|tr|ul|ol|dl)$/;

/** Draw one proposal from the system's source in the harness page. */
async function fromSource(page: any, h: Harness, fresh: FreshDraw, s: any, p: Wanted, k: string, dir: string, hash: string): Promise<Proposal> {
  const dataTag = DATA_TAGS.test(s.tag ?? '');
  const icon = p.own?.iconName && p.iconFile ? { file: harnessUrlFor(p.iconFile), name: p.own.iconName } : null;
  // With no words of its own, it's drawn with none: that is the element (no stand-in label it doesn't have).
  const draw = (text: string | null) => drawFresh(page, h, fresh, { file: harnessUrlFor(s.file), name: s.component, props: p.props, text, icon, slot: s.slot, empty: true });
  const scan = (): Promise<Found[]> => run(page, SCAN, { slot: s.slot, want: p.props, classes: s.axisClasses ?? null });
  const text = dataTag ? null : p.own?.text ?? null;
  let r = await draw(text);
  if (!r.ok) return { ...noOwn(p), check: 'none', via: 'source', note: `${p.use} couldn't be drawn from the system's source: ${r.why}.`, hash };
  let found = await scan();
  // A whole structure holding one line of joined words reads as the element's and isn't: drawn without them.
  let whole = dataTag;
  const first = topOf(found);
  if (first && p.own && !dataTag && !severalBlocks(p) && await run<boolean>(page, HOLDS_STRUCTURE, { sel: `[data-dsa-p="${first.idx}"][data-slot="${s.slot}"]` })) {
    whole = true;
    if (text) { r = await draw(null); if (!r.ok) return { ...noOwn(p), check: 'none', via: 'source', note: `${p.use} couldn't be drawn from the system's source: ${r.why}.`, hash }; found = await scan(); }
  }
  const top = topOf(found);
  if (!top) return { ...noOwn(p), check: 'none', via: 'source', note: `${p.use} drew from the system's source, but nothing showed.`, hash };
  const check: Proposal['check'] = top.contradicted ? 'closest' : top.unknown ? 'unverified' : 'exact';
  const sel = `[data-dsa-p="${top.idx}"][data-slot="${s.slot}"]`;
  let own: { own: boolean; why?: string; inner?: boolean } | null = null;
  if (p.own) {
    if (whole) own = { own: false, why: DRAWN_EMPTY };
    else if (p.own.icon || p.own.inner?.html || isField(p)) own = await run<{ own: boolean; why?: string; inner?: boolean }>(page, INJECT_OWN, { sel, own: p.own }).catch(() => ({ own: false, why: 'its content could not be set' }));
    else {
      // Its words went in as children; an icon named in the source was imported and drawn beside them.
      const shown = await run<{ text: boolean; icon: boolean }>(page, SHOWN_OWN, { sel, text: p.own.text ?? null, label: p.own.ariaLabel ?? null });
      const iconOnly = !p.own.text;
      own = iconOnly && !shown.icon ? { own: false, why: p.own.iconName ? `the app's icon (${p.own.iconName}) couldn't be loaded, so none is drawn` : "stand-in icon: the app's own icon wasn't captured" } : shown.text ? { own: true } : { own: false, why: 'its words could not be set' };
    }
  }
  const file = `proposal-${sha(k).slice(0, 12)}.png`;
  const shot = await shoot(page, sel, path.join(dir, file));
  const seen = shot ? await lookAt(page, sel, path.join(dir, file), p, own) : { shows: false, why: "no picture could be taken" };
  if (!seen.shows) return { ...noOwn(p), check: 'none', via: 'source', note: `${p.use} drew from the system's source, but ${seen.why}.`, hash };
  if (seen.notOwn) own = { own: false, why: seen.notOwn };
  const content = own && !own.own && own.why ? own.why : undefined;
  const size = await sizedDrawing(page, sel, p, k, dir, file, own);
  return { ...noOwn(p), check, via: 'source', shot: file, ...size, ...(seen.notOwn ? {} : { checked: CHECKED }), styles: top.styles, ...(unstyledLook(top.styles) ? { unstyled: true } : {}), ...innerOf(p, own), ...(own?.own ? { own: true, text: ownText(p.own) } : {}), ...(content ? { content } : {}), ...(top.contradicted ? { actual: top.actual } : {}), hash };
}

/** Runs in the page: did the element's own words and icon show, and set its accessible name. */
/** What the proposal stores about the element's inner content: drawn with it, or without it. */
const innerOf = (p: Wanted, own: { own: boolean; inner?: boolean; example?: boolean } | null) => (!p.own?.inner || own?.example ? {} : own?.own && own.inner ? { inner: true } : { innerLost: true });
const isField = (p: Wanted) => p.own?.value != null || p.own?.placeholder != null;
/** The element is itself several blocks, copied whole: that copy keeps its structure. */
const severalBlocks = (p: Wanted) => Boolean(p.own?.inner?.html && p.own.inner.blocks > 1);
/** Runs in the page: does this drawing hold a whole structure, rows or a list? */
const HOLDS_STRUCTURE = `({ sel }) => { const el = document.querySelector(sel); return Boolean(el && (el.matches(${JSON.stringify(STRUCTURE)}) || el.querySelector(${JSON.stringify(STRUCTURE)}))); }`;

/**
 * Runs in the page: does the element's width come from its container? Half the room, and see. Says how the
 * width follows the room, so a width can be asked for. A popup outside the drawing's root has no room to change.
 * A wrapper with a width of its own (a family's frame, a story's) can hold it back: those are opened, and stay
 * open if that lets it follow the room.
 */
const FILLS = `({ sel }) => {
  const el = document.querySelector(sel), root = el && el.closest('#root, #storybook-root');
  if (!root) return null;
  const room = root.getBoundingClientRect().width;
  const follows = () => {
    const was = el.getBoundingClientRect().width;
    root.style.width = room / 2 + 'px';
    const then = el.getBoundingClientRect().width;
    root.style.width = '';
    const rate = (was - then) / (room / 2);
    return rate >= 0.4 ? { rate, rest: was - rate * room } : null;
  };
  const own = follows();
  if (own) return own;
  const opened = [];
  for (let n = el.parentElement; n && n !== root; n = n.parentElement) { opened.push([n, n.style.width, n.style.maxWidth]); n.style.width = '100%'; n.style.maxWidth = 'none'; }
  const held = opened.length ? follows() : null;
  if (!held) for (const [n, w, m] of opened) { n.style.width = w; n.style.maxWidth = m; }
  return held;
}`;
/** Runs in the page: give the drawing the room that makes the element this wide (null: back as it was). */
const SET_WIDTH = `({ sel, room }) => {
  const el = document.querySelector(sel), root = el && el.closest('#root, #storybook-root');
  if (!root) return null;
  root.style.width = room === null ? '' : room + 'px';
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
}`;
/**
 * In the page: are this element's words cut off? What decides is where they are drawn, not what it holds. Text
 * clipped by a box, squeezed to nothing, or further outside the element than `spill` is cut off. A picture
 * holds a margin around the element, so text a little past its edge still shows whole. A line counts as inside
 * when its middle is, since a line's box is taller than its letters. What's meant not to show doesn't count. With
 * `words` given, some text has to show, unless they're a label only for screen readers.
 */
const IS_CUT = `(el, words, spill) => {
  const NOT_WORDS = 'svg, style, script, select, textarea, [data-slot=icon], [aria-hidden=true], .material-symbols-outlined, .material-symbols-rounded, .material-icons, [data-dsa-mark]';
  let shown = false, forReaders = false;
  const field = el.matches('input, select, textarea') ? el : el.querySelector('input, select, textarea');
  if (field && !/^(checkbox|radio|range|color|file|hidden)$/.test(field.type || '')) {
    const said = field.tagName === 'SELECT' ? (field.selectedOptions[0]?.textContent || '') : (field.value || field.placeholder || '');
    if (said.trim()) {
      const cs = getComputedStyle(field), room = field.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (field.tagName === 'TEXTAREA') { if (field.value && field.scrollHeight > field.clientHeight + 1) return true; }
      else {
        const pen = document.createElement('canvas').getContext('2d');
        pen.font = cs.font;
        if (pen.measureText(said).width > room + 1) return true;
      }
      shown = true;
    }
  }
  const range = document.createRange();
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const t = walk.currentNode, at = t.parentElement;
    if (!(t.nodeValue || '').trim() || !at || at.closest(NOT_WORDS)) continue;
    if (!at.checkVisibility({ visibilityProperty: true })) continue;
    // A label only for screen readers: one pixel square and clipped, on purpose.
    let meantHidden = false;
    for (let n = at; n && n !== el.parentElement; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.position === 'absolute' && cs.overflow !== 'visible' && n.getBoundingClientRect().width <= 1) meantHidden = true; }
    if (meantHidden) { forReaders = true; continue; }
    range.selectNodeContents(t);
    const lines = Array.from(range.getClientRects());
    const all = range.getBoundingClientRect();
    if (!lines.length || all.width < 1 || all.height < 1) return true;
    for (let n = at; n && n !== el.parentElement; n = n.parentElement) {
      const clips = getComputedStyle(n).overflowX !== 'visible' || getComputedStyle(n).overflowY !== 'visible';
      if (n !== el && !clips) continue;
      const b = n.getBoundingClientRect();
      if (!b.width || !b.height) { if (n === el) continue; return true; }
      const past = clips ? 1 : spill;
      if (all.left < b.left - past || all.right > b.right + past) return true;
      if (lines.some(l => (l.top + l.bottom) / 2 < b.top - (clips ? 0 : spill) || (l.top + l.bottom) / 2 > b.bottom + (clips ? 0 : spill))) return true;
    }
    shown = true;
  }
  return Boolean(words && words.trim() && !shown && !forReaders);
}`;
/** What a picture holds past the element's edge (shoot's margin). */
const PICTURE_MARGIN = 6;
const CUT_NOW = `({ sel, words }) => { const el = document.querySelector(sel); return Boolean(el) && (${IS_CUT})(el, words, ${PICTURE_MARGIN}); }`;
/**
 * Runs in the page: make the element this wide, or as little wider as lets its words show. The room is searched,
 * since words can need more than they measure (padding, a slot beside them). With room to spare, words stay
 * inside the element. Still cut off in all the room there is, it stays there and says so.
 */
const FIT_WIDTH = `({ sel, rate, rest, width, words }) => {
  const el = document.querySelector(sel), root = el && el.closest('#root, #storybook-root');
  if (!root) return null;
  const check = ${IS_CUT};
  const isCut = (e, w) => check(e, w, 1);
  const at = (w) => { root.style.width = Math.max(1, (w - rest) / rate) + 'px'; };
  const read = (o) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, ...o }; };
  at(width);
  if (!isCut(el, words)) return read({});
  root.style.width = '';
  if (isCut(el, words)) return check(el, words, ${PICTURE_MARGIN}) ? read({ cut: true }) : read({ wider: true });
  let low = width, high = el.getBoundingClientRect().width;
  for (let i = 0; i < 12 && high - low > 1; i++) {
    const mid = (low + high) / 2;
    at(mid);
    if (isCut(el, words)) low = mid; else high = mid;
  }
  at(Math.ceil(high));
  return read({ wider: true });
}`;
/** Runs in the page: a control whose content is its words, with no words and nothing else in it? */
const BARE = `({ sel }) => {
  const el = document.querySelector(sel);
  return Boolean(el && el.matches('button:not([role]), a, [role=button], [role=link]') && !el.children.length && !(el.textContent || '').trim());
}`;

/**
 * A component that fills its container is as wide as the page it was drawn on, which says nothing about it.
 * Drawn again at the width of each element it's for, so a person compares like with like. A whole structure
 * keeps its room: squeezed to one element's width, a table is no longer an example of a table.
 */
async function sizedDrawing(page: any, sel: string, p: Wanted, k: string, dir: string, file: string, own: { own: boolean } | null): Promise<Pick<Proposal, 'fills' | 'sizes' | 'bare' | 'cut'>> {
  const bare = !p.own && await run<boolean>(page, BARE, { sel }).catch(() => false);
  const out = bare ? { bare: true } : {};
  const f = await run<{ rate: number; rest: number } | null>(page, FILLS, { sel }).catch(() => null);
  if (await run<boolean>(page, HOLDS_STRUCTURE, { sel }).catch(() => false)) return f ? { ...out, fills: true } : out;
  const words = own?.own && p.own ? ownText(p.own) ?? null : null;
  if (!f) return await run<boolean>(page, CUT_NOW, { sel, words }).catch(() => false) ? { ...out, cut: true } : out;
  const widths = drawWidths(p.widths);
  const sizes: NonNullable<Proposal['sizes']> = [];
  for (const [i, w] of (widths.length ? widths : [PLAIN_WIDTH]).entries()) {
    const box = await run<{ w: number; h: number; wider?: boolean; cut?: boolean } | null>(page, FIT_WIDTH, { sel, rate: f.rate, rest: f.rest, width: w, words }).catch(() => null);
    const shot = i === 0 ? file : `proposal-${sha(k).slice(0, 12)}-${w}.png`;
    if (box && await shoot(page, sel, path.join(dir, shot))) sizes.push({ for: w, shot, ...box });
    else if (i === 0) break; // the main picture stays as it was drawn, so no size may claim otherwise
  }
  await run(page, SET_WIDTH, { sel, room: null }).catch(() => {});
  return { ...out, fills: true, ...(sizes.length ? { sizes, ...(sizes[0]!.cut ? { cut: true } : {}) } : {}) };
}

/**
 * Runs in the page, once a drawing is on screen: can it be seen, and do the words that show equal the ones
 * it should hold? Marks and icons aren't words. Inner content is compared with what was put in, whose words
 * are the ones that showed in the app (the photo's own words can include text it kept hidden).
 */
const SHOWN = `({ sel, words, inner, field }) => {
  const el = document.querySelector(sel);
  if (!el) return { shows: false, why: 'it was gone by the time it was looked at' };
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { shows: false, why: 'it has no size' };
  if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return { shows: false, why: 'it sits off the page' };
  if (getComputedStyle(el).visibility !== 'visible') return { shows: false, why: "it's hidden, as an overlay part is when nothing opened it" };
  let op = 1;
  for (let n = el; n; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none') return { shows: false, why: "it's hidden, as an overlay part is when nothing opened it" }; op *= parseFloat(cs.opacity); }
  if (op < 0.1) return { shows: false, why: "it's fully see-through, as an overlay part is before it opens" };
  if (words === null) return { shows: true };
  // A field's words aren't text in it: what's typed, or its placeholder.
  const box = field && (el.matches('input, textarea') ? el : el.querySelector('input, textarea'));
  if (box) return (box.value || '') === (field.value || '') && (box.getAttribute('placeholder') || '') === (field.placeholder || '') ? { shows: true } : { shows: true, notOwn: 'the words in it are not its own' };
  const NOT_WORDS = 'svg, style, script, [data-slot=icon], [aria-hidden=true], .material-symbols-outlined, .material-symbols-rounded, .material-icons, [data-dsa-mark]';
  const seenIn = (root, live) => {
    const out = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const t = walk.currentNode, at = t.parentElement;
      if (!t.nodeValue || (at && at.closest(NOT_WORDS))) continue;
      if (live) { const cs = getComputedStyle(at); if (cs.visibility !== 'visible' || !at.getClientRects().length || /material|symbols|icons?\\b|phosphor|awesome/i.test(cs.fontFamily)) continue; }
      out.push(t);
    }
    return out;
  };
  const say = (nodes) => nodes.map(t => t.nodeValue).join('').replace(/\\s+/g, ' ').trim();
  const nodes = seenIn(el, true);
  const shown = say(nodes);
  let want = words;
  if (inner) { const t = document.createElement('template'); t.innerHTML = inner; want = say(seenIn(t.content, false)); }
  want = want.replace(/\\s+/g, ' ').trim();
  if (shown.slice(0, Math.max(80, want.length)).trim() !== want && shown.slice(0, 80).trim() !== want) return { shows: true, notOwn: want ? 'the words that show are not its own' : 'it shows words the element does not have' };
  if (!nodes.length) return { shows: true };
  // Words the colour of what's behind them: every layer down to the first solid one.
  const k = document.createElement('canvas'); k.width = k.height = 1;
  const g = k.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { g.clearRect(0, 0, 1, 1); g.fillStyle = 'rgba(0,0,0,0)'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); return Array.from(g.getImageData(0, 0, 1, 1).data); };
  const lum = (c) => { const f = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
  const at = nodes[0].parentElement;
  const ink = rgba(getComputedStyle(at).color);
  if (ink[3] < 26) return { shows: true, notOwn: 'its words are see-through' };
  let back = [255, 255, 255, 255];
  for (let n = at; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.backgroundImage !== 'none') return { shows: true };
    const b = rgba(cs.backgroundColor);
    if (b[3] > 230) { back = b; break; }
  }
  const a = lum(ink), b = lum(back);
  if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 1.25) return { shows: true, notOwn: 'its words are the same colour as what is behind them' };
  return { shows: true };
}`;

/**
 * Look at a drawing before believing it. Can it be seen, in the page and in its picture? And where it claims
 * the element's own words, are they what shows? `notOwn` says why not; a drawing that can't be seen isn't one.
 */
export async function lookAt(page: any, sel: string, file: string, p: Wanted, own: { own: boolean } | null): Promise<{ shows: boolean; why?: string; notOwn?: string }> {
  const claims = Boolean(p.own && own?.own);
  const seen = await run<{ shows: boolean; why?: string; notOwn?: string }>(page, SHOWN, { sel, words: claims ? ownText(p.own) : null, inner: claims ? p.own!.inner?.html ?? null : null, field: claims && isField(p) ? { value: p.own!.value ?? null, placeholder: p.own!.placeholder ?? null } : null }).catch(() => ({ shows: false, why: 'it could not be looked at' }));
  if (!seen.shows) return seen;
  try { if (isBlank(decodePng(fs.readFileSync(file)), null, 2, BLANK_INSET)) return { shows: false, why: 'its picture is blank' }; } catch { /* an image we can't read: keep it */ }
  return seen;
}

const SHOWN_OWN = `({ sel, text, label }) => {
  const el = document.querySelector(sel);
  if (!el) return { text: false, icon: false };
  if (label) el.setAttribute('aria-label', label);
  return { text: !text || (el.textContent || '').includes(text), icon: Boolean(el.querySelector('svg, [data-slot=icon], img')) };
}`;

/** Draw one proposal from the component's stories: one that shows these props as written, else one driven by args. */
async function fromStories(sb: { url: string; stories: any[]; page: any }, s: any, p: Wanted, k: string, dir: string, hash: string, first: boolean, guard: { ms: number; stopped: (from: string, ms: number) => Promise<void> }): Promise<Proposal> {
  // Args-driven stories (Default, Playground), then ones showing many combinations, then the rest.
  const rank = (x: any) => (/default|playground|basic|primary/i.test(x.name) ? 0 : /all|variant|size|matrix|gallery|overview/i.test(x.name) ? 1 : 2);
  const stemOf = (f: string) => path.basename(f).split('.')[0]!.toLowerCase();
  const candidates = sb.stories.filter(x => stemOf(x.importPath) === stemOf(s.file)).sort((a, b) => rank(a) - rank(b)).slice(0, 8);
  if (!candidates.length) return { ...noOwn(p), check: 'none', noSource: true, via: 'story', note: `${p.use} has no story to draw it from (${path.basename(s.file)}).`, hash };
  const args = argsParam(p.props);
  const hasProps = Object.keys(p.props).length > 0;
  // First every story as its authors wrote it: one that already shows these props shows them with real content
  // (an icon in an icon button). Then the args-driven stories with the props set, whose content is the story default.
  const attempts = [...candidates.map(st => ({ st, set: false })), ...(hasProps ? candidates.filter(st => rank(st) === 0).map(st => ({ st, set: true })) : [])];
  let best: Proposal | null = null;
  // An icon-size proposal set through args holds the story's default label; give it the system's own icon, taken from any story where this component holds one.
  const iconSize = /icon/i.test(p.props.size ?? '');
  let icon: { html: string; story: string } | null = null;
  let n = 0;
  // One story with its own time limit: true when this drawing needs no more. A stuck story ends the search here.
  const attempt = async (st: any, set: boolean): Promise<boolean> => {
    const page = sb.page;
    try {
      await page.goto(new URL(`iframe.html?id=${encodeURIComponent(st.id)}&viewMode=story${set && args ? `&args=${encodeURIComponent(args)}` : ''}`, sb.url).toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(`(() => { const r = document.querySelector('#storybook-root, #root'); return r && r.children.length > 0; })()`, null, { timeout: first && n++ === 0 ? 90000 : 20000 });
      // Storybook 8+ ignores URL args inside the preview frame; its channel (what Controls uses) sets them on any version.
      if (set) {
        await page.evaluate(`window.__STORYBOOK_ADDONS_CHANNEL__ && window.__STORYBOOK_ADDONS_CHANNEL__.emit('updateStoryArgs', { storyId: ${JSON.stringify(st.id)}, updatedArgs: ${JSON.stringify(p.props)} })`);
        await page.waitForTimeout(600);
      }
      await page.waitForTimeout(250);
    } catch { return false; }
    if (iconSize && !icon) {
      const html: string | null = await page.evaluate(`(() => { const i = document.querySelector('[data-slot="${s.slot}"] [data-slot=icon], [data-slot="${s.slot}"] svg'); return i ? i.outerHTML : null; })()`);
      if (html) icon = { html, story: st.id };
    }
    if (set && iconSize && icon) await page.evaluate(`(() => { for (const el of document.querySelectorAll('[data-slot="${s.slot}"]')) if (!el.querySelector('svg, [data-slot=icon]')) el.innerHTML = ${JSON.stringify(icon.html)}; })()`);
    const scan = (): Promise<Found[]> => run(page, SCAN, { slot: s.slot, want: p.props, classes: s.axisClasses ?? null });
    let found = await scan();
    // A menu item or popover part renders only once its overlay is open: open the story's trigger and look again.
    if (!found.length) {
      const trigger = page.locator('[data-slot$="-trigger"]:visible').first();
      if (await trigger.count()) { await trigger.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(500); found = await scan(); }
    }
    const top = topOf(found);
    if (!top) return false;
    const check: Proposal['check'] = top.contradicted ? 'closest' : top.unknown ? 'unverified' : 'exact';
    // A later story can still replace one as sure whose words turned out not to be the element's.
    if (best && ORDER[best.check] <= ORDER[check] && !(p.own && !best.own && best.check === check)) return false;
    const file = `proposal-${sha(k).slice(0, 12)}.png`;
    // The element's own words, name and icon in place of the story's: then the proposal is this element.
    const sel = `[data-dsa-p="${top.idx}"][data-slot="${s.slot}"]`;
    let own: { own: boolean; why?: string; inner?: boolean; example?: boolean } | null = p.own ? await run<{ own: boolean; why?: string; inner?: boolean; example?: boolean }>(page, INJECT_OWN, { sel, own: p.own }).catch(() => ({ own: false, why: 'its content could not be set' })) : null;
    if (own?.own) await page.waitForTimeout(120);
    const shot = await shoot(page, sel, path.join(dir, file));
    const seen = shot ? await lookAt(page, sel, path.join(dir, file), p, own) : { shows: false, why: 'no picture could be taken' };
    if (!seen.shows) return false;
    if (seen.notOwn) own = { own: false, why: seen.notOwn };
    const content = own?.own ? undefined : own?.why ? own.why : set ? (iconSize && icon ? `icon from ${icon.story}` : 'story default') : undefined;
    const size = await sizedDrawing(page, sel, p, k, dir, file, own);
    best = { ...noOwn(p), check, via: 'story', shot: file, ...size, ...(seen.notOwn ? {} : { checked: CHECKED }), styles: top.styles, ...(unstyledLook(top.styles) ? { unstyled: true } : {}), ...innerOf(p, own), story: st.id, ...(own?.example ? { example: true } : {}), ...(own?.own ? { own: true, text: ownText(p.own) } : {}), ...(content ? { content } : {}), ...(top.contradicted ? { actual: top.actual } : {}), hash };
    return check === 'exact' && (!p.own || Boolean(own?.own) || !seen.notOwn);
  };
  let tried = 0;
  for (const { st, set } of attempts) {
    const ms = guard.ms * (first && tried++ === 0 ? FIRST_DRAW : 1);
    const finished = await withinLimit(() => attempt(st, set), ms);
    if (finished === STUCK) {
      await guard.stopped(`story ${st.id}`, ms);
      return best ?? { ...noOwn(p), check: 'none', via: 'story', story: st.id, note: `${p.use} took longer than ${ms / 1000} seconds to draw from its story, so it was stopped. It may be stuck in a loop.`, hash };
    }
    if (finished) break;
  }
  if (best) return best;
  // Nothing to photograph with these props: show the component's first story as its authors wrote it, and say why.
  let fallback: string | undefined;
  const asWritten = await withinLimit(async () => {
    const page = sb.page;
    try {
      await page.goto(new URL(`iframe.html?id=${encodeURIComponent(candidates[0]!.id)}&viewMode=story`, sb.url).toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(400);
      const f = `fallback-${sha(k).slice(0, 12)}.png`;
      if (await shoot(page, '#storybook-root > *, #root > *', path.join(dir, f))) return f;
    } catch { /* no fallback */ }
    return undefined;
  }, guard.ms);
  if (asWritten === STUCK) await guard.stopped(`story ${candidates[0]!.id}`, guard.ms);
  else fallback = asWritten;
  return { ...noOwn(p), check: 'none', via: 'story', note: `${p.use} doesn't show in its stories: it may only appear inside something closed, like a menu or a dialog, and opening it didn't show it.${fallback ? ' Its story as written is shown instead.' : ''}`, story: candidates[0]!.id, ...(fallback ? { fallback } : {}), hash };
}

interface Found { idx: number; confirmed: number; contradicted: number; unknown: number; actual: Record<string, string>; styles: Styles }

/** Where the component shows its props, an element that shows none is something else (a stock copy, a wrapper). */
function topOf(found: Found[]): Found | undefined {
  const exposing = found.filter(f => f.confirmed + f.contradicted > 0);
  return (exposing.length ? exposing : found).sort((a, b) => a.contradicted - b.contradicted || b.confirmed - a.confirmed)[0];
}

/**
 * Runs in the page: every visible element of the component, with how many of the proposal's props it
 * confirms. A prop is read from its data attribute (data-variant, data-size), else from its classes: the
 * classes cva adds for that value all present, and no other value's.
 */
const SCAN = `({ slot, want, classes }) => {
  const read = ${READ_STYLE};
  const has = (el, t) => t.every((c) => el.classList.contains(c));
  return Array.from(document.querySelectorAll('[data-slot="' + slot + '"]')).map((el, idx) => {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null;
    let confirmed = 0, contradicted = 0, unknown = 0; const actual = {};
    for (const [k, v] of Object.entries(want)) {
      const a = el.getAttribute('data-' + k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));
      if (a != null) { if (a === v) confirmed++; else { contradicted++; actual[k] = a; } continue; }
      const axis = classes && classes[k];
      if (!axis || !axis[v]) { unknown++; continue; }
      const mine = axis[v];
      const other = Object.entries(axis).find(([o, t]) => o !== v && t.length && has(el, t) && !t.every((c) => mine.includes(c)));
      if (other) { contradicted++; actual[k] = other[0]; } else if (has(el, mine)) confirmed++; else unknown++;
    }
    el.setAttribute('data-dsa-p', String(idx));
    return { idx, confirmed, contradicted, unknown, actual, styles: read(el) };
  }).filter(Boolean);
}`;

/** Runs in the harness page: draw one component (harness.ts). */
const DRAW = `(a) => window.__dsaDraw(a)`;

export interface FreshDraw { /** Times the page was reloaded. */ reloads: number; /** Files that fail the same way in a fresh page, so reloading won't help. */ gaveUp: Set<string> }

/**
 * Draw one component, and reload the page if its dependencies changed under it. Vite finds a dependency
 * late, rebuilds its bundle and gives React a new URL. With a page open, what it imports from then on gets
 * that second copy of React while react-dom keeps the first, so its hooks read a null dispatcher. A fresh
 * page has one copy again.
 */
export async function drawFresh(page: any, h: Harness, fresh: FreshDraw, arg: { file: string } & Record<string, unknown>): Promise<{ ok: boolean; why?: string | undefined }> {
  const draw = () => run<{ ok: boolean; why?: string }>(page, DRAW, arg).catch((e: any) => ({ ok: false, why: String(e?.message ?? e).split('\n')[0] }));
  const r = await draw();
  if (r.ok || !staleDeps(r.why) || fresh.gaveUp.has(arg.file)) return r;
  fresh.reloads++;
  if (!(await openHarness(page, h))) return r;
  const again = await draw();
  if (!again.ok && staleDeps(again.why)) fresh.gaveUp.add(arg.file);
  return again;
}

/** For tests: the in-page prop check and the helper that runs it. */
export const __test = { SCAN, get INJECT_OWN() { return INJECT_OWN; }, run, pickBetter, get SHOWN() { return SHOWN; }, get FILLS() { return FILLS; }, get SET_WIDTH() { return SET_WIDTH; }, get BARE() { return BARE; }, get CUT_NOW() { return CUT_NOW; }, get FIT_WIDTH() { return FIT_WIDTH; } };

/** A proposal as stored: its component and props; the content it was asked to show isn't kept. */
const noOwn = (p: Wanted) => ({ use: p.use, props: p.props });

/** Run a fixed in-page function with data as its argument (the function is a constant here, never built from data). */
async function run<T = any>(page: any, src: string, arg?: unknown): Promise<T> {
  const fn = await page.evaluateHandle(src);
  try { return await page.evaluate(([f, a]: [any, unknown]) => f(a), [fn, arg]); }
  finally { await fn.dispose().catch(() => {}); }
}

/**
 * Runs in the page: put an element's own content into the rendered component. Its icon replaces the
 * story's (or becomes the only child of an icon-only button), its words replace the sample label, its
 * aria-label is set. An icon-only element whose icon wasn't captured keeps the stand-in, and says so.
 */
const INJECT_OWN = `({ sel, own }) => {
  const el = document.querySelector(sel);
  if (!el) return { own: false, why: 'the component was not found to set its content' };
  // A whole structure isn't one element's words or icon: it stays as its story wrote it, called an example.
  const several = own.inner && own.inner.html && own.inner.blocks > 1;
  if (!several && (el.matches(${JSON.stringify(STRUCTURE)}) || el.querySelector(${JSON.stringify(STRUCTURE)}))) return { own: false, example: true, why: ${JSON.stringify(EXAMPLE)} };
  // A field's words go in its box. With no box in the drawing, they're its label.
  if (own.value != null || own.placeholder != null) {
    const box = el.matches('input, textarea') ? el : el.querySelector('input, textarea');
    if (box) {
      box.value = own.value || '';
      if (own.placeholder) box.setAttribute('placeholder', own.placeholder); else box.removeAttribute('placeholder');
      if (own.ariaLabel) el.setAttribute('aria-label', own.ariaLabel);
      return { own: true };
    }
    own = { ...own, text: own.text || own.value || own.placeholder };
  }
  if (own.inner && own.inner.html) {
    const t = document.createElement('template');
    t.innerHTML = own.inner.html;
    el.replaceChildren(...Array.from(t.content.childNodes));
    // What sits on top of something inside it is placed against the element itself.
    if (el.querySelector('[style*="position: absolute"]') && getComputedStyle(el).position === 'static') el.style.position = 'relative';
    if (own.ariaLabel) el.setAttribute('aria-label', own.ariaLabel);
    // Each mark shows, at about the size it had: an icon font that isn't here spells its name out instead.
    const shown = Array.from(el.querySelectorAll('[data-dsa-mark]'));
    const ok = shown.length === own.inner.marks && shown.every(m => { const r = m.getBoundingClientRect(); const was = Number(m.getAttribute('data-dsa-mark')) || 0; return r.width > 0 && r.height > 0 && r.width <= Math.max(was * 1.6, was + 8); });
    return { own: true, inner: ok && !own.inner.lost };
  }
  const icons = Array.from(el.querySelectorAll('svg, [data-slot=icon]'));
  const iconOnly = !own.text;
  if (iconOnly && !own.icon) {
    if (own.ariaLabel) el.setAttribute('aria-label', own.ariaLabel);
    return { own: false, why: own.inner && own.inner.marks ? "what it holds couldn't be copied, so the story's sample shows instead" : "stand-in icon: the app's own icon wasn't captured" };
  }
  let svg = null;
  if (own.icon) { const t = document.createElement('template'); t.innerHTML = own.icon; svg = t.content.querySelector('svg'); }
  if (iconOnly) { el.textContent = ''; if (svg) el.append(svg); }
  else {
    if (svg && icons[0]) icons[0].replaceWith(svg); else if (svg) el.prepend(svg);
    // The sample's icon-font glyph is a word in that font: not the label, and not this element's.
    const leaves = () => Array.from(el.querySelectorAll('*')).filter(n => !n.closest('svg') && n.children.length === 0 && (n.textContent || '').trim());
    for (const n of leaves()) if (n.closest('.material-symbols-outlined, .material-symbols-rounded, .material-icons') || /material|symbols|icons?\\b|phosphor|awesome/i.test(getComputedStyle(n).fontFamily)) n.remove();
    // The label: bare words directly in the element (beside an icon, say), else the deepest element holding the sample's words, else the element itself.
    const holders = leaves();
    const bare = Array.from(el.childNodes).filter(n => n.nodeType === 3 && (n.nodeValue || '').trim());
    if (bare.length) { bare[0].nodeValue = own.text; bare.slice(1).forEach(n => n.remove()); holders.forEach(h => h.remove()); }
    else if (holders.length) { holders[0].textContent = own.text; holders.slice(1).forEach(h => h.remove()); }
    else { for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) n.remove(); el.append(document.createTextNode(own.text)); }
  }
  if (own.ariaLabel) el.setAttribute('aria-label', own.ariaLabel);
  return { own: true };
}`;

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
