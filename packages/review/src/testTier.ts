import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEDGER_RUNTIME } from '@snds/dsa/tag';
import { packageEntry } from './apps.js';

/**
 * The app's own component tests as a render tier. Many states the crawler can't reach (a dialog a socket
 * opens, an editor with a picked image, an empty list) are exactly what an app's component tests render. So,
 * before the crawl, the app's tests run with Vitest from the app's own folder and its own config, plus:
 *
 * - dsa's tagger, so each element they render carries its source tag;
 * - a setup file, first among the app's, that installs the ledger runtime before React loads and appends what
 *   it records to a file, each record named by its test ("test:<file> › <test>"), not a URL.
 *
 * Nothing in the app is written: the tests run from a copy of the app in the system's temp folder (its files
 * copied, its node_modules linked, every link pointing where the original's does), with Vite's cache there
 * too, so neither Vitest nor what the app's own tests write lands in the app. The tagger names the copy's
 * files as the originals (DSA_TAG_COPY), so tags match the scan's. What
 * the tests pass or fail doesn't matter; what they rendered is the evidence. Off by default (shots.renderTests,
 * or DSA_RENDER_TESTS=1): it runs the app's code the way its own `vitest run` would.
 */
export interface TierResult { ran: boolean; why?: string; records: number; files: number; seconds: number; tests?: string; /** Why the tests ran in the app's own DOM stand-in, not a browser. */ browser?: string }

/**
 * Whether the tests could run in a real browser (Vitest's browser mode), where each element has a size and a
 * picture: only with its provider installed in the app, since dsa installs nothing there. Not used yet either
 * way: records come from the app's own test environment (jsdom or happy-dom), so they hold props and state
 * but no sizes.
 */
export function browserMode(appDir: string): string {
  const has = ['@vitest/browser-playwright', '@vitest/browser'].find(p => packageEntry(appDir, p));
  return has
    ? `the app has ${has}, but dsa runs its tests in their own environment for now (records hold props and state, no sizes)`
    : "the app doesn't have @vitest/browser-playwright installed and dsa installs nothing in the app, so its tests ran in their own environment (records hold props and state, no sizes)";
}

