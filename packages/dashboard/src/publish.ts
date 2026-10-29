import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '@snds/dsa/engine';

import { renderReport } from './report.js';

import type { ResolvedProfile } from '@snds/dsa';

/**
 * `dsa publish`: the dashboard as a static folder (for GitHub Pages or any static host). One page with
 * the data embedded, plus only the screenshots and system renderings it shows. The live parts (decide,
 * run a scan, ask an agent) say they need `dsa serve`. Default folder: <data>/site.
 */
export const siteDir = (dataDir: string) => path.join(dataDir, 'site');

export async function publish(root: string, config: Config, dataDir: string, profile: ResolvedProfile, outDir = siteDir(dataDir)): Promise<{ dir: string; shots: number; rendered: number; bytes: number }> {
  const html = await renderReport(root, config, dataDir, profile, { site: true });
  // Start clean so images from an older scan don't linger in the commit.
  for (const sub of ['shots', 'rendered']) fs.rmSync(path.join(outDir, sub), { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  let bytes = 0;
  const copied: Record<string, number> = { shots: 0, rendered: 0 };
  for (const sub of ['shots', 'rendered'] as const) {
    const names = new Set([...html.matchAll(new RegExp(`"${sub}/([\\w.-]+\\.png)"`, 'g'))].map(m => m[1]));
    for (const n of names) {
      const from = path.join(dataDir, sub, path.basename(n));
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.join(outDir, sub), { recursive: true });
      fs.copyFileSync(from, path.join(outDir, sub, n));
      bytes += fs.statSync(from).size;
      copied[sub]++;
    }
  }
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  bytes += Buffer.byteLength(html);
  return { dir: outDir, shots: copied.shots, rendered: copied.rendered, bytes };
}
