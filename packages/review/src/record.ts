import path from 'node:path';
import { federate, resolveTargets, type Config } from '@snds/dsa/engine';
import { detectApp, linkCoreForChild, startApp, tagPlan } from './apps.js';

/**
 * An app started for a person to click through, with source tags and the evidence ledger on: what renders as
 * they go (a flow behind a sign-up step, a record picked from a list) is recorded, each element with its URL,
 * the state above it and its owner's props, to a file `dsa shots` reads next time (ledger.ts). Like the
 * crawler's, the app runs from a temp copy, so nothing it writes lands in the app.
 */
export async function recordApp(o: { root: string; dataDir: string; config: Config; target?: string | undefined; out?: string | undefined; log: (m: string) => void }): Promise<{ url: string; out: string; stop: () => void }> {
  const fed = federate(o.root, o.config);
  const apps = resolveTargets(o.root, fed.config).filter(t => t.role !== 'core');
  const t = o.target ? apps.find(a => a.name === o.target) : apps.length === 1 ? apps[0] : undefined;
  if (!t) throw new Error(o.target ? `no app named "${o.target}" here. Apps found: ${apps.map(a => a.name).join(', ') || 'none'}.` : `name the app to record with --target: ${apps.map(a => a.name).join(', ') || 'none found'}.`);
  if (t.role === 'child') linkCoreForChild(t.dir, o.root, fed.config.designSystem.core.packages, o.log);
  const found = detectApp(t, fed.config);
  if ('reason' in found) throw new Error(`${t.name}: ${found.reason}`);
  const out = path.resolve(o.out ?? path.join(o.dataDir, 'shots', 'ledger-lines.jsonl'));
  const before = process.env.DSA_LEDGER;
  process.env.DSA_LEDGER = out;
  try {
    const app = await startApp(tagPlan(found, { root: o.root, dir: t.dir }));
    return { url: app.url, out, stop: app.stop };
  } finally {
    if (before === undefined) delete process.env.DSA_LEDGER; else process.env.DSA_LEDGER = before;
  }
}
