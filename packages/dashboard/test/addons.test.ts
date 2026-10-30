import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProgram, runAfterHooks, type AddonApi, type DsaAddon } from '@snds/dsa';
import { openStore } from '@snds/dsa/engine';
import { ACME_ROOT, contextFor, NOW, runPipeline, tmp } from '../../../test/engine/fixture.js';
import agent from '@snds/dsa-agent';
import dashboard from '../src/index.js';
import figma from '@snds/dsa-figma';
import review from '@snds/dsa-review';

// The four add-ons plug into the one CLI: their commands and options, and the steps after a run.

const ADDONS: DsaAddon[] = [agent, dashboard, figma, review];

test('add-ons: each adds its commands and run options to the one dsa CLI', () => {
  const out: string[] = [];
  const program = createProgram({ out: s => out.push(s), err: () => {}, cwd: ACME_ROOT });
  const api = { cwd: ACME_ROOT, out: () => {}, err: () => {}, context: async () => contextFor(ACME_ROOT, tmp()), addons: async () => ADDONS, requireStore: async () => {} } as AddonApi;
  for (const a of ADDONS) a.commands?.(program, api);
  const names = program.commands.map(c => c.name());
  for (const c of ['serve', 'report', 'publish', 'shots', 'render', 'setup', 'mcp', 'agent']) assert.ok(names.includes(c), c);
  const run = program.commands.find(c => c.name() === 'run')!;
  const flags = run.options.map(o => o.long);
  for (const f of ['--shots', '--no-shots', '--no-report', '--figma', '--no-figma']) assert.ok(flags.includes(f), f);
  assert.ok(program.commands.find(c => c.name() === 'agent')!.commands.some(c => c.name() === 'brief'));
});

test('add-ons: after a run the report is written, screenshots only when asked, the agent snapshot only from dsa serve', async () => {
  const data = tmp();
  await runPipeline({ root: ACME_ROOT, dataDir: data, git: false, now: NOW });
  const ctx = contextFor(ACME_ROOT, data);
  const log: string[] = [];
  const notes: string[] = [];
  await runAfterHooks(ADDONS, { kind: 'run', ctx, options: {}, store: d => openStore(d), notes, log: m => log.push(m) });
  assert.ok(fs.existsSync(path.join(data, 'report', 'index.html')));
  assert.ok(!fs.existsSync(path.join(data, 'shots')), 'shots.auto is off and --shots was not given');
  assert.ok(!fs.existsSync(path.join(data, 'agent', 'snapshot.json')), 'the CLI run leaves the snapshot alone');
  assert.deepEqual(notes, []);
  fs.rmSync(path.join(data, 'report'), { recursive: true });
  await runAfterHooks(ADDONS, { kind: 'run', ctx, options: { report: false, from: 'serve' }, store: d => openStore(d), notes, log: () => {} });
  assert.ok(!fs.existsSync(path.join(data, 'report')), '--no-report');
  assert.ok(fs.existsSync(path.join(data, 'agent', 'snapshot.json')), 'a scan from the dashboard refreshes what agents read');
});
