// Runs the analytics suite (the old side of a parity run) the way the parity runner needs it.
// Started by run.mjs through the suite's own tsx.
//   tsx old-driver.ts <suite dir> <root> <data dir> <now iso> <readiness on|off>
//     one run: no git history, no Figma, no registry, a fixed time.
//   tsx old-driver.ts extras <suite dir> <root> <data dir> [shots]
//     what the suite's CLI wrote after runs: screenshots (with "shots", as `dsa shots` did), issue
//     drafts (issues draft), the report, the published site.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const mod = (suite: string, f: string) => import(pathToFileURL(path.join(suite, 'src', f)).href);

if (args[0] === 'extras') {
  const [, suite, root, dataDir, shots] = args as [string, string, string, string, string | undefined];
  const { loadConfig } = await mod(suite, 'config.ts');
  const { Store } = await mod(suite, 'store.ts');
  const { rowToFinding } = await mod(suite, 'evaluate.ts');
  const { writeDrafts } = await mod(suite, 'issues.ts');
  const { buildReport } = await mod(suite, 'report.ts');
  const { publish } = await mod(suite, 'publish.ts');
  const { config } = loadConfig(root);
  if (shots === 'shots') {
    // The suite CLI's shots(): screenshots, re-evaluate on new placement, rendered evidence.
    const { takeShots } = await mod(suite, 'shots.ts');
    const { pagePlacementKey } = await mod(suite, 'placement.ts');
    const { reevaluateElements } = await mod(suite, 'pipeline.ts');
    const { applyRenderedEvidence } = await mod(suite, 'rendered.ts');
    const before = pagePlacementKey(dataDir);
    await takeShots({ root, dataDir, config, url: config.shots?.url, perGroup: Number(config.shots?.perGroup ?? 3), fresh: false, retryMissing: false, log: () => {} });
    if (pagePlacementKey(dataDir) !== before) await reevaluateElements({ root, dataDir, log: () => {} });
    await applyRenderedEvidence(dataDir, config.review?.threshold ?? 0.9);
  }
  // The suite CLI's draftIssues: open findings, drafted fresh.
  const store = await Store.open(dataDir);
  let open: any[] = [];
  try { open = (await store.all('select * from findings where status <> \'resolved\' order by score desc')).map(rowToFinding).filter((f: any) => f.status === 'open'); } finally { store.close(); }
  const dir = path.join(dataDir, 'issues');
  fs.rmSync(dir, { recursive: true, force: true });
  const drafts = writeDrafts(open, dir).length;
  await buildReport(root, config, dataDir, path.join(dataDir, 'report', 'index.html'));
  const site = await publish(root, config, dataDir, path.join(dataDir, 'site'));
  console.log(JSON.stringify({ drafts, site: site.dir }));
} else {
  const [suite, root, dataDir, now, readiness] = args as [string, string, string, string, string];
  const { runPipeline } = await mod(suite, 'pipeline.ts');
  const res = await runPipeline({ root, dataDir, registry: false, figma: false, git: false, now: new Date(now), readiness: readiness === 'on', log: () => {} });
  console.log(JSON.stringify({ runId: res.runId, notes: res.notes }));
}
