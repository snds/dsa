import path from 'node:path';
import type { Command } from 'commander';
import { defineAddon, type AddonApi } from '@snds/dsa';
import { buildReport } from './report.js';
import { publish } from './publish.js';
import { serve } from './server.js';

export { buildReport, renderReport, type ReportOptions } from './report.js';
export { publish, siteDir } from './publish.js';
export { serve, startServer, readView, saveView, type ServeOptions } from './server.js';
export { buildQueue, createIssues, syncLinks, readState, agentPrompt, PKG_DIR, type QueueItem } from './queue.js';

/** Where `dsa run` and `dsa report` write the single-file report. */
export const reportFile = (dataDir: string) => path.join(dataDir, 'report', 'index.html');

/** `--no-report` on a command the core defines. */
function noReport(program: Command, name: string) {
  program.commands.find(c => c.name() === name)?.option('--no-report', "don't rebuild the HTML report");
}

export default defineAddon({
  name: '@snds/dsa-dashboard',
  afterRun: [
    {
      id: 'Report',
      order: 50,
      async run({ ctx, options, log }) {
        if (options.report === false) return;
        const out = await buildReport(ctx.root, ctx.config, ctx.dataDir, ctx.profile, reportFile(ctx.dataDir));
        log(`Report: ${out}`);
      },
    },
  ],
  commands(program: Command, api: AddonApi) {
    noReport(program, 'run');
    noReport(program, 'reevaluate');

    program
      .command('serve')
      .description('the dashboard on localhost, with live Settings, element review, the action queue and a Run button')
      .option('--port <n>', 'port', '4319')
      .action(async (o: { port: string }, cmd: Command) => {
        await api.context(cmd); // fail early on a bad config or profile
        await serve({ load: () => api.context(cmd), port: Number(o.port), addons: await api.addons(), log: api.out });
      });

    program
      .command('report')
      .description('rebuild the HTML report from the latest run -> <data>/report/index.html')
      .action(async (_o: unknown, cmd: Command) => {
        const ctx = await api.context(cmd);
        await api.requireStore('report');
        api.out(await buildReport(ctx.root, ctx.config, ctx.dataDir, ctx.profile, reportFile(ctx.dataDir)));
      });

    program
      .command('publish')
      .description('the dashboard as a static folder for GitHub Pages or any host (default <data>/site); read-only: live actions need dsa serve')
      .option('--out <dir>', 'where to write the site')
      .action(async (o: { out?: string }, cmd: Command) => {
        const ctx = await api.context(cmd);
        await api.requireStore('publish');
        const r = await publish(ctx.root, ctx.config, ctx.dataDir, ctx.profile, o.out ? path.resolve(api.cwd, o.out) : undefined);
        api.out(`Published ${r.dir}: ${r.shots} screenshots, ${r.rendered} ${ctx.profile.label} renderings, ${(r.bytes / 1e6).toFixed(1)} MB.`);
      });
  },
});
