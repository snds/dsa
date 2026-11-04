import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashText, historyPairs, stripSystemComponents, systemImports, type Label, type StripTarget } from '@snds/dsa';
import { allDsPackages, buildSignatures, normalize, resolveTargets, type Config, type Target } from '@snds/dsa/engine';
import { isCorrect, matchLabels, predictionsOf } from './bench.js';

/**
 * `dsa labels`: ground truth without hand-labelling everything (bootstrap-labels.ts in the core does the
 * reading). Every file it writes goes where it is told, never into the apps it reads.
 */

/**
 * Folders and files a label is never about: build output, vendored copies of other code, and what isn't
 * product code. The non-product part is a local copy of the engine scanner's list (NON_PRODUCT in
 * src/model/extract.ts on the engine branch): tests, stories, examples, demos, fixtures, mocks, stubs and
 * docs. Keep the two in step: a label in a file the scanner skips can never be matched.
 */
const SKIP_DIRS = /^(node_modules|\.git|dist|build|\.next|coverage|vendor|__tests__|__mocks__|__fixtures__|fixtures|test|tests|stories|examples?|demos?|playgrounds?|stubs|__stubs__|docs)$/;
const SKIP_FILES = /\.(test|spec|stories|stub)\.[cm]?[jt]sx?$/;

/** The app's .tsx and .jsx files, relative to it. */
export function sourceFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) { if (!SKIP_DIRS.test(d.name) && !d.name.startsWith('.')) out.push(...sourceFiles(dir, r)); }
    else if (/\.[jt]sx$/.test(d.name) && !SKIP_FILES.test(d.name)) out.push(r);
  }
  return out.sort();
}

/**
 * Read-only git: the apps are other people's checkouts. `git status` and `git diff` refresh stat info and
 * rewrite .git/index, so neither is used. Plumbing only, with GIT_OPTIONAL_LOCKS=0: `diff-index` lists
 * candidates (it also lists files whose mtime changed with the same content), and each is confirmed by
 * comparing `hash-object` with the blob at HEAD. (The engine's src/engine/git-read.ts does the same; a
 * local copy keeps this package from depending on it.)
 */
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
const gitRead = (dir: string, args: string[], maxBuffer = 64 * 1024 * 1024) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: GIT_ENV, maxBuffer });

/** The source revision of a folder: its commit, or "worktree" when tracked files under it changed (or it isn't in git). */
export function sourceRef(dir: string): string {
  try {
    const head = gitRead(dir, ['rev-parse', 'HEAD']).trim();
    const top = gitRead(dir, ['rev-parse', '--show-toplevel']).trim();
    const listed = gitRead(dir, ['diff-index', '--name-only', 'HEAD', '--', '.']).split('\n').map((x) => x.trim()).filter(Boolean);
    const changed = listed.some((f) => {
      try { return gitRead(top, ['hash-object', '--', f]).trim() !== gitRead(top, ['rev-parse', `HEAD:${f}`]).trim(); } catch { return true; }
    });
    return changed ? 'worktree' : head;
  } catch { return 'worktree'; }
}

/** Pixels from a class list, later classes winning: rem, px, [Npx], and tokens followed to their values. */
export function renderedPx(classes: string[], aliases: Map<string, string>, values: Map<string, string>): { height?: number | undefined; width?: number | undefined } {
  const p = normalize(classes, aliases);
  const px = (v: string | undefined, depth = 0): number | undefined => {
    if (!v || depth > 8) return undefined;
    const s = v.trim().replace(/^\[(.+)\]$/, '$1');
    if (s.startsWith('var:')) return px(values.get(s.slice(4)), depth + 1);
    const ref = /^var\(--([\w-]+)\)$/.exec(s);
    if (ref) return px(values.get(ref[1]!), depth + 1);
    const m = /^(-?\d*\.?\d+)(rem|px)?$/.exec(s);
    return m ? (m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1])) : undefined;
  };
  return { height: px(p.get('height')), width: px(p.get('width')) };
}

const labelId = (...parts: (string | number)[]) => `L-${crypto.createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 12)}`;

/** The system's components as strip targets (host tag, axes, the classes for a variant and size). */
export function stripTargets(root: string, config: Config): Map<string, StripTarget> {
  const targets = resolveTargets(root, config);
  const core = targets.filter((t) => t.role === 'core').map((t) => { let name: string | undefined; try { name = JSON.parse(fs.readFileSync(path.join(t.dir, 'package.json'), 'utf8')).name; } catch { /* none */ } return { dir: t.dir, name: name ?? t.name }; });
  const sigs = buildSignatures(core);
  const out = new Map<string, StripTarget>();
  for (const c of sigs.components.values()) {
    if (!c.tag || !/^[a-z]/.test(c.tag)) continue;
    out.set(c.component, { tag: c.tag, axes: c.axes, defaults: c.defaults, classes: (v, s) => c.sigs.find((x) => x.variant === v && x.size === s)?.classes ?? null, px: (cls) => renderedPx(cls, sigs.aliases, sigs.values) });
  }
  return out;
}

