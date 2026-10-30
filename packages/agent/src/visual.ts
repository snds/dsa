import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { materializeRemotes, resolveTargets, targetRelative, type Config } from '@snds/dsa/engine';

import { detectApp, discoverRoutes, ensureBrowser, startApp, type AppPlan } from '@snds/dsa-review';
import { captureSession, type Flow } from '@snds/dsa-review';

import { buildBrief } from './context.js';
import { agentDir, readSnapshot, type Snapshot } from './snapshot.js';
import { addWorktree, baseOf, depLinks, readSession, sandboxChanges, SANDBOXES, VITE_WRAPPER, writeSession, type Session } from './sessions.js';

/**
 * Before/after pictures for a sandbox change. Opt-in, because it starts the app twice:
 *
 *   before: a second worktree at the commit the sandbox started from (the real checkout may have moved
 *           on or have edits of its own, and we never write in it)
 *   after:  the sandbox, with the agent's edits
 *
 * Both copies start the same way the screenshot crawler starts the app (apps.ts), one after the other,
 * and get the same capture pass (shots.ts) with the same network guard: reads only, nothing under /api/.
 * "After" looks on the pages where "before" found each element first. Every dev server is stopped when
 * its side is done, whatever happens.
 */
export interface Side { file?: string; page?: string; revealedBy?: string; match?: number; loose?: boolean }
export interface Pair { id: string; label: string; file: string; line: number; reason: string; before: Side; after: Side; same: boolean | null }
export interface VisualRun { key: string; at: string; base: string; target: string; diffHash: string; pairs: Pair[]; notes: string[]; seconds: number }

export const MAX_ELEMENTS = 6;
const running = new Set<string>();
export const isVisualRunning = (id: string) => running.has(id);

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const slash = (p: string) => p.split(path.sep).join('/');
export const diffHash = (diff: string) => crypto.createHash('sha1').update(diff).digest('hex').slice(0, 12);
export const visualDir = (dataDir: string, id: string) => path.join(agentDir(dataDir), 'visual', id.replace(/[^\w-]/g, ''));

export interface Pick { e: any; rel: string; reason: string; score: number }

/**
 * Which elements to picture, best first: ones in a file the agent changed, then the session's own
 * elements (a change to a shared file can move them too). One per file before a second from the same
 * file, so a few pictures cover as much of the change as they can.
 */
export function pickElements(snap: Snapshot, s: { repo: { top: string } }, changed: string[], subjectIds: string[], max = 4): Pick[] {
  const changedSet = new Set(changed.map(slash));
  const subject = new Set(subjectIds);
  const out: Pick[] = [];
  for (const e of snap.evals ?? []) {
    if (e.exception || !e.match) continue;
    const t = snap.targets.find(x => x.name === e.target);
    if (!t) continue;
    const rel = slash(path.relative(s.repo.top, path.join(t.dir, targetRelative(snap.root, e.file, t.dir))));
    if (rel.startsWith('..')) continue;
    const inFile = changedSet.has(rel), mine = subject.has(e.id);
    if (!inFile && !mine) continue;
    const shot = Boolean(snap.shots?.[e.id]);
    out.push({ e, rel, reason: inFile && mine ? 'in a changed file, and part of this session' : inFile ? 'in a changed file' : 'part of this session', score: (inFile ? 4 : 0) + (mine ? 2 : 0) + (shot ? 1 : 0) });
  }
  out.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel) || a.e.line - b.e.line);
  const picked: Pick[] = [], files = new Set<string>();
  for (const p of out) if (picked.length < max && !files.has(p.rel)) { picked.push(p); files.add(p.rel); }
  for (const p of out) if (picked.length < max && !picked.includes(p)) picked.push(p);
  return picked;
}

/** Routes to try, in order: pages where an element was seen, then the app's configured routes, then the ones in its source. */
export function routesFor(known: (string | undefined)[], extra: string[], discovered: string[], cap = 25): string[] {
  const rel = (u: string) => { try { const x = new URL(u, 'http://x/'); return (x.pathname === '/' ? '' : x.pathname) + x.search + x.hash; } catch { return u; } };
  return [...new Set([...known.filter((k): k is string => Boolean(k)).map(rel), ...extra, '', ...discovered])].slice(0, cap);
}

/**
 * A Vite config that wraps the app's own and widens what the dev server may read. The worktrees link
 * node_modules (and the profile's sandboxLinks) to the real checkout; without this, Vite refuses to serve files behind
 * those links (fonts, icon fonts) and the pictures lose them. Its cache goes outside the real checkout.
 */
