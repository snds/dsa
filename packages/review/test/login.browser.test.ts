import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { login } from '../src/index.js';

// `dsa login` saves the session without getting in the person's way: never on a timer (reading the
// storage state while someone types stole focus from a sign-in form), only after a page finishes
// loading and goes quiet, and once at the end. Skipped without a headless browser (`dsa setup`).

const chromium = process.env.DSA_NO_BROWSER ? null : await (async () => { try { return (await import('playwright')).chromium; } catch { return null; } })();
const hasBrowser = chromium ? await chromium.launch().then(b => b.close().then(() => true), () => false) : false;

test('no save while the page sits idle or someone types; one after load, one at the end', { timeout: 30_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const server = http.createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.setHeader('set-cookie', 'sid=abc; Path=/'); s.end('<form><input id="u"><input id="p" type="password"></form>'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/`;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-login-')), 'auth.json');
  const browser = await chromium!.launch();
  const saves: number[] = [];
  let finish!: () => void;
  const until = new Promise<void>(r => { finish = r; });
  const run = login(url, out, () => {}, { browser, until, debounceMs: 300, onSave: n => saves.push(n) });
  try {
    await new Promise(r => setTimeout(r, 900));
    assert.equal(saves.length, 1, 'one save after the page loaded and went quiet');
    // Typing a password: nothing reads the page meanwhile.
    const page = browser.contexts()[0]!.pages()[0]!;
    await page.locator('#p').type('hunter2-not-real', { delay: 40 });
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(saves.length, 1, 'idle and typing: no save');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.id), 'p', 'focus stays where the person put it');
    finish();
    await run;
  } finally { server.close(); }
  assert.equal(saves.length, 2, 'and once at the end');
  const state = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(state.cookies.some((c: any) => c.name === 'sid'));
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});
