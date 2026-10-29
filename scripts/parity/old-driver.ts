// Runs the analytics suite's pipeline (the old side of a parity run) with what the parity runner sets:
// no git history, no Figma, no registry, a fixed time. Started by run.mjs through the suite's own tsx.
//   tsx old-driver.ts <suite dir> <root> <data dir> <now iso> <readiness on|off>
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [suite, root, dataDir, now, readiness] = process.argv.slice(2) as [string, string, string, string, string];
const { runPipeline } = await import(pathToFileURL(path.join(suite, 'src', 'pipeline.ts')).href);
const res = await runPipeline({ root, dataDir, registry: false, figma: false, git: false, now: new Date(now), readiness: readiness === 'on', log: () => {} });
console.log(JSON.stringify({ runId: res.runId, notes: res.notes }));