export interface MigratedResult {
  labels: Label[];
  /** Each app's stripped copy. */
  apps: { name: string; from: string; to: string; files: number; stripped: number }[];
  /** The root to scan the copies from (a copy of the repo when an app sits inside it), and a config that scans them (output in <workDir>/data). */
  root: string;
  config: string;
}

/**
 * (a) migrated: copy each app to `workDir` with every system component stripped back to the raw markup
 * it renders, and label each with what was there. Then scan the copy (`dsa run --config <config> --root
 * <root> --no-shots`) and bench against these labels. The apps themselves are only read.
 */
export function migratedLabels(o: { root: string; config: Config; configFile: string; workDir: string; labeler?: string; now?: Date; apps?: string[] }): MigratedResult {
  const now = (o.now ?? new Date()).toISOString();
  const work = path.resolve(o.workDir);
  const root = path.resolve(o.root);
  // Apps whose look-alikes the config doesn't measure would never be scanned: no labels for them.
  const targets = resolveTargets(root, o.config).filter((t) => t.role === 'consumer' && o.config.apps?.[t.name]?.lookalikes !== false && (!o.apps || o.apps.includes(t.name)));
  for (const d of [root, ...targets.map((t) => t.dir)]) if (isInside(work, d) || isInside(d, work)) throw new Error(`The work folder (${work}) and ${d} overlap: put the work folder somewhere else.`);
  const strip = stripTargets(root, o.config);
  const packages = allDsPackages(o.config);
  // An app inside the repo is scanned through the repo (its workspaces), so the repo is copied; one
  // outside it is copied on its own and the config points at the copy.
  const copyRoot = targets.some((t) => isInside(root, t.dir));
  const workRoot = copyRoot ? path.join(work, 'root') : root;
  if (copyRoot) { fs.rmSync(workRoot, { recursive: true, force: true }); copyApp(root, workRoot); }
  const labels: Label[] = [];
  const apps: MigratedResult['apps'] = [];
  for (const t of targets) {
    const to = isInside(root, t.dir) ? path.join(workRoot, path.relative(root, t.dir)) : path.join(work, 'apps', safe(t.name));
    if (!isInside(root, t.dir)) { fs.rmSync(to, { recursive: true, force: true }); copyApp(t.dir, to); }
    const ref = sourceRef(t.dir);
    let files = 0, stripped = 0;
    for (const rel of sourceFiles(t.dir)) {
      const src = fs.readFileSync(path.join(t.dir, rel), 'utf8');
      const imports = systemImports(src, packages);
      if (!imports.size) continue;
      const r = stripSystemComponents(src, imports, strip);
      if (!r.stripped.length) continue;
      fs.writeFileSync(path.join(to, rel), r.text);
      files++; stripped += r.stripped.length;
      for (const s of r.stripped) labels.push({
        id: labelId(t.name, rel, s.line, s.elementHash), app: t.name, file: rel, line: s.line, sourceRef: ref, elementHash: s.elementHash,
        truth: { verdict: 'replace', use: s.component, props: s.props }, acceptableAlts: (s.alts ?? []).map((props) => ({ use: s.component, props })), labeler: o.labeler ?? 'dsa labels migrated', method: 'migrated', at: now,
        notes: s.alts?.length ? `Was this component; stripped back to the markup it renders. Its className overrides the size, so ${s.alts.map((a) => `size "${a.size}"`).join(' or ')} renders the same pixels.` : 'Was this component; stripped back to the markup it renders.',
      });
    }
    apps.push({ name: t.name, from: t.dir, to, files, stripped });
  }
  const config = path.join(work, 'dsa.config.json');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(config, JSON.stringify(workConfig(o.configFile, root, workRoot, apps, path.join(work, 'data')), null, 2));
  return { labels, apps, root: workRoot, config };
}

/** The run's config, pointed at the stripped copies: no screenshots, no live check, output in the work folder. */
function workConfig(configFile: string, root: string, workRoot: string, apps: MigratedResult['apps'], dataDir: string) {
  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const base = path.dirname(configFile);
  const moved = (p: string) => {
    const a = path.isAbsolute(p) ? p : path.resolve(base, p);
    const app = apps.find((x) => path.resolve(x.from) === a);
    if (app) return app.to;
    return isInside(root, a) ? path.join(workRoot, path.relative(root, a)) : a;
  };
  for (const c of raw.consumers ?? []) if (typeof c.path === 'string') c.path = moved(c.path);
  if (typeof raw.profile === 'string' && /^\.\.?\//.test(raw.profile)) raw.profile = path.resolve(base, raw.profile);
  delete raw.live;
  raw.shots = { ...(raw.shots ?? {}), auto: false };
  raw.output = { ...(raw.output ?? {}), dir: dataDir };
  return raw;
}

function copyApp(from: string, to: string) {
  fs.cpSync(from, to, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git|\.dsa|dist|build|\.next|coverage)$/.test(src) });
}

