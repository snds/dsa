import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { htmlPages, walk, type Config, type Target } from '@snds/dsa/engine';

/**
 * Running the apps the scan looked at, so screenshots need no manual dev server:
 * detect how an app starts (vite, next, astro, a "dev" script…), start it on a free port,
 * wait until it answers, hand back its URL, and stop it afterwards. Also: find its routes
 * in the source, and make sure the headless browser is installed.
 */

export interface AppPlan { target: string; cwd: string; command: string; args: string[]; url: (port: number) => string; how: string }

export function detectApp(t: Target, config: Config): AppPlan | { target: string; reason: string } {
  const app = config.apps?.[t.name];
  const pj = readPkg(t.dir);
  if (app?.start) {
    const [command, ...args] = app.start.split(/\s+/);
    return { target: t.name, cwd: t.dir, command, args, url: p => (app.url ?? 'http://127.0.0.1:{port}/').replace('{port}', String(p)), how: `apps["${t.name}"].start` };
  }
  if (!pj) return { target: t.name, reason: 'no package.json' };
  const dev = pj.scripts?.dev ?? '';
  const deps = { ...(pj.dependencies ?? {}), ...(pj.devDependencies ?? {}) };
  const url = (p: number) => (app?.url ?? 'http://127.0.0.1:{port}/').replace('{port}', String(p));
  // Call the framework directly so the port is ours, whatever the script adds.
  if (/\bvite\b/.test(dev) || (deps.vite && !dev)) return { target: t.name, cwd: t.dir, command: 'npx', args: ['vite', '--port', '{port}', '--strictPort', '--host', '127.0.0.1'], url, how: 'vite' };
  if (/\bnext\b/.test(dev)) return { target: t.name, cwd: t.dir, command: 'npx', args: ['next', 'dev', '-p', '{port}', '-H', '127.0.0.1'], url, how: 'next dev' };
  if (/\bastro\b/.test(dev)) return { target: t.name, cwd: t.dir, command: 'npx', args: ['astro', 'dev', '--port', '{port}', '--host', '127.0.0.1'], url, how: 'astro dev' };
  if (/storybook dev/.test(dev)) return { target: t.name, cwd: t.dir, command: 'npx', args: ['storybook', 'dev', '-p', '{port}', '--ci', '--no-open'], url, how: 'storybook dev' };
  if (dev) return { target: t.name, cwd: t.dir, command: 'npm', args: ['run', 'dev', '--', '--port', '{port}'], url, how: 'npm run dev' };
  return { target: t.name, reason: 'no dev script or known framework' };
}

const readPkg = (dir: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } };

export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = net.createServer();
    s.unref();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); });
  });
}

/** Installed here, or hoisted to a workspace root above (npm, pnpm and yarn workspaces install there). */
export function hasDeps(dir: string): boolean {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'node_modules'))) return true;
    if (fs.existsSync(path.join(d, '.git')) || path.dirname(d) === d) return false;
  }
}

export interface RunningApp { url: string; stop: () => void; logTail: () => string }

