// Builds a published dashboard whose Element Review has real evidence: the acme fixture with the
// review-demo overlay (test/fixtures/review-demo), photographed from its built pages and rendered from
// its built Storybook, as a real system's review runs. Needs `pnpm build` and a headless browser.
//
//   node scripts/review-demo.mjs <out-dir>          writes <out-dir>/index.html and its images
//   node scripts/review-demo.mjs <out-dir> --score  …and prints the trust rubric's score for it
//   … --score --card '{"photoLabels":false}'         scores what an older card showed, on the same data
//   … --tag                                           photographs pages built with source tags (scripts/review-demo-tag.mjs)
//   … --no-harness                                    draws proposals from the Storybook only, not the system's source
//
// The rubric is packages/dashboard/src/trust.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? 'review-demo-site');
const quiet = process.argv.includes('--quiet');
const log = (m) => { if (!quiet) console.log(m); };

const core = await import(path.join(ROOT, 'dist/index.js'));
const engine = await import(path.join(ROOT, 'dist/engine/index.js'));
const hist = await import(path.join(ROOT, 'packages/history/dist/index.js'));
const review = await import(path.join(ROOT, 'packages/review/dist/index.js'));
const dash = await import(path.join(ROOT, 'packages/dashboard/dist/index.js'));
core.registerStore(hist.openDuckStore);

const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-review-demo-')), 'repo');
fs.cpSync(path.join(ROOT, 'test/fixtures/acme-monorepo'), root, { recursive: true });
fs.cpSync(path.join(ROOT, 'test/fixtures/review-demo'), root, { recursive: true });
// What is live: each app's built pages, and the system's built Storybook.
const cfgFile = path.join(root, 'dsa.config.json');
const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
raw.live = { apps: { billing: { dir: 'apps/billing/site' }, checkout: { dir: 'apps/checkout/site' } }, storybook: { dir: 'storybook-static' } };
// Proposals are drawn from the system's own source when Vite and React are installed with it: here, the
// dashboard's own install stands in for the demo's (--no-harness draws from the stories only).
const kit = path.join(ROOT, 'packages/dashboard/ui/node_modules');
if (process.argv.includes('--no-harness')) raw.rendered = { ...(raw.rendered ?? {}), harness: false };
else if (fs.existsSync(path.join(kit, 'vite'))) fs.symlinkSync(kit, path.join(root, 'node_modules'), 'dir');
fs.writeFileSync(cfgFile, JSON.stringify(raw, null, 2));
if (process.argv.includes('--tag')) {
  // The built pages, built again with source tags, so the crawler matches by source line.
  const { tagDemoSites } = await import(path.join(ROOT, 'scripts/review-demo-tag.mjs'));
  const { createRequire } = await import('node:module');
  const req = createRequire(path.join(ROOT, 'packages/review/package.json'));
  const tags = await tagDemoSites(root, { tagSource: (await import(path.join(ROOT, 'dist/tag/index.js'))).tagSource, ts: req(path.join(ROOT, 'node_modules/typescript')), React: req('react'), renderToStaticMarkup: req('react-dom/server').renderToStaticMarkup });
  log(`Source tags: ${Object.entries(tags).map(([a, t]) => `${a} ${t.length}`).join(', ')}`);
}

const loaded = core.loadConfig({ cwd: root });
const profile = core.NEUTRAL_PROFILE;
const config = core.engineConfig(loaded.config, profile);
const dataDir = path.join(root, '.dsa');
const store = (d) => core.openStore(d);
await core.runPipeline({ root, dataDir, config, profile, store, git: false, dsaConfig: loaded.config });
const ctx = { root, dataDir, config, profile, configDir: root, loaded };
await review.shotsAndEvidence(ctx, { perGroup: 3 }, log);
await review.renderSignatures({ root, config, dataDir, log });
await review.renderProposals({ root, config, dataDir, log });
// Again, now that the rendered evidence exists (shots are cached, so nothing is re-captured), then draw
// what the cards now propose, with each element's own content, as `dsa run` does after its screenshots.
await review.shotsAndEvidence(ctx, { perGroup: 3 }, log);
await review.settleProposals({ root, config, dataDir, log });
fs.rmSync(out, { recursive: true, force: true });
await dash.publish(root, config, dataDir, profile, out, null);
log(`Review demo: ${path.join(out, 'index.html')}`);

if (process.argv.includes('--score')) {
  const { trustRubric } = await import(path.join(ROOT, 'packages/dashboard/dist/trust.js'));
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const payload = JSON.parse(html.match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)[1]);
  // --card '{"photoLabels":false,…}' scores what an older card showed, on the same data.
  const at = process.argv.indexOf('--card');
  const card = at > 0 ? { ...(await import(path.join(ROOT, 'packages/dashboard/dist/trust.js'))).CARD, ...JSON.parse(process.argv[at + 1]) } : undefined;
  const { rows, ...score } = trustRubric(payload, { dir: out, card });
  console.log(JSON.stringify({ ...score, failing: rows.filter((r) => !r.pass).map((r) => `${r.target} ${r.id}: ${r.failed.join(' ')}`) }, null, 1));
}
void engine;
