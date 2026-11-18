import { test } from 'vitest';
import assert from 'node:assert/strict';
import { claudeArgs, cursorArgs } from '../src/providers.js';
import { cursorPermissions } from '../src/sessions.js';
import { RUNS_AT_START } from '../src/visual.js';

// From the nine-way review (code A, B, C): the agent's sandbox wasn't one. Edits could go through the
// linked node_modules into the real checkout, Cursor ran with no limits, and Before/After ran code the
// agent had edited.

const base = { provider: 'claude-code' as const, cwd: '/tmp/sb/app', prompt: 'hi', mcpConfig: '/tmp/m.json', persona: 'p' };

test('Claude Code may read the linked folders and the extra dirs, never edit them', () => {
  const a = claudeArgs({ ...base, mode: 'try', addDirs: ['/srv/system'], readOnly: ['/tmp/sb/node_modules', '/repo/node_modules', '/srv/system'] });
  const settings = JSON.parse(a[a.indexOf('--settings') + 1]);
  assert.deepEqual(settings.permissions.deny, ['Edit(//tmp/sb/node_modules/**)', 'Edit(//repo/node_modules/**)', 'Edit(//srv/system/**)']);
  assert.ok(a.includes('--add-dir') && a.includes('/srv/system'), 'still readable');
  assert.ok(a[a.indexOf('--disallowedTools') + 1].includes('Bash'), 'never a shell');
});

test('Cursor: no shell ever, no writing in Advise, and in Try no writing through the links', () => {
  const advise = cursorPermissions('advise').permissions, tryIt = cursorPermissions('try').permissions;
  assert.ok(advise.deny.includes('Shell(*)') && advise.deny.includes('Write(**)'));
  assert.ok(tryIt.deny.includes('Shell(*)') && tryIt.deny.includes('Write(node_modules/**)'));
  assert.ok(tryIt.allow.includes('Write(**)') && !advise.allow.includes('Write(**)'));
  // A message starting with "-" is a message, not a flag.
  const a = cursorArgs({ ...base, provider: 'cursor', mode: 'advise', prompt: '--force everything' });
  assert.equal(a[a.length - 1], ' --force everything');
  assert.equal(a.filter(x => x === '--force').length, 0, 'advise never forces');
});

test('Before/After refuses to start an app whose start-up files the agent changed', () => {
  for (const f of ['package.json', 'apps/web/package.json', 'vite.config.ts', 'apps/web/vite.config.mjs', 'tailwind.config.js', 'postcss.config.cjs', '.husky/pre-commit', '.npmrc', 'scripts/dev.sh'])
    assert.ok(RUNS_AT_START.test(f), f);
  for (const f of ['src/Button.tsx', 'apps/web/src/config.ts', 'README.md', 'src/package.json.ts'])
    assert.ok(!RUNS_AT_START.test(f), f);
});