/** Start an app and wait until it serves. Throws with the app's own output if it doesn't come up. */
export async function startApp(plan: AppPlan, timeoutMs = 90000): Promise<RunningApp> {
  if (!hasDeps(plan.cwd)) throw new Error(`${plan.target}: dependencies aren't installed in ${plan.cwd}. Run "dsa setup" (or npm install there).`);
  const port = await freePort();
  const args = plan.args.map(a => a.replace('{port}', String(port)));
  let out = '';
  const child: ChildProcess = spawn(plan.command, args, { cwd: plan.cwd, env: { ...process.env, BROWSER: 'none', CI: '1', FORCE_COLOR: '0' }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (b: Buffer) => { out = (out + b.toString()).slice(-4000); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  let exited = false;
  child.on('exit', () => { exited = true; });
  const stop = () => {
    if (exited) return;
    try { process.platform !== 'win32' ? process.kill(-child.pid!, 'SIGTERM') : child.kill(); } catch { /* already gone */ }
  };
  // Don't leave dev servers behind if the scan is interrupted.
  const onExit = () => stop();
  process.once('exit', onExit);
  process.once('SIGINT', () => { stop(); process.exit(130); });
  const url = plan.url(port);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) break;
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) return { url, stop: () => { stop(); process.removeListener('exit', onExit); }, logTail: () => out }; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  stop();
  throw new Error(`${plan.target} didn't start with ${plan.how} (${plan.command} ${args.join(' ')}):\n${out.split('\n').slice(-12).join('\n')}`);
}

/**
 * Routes from the source: hash routes ('#/materials'), router paths (path: '/materials',
 * <Route path="/x">), href="/x" literals, and the app's other HTML pages (labs, demos).
 * Test files count: they're where concrete detail routes live ('#/material/1').
 *
 * Ordered for a page budget: other HTML pages, one detail route per kind, one route per section,
 * then the rest. A hash-routed app drops plain paths (they'd all load the same home page).
 */
export function discoverRoutes(dir: string, exclude: string[] = []): string[] {
  const hash = new Set<string>(), paths = new Set<string>();
  let hashRouter = false;
  const files = walk(dir, new Set(['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte']), exclude, true).slice(0, 6000);
  // React Router's route config (app/routes.ts): every route it declares, those that need no value.
  for (const r of routeConfig(dir, files).routes) paths.add(r);
  for (const f of files) {
    let src: string;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (/createHashRouter|HashRouter|location\.hash|hashchange/.test(src)) hashRouter = true;
    for (const m of src.matchAll(/['"`](#\/[\w\-/.]*)['"`]/g)) hash.add(m[1]);
    for (const m of src.matchAll(/\bpath\s*[:=]\s*['"`](\/[\w\-/.]*)['"`]/g)) paths.add(m[1]);
    for (const m of src.matchAll(/\bhref\s*=\s*['"](\/[\w\-/.]*)['"]/g)) paths.add(m[1]);
  }
  const junk = (r: string) => r.includes(':') || /\.\.|…/.test(r) || /\.(png|jpe?g|svg|css|js|json|ico|pdf)$/.test(r) || /\/$/.test(r) && r.length > 2;
  // A deep detail route from a test (#/print/PRT-0142/where-used) implies the record's own page too.
  for (const r of [...hash]) { const m = r.match(/^(#\/[\w-]+\/[\w-]*\d[\w-]*)\/.+/); if (m) hash.add(m[1]); }
  const routes = [...hash, ...(hashRouter && hash.size >= 3 ? [] : paths)].filter(r => !junk(r));
  const pages = htmlPages(dir).map(f => path.relative(dir, f).split(path.sep).join('/')).filter(p => p !== 'index.html').map(p => '/' + p);
  const segs = (r: string) => r.replace(/^#?\//, '').split('/').filter(Boolean);
  const isDetail = (r: string) => segs(r).length >= 2 && /\d|-/.test(segs(r)[segs(r).length - 1]) && !/^(table|grid|gallery|list|board)$/.test(segs(r)[1]);
  const byLen = [...routes].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const out: string[] = [];
  const take = (r: string) => { if (!out.includes(r)) out.push(r); };
  // Detail pages first: one record per kind. That's where edit modes, media dialogs, and side panels live.
  const kinds = new Set<string>();
  for (const r of byLen) { if (isDetail(r) && !kinds.has(segs(r)[0])) { kinds.add(segs(r)[0]); take(r); } }
  const sections = new Set<string>();
  for (const r of byLen) { const s0 = segs(r)[0] ?? ''; if (!sections.has(s0) && !isDetail(r)) { sections.add(s0); take(r); } }
  for (const r of byLen) take(r);
  return [...pages, ...out].slice(0, 150);
}

/**
 * React Router's route config (`app/routes.ts`, built with route(), index(), layout() and prefix() from
 * `@react-router/dev/routes`), read from its source. `routes` are the paths a crawler can open as they are;
 * `needsValue` are the ones with a parameter (`:id`) or a splat (`*`), which need a real value to open:
 * list one in apps["name"].routes. An optional segment (`:lang?`, `edit?`) is opened without it.
 */
export function routeConfig(dir: string, files?: string[]): { file: string | null; routes: string[]; needsValue: string[] } {
  const list = files ?? walk(dir, new Set(['.ts', '.tsx', '.js', '.jsx']), [], true).slice(0, 6000);
  const out = { file: null as string | null, routes: [] as string[], needsValue: [] as string[] };
  for (const f of list) {
    if (!/routes\.[jt]sx?$/.test(f)) continue;
    let src: string;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!/@react-router\/dev\/routes/.test(src)) continue;
    out.file = f;
    const at = src.search(/export\s+default\s*\[|=\s*\[/);
    if (at < 0) continue;
    const open = src.indexOf('[', at);
    const found = new Set<string>(), params = new Set<string>();
    walkRoutes(src, open, '', found, params);
    out.routes.push(...found);
    out.needsValue.push(...params);
  }
  out.routes = [...new Set(out.routes)].sort();
  out.needsValue = [...new Set(out.needsValue)].sort();
  return out;
}

/** Read the array at `open` ("[…]"): each route(), index(), layout(), prefix() call, nested ones under their path. */
function walkRoutes(src: string, open: number, base: string, found: Set<string>, params: Set<string>) {
  const close = matching(src, open);
  if (close < 0) return;
  let i = open + 1;
  while (i < close) {
    const m = /(?:\.\.\.\s*)?\b(route|index|layout|prefix)\s*\(/y;
    m.lastIndex = i;
    const hit = m.exec(src);
    if (!hit) { i = skip(src, i); continue; }
    const argsOpen = m.lastIndex - 1, argsClose = matching(src, argsOpen);
    if (argsClose < 0) return;
    const args = splitArgs(src, argsOpen + 1, argsClose);
    const str = (a?: { start: number; end: number }) => { const t = a ? src.slice(a.start, a.end).trim() : ''; const q = t.match(/^(['"`])(.*)\1$/s); return q ? q[2]! : null; };
    const child = (a?: { start: number; end: number }) => { if (!a) return -1; const t = src.slice(a.start, a.end).trimStart(); return t.startsWith('[') ? a.start + src.slice(a.start, a.end).indexOf('[') : -1; };
    const kind = hit[1];
    if (kind === 'index') add(base, found, params);
    else if (kind === 'route') {
      const p = str(args[0]);
      const here = p == null ? base : join(base, p);
      if (p != null) add(here, found, params);
      const kids = args.slice(2).map(child).find(x => x >= 0);
      if (kids != null && kids >= 0) walkRoutes(src, kids, here, found, params);
    } else if (kind === 'layout') {
      const kids = args.slice(1).map(child).find(x => x >= 0);
      if (kids != null && kids >= 0) walkRoutes(src, kids, base, found, params);
    } else if (kind === 'prefix') {
      const p = str(args[0]);
      const kids = args.slice(1).map(child).find(x => x >= 0);
      if (kids != null && kids >= 0) walkRoutes(src, kids, p == null ? base : join(base, p), found, params);
    }
    i = argsClose + 1;
  }
}

const join = (a: string, b: string) => ('/' + [a, b].join('/').split('/').filter(Boolean).join('/'));
/** A route path: optional segments dropped; one with a :param or a splat needs a value. */
function add(p: string, found: Set<string>, params: Set<string>) {
  const segs = p.split('/').filter(Boolean);
  const kept = segs.filter(s => !s.endsWith('?'));
  if (kept.some(s => s.startsWith(':') || s === '*')) { params.add('/' + segs.join('/')); return; }
  found.add('/' + kept.join('/'));
  if (segs.some(s => s.endsWith('?') && !s.startsWith(':'))) found.add('/' + segs.map(s => s.replace(/\?$/, '')).join('/'));
}

/** Past one character, string or comment. */
function skip(src: string, i: number): number {
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') { let j = i + 1; while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1; return j + 1; }
  if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); return j < 0 ? src.length : j; }
  if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); return j < 0 ? src.length : j + 2; }
  return i + 1;
}

/** The index of the bracket that closes the one at `open` ((, [ or {), strings and comments skipped. */
function matching(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < src.length;) {
    const c = src[i]!;
    if (pairs[c]) { stack.push(pairs[c]!); i++; continue; }
    if (c === ')' || c === ']' || c === '}') { if (stack.pop() !== c) return -1; if (!stack.length) return i; i++; continue; }
    i = skip(src, i);
  }
  return -1;
}

/** The top-level arguments between `from` and `to`, as spans. */
function splitArgs(src: string, from: number, to: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = from;
  for (let i = from; i < to;) {
    const c = src[i]!;
    if (c === '(' || c === '[' || c === '{') { const j = matching(src, i); i = j < 0 ? to : j + 1; continue; }
    if (c === ',') { out.push({ start, end: i }); start = i + 1; i++; continue; }
    i = skip(src, i);
  }
  if (src.slice(start, to).trim()) out.push({ start, end: to });
  return out;
}

/** Make sure Playwright's Chromium is installed; install it once if not. */
export async function ensureBrowser(log: (m: string) => void = () => {}): Promise<any> {
  let pw: any;
  try { const mod = 'playwright'; pw = await import(mod); } catch {
    throw new Error('Playwright is missing: install @snds/dsa-review with its dependencies (npm install @snds/dsa-review).');
  }
  try {
    const b = await pw.chromium.launch();
    await b.close();
  } catch (e: any) {
    if (!/Executable doesn't exist|browserType.launch|install/i.test(String(e?.message))) throw e;
    // One install at a time on this machine: two at once write the same folder and leave a broken browser.
    await withInstallLock(async () => {
      try { const b = await pw.chromium.launch(); await b.close(); return; } catch { /* still missing: install it */ }
      log('Installing the headless browser for screenshots (one time, ~150 MB)…');
      const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
      const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('Could not install Chromium for Playwright. Run "npx playwright install chromium".');
    });
  }
  return pw;
}

/** Run `fn` holding a machine-wide lock file (a stale lock older than 10 minutes is taken over). */
async function withInstallLock(fn: () => Promise<void>): Promise<void> {
  const lock = path.join(os.tmpdir(), 'dsa-playwright-install.lock');
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10 * 60_000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error(`Another browser install holds ${lock}. Remove it if no install is running.`);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  try { await fn(); } finally { fs.rmSync(lock, { force: true }); }
}

/** Install an app's dependencies if they're missing (setup only; scans never install on their own). */
export function installAppDeps(plan: AppPlan, log: (m: string) => void): boolean {
  if (hasDeps(plan.cwd)) return true;
  const lock = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].find(f => fs.existsSync(path.join(plan.cwd, f)));
  const [cmd, args] = lock === 'pnpm-lock.yaml' ? ['pnpm', ['install', '--frozen-lockfile']] : lock === 'yarn.lock' ? ['yarn', ['install', '--frozen-lockfile']] : ['npm', [lock ? 'ci' : 'install', '--no-audit', '--no-fund']];
  log(`Installing ${plan.target} dependencies (${cmd} ${(args as string[]).join(' ')})…`);
  return spawnSync(cmd, args as string[], { cwd: plan.cwd, stdio: 'inherit' }).status === 0;
}

/**
 * A child library in its own repo often consumes the core through a local link
 * ("@acme/ui": "file:./vendor/acme/packages/ui"). In a fresh clone that link is missing, so the
 * app can't install or start. Point it at the host repo (the core) when the package is a core package.
 */
export function linkCoreForChild(childDir: string, hostRoot: string, corePackages: string[], log: (m: string) => void) {
  const pj = readPkg(childDir);
  if (!pj) return;
  const deps = { ...(pj.dependencies ?? {}), ...(pj.devDependencies ?? {}) } as Record<string, string>;
  for (const [name, spec] of Object.entries(deps)) {
    if (!corePackages.includes(name) || !spec.startsWith('file:')) continue;
    const rel = spec.slice(5);
    if (fs.existsSync(path.resolve(childDir, rel))) continue;
    // file:./vendor/acme/packages/ui → link ./vendor/acme to the host root if the rest exists there.
    const parts = rel.replace(/^\.\//, '').split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const inHost = path.join(hostRoot, ...parts.slice(i));
      if (fs.existsSync(inHost)) {
        const linkAt = path.resolve(childDir, ...parts.slice(0, i));
        let present = false;
        try { fs.lstatSync(linkAt); present = true; } catch { /* free */ }
        if (present) { log(`${path.relative(childDir, linkAt)} exists but doesn't contain ${name}; leaving it alone.`); break; }
        fs.mkdirSync(path.dirname(linkAt), { recursive: true });
        fs.symlinkSync(hostRoot, linkAt, 'dir');
        log(`Linked ${path.relative(childDir, linkAt)} → ${hostRoot} so ${name} resolves to this core checkout.`);
        break;
      }
    }
  }
}
