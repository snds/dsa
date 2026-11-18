import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NEUTRAL_PROFILE } from '@snds/dsa';
import { agentRoutes } from '../src/routes.js';
import { readDismissals } from '../src/dismissals.js';

// From the nine-way review (UX A, B, C all found it): only the agent could propose a dismissal, so a person
// couldn't clear noise, and nothing undid one. Now a person dismisses directly, with a reason, and undoes it.

function call(dataDir: string, p: string, body: any) {
  let out: { status: number; body: any } = { status: 0, body: null };
  return agentRoutes({
    req: { method: 'POST' } as any, res: {} as any, url: new URL(`http://localhost${p}`), body: async () => body,
    send: (status: number, b: any) => { out = { status, body: b }; }, context: async () => ({ profile: NEUTRAL_PROFILE, root: dataDir, dataDir, config: {}, configDir: dataDir, loaded: {} }) as any, root: dataDir, dataDir,
  } as any).then(() => out);
}

test('a person dismisses an issue with a reason, and undoes it', async () => {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-dis-')));
  const r = await call(dataDir, '/api/agent/dismissal', { key: 'Q-1A2B3C', label: 'intended', reason: 'A one-off for the launch page.', who: 'sample-lead', title: 'Dropdown selects' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual({ ...readDismissals(dataDir)['Q-1A2B3C'], date: 'x' }, { label: 'intended', reason: 'A one-off for the launch page.', who: 'sample-lead', date: 'x', title: 'Dropdown selects' });
  const u = await call(dataDir, '/api/agent/dismissal/undo', { key: 'Q-1A2B3C' });
  assert.equal(u.status, 200);
  assert.equal(readDismissals(dataDir)['Q-1A2B3C'], undefined);
});

test('a dismissal needs an issue and a known reason; constructor and __proto__ are not reasons', async () => {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-dis-')));
  assert.equal((await call(dataDir, '/api/agent/dismissal', { label: 'intended' })).status, 400);
  for (const label of ['nope', 'constructor', '__proto__', 'toString']) assert.equal((await call(dataDir, '/api/agent/dismissal', { key: 'Q-1', label })).status, 400, label);
  assert.deepEqual(readDismissals(dataDir), {});
});
