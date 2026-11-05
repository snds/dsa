import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { labelsJsonl, readLabels, type AddonApi, type Label } from '@snds/dsa';
import { allDsPackages, resolveTargets } from '@snds/dsa/engine';
import { bench, benchText, defaultsFrom, repeatability, sealedOf, splitLabels, type Defaults } from './bench.js';
import { PROBE_CARDS, type CardFacts } from './card-dom.js';
import { historyLabels, migratedLabels, reviewQueue, stripTargets } from './labels.js';
import { renderReport } from './report.js';

/** The data a page carries (the report payload), from a published folder or a report file. */
export function payloadOf(siteOrFile: string): any {
  const file = fs.statSync(siteOrFile).isDirectory() ? path.join(siteOrFile, 'index.html') : siteOrFile;
  const m = fs.readFileSync(file, 'utf8').match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s);
  if (!m) throw new Error(`${file} isn't a dsa page: it carries no data.`);
  return JSON.parse(m[1]!);
}

/** What each card on a published page shows, read in a headless browser (needs @snds/dsa-review). */
export async function cardsOf(siteDir: string, log: (m: string) => void): Promise<CardFacts[] | null> {
  let review: any;
  try { const name = '@snds/dsa-review'; review = await import(name); } catch { log('Card checks untested: they need @snds/dsa-review (a headless browser).'); return null; }
  return review.onReviewPage(siteDir, PROBE_CARDS, { click: true }, log);
}

function loadLabels(file: string, out: (m: string) => void): Label[] {
  const { labels, errors } = readLabels(file);
  for (const e of errors.slice(0, 20)) out(`${file}:${e.line}: ${e.message}`);
  if (errors.length) throw new Error(`${errors.length} label line${errors.length === 1 ? '' : 's'} in ${file} don't match the schema (schema/label.json).`);
  return labels;
}