export async function renderTests(o: { appDir: string; root: string; dir: string; out: string; maxMinutes?: number | undefined; include?: string[] | undefined; log: (m: string) => void }): Promise<TierResult> {
  const started = Date.now();
  const done = (r: Omit<TierResult, 'seconds'>): TierResult => ({ ...r, seconds: Math.round((Date.now() - started) / 1000), browser: browserMode(o.appDir) });
  const vitest = packageEntry(o.appDir, 'vitest', './node');
  const vitestMain = packageEntry(o.appDir, 'vitest');
  const vite = packageEntry(o.appDir, 'vite');
  if (!vitest || !vitestMain || !vite) return done({ ran: false, why: "the app doesn't have Vitest installed", records: 0, files: 0 });
  const core = packageEntry(path.dirname(fileURLToPath(import.meta.url)), '@snds/dsa', './tag');
  if (!core) return done({ ran: false, why: "dsa's tagger wasn't found", records: 0, files: 0 });
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-tests-')));
  const copy = path.join(tmp, path.basename(o.appDir));
  copyApp(o.appDir, copy);
  const runner = path.join(tmp, 'run.mjs');
  const setup = path.join(tmp, 'ledger-setup.mjs');
  fs.writeFileSync(runner, VITEST_TAGGED);
  // The setup file sits outside the app, so it imports the app's own Vitest by its path, not by name.
  fs.writeFileSync(setup, SETUP.replace('/*LEDGER_RUNTIME*/', () => LEDGER_RUNTIME).replace('"vitest"', () => JSON.stringify(pathToFileURL(vitestMain).href)));
  fs.rmSync(o.out, { force: true });
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  const env = {
    ...process.env, NODE_ENV: 'test',
    DSA_TAG: '1', DSA_TAG_ROOT: o.root, DSA_TAG_DIR: o.dir, DSA_TAG_USES: '1', DSA_TAG_COPY: JSON.stringify([copy, o.appDir]),
    DSA_APP_DIR: fs.realpathSync(o.appDir),
    DSA_VITEST_NODE: pathToFileURL(vitest).href, DSA_TAG_MODULE: pathToFileURL(core).href,
    DSA_TAG_VITE: pathToFileURL(vite).href, DSA_LEDGER_DIR: tmp, DSA_LEDGER_SETUP: setup, DSA_LEDGER_TESTS: o.out, DSA_TEST_INCLUDE: JSON.stringify(o.include ?? []),
  };
  const ms = (o.maxMinutes ?? 10) * 60_000;
  let tail = '';
  // The whole run's output, kept beside the records (`<out>.log`), for whoever needs to see why.
  const log = fs.createWriteStream(`${o.out}.log`);
  const code = await new Promise<number | 'timeout'>((resolve) => {
    const child = spawn(process.execPath, [runner], { cwd: copy, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (b: Buffer) => { tail = (tail + b.toString()).slice(-4000); log.write(b); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, ms);
    child.on('close', (c) => { clearTimeout(timer); resolve(c ?? 1); });
    child.on('error', () => { clearTimeout(timer); resolve(1); });
  });
  log.end();
  if (!process.env.DSA_KEEP_COPY) fs.rmSync(tmp, { recursive: true, force: true }); else o.log(`  tests: copy kept at ${tmp}`);
  let lines: string[] = [];
  try { lines = fs.readFileSync(o.out, 'utf8').split('\n').filter(Boolean); } catch { /* none recorded */ }
  const files = new Set(lines.map(l => { try { return String(JSON.parse(l).src).replace(/:\d+:\d*$/, ''); } catch { return ''; } }).filter(Boolean));
  const tests = tail.match(/Test Files\s+([^\n]+)/)?.[1]?.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!lines.length) return done({ ran: code !== 'timeout', why: code === 'timeout' ? `out of time (${o.maxMinutes ?? 10} min)` : `nothing recorded${tests ? ` (test files: ${tests})` : ''}; the run's last words: ${lastWords(tail)}`, records: 0, files: 0, ...(tests ? { tests } : {}) });
  return done({ ran: true, records: lines.length, files: files.size, ...(code === 'timeout' ? { why: `out of time (${o.maxMinutes ?? 10} min); what ran so far is kept` } : {}), ...(tests ? { tests } : {}) });
}

/** Folders a copy of the app leaves out: installed packages (linked instead), history, builds and caches. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.vite', '.turbo', '.next', '.cache', '.dsa']);

/** A copy of the app to run its tests from: files copied, node_modules linked, links pointing where the original's do. */
function copyApp(from: string, to: string) {
  const walk = (a: string, b: string) => {
    fs.mkdirSync(b, { recursive: true });
    for (const d of fs.readdirSync(a, { withFileTypes: true })) {
      const src = path.join(a, d.name), dst = path.join(b, d.name);
      if (d.name === 'node_modules') { try { fs.symlinkSync(fs.realpathSync(src), dst, 'dir'); } catch { /* none */ } continue; }
      if (SKIP.has(d.name)) continue;
      if (d.isSymbolicLink()) { try { const t = fs.realpathSync(src); fs.symlinkSync(t, dst, fs.statSync(t).isDirectory() ? 'dir' : 'file'); } catch { /* a broken link */ } continue; }
      if (d.isDirectory()) walk(src, dst);
      else if (d.isFile()) fs.copyFileSync(src, dst);
    }
  };
  walk(from, to);
}

/** The end of a run's output, plain: what a person needs to see why nothing was recorded. */
const lastWords = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(l => l.trim()).filter(l => l && !/^[·×✓\s-]+$/.test(l)).slice(-6).join(' / ').slice(0, 600);

/**
 * Run by renderTests, in the app's folder: Vitest with the app's own config, the tagger among its plugins and
 * the ledger's setup file first among its setup files. Fixed text; the paths come in the environment.
 */
const VITEST_TAGGED = `const { startVitest } = await import(process.env.DSA_VITEST_NODE);
const { searchForWorkspaceRoot } = await import(process.env.DSA_TAG_VITE);
const { dsaTag } = await import(process.env.DSA_TAG_MODULE);
const setup = process.env.DSA_LEDGER_SETUP;
const first = (s) => [setup, ...(s == null ? [] : Array.isArray(s) ? s : [s]).filter((x) => x !== setup)];
// First among the setup files: React has to find the ledger's hook before it loads.
const ledgerFirst = {
  name: 'dsa:ledger-first', enforce: 'post',
  config(c) {
    c.test = c.test || {}; c.test.setupFiles = first(c.test.setupFiles);
    // The setup file sits in a temp folder: served, as well as what the app's server serves already.
    c.server = c.server || {}; c.server.fs = c.server.fs || {};
    // Served too: the app's own folder, where the copy's links (node_modules, a linked checkout) lead. A test
    // run's server answers no one but Vitest, so files anywhere the links lead are let through.
    c.server.fs.allow = [...(c.server.fs.allow || [searchForWorkspaceRoot(c.root || process.cwd())]), process.env.DSA_LEDGER_DIR, process.env.DSA_APP_DIR];
    c.server.fs.strict = false;
    // Vite's and Vitest's caches in the temp folder, never under the app's node_modules (a link to the app's own).
    c.cacheDir = process.env.DSA_LEDGER_DIR + '/vite-cache';
  },
  configResolved(c) { if (c.test) c.test.setupFiles = first(c.test.setupFiles); },
};
const include = JSON.parse(process.env.DSA_TEST_INCLUDE || '[]');
const ctx = await startVitest('test', include, { watch: false, run: true, reporters: ['dot'], passWithNoTests: true, coverage: { enabled: false } }, { plugins: [dsaTag({ when: true }), ledgerFirst] });
await ctx?.close();
process.exit(0);
`;

/** The setup file: where to send records, how to name them, then the ledger runtime itself. */
const SETUP = `import fs from 'node:fs';
import path from 'node:path';
import { expect } from "vitest";
if (typeof window !== 'undefined') {
  window.__dsaLedgerSync = true;
  window.__dsaLedgerWhere = () => { const s = expect.getState(); return 'test:' + path.relative(process.cwd(), s.testPath || '') + (s.currentTestName ? ' › ' + s.currentTestName : ''); };
  window.__dsaLedgerPut = (batch) => { try { fs.appendFileSync(process.env.DSA_LEDGER_TESTS, batch.map((r) => JSON.stringify(r)).join('\\n') + '\\n'); } catch {} };
  /*LEDGER_RUNTIME*/
}
`;
