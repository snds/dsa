import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evidenceSummary, isVendored, parsePlace, parsePlaces } from '../../src/engine/places.js';
import { isSecretPath, placeExcerpts } from '../../src/engine/source.js';
import { openStore } from '../../src/engine/store.js';
import { rowToFinding } from '../../src/engine/evaluate.js';
import { NOW, fixtureCopy, loadConfig, runPipeline, tmp } from './fixture.js';

// Evidence as data: findings carry the places they cite; older findings' text is read back; the
// static page's excerpts stay inside the scanned targets, skip secrets, and are capped.

test('older evidence text reads back into places and a summary', () => {
  const text = '5 of 17 instances overridden (5 className). Examples: ledger-main/app/ToolbarDivider.tsx:8, vendor/acme-ui/src/filters/Body.tsx:91:4, src/a.tsx (12)';
  assert.deepEqual(parsePlaces(text), [
    { file: 'ledger-main/app/ToolbarDivider.tsx', line: 8 },
    { file: 'vendor/acme-ui/src/filters/Body.tsx', line: 91, col: 4 },
  ]);
  assert.equal(evidenceSummary(text), '5 of 17 instances overridden (5 className).');
  assert.deepEqual(parsePlaces('Pinned abc; latest def.'), [], 'no examples, no places');
  assert.equal(parsePlace('not a place'), null);
});

test('vendored and third-party code is marked', () => {
  assert.equal(isVendored('vendor/acme-ui/src/Body.tsx'), true);
  assert.equal(isVendored('ledger-main/node_modules/x/index.js'), true);
  assert.equal(isVendored('ledger-main/third_party/chart.ts'), true);
  assert.equal(isVendored('ledger-main/app/vendorList.tsx'), false);
});

test('secret files are never read for the code reader', () => {
  for (const f of ['.env', 'app/.env.local', 'config/secrets.json', 'certs/server.pem', 'deploy/id_rsa', '.dsa/secrets.json', 'x/.git/config', '.npmrc'])
    assert.equal(isSecretPath(f), true, f);
  for (const f of ['src/env.ts', 'src/Secrets.tsx', 'app/keys.ts']) assert.equal(isSecretPath(f), false, f);
});

test('excerpts: lines around cited places, inside the targets, no secrets, capped', () => {
  const root = fixtureCopy();
  const { config } = loadConfig(root);
  const billing = 'apps/billing/src/Invoices.tsx';
  fs.writeFileSync(path.join(root, 'apps/billing/.env'), 'TOKEN=shh\n');
  const long = path.join(root, 'apps/billing/src/Long.tsx');
  fs.writeFileSync(long, Array.from({ length: 200 }, (_, i) => (i === 99 ? 'x'.repeat(1000) : `line ${i + 1}`)).join('\n'));
  const out = placeExcerpts(root, config, [
    { file: billing, line: 5 },
    { file: 'apps/billing/src/Long.tsx', line: 100 },
    { file: 'apps/billing/.env', line: 1 },
    { file: '../outside.tsx', line: 1 },
  ]);
  assert.deepEqual(Object.keys(out).sort(), [billing, 'apps/billing/src/Long.tsx'].sort(), 'secrets and paths outside the targets are left out');
  const lines = out['apps/billing/src/Long.tsx']!.chunks.flatMap(c => c.lines);
  assert.equal(out['apps/billing/src/Long.tsx']!.chunks[0]!.start, 88, '12 lines either side');
  assert.equal(lines.length, 25);
  assert.ok(lines[12]!.length < 410 && lines[12]!.endsWith('…'), 'long lines are cut');
  const capped = placeExcerpts(root, config, [{ file: 'apps/billing/src/Long.tsx', line: 100 }], { context: 12, maxLineChars: 400, maxFiles: 200, maxLines: 10 });
  assert.equal(capped['apps/billing/src/Long.tsx']!.chunks.flatMap(c => c.lines).length, 10, 'the total line budget holds');
});

test('a scan stores structured places on findings, with their target and kind', async () => {
  const root = fixtureCopy();
  const data = tmp();
  await runPipeline({ root, dataDir: data, git: false, now: NOW });
  const s = await openStore(data);
  try {
    const findings = (await s.all<any>('select * from findings')).map(rowToFinding);
    const withPlaces = findings.filter(f => f.places?.length);
    assert.ok(withPlaces.length > 0, 'some findings cite places');
    for (const f of withPlaces) for (const p of f.places!) {
      assert.equal(typeof p.file, 'string'); assert.ok(p.line > 0); assert.ok(p.target, `${f.id} place has a target`); assert.ok(p.kind, `${f.id} place has a kind`);
    }
    const misuse = withPlaces.find(f => f.rule.startsWith('misuse'));
    if (misuse) assert.ok(misuse.places!.every(p => /className|style|spread/.test(p.kind!)), 'override places say which override');
  } finally { s.close(); }
});
