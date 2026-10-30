import type { Command } from 'commander';
import { defineAddon, type PipelineStage } from '@snds/dsa';
import { figmaEnabled, figmaToken } from '@snds/dsa/engine';
import { crawlFigma, figmaFetcher, type Fetcher } from './crawl.js';

export { crawlFigma, figmaFetcher, figmaWhoAmI, parseFigmaUrl, type Fetcher, type FigmaCrawlDiag } from './crawl.js';

/**
 * The Figma crawl as a "scan" stage of `dsa run`. It runs by itself when modules.figma is on and a
 * token and at least one library are set (Settings, or FIGMA_TOKEN). `--figma` forces an attempt (and
 * says what's missing); `--no-figma` skips it. Tests pass a fetcher function as the figma option.
 */
export const figmaStage: PipelineStage = {
  id: 'Figma crawl',
  phase: 'scan',
  async run(ctx) {
    const { config, notes, log, data } = ctx;
    const opt = ctx.options.figma as boolean | Fetcher | undefined;
    if (opt === false) return;
    const token = figmaToken(ctx.dataDir);
    const auto = opt === undefined && figmaEnabled(config) && Boolean(token) && Boolean(config.figma?.libraries?.length);
    if (!(opt === true || typeof opt === 'function' || auto)) return;
    const fetcher = typeof opt === 'function' ? opt : token ? figmaFetcher(token) : null;
    if (!fetcher) { notes.push('Figma crawl skipped: add a Figma token in Settings (or set FIGMA_TOKEN).'); return; }
    if (!config.figma?.libraries?.length) { notes.push('Figma crawl skipped: add at least one library file in Settings.'); return; }
    // A Figma problem (bad token, rate limit) shouldn't cost the code scan.
    try {
      const r = await crawlFigma(config, fetcher, ctx.now);
      data.figma = r.rows;
      data.figmaCrawled = true;
      ctx.sources.figmaDiag = { ...r.diag, crawled: r.filesCrawled };
      log(`Figma: ${r.filesCrawled} files crawled, ${r.skipped.length} skipped as not recently edited`);
      if (!r.diag.sources.files) notes.push('Figma: no design files to scan. Add team, project, or file links under Settings › Figma › Files to scan (library files themselves are not counted as usage).');
      for (const l of r.diag.libraries.filter(l => l.error)) notes.push(`Figma library "${l.name}": ${l.error}`);
      for (const e of r.diag.errors.slice(0, 3)) notes.push(`Figma: ${e}`);
      const failed = r.diag.files.filter(f => f.status === 'error');
      if (failed.length) notes.push(`Figma: ${failed.length} file(s) couldn't be read (first: ${failed[0].name}: ${failed[0].error})`);
    } catch (e: any) {
      ctx.sources.figmaDiag = { error: String(e?.message ?? e).slice(0, 300) };
      notes.push(`Figma crawl failed, code scan kept: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  },
};

export default defineAddon({
  name: '@snds/dsa-figma',
  stages: [figmaStage],
  commands(program: Command) {
    const run = program.commands.find(c => c.name() === 'run');
    run?.option('--figma', "force a Figma crawl and say what's missing (with modules.figma on it runs by itself once a token and a library are set)");
    run?.option('--no-figma', 'skip the Figma crawl this run');
  },
});