const isInside = (dir: string, p: string) => { const r = path.relative(dir, p); return !r.startsWith('..') && !path.isAbsolute(r); };
const safe = (n: string) => n.replace(/[^\w.-]+/g, '_');

/**
 * (b) history: walk an app's git history for commits that turned a raw element into a system component,
 * and label the raw element, at the parent commit, with what it became. A shallow clone has no history
 * to read; the result says so.
 */
export function historyLabels(o: { app: Target; components: Set<string>; maxCommits?: number; labeler?: string; now?: Date }): { labels: Label[]; commits: number; shallow: boolean } {
  const now = (o.now ?? new Date()).toISOString();
  const git = (...a: string[]) => gitRead(o.app.dir, a, 256 * 1024 * 1024);
  let shallow = false;
  try { shallow = git('rev-parse', '--is-shallow-repository').trim() === 'true'; } catch { return { labels: [], commits: 0, shallow: false }; }
  const shas = git('log', '--format=%H %P', `-n${o.maxCommits ?? 2000}`, '--', '.').trim().split('\n').filter(Boolean).map((l) => l.split(' '));
  const labels: Label[] = [];
  let commits = 0;
  for (const [sha, parent] of shas) {
    if (!sha || !parent) continue;
    commits++;
    const diff = git('show', '-U0', '--no-color', '--format=', sha, '--', '*.tsx', '*.jsx');
    for (const p of historyPairs(diff, o.components)) {
      labels.push({
        id: labelId(o.app.name, p.file, p.line, parent, p.elementHash), app: o.app.name, file: p.file, line: p.line, sourceRef: parent, elementHash: p.elementHash,
        truth: { verdict: 'replace', use: p.component, ...(Object.keys(p.props).length ? { props: p.props } : {}) }, acceptableAlts: [],
        labeler: o.labeler ?? 'dsa labels history', method: 'history', at: now, notes: `<${p.rawTag}> became ${p.component} in ${sha.slice(0, 12)}.`,
      });
    }
  }
  return { labels, commits, shallow };
}

export interface QueueItem {
  id: string; app: string; file: string; line: number;
  why: 'disagree' | 'audit';
  /** What dsa recommends, and what each label or judge says. */
  predicted: { verdict: string; use: string | null; props: Record<string, string>; confidence: number } | null;
  answers: { method: string; labeler: string; verdict: string; use?: string | undefined; props?: Record<string, string> | undefined }[];
}

/**
 * (c) What people should look at: every element where dsa and a label (or a second judge's labels)
 * disagree, or where two labels disagree, plus a random audit of a share of the rest (10% by default,
 * the same draw for the same seed). Human labels are never re-queued.
 */
export function reviewQueue(o: { labels: Label[]; payload: any; judge?: Label[]; audit?: number; seed?: string }): { items: QueueItem[]; disagree: number; audited: number } {
  const preds = predictionsOf(o.payload);
  const all = [...o.labels, ...(o.judge ?? [])];
  const pairs = matchLabels(all, preds);
  const byElem = new Map<string, { key: string; pred: (typeof pairs)[number]['pred']; labels: Label[] }>();
  for (const { label, pred } of pairs) {
    const key = pred?.id ?? `${label.app}\u0001${label.file}\u0001${label.line}`;
    const g = byElem.get(key) ?? { key, pred, labels: [] };
    g.labels.push(label);
    byElem.set(key, g);
  }
  const items: QueueItem[] = [];
  const rest: QueueItem[] = [];
  const answer = (l: Label) => ({ method: l.method, labeler: l.labeler, verdict: l.truth.verdict, use: l.truth.use, props: l.truth.props });
  for (const g of byElem.values()) {
    if (g.labels.some((l) => l.method === 'human')) continue;
    const l0 = g.labels[0]!;
    const truths = new Set(g.labels.map((l) => `${l.truth.verdict}|${l.truth.use ?? ''}|${JSON.stringify(l.truth.props ?? {})}`));
    const wrong = g.pred ? g.labels.some((l) => !isCorrect(l, g.pred!)) : false;
    const item: QueueItem = {
      id: g.pred?.id ?? l0.id, app: l0.app, file: l0.file, line: l0.line, why: 'disagree',
      predicted: g.pred ? { verdict: g.pred.verdict, use: g.pred.use, props: g.pred.props, confidence: g.pred.confidence } : null,
      answers: g.labels.map(answer),
    };
    if (wrong || truths.size > 1) items.push(item); else rest.push({ ...item, why: 'audit' });
  }
  const share = o.audit ?? 0.1;
  const draw = (id: string) => parseInt(hashText(`${o.seed ?? 'dsa'}\u0001${id}`).slice(0, 8), 16) / 0xffffffff;
  const audit = rest.filter((x) => draw(x.id) < share);
  return { items: [...items, ...audit], disagree: items.length, audited: audit.length };
}
