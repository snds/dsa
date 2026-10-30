import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveProfile, type DsaProfile, type ReadinessProvider } from '@snds/dsa';
import { openStore, runPipeline } from '@snds/dsa/engine';
import { writeSnapshot } from '@snds/dsa-agent';
import { ACME_PROFILE, ACME_ROOT, contextFor, loadConfig, NOW, tmp } from '../../../test/engine/fixture.js';
import { renderReport } from '../src/report.js';

// Agent readiness comes from the profile's provider; its usage checker's details and its reconcile
// (where the checker's raw-element count and the scan's look-alikes differ) reach the report and agents.

test("readiness: a provider's usage metric and reconcile reach the report and the agent snapshot", async () => {
  const usage = { files: 3, clean: 1, errors: 6, warnings: 0, byRule: { 'raw-element': 5 }, byFile: [{ file: 'src/a.tsx', errors: 3, rules: { 'raw-element': 3 } }] };
  const provider: ReadinessProvider = {
    id: 'acme-bench', available: () => true,
    async collect(repos) {
      return repos.filter(r => r.subject === 'checkout').map(r => ({ ...r, mode: 'host', score: 62, tier: 'Invested', kit: true, checks: [], metrics: [{ metric_id: 'usage_checker_errors', value: usage.errors, detail: usage }] }));
    },
    usageMetric: 'usage_checker_errors',
    reconcile: (u, looks) => ({ checkUsage: u.byRule['raw-element'], dsa: looks.length, note: `checker ${u.byRule['raw-element']}, scan ${looks.length}` }),
    benchRuns: async () => [{ id: 'B-1', at: '2026-10-01', repo: 'checkout', rows: [], cells: 2, errored: 0, tasks: [], findings: [], manifest: { profile: 'smoke', label: null, systemCommit: 'abc1234', agent: null } }],
  };
  const profile = resolveProfile({ ...(ACME_PROFILE as DsaProfile), readiness: provider });
  const data = tmp();
  await runPipeline({ root: ACME_ROOT, dataDir: data, config: loadConfig(ACME_ROOT).config, profile, store: d => openStore(d), git: false, now: NOW });
  const html = await renderReport(ACME_ROOT, loadConfig(ACME_ROOT).config, data, profile);
  const payload = JSON.parse(html.match(/id="dsa-data" type="application\/json">(.*?)<\/script>/s)![1]!);
  const r = payload.readiness.find((x: any) => x.subject === 'checkout');
  assert.equal(r.score, 62);
  assert.equal(r.usage.errors, 6);
  assert.match(r.reconcile.note, /^checker 5, scan \d+$/);
  assert.equal(payload.bench[0].manifest.systemCommit, 'abc1234');
  const snap = await writeSnapshot({ ...contextFor(ACME_ROOT, data), profile });
  assert.equal(snap.readiness[0].usage.errors, 6);
  assert.match(snap.readiness[0].reconcile.note, /^checker 5/);
});
