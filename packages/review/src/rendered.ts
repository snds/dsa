import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { capByEvidence, cardPicks, latestEvals, lookProps, ownKey, ownOf, proposalKey, readProposals, readRendered, resolveTargets, type Config, type OwnContent, type Proposal, type RenderedSet, type Styles } from '@snds/dsa/engine';

import { cookiesFor, openSurface, serveStatic } from '@snds/dsa';
import { detectApp, ensureBrowser, startApp } from './apps.js';
import { harnessUrlFor, iconFile, openHarness, startHarness, type Harness } from './harness.js';

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

/**
 * Every component and look props the review proposes: each card's own pick (with the size it auto-picks,
 * which may be one no evaluation named), each recommendation, each scored alternative, each decision.
 * The card's pick is also wanted with each element's own content (its words, accessible name and icon),
 * keyed by that content, so the proposal shows the element as it would be, not a story's sample.
 */
export interface Wanted { use: string; props: Record<string, string>; own?: OwnContent; /** The file the element's icon component comes from (when only its name is known), to draw that icon. */ iconFile?: string | undefined }

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
  const add = (r: any, own?: OwnContent | null) => {
    if (r?.verdict !== 'replace' || !r.use) return;
    if (!out.has(proposalKey(r.use, r.props))) out.set(proposalKey(r.use, r.props), { use: r.use, props: lookProps(r.props) });
    if (own) out.set(ownKey(r.use, r.props, own), { use: r.use, props: lookProps(r.props), own, ...(icon ? { iconFile: icon } : {}) });
  };
  for (const e of evals) {
    if (e.exception) continue;
    const own = ownOf(e, shots[e.id]);
    icon = own?.iconName && root ? iconFile(root, e.file, own.iconName) ?? undefined : undefined;
    for (const p of picks.get(e.id) ?? []) add(p, own);
    for (const r of [e, e.decided?.decision, ...(e.alternatives ?? [])] as any[]) add(r, r === e || r === e.decided?.decision ? own : null);
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
    if (c && c.hash === hashOf(p.use) && (!c.shot || fs.existsSync(path.join(opts.dataDir, 'rendered', c.shot)))) items[k] = c; else todo.push([k, p]);
  }
  const reused = Object.keys(items).length;
  const write = () => {
    fs.mkdirSync(path.join(opts.dataDir, 'rendered'), { recursive: true });
    fs.writeFileSync(path.join(opts.dataDir, 'rendered', 'proposals.json'), JSON.stringify({ takenAt: new Date().toISOString(), items }, null, 1));
  };
  const exactCount = () => Object.values(items).filter(p => p.check === 'exact').length;
  if (!todo.length) { write(); log(`Proposed components: ${reused} rendered with their props (all cached).`); return { rendered: 0, reused, exact: exactCount() }; }

  const dir = path.join(opts.dataDir, 'rendered');
  fs.mkdirSync(dir, { recursive: true });
  log(`Proposed components: ${todo.length} to render with their props, ${reused} cached.`);
  const pw = await ensureBrowser(log);
  const browser = await pw.chromium.launch();
  let rendered = 0;
  // The system's own source: started once, when something needs drawing.
  let harness: Harness | null = null, hpage: any = null, harnessTried = false;
  const source = async () => {
    if (harnessTried) return harness;
    harnessTried = true;
    try { harness = await startHarness(opts.root, opts.config, sigs.filter(c => c.file).map(c => c.file), log); } catch (e: any) { log(`  Proposals: the system's source didn't start for drawing (${String(e?.message ?? e).split('\n')[0]}); drawing from its stories.`); harness = null; }
    if (harness) {
      hpage = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
      if (!(await openHarness(hpage, harness))) { log("  Proposals: the drawing page didn't load; drawing from its stories."); await harness.stop().catch(() => {}); harness = null; }
    }
    return harness;
  };
  // Its stories: started only when the source didn't draw something exactly.
  let sbs: { url: string; stories: any[]; page: any; stop: () => void } | null = null, sbWhy: string | null = null;
  const storybook = async () => {
    if (sbs || sbWhy) return sbs;
    try {
      let sb = opts.storybook, stop = () => {};
      if (!sb) { const started = await startStorybook(opts.root, opts.config, log); sb = started; stop = started.stop; }
      const index: any = await storyIndex(sb.url, sb.cookie);
      const stories = Object.values<any>(index.entries ?? index.stories ?? {}).filter(st => st.type !== 'docs' && st.importPath);
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, ...(sb.storageState ? { storageState: sb.storageState } : {}) });
      sbs = { url: sb.url, stories, page, stop };
    } catch (e: any) { sbWhy = String(e?.message ?? e).split('\n')[0]!; log(`  Proposals: no stories to draw from (${sbWhy}).`); }
    return sbs;
  };
  try {
    for (const [k, p] of todo) {
      const s = sigOf(p.use);
      if (!s) { items[k] = { ...noOwn(p), check: 'none', note: `${p.use} isn't a component dsa found in the design system's source, so it can't be drawn.`, hash: hashOf(p.use) }; continue; }
      let best: Proposal | null = null;
      if (await source()) best = await fromSource(hpage, s, p, k, dir, hashOf(p.use));
      const done = (b: Proposal | null) => Boolean(b && b.check === 'exact' && b.shot && (!p.own || b.own));
      if (!done(best) && (await storybook())) best = pickBetter(best, await fromStories(sbs!, s, p, k, dir, hashOf(p.use), rendered === 0));
      items[k] = best ?? { ...noOwn(p), check: 'none', note: `${p.use} couldn't be drawn${sbWhy ? `: there's no Storybook to draw it from (${sbWhy})` : ''}.`, hash: hashOf(p.use) };
      rendered++;
      if (rendered % 10 === 0) log(`  rendered ${rendered}/${todo.length}…`);
    }
  } finally {
    await browser.close().catch(() => {});
    await (harness as Harness | null)?.stop().catch(() => {});
    (sbs as { stop: () => void } | null)?.stop();
  }
  write();
  const fromSrc = Object.values(items).filter(p => p.via === 'source' && p.check === 'exact').length;
  log(`Proposed components: ${Object.keys(items).length} rendered with their props · ${exactCount()} exact (confirmed by the element's attributes or classes)${fromSrc ? ` · ${fromSrc} drawn from the system's source` : ''}.`);
  return { rendered, reused, exact: exactCount() };
}

const ORDER: Record<Proposal['check'], number> = { exact: 0, unverified: 1, closest: 2, none: 3 };
/** The better of two drawings: the surer props, then the one with the element's own content, then one with a picture. */
function pickBetter(a: Proposal | null, b: Proposal | null): Proposal | null {
  if (!a || !b) return a ?? b;
  const d = ORDER[a.check] - ORDER[b.check] || Number(Boolean(b.own)) - Number(Boolean(a.own)) || Number(Boolean(b.shot)) - Number(Boolean(a.shot));
  return d > 0 ? b : a;
}

/** Tags whose own words can't go inside them as text (rows come from data). */
const DATA_TAGS = /^(table|thead|tbody|tr|ul|ol|dl)$/;

/** Draw one proposal from the system's source in the harness page. */
async function fromSource(page: any, s: any, p: Wanted, k: string, dir: string, hash: string): Promise<Proposal> {
  const dataTag = DATA_TAGS.test(s.tag ?? '');
  const icon = p.own?.iconName && p.iconFile ? { file: harnessUrlFor(p.iconFile), name: p.own.iconName } : null;
  const r = await run<{ ok: boolean; why?: string }>(page, DRAW, { file: harnessUrlFor(s.file), name: s.component, props: p.props, text: dataTag ? null : p.own?.text ?? null, icon, slot: s.slot, empty: true }).catch((e: any) => ({ ok: false, why: String(e?.message ?? e).split('\n')[0] }));
  if (!r.ok) return { ...noOwn(p), check: 'none', via: 'source', note: `${p.use} couldn't be drawn from the system's source: ${r.why}.`, hash };
  const found: Found[] = await run(page, SCAN, { slot: s.slot, want: p.props, classes: s.axisClasses ?? null });
  const top = topOf(found);
  if (!top) return { ...noOwn(p), check: 'none', via: 'source', note: `${p.use} drew from the system's source, but nothing showed.`, hash };
  const check: Proposal['check'] = top.contradicted ? 'closest' : top.unknown ? 'unverified' : 'exact';
  const sel = `[data-dsa-p="${top.idx}"][data-slot="${s.slot}"]`;
  let own: { own: boolean; why?: string } | null = null;
  if (p.own) {
    if (dataTag) own = { own: false, why: "its rows come from data the scan couldn't read, so it's drawn empty" };
    else if (p.own.icon) own = await run<{ own: boolean; why?: string }>(page, INJECT_OWN, { sel, own: p.own }).catch(() => ({ own: false, why: 'its content could not be set' }));
    else {
      // Its words went in as children; an icon named in the source was imported and drawn beside them.
      const shown = await run<{ text: boolean; icon: boolean }>(page, SHOWN_OWN, { sel, text: p.own.text ?? null, label: p.own.ariaLabel ?? null });
      const iconOnly = !p.own.text;
      own = iconOnly && !shown.icon ? { own: false, why: p.own.iconName ? `the app's icon (${p.own.iconName}) couldn't be loaded, so none is drawn` : "stand-in icon: the app's own icon wasn't captured" } : shown.text ? { own: true } : { own: false, why: 'its words could not be set' };
    }
  }
  const file = `proposal-${sha(k).slice(0, 12)}.png`;
  const shot = await shoot(page, sel, path.join(dir, file));
  return { ...noOwn(p), check, via: 'source', shot: shot ? file : undefined, styles: top.styles, ...(own?.own ? { own: true } : {}), ...(own && !own.own && own.why ? { content: own.why } : {}), ...(top.contradicted ? { actual: top.actual } : {}), hash };
}

/** Runs in the page: did the element's own words and icon show, and set its accessible name. */
const SHOWN_OWN = `({ sel, text, label }) => {
  const el = document.querySelector(sel);
  if (!el) return { text: false, icon: false };
  if (label) el.setAttribute('aria-label', label);
  return { text: !text || (el.textContent || '').includes(text), icon: Boolean(el.querySelector('svg, [data-slot=icon], img')) };
}`;

/** Draw one proposal from the component's stories: one that shows these props as written, else one driven by args. */
async function fromStories(sb: { url: string; stories: any[]; page: any }, s: any, p: Wanted, k: string, dir: string, hash: string, first: boolean): Promise<Proposal> {
  const page = sb.page;
  // Args-driven stories (Default, Playground), then ones showing many combinations, then the rest.
  const rank = (x: any) => (/default|playground|basic|primary/i.test(x.name) ? 0 : /all|variant|size|matrix|gallery|overview/i.test(x.name) ? 1 : 2);
  const stemOf = (f: string) => path.basename(f).split('.')[0]!.toLowerCase();
  const candidates = sb.stories.filter(x => stemOf(x.importPath) === stemOf(s.file)).sort((a, b) => rank(a) - rank(b)).slice(0, 8);
  if (!candidates.length) return { ...noOwn(p), check: 'none', via: 'story', note: `${p.use} has no story to draw it from (${path.basename(s.file)}).`, hash };
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
  for (const { st, set } of attempts) {
    try {
      await page.goto(new URL(`iframe.html?id=${encodeURIComponent(st.id)}&viewMode=story${set && args ? `&args=${encodeURIComponent(args)}` : ''}`, sb.url).toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(`(() => { const r = document.querySelector('#storybook-root, #root'); return r && r.children.length > 0; })()`, null, { timeout: first && n++ === 0 ? 90000 : 20000 });
      // Storybook 8+ ignores URL args inside the preview frame; its channel (what Controls uses) sets them on any version.
      if (set) {
        await page.evaluate(`window.__STORYBOOK_ADDONS_CHANNEL__ && window.__STORYBOOK_ADDONS_CHANNEL__.emit('updateStoryArgs', { storyId: ${JSON.stringify(st.id)}, updatedArgs: ${JSON.stringify(p.props)} })`);
        await page.waitForTimeout(600);
      }
      await page.waitForTimeout(250);
    } catch { continue; }
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
    if (!top) continue;
    const check: Proposal['check'] = top.contradicted ? 'closest' : top.unknown ? 'unverified' : 'exact';
    if (best && ORDER[best.check] <= ORDER[check]) continue;
    const file = `proposal-${sha(k).slice(0, 12)}.png`;
    // The element's own words, name and icon in place of the story's: then the proposal is this element.
    const sel = `[data-dsa-p="${top.idx}"][data-slot="${s.slot}"]`;
    const own = p.own ? await run<{ own: boolean; why?: string }>(page, INJECT_OWN, { sel, own: p.own }).catch(() => ({ own: false, why: 'its content could not be set' })) : null;
    if (own?.own) await page.waitForTimeout(120);
    const shot = await shoot(page, sel, path.join(dir, file));
    const content = own?.own ? undefined : own?.why ? own.why : set ? (iconSize && icon ? `icon from ${icon.story}` : 'story default') : undefined;
    best = { ...noOwn(p), check, via: 'story', shot: shot ? file : undefined, styles: top.styles, story: st.id, ...(own?.own ? { own: true } : {}), ...(content ? { content } : {}), ...(top.contradicted ? { actual: top.actual } : {}), hash };
    if (check === 'exact') break;
  }
  if (best) return best;
  // Nothing to photograph with these props: show the component's first story as its authors wrote it, and say why.
  let fallback: string | undefined;
  try {
    await page.goto(new URL(`iframe.html?id=${encodeURIComponent(candidates[0]!.id)}&viewMode=story`, sb.url).toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(400);
    const f = `fallback-${sha(k).slice(0, 12)}.png`;
    if (await shoot(page, '#storybook-root > *, #root > *', path.join(dir, f))) fallback = f;
  } catch { /* no fallback */ }
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
  const icons = Array.from(el.querySelectorAll('svg, [data-slot=icon]'));
  const iconOnly = !own.text;
  if (iconOnly && !own.icon) {
    if (own.ariaLabel) el.setAttribute('aria-label', own.ariaLabel);
    return { own: false, why: "stand-in icon: the app's own icon wasn't captured" };
  }
  let svg = null;
  if (own.icon) { const t = document.createElement('template'); t.innerHTML = own.icon; svg = t.content.querySelector('svg'); }
  if (iconOnly) { el.textContent = ''; if (svg) el.append(svg); }
  else {
    if (svg && icons[0]) icons[0].replaceWith(svg); else if (svg) el.prepend(svg);
    // The label: the deepest element holding the sample's words, else the element itself.
    const holders = Array.from(el.querySelectorAll('*')).filter(n => !n.closest('svg') && n.children.length === 0 && (n.textContent || '').trim());
    if (holders.length) { holders[0].textContent = own.text; holders.slice(1).forEach(h => h.remove()); }
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
