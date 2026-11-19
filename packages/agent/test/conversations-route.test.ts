import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NEUTRAL_PROFILE } from '@snds/dsa';
import { agentRoutes } from '../src/routes.js';
import { readSession, writeSession } from '../src/sessions.js';

// The Conversations tab: every conversation with its state, what was asked, and a name and star the
// person sets.

function call(dataDir: string, method: string, p: string, body?: any) {
  let out: { status: number; body: any } = { status: 0, body: null };
  return agentRoutes({
    req: { method } as any, res: {} as any, url: new URL(`http://localhost${p}`), body: async () => body,
    send: (status: number, b: any) => { out = { status, body: b }; }, context: async () => ({ profile: NEUTRAL_PROFILE, root: dataDir, dataDir, config: {}, configDir: dataDir, loaded: {} }) as any, root: dataDir, dataDir,
  } as any).then(() => out);
}

const session = (id: string, subject: any, messages: any[]) => ({ id, subject, title: 'Two issues', provider: 'claude-code', mode: 'advise', repo: { name: 'core', dir: '/x', top: '/x', sub: '' }, sandbox: null, brief: '', starters: [], messages, createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z' });

test('the list gives each conversation its state, anchor and first question; rename and star stick', async () => {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-conv-')));
  writeSession(dataDir, session('S-1', { kind: 'set', items: [{ key: 'F-1' }, { key: 'F-2' }] }, [{ role: 'user', text: 'What do these share?', at: 'x' }, { role: 'assistant', text: 'A lot.', at: 'x' }]) as any);
  const r = await call(dataDir, 'GET', '/api/agent/sessions');
  assert.equal(r.status, 200);
  const c = r.body.sessions[0];
  assert.match(c.anchor, /^set:S-[0-9A-F]{8}$/);
  assert.equal(c.state, 'waiting-on-you');
  assert.equal(c.asked, 'What do these share?');
  assert.equal(c.turns, 2);

  const m = await call(dataDir, 'POST', '/api/agent/session/meta', { id: 'S-1', name: '  Toolbar   question  ', starred: true });
  assert.equal(m.status, 200);
  assert.deepEqual(m.body.session, { id: 'S-1', name: 'Toolbar question', starred: true });
  assert.equal(readSession(dataDir, 'S-1')!.name, 'Toolbar question');
  await call(dataDir, 'POST', '/api/agent/session/meta', { id: 'S-1', name: '' });
  assert.equal(readSession(dataDir, 'S-1')!.name, null, 'an empty name goes back to the title');
  assert.equal((await call(dataDir, 'POST', '/api/agent/session/meta', { id: 'S-404', starred: true })).status, 404);
});