export function viteWrapper(appDir: string, allow: string[], cacheDir: string): string {
  const own = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'].find(f => fs.existsSync(path.join(appDir, f)));
  const extra = JSON.stringify({ cacheDir, server: { fs: { allow } } });
  return [
    `// Written by dsa for a before/after run; removed when the run ends.`,
    `import { mergeConfig } from 'vite';`,
    own ? `import own from './${own}';` : `const own = {};`,
    `export default async (env) => mergeConfig(typeof own === 'function' ? await own(env) : await own, ${extra});`,
    '',
  ].join('\n');
}

/** The app plan for one copy of the repo: the crawler's own plan, moved into that copy. */
function planIn(plan: AppPlan, appDir: string, wrapper: string | null): AppPlan {
  return { ...plan, cwd: appDir, args: wrapper ? [...plan.args, '--config', wrapper] : plan.args };
}

const sha = (f: string) => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };

export async function beforeAfter(opts: { root: string; dataDir: string; config: Config; id: string; max?: number; log?: (m: string) => void }): Promise<VisualRun> {
  const log = opts.log ?? (() => {});
  const s = readSession(opts.dataDir, opts.id);
  if (!s) throw new Error('No such session.');
  if (running.has(s.id)) throw new Error('Before/after pictures are already being taken for this session.');
  running.add(s.id);
  const t0 = Date.now();
  try {
    const ch = sandboxChanges(s);
    if (!s.sandbox || !ch?.files.length) throw new Error('There are no sandbox changes to picture.');
    const snap = readSnapshot(opts.dataDir);
    if (!snap) throw new Error('No scan yet: run a scan first.');
    const { config } = opts;
    const subjectIds = (() => { try { return buildBrief(snap, s.subject).ids; } catch { return []; } })();
    const picks = pickElements(snap, s, ch.files.map(f => f.file), subjectIds, Math.max(1, Math.min(MAX_ELEMENTS, opts.max ?? 4)));
    if (!picks.length) throw new Error("None of the changed files has an element the scan knows, so there's nothing to look for. Run a scan that covers them, or ask the agent which page to check.");
    // One app per run: the target most of the picks belong to.
    const counts = new Map<string, number>();
    for (const p of picks) counts.set(p.e.target, (counts.get(p.e.target) ?? 0) + 1);
    const targetName = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const mine = picks.filter(p => p.e.target === targetName);
    const { config: cfg } = materializeRemotes(config, opts.root, opts.dataDir, false, () => {});
    const t = resolveTargets(opts.root, cfg).find(x => x.name === targetName);
    if (!t) throw new Error(`The app ${targetName} isn't in this scan's config any more.`);
    if (config.apps?.[targetName]?.screenshots === false) throw new Error(`Screenshots are off for ${targetName} (apps["${targetName}"].screenshots).`);
    const sub = path.relative(s.repo.top, t.dir);
    if (sub.startsWith('..')) throw new Error(`${targetName} isn't inside ${s.repo.name}, the repo this session's sandbox copies.`);
    const plan = detectApp(t, config);
    if ('reason' in plan) throw new Error(`Can't start ${targetName}: ${plan.reason}.`);

    // The starting point: the commit the sandbox was made from.
    const baseRef = git(s.sandbox, ['rev-parse', 'HEAD']);
    const base = baseOf(s);
    if (fs.existsSync(base) && git(base, ['rev-parse', 'HEAD']) !== baseRef) git(base, ['checkout', '--detach', '--force', baseRef]);
    if (!fs.existsSync(base)) { log(`Making a copy of ${s.repo.name} at ${baseRef.slice(0, 7)} (before the change)…`); addWorktree(s, base, baseRef); }

    const pw = await ensureBrowser(log);
    const key = new Date().toISOString().replace(/[:.]/g, '-');
    const out = visualDir(opts.dataDir, s.id);
    fs.rmSync(out, { recursive: true, force: true });
    const notes: string[] = [];
    const extra = config.apps?.[targetName]?.extraRoutes ?? [];
    const discovered = (() => { try { return discoverRoutes(path.join(s.sandbox, sub), []); } catch { return []; } })();
    const sh = config.shots ?? {};
    const evals = mine.map(p => p.e);

    type Found = Record<string, Side>;
    type Pass = (routes: string[], examples: any[]) => Promise<Found>;
    /** Start one copy of the app, run `work` against it, and always stop it. */
    const side = async (name: 'before' | 'after', top: string, work: (pass: Pass) => Promise<Found>): Promise<Found> => {
      const appDir = path.join(top, sub);
      const dir = path.join(out, key, name);
      fs.mkdirSync(dir, { recursive: true });
      const wrapper = plan.how === 'vite' ? path.join(appDir, VITE_WRAPPER) : null;
      if (wrapper) {
        const links = depLinks().map(l => path.join(top, l)).filter(p => fs.existsSync(p)).map(p => fs.realpathSync(p));
        fs.writeFileSync(wrapper, viteWrapper(appDir, [...new Set([top, appDir, ...links])], path.join(SANDBOXES, `${s.id}-vite-${name}`)));
      }
      log(`Starting ${targetName} ${name} the change (${plan.how})…`);
      let app: Awaited<ReturnType<typeof startApp>> | null = null;
      try {
        app = await startApp(planIn(plan, appDir, wrapper));
        const url = app.url;
        return await work(async (routes, examples) => {
          const r = await captureSession(pw, { url, routes, flows: config.apps?.[targetName]?.flows as Flow[] | undefined, crawl: false, examples, dir, maxPages: 20, waitMs: sh.waitMs ?? 600, log, reveal: true, maxActions: 12, maxDepth: 2, maxMinutes: 3, maxReplays: 10 });
          const found: Found = {};
          for (const [id, v] of Object.entries<any>(r.shots)) found[id] = { file: `${key}/${name}/${v.file}`, page: String(v.page).replace(/^https?:\/\/[^/]+/, ''), revealedBy: v.revealedBy, match: v.matchScore };
          return found;
        });
      } finally {
        app?.stop();
        if (wrapper) fs.rmSync(wrapper, { force: true });
      }
    };

    // Before: where the last scan saw each element first.
    const before = await side('before', base, pass => pass(routesFor(mine.map(p => snap.shots?.[p.e.id]?.page), extra, discovered), evals));
    // After: where "before" found it first. An edit often changes an element's classes, so anything not found
    // by its full description is looked for again on the same page by its words, labelled as a looser match.
    const after = await side('after', s.sandbox, async pass => {
      const found = await pass(routesFor([...Object.values(before).map(f => f.page), ...mine.map(p => snap.shots?.[p.e.id]?.page)], extra, discovered), evals);
      const lost = evals.filter(e => !found[e.id] && before[e.id] && (e.match.text || e.match.ariaLabel || e.match.title));
      if (lost.length) {
        log(`Looking again for ${lost.length} by their words, on the page where they were before…`);
        const again = await pass([...new Set(lost.map(e => before[e.id].page!))], lost.map(e => ({ ...e, match: { ...e.match, classes: [] }, reach: undefined })));
        for (const [id, f] of Object.entries(again)) found[id] = { ...f, loose: true };
      }
      return found;
    });

    const pairs: Pair[] = mine.map(p => {
      const b = before[p.e.id] ?? {}, a = after[p.e.id] ?? {};
      const same = b.file && a.file ? sha(path.join(out, b.file)) === sha(path.join(out, a.file)) : null;
      return { id: p.e.id, label: `${p.e.element ?? p.e.match?.tag ?? 'element'}${p.e.match?.text ? ` “${String(p.e.match.text).slice(0, 40)}”` : ''}`, file: p.rel, line: p.e.line, reason: p.reason, before: b, after: a, same };
    });
    if (mine.length < picks.length) notes.push(`${picks.length - mine.length} element(s) belong to another app and weren't pictured in this run.`);
    if (pairs.some(x => !x.before.file)) notes.push("Some elements weren't found before the change either: the crawler couldn't reach them in the time it has.");
    if (pairs.some(x => x.before.file && !x.after.file)) notes.push("Some elements weren't found after the change: the edit may have changed them past recognition, or moved them.");
    const run: VisualRun = { key, at: new Date().toISOString(), base: baseRef.slice(0, 7), target: targetName, diffHash: diffHash(ch.diff), pairs, notes, seconds: Math.round((Date.now() - t0) / 1000) };
    const latest = readSession(opts.dataDir, s.id) ?? s;
    latest.visual = run;
    writeSession(opts.dataDir, latest);
    return run;
  } finally { running.delete(s.id); }
}

/** A picture from the session's last run, by its stored relative path (nothing outside the run's folder). */
export function visualFile(dataDir: string, s: Session, rel: string): string | null {
  if (!s.visual || !/^[\w-]+\/(before|after)\/[\w-]+\.png$/.test(rel) || !rel.startsWith(s.visual.key + '/')) return null;
  const f = path.join(visualDir(dataDir, s.id), rel);
  return fs.existsSync(f) ? f : null;
}