export function benchCommands(program: Command, api: AddonApi) {
  program
    .command('bench')
    .description('is dsa right, and can a person see it? Presentation (the trust rubric, from the rendered cards) and correctness (against labels.jsonl), never merged; with more than one --site, how much repeated runs agree')
    .option('--labels <file>', 'ground truth, one label per line (schema/label.json)')
    .option('--site <dir...>', 'published dashboards (dsa publish) to score; the first is benched, all of them are compared for repeatability (default: a report of the latest run)')
    .option('--no-cards', "don't open the pages in a browser: card checks stay untested")
    .option('--ready <n>', 'the ready bar (default: the report threshold)')
    .option('--folds <n>', 'also report held-out precision at the ready bar, labels split into n folds by file')
    .option('--fold-site <path...>', 'per fold, a published page or report file of a run calibrated without that fold (dsa labels split)')
    .option('--signatures <file>', "the run's signatures.json, for each component's defaults (default: the data folder's, when not scoring --site)")
    .action(async (o: { labels?: string; site?: string[]; cards: boolean; ready?: string; folds?: string; foldSite?: string[]; signatures?: string }, cmd: Command) => {
      // --json is the CLI's own option (dsa --json bench, or dsa bench --json).
      const json = Boolean((cmd.optsWithGlobals() as { json?: boolean }).json);
      const labels = o.labels ? loadLabels(path.resolve(api.cwd, o.labels), api.out) : null;
      const threshold = o.ready ? Number(o.ready) : undefined;
      let payloads: any[], dirs: (string | undefined)[], cards: (CardFacts[] | null)[];
      let sigFile = o.signatures ? path.resolve(api.cwd, o.signatures) : undefined;
      if (o.site?.length) {
        dirs = o.site.map((s) => path.resolve(api.cwd, s));
        payloads = dirs.map((d) => payloadOf(d!));
        cards = [];
        for (const d of dirs) cards.push(o.cards ? await cardsOf(d!, api.out) : null);
      } else {
        const ctx = await api.context(cmd);
        await api.requireStore('bench');
        payloads = [payloadOf(await writeTemp(await renderReport(ctx.root, ctx.config, ctx.dataDir, ctx.profile)))];
        sigFile ??= path.join(ctx.dataDir, 'signatures.json');
        dirs = [undefined]; cards = [null];
      }
      const folds = o.folds ? Number(o.folds) : undefined;
      const foldPayloads = o.foldSite?.length ? o.foldSite.map((f) => payloadOf(path.resolve(api.cwd, f))) : null;
      let defaults: Defaults | undefined;
      try { if (sigFile) defaults = defaultsFrom(JSON.parse(fs.readFileSync(sigFile, 'utf8'))); } catch { /* no signatures: "default" values count as unset */ }
      const b = bench(payloads[0], labels, { cards: cards[0] ?? null, ...(dirs[0] ? { dir: dirs[0] } : {}), ...(threshold != null ? { threshold } : {}), ...(folds ? { folds, foldPayloads } : {}), ...(defaults ? { defaults } : {}) });
      const rep = payloads.length > 1 ? repeatability(payloads, { cards, dirs, ...(threshold != null ? { threshold } : {}) }) : null;
      api.out(json ? JSON.stringify({ ...b, repeatability: rep }, null, 1) : benchText(b, rep));
    });

  const labels = program.command('labels').description('ground truth for dsa bench: check a labels file, or bootstrap labels from code that already answers');
  labels
    .command('check <file>')
    .description('validate a labels.jsonl file against schema/label.json')
    .action((file: string) => {
      const { labels: ls, errors } = readLabels(path.resolve(api.cwd, file));
      for (const e of errors) api.out(`${file}:${e.line}: ${e.message}`);
      api.out(`${ls.length} labels${errors.length ? `, ${errors.length} bad lines` : ', all valid'}.`);
      if (errors.length) process.exitCode = 1;
    });
  labels
    .command('split <file>')
    .description('write training and held-out label files for k-fold cross-validation by file: calibrate a run on each training file, then dsa bench --folds k --fold-site <runs>')
    .requiredOption('--out <prefix>', 'writes <prefix>.train-<k>.jsonl and <prefix>.test-<k>.jsonl')
    .option('--folds <n>', 'how many folds', '2')
    .option('--seal <share>', 'first set aside a sealed test set (this share of files, by a salted hash of app and file): writes <prefix>.sealed.jsonl and <prefix>.open.jsonl, and folds only the open part')
    .action((file: string, o: { out: string; folds: string; seal?: string }) => {
      let all = loadLabels(path.resolve(api.cwd, file), api.out);
      if (o.seal) {
        const share = Number(o.seal);
        const sealed = all.filter((l) => sealedOf(l, share));
        all = all.filter((l) => !sealedOf(l, share));
        writeLabels(path.resolve(api.cwd, `${o.out}.sealed.jsonl`), sealed);
        writeLabels(path.resolve(api.cwd, `${o.out}.open.jsonl`), all);
        api.out(`sealed ${sealed.length}, open ${all.length} (share ${share} of files by hash).`);
      }
      const parts = splitLabels(all, Number(o.folds));
      parts.forEach((p, k) => {
        writeLabels(path.resolve(api.cwd, `${o.out}.train-${k}.jsonl`), p.train);
        writeLabels(path.resolve(api.cwd, `${o.out}.test-${k}.jsonl`), p.test);
        api.out(`fold ${k}: ${p.train.length} training, ${p.test.length} held out.`);
      });
    });
  labels
    .command('migrated')
    .description("strip every system component in each app back to the markup it renders, in a copy, and label each with what was there; then scan the copy and bench it")
    .requiredOption('--work <dir>', 'where the stripped copies, their config and their data go (outside the apps)')
    .requiredOption('--out <file>', 'the labels to write (labels.jsonl)')
    .option('--app <names...>', 'only these apps')
    .action(async (o: { work: string; out: string; app?: string[] }, cmd: Command) => {
      const ctx = await api.context(cmd);
      const configFile = ctx.loaded.configPath;
      if (!configFile) throw new Error('dsa labels migrated needs a dsa.config.json to copy for the stripped apps.');
      const r = migratedLabels({ root: ctx.root, config: ctx.config, configFile, workDir: path.resolve(api.cwd, o.work), ...(o.app ? { apps: o.app } : {}) });
      writeLabels(path.resolve(api.cwd, o.out), r.labels);
      for (const a of r.apps) api.out(`${a.name}: ${a.stripped} components stripped in ${a.files} files -> ${a.to}`);
      api.out(`${r.labels.length} labels -> ${o.out}. Next: dsa run --config ${r.config} --root ${r.root} --no-shots, then dsa bench --config ${r.config} --root ${r.root} --labels ${o.out}.`);
    });
  labels
    .command('history')
    .description('label raw elements that a commit later turned into a system component, at the commit before')
    .requiredOption('--out <file>', 'the labels to write (labels.jsonl)')
    .option('--app <names...>', 'only these apps')
    .option('--max <n>', 'commits to read per app', '2000')
    .action(async (o: { out: string; app?: string[]; max: string }, cmd: Command) => {
      const ctx = await api.context(cmd);
      const targets = stripTargets(ctx.root, ctx.config);
      const packages = allDsPackages(ctx.config);
      const all: Label[] = [];
      for (const t of resolveTargets(ctx.root, ctx.config).filter((x) => x.role === 'consumer' && ctx.config.apps?.[x.name]?.lookalikes !== false && (!o.app || o.app.includes(x.name)))) {
        const r = historyLabels({ app: t, targets, packages, maxCommits: Number(o.max) });
        api.out(`${t.name}: ${r.labels.length} labels from ${r.commits} commits${r.shallow ? ' (a shallow clone: its history is cut off)' : ''}.`);
        all.push(...r.labels);
      }
      writeLabels(path.resolve(api.cwd, o.out), all);
      api.out(`${all.length} labels -> ${o.out}.`);
    });
  labels
    .command('queue')
    .description("what people should check: where dsa and the labels (or a second judge) disagree, plus a random audit of the rest")
    .requiredOption('--labels <file>', 'labels.jsonl')
    .requiredOption('--site <dir>', 'the published dashboard to compare with')
    .requiredOption('--out <file>', 'the queue to write (JSONL)')
    .option('--judge <file>', "a second judge's labels (another model, another person)")
    .option('--audit <share>', 'share of agreeing labels to audit at random', '0.1')
    .option('--seed <text>', 'the random draw (same seed, same audit)', 'dsa')
    .action((o: { labels: string; site: string; out: string; judge?: string; audit: string; seed: string }) => {
      const q = reviewQueue({ labels: loadLabels(path.resolve(api.cwd, o.labels), api.out), payload: payloadOf(path.resolve(api.cwd, o.site)), ...(o.judge ? { judge: loadLabels(path.resolve(api.cwd, o.judge), api.out) } : {}), audit: Number(o.audit), seed: o.seed });
      const file = path.resolve(api.cwd, o.out);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, q.items.map((x) => JSON.stringify(x)).join('\n') + (q.items.length ? '\n' : ''));
      api.out(`${q.items.length} to check (${q.disagree} disagree, ${q.audited} audit) -> ${o.out}. ${q.needsEvidence} need evidence before review and are left out.`);
    });
}

function writeLabels(file: string, labels: Label[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, labelsJsonl(labels));
}

async function writeTemp(html: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'dsa-bench-'));
  const f = path.join(dir, 'index.html');
  fs.writeFileSync(f, html);
  return f;
}
