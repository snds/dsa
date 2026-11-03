import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '@snds/dsa';
import { fixtureCopy, loadConfig, NOW, runPipeline } from '../../../test/engine/fixture.js';
import { login } from '../src/index.js';
import { takeShots } from '../src/shots.js';

// A single-page app signed in with OpenID Connect (code flow with PKCE) keeps its tokens in memory: the
// saved sign-in holds only the identity provider's session, so every fresh page starts signed out at
// /login. With live.apps[name].signIn the crawler clicks the sign-in button once, comes back signed in
// without a password, and moves inside the app from then on; the network stays read-only on the app.
// A tiny local identity provider and app, made-up names. Skipped without a headless browser.

const hasBrowser = process.env.DSA_NO_BROWSER ? false : await (async () => {
  try { const { chromium } = await import('playwright'); const b = await chromium.launch(); await b.close(); return true; } catch { return false; }
})();
const DEMO = path.resolve(import.meta.dirname, '../../../test/fixtures/review-demo');
const TOKEN = 'tok-0f3a9c-not-a-real-secret';
const CODE = 'code-7b21e4';
const listen = (s: http.Server) => new Promise<number>(r => s.listen(0, '127.0.0.1', () => r((s.address() as any).port)));

/** The identity provider (on localhost) and the app (on 127.0.0.1): two origins, as in production. */
async function world() {
  const hits = { auth: 0, token: 0, appPages: 0, writes: 0, admin: 0 };
  let idpOrigin = '';
  const idp = http.createServer((q, s) => {
    const u = new URL(q.url!, 'http://x');
    if (u.pathname === '/realms/acme/protocol/openid-connect/auth') {
      hits.auth++;
      if (/acme_sso=alive/.test(q.headers.cookie ?? '')) { s.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=${CODE}&state=${u.searchParams.get('state')}` }); s.end(); return; }
      s.setHeader('content-type', 'text/html'); s.end('<h1>Acme ID</h1><form method="post"><input name="username"><input type="password" name="password"><button>Sign in</button></form>'); return;
    }
    if (u.pathname === '/realms/acme/protocol/openid-connect/token') {
      s.setHeader('access-control-allow-origin', q.headers.origin ?? '*'); s.setHeader('access-control-allow-headers', 'content-type'); s.setHeader('access-control-allow-methods', 'POST');
      if (q.method === 'OPTIONS') { s.end(); return; }
      hits.token++;
      let body = ''; q.on('data', c => { body += c; }); q.on('end', () => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify(body.includes(CODE) ? { access_token: TOKEN } : { error: 'invalid_grant' })); });
      return;
    }
    s.writeHead(404); s.end();
  });
  idpOrigin = `http://localhost:${await listen(idp)}`;
  // The billing page from the review demo, behind sign-in, its rows loaded from /api/ledger with the token.
  const page = fs.readFileSync(path.join(DEMO, 'apps/billing/site/index.html'), 'utf8');
  const spa = `<script>
    const IDP = ${JSON.stringify(idpOrigin)};
    const APP = document.body.innerHTML;
    let token = sessionStorage.getItem('ledger.token'); // kept in memory; some builds keep it in session storage
    function render() {
      const p = location.pathname;
      if (p === '/auth/callback') {
        document.body.innerHTML = '<p>Signing in…</p>';
        fetch(IDP + '/realms/acme/protocol/openid-connect/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code&code=' + new URLSearchParams(location.search).get('code') })
          .then(r => r.json()).then(j => { token = j.access_token; history.replaceState(null, '', sessionStorage.getItem('next') || '/'); render(); });
        return;
      }
      if (!token) {
        if (p !== '/login') { sessionStorage.setItem('next', p); history.replaceState(null, '', '/login'); }
        document.body.innerHTML = '<h1>Ledger</h1><button id="si">Sign in with Acme ID</button>';
        document.getElementById('si').onclick = () => { location.href = IDP + '/realms/acme/protocol/openid-connect/auth?client_id=ledger&redirect_uri=' + encodeURIComponent(location.origin + '/auth/callback') + '&state=s1&code_challenge=c1'; };
        return;
      }
      fetch('/api/ledger/invoices', { headers: { authorization: 'Bearer ' + token } }).then(r => r.json()).then(() => {
        document.body.innerHTML = APP;
        fetch('/api/ledger/audit', { method: 'POST', body: 'viewed' }).catch(() => {});
        fetch('/api/admin/users').catch(() => {});
      });
    }
    addEventListener('popstate', render);
    render();
  </script>`;
  const app = http.createServer((q, s) => {
    const u = new URL(q.url!, 'http://x');
    if (u.pathname.startsWith('/api/')) {
      if (q.method !== 'GET') { hits.writes++; s.writeHead(204); s.end(); return; }
      if (u.pathname.startsWith('/api/admin')) { hits.admin++; s.end('[]'); return; }
      s.setHeader('content-type', 'application/json');
      s.end(q.headers.authorization === `Bearer ${TOKEN}` ? '[{"id":"INV-1042"}]' : '{"error":"unauthorized"}');
      return;
    }
    hits.appPages++;
    s.setHeader('content-type', 'text/html'); s.end(page.replace('</body>', spa + '</body>'));
  });
  const appUrl = `http://127.0.0.1:${await listen(app)}/`;
  return { hits, idpOrigin, appUrl, close: () => { idp.close(); app.close(); } };
}

/** The review demo, with billing live at the app and the given saved sign-in. */
function demo(appUrl: string, opts: { signIn?: boolean; cookie?: boolean; session?: Record<string, string> } = {}) {
  const root = fixtureCopy();
  fs.cpSync(DEMO, root, { recursive: true });
  const auth = path.join(root, '.dsa-auth', 'ledger.json');
  fs.mkdirSync(path.dirname(auth), { recursive: true });
  const origin = new URL(appUrl).origin;
  fs.writeFileSync(auth, JSON.stringify({
    cookies: opts.cookie === false ? [] : [{ name: 'acme_sso', value: 'alive', domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
    origins: [], ...(opts.session ? { sessionStorage: { [origin]: opts.session } } : {}),
  }), { mode: 0o600 });
  const billing = { url: appUrl, auth: '.dsa-auth/ledger.json', readApi: false, readPaths: ['/api/ledger/**'], ...(opts.signIn === false ? {} : { signIn: { path: '/login', click: 'Sign in with Acme ID' } }) };
  const config = () => ({ ...loadConfig(root).config, apps: { billing: { extraRoutes: ['/invoices', '/customers'] } }, live: parseConfig({ live: { apps: { billing } } }).live }) as any;
  return { root, data: path.join(root, '.dsa'), config };
}

test('with signIn: signed in once, without a password; then read-only inside the app', { timeout: 180_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const w = await world();
  try {
    const { root, data, config } = demo(w.appUrl);
    await runPipeline({ root, dataDir: data, git: false, now: NOW });
    const logs: string[] = [];
    const r = await takeShots({ root, dataDir: data, config: config(), target: 'billing', perGroup: 3, log: m => logs.push(m) });
    const a = r.apps.find(x => x.target === 'billing')!;
    assert.equal(a.signIn, undefined, logs.join('\n'));
    assert.ok((a.captured ?? 0) > 0, logs.join('\n'));
    assert.equal(w.hits.auth, 1, 'signed in once, for three routes');
    assert.equal(w.hits.token, 1);
    assert.equal(w.hits.writes, 0, 'no write reached the app');
    assert.equal(w.hits.admin, 0, 'a read outside readPaths was stopped');
    // What was let through and stopped, by path: never a token or a code.
    const net = logs.find(l => l.includes('network:'))!;
    assert.match(net, /allowed .*GET \/api\/ledger\/invoices/);
    assert.match(net, /POST http:\/\/localhost:\d+\/realms\/acme\/protocol\/openid-connect\/token/);
    assert.match(net, /blocked .*POST \/api\/ledger\/audit/);
    assert.match(net, /GET \/api\/admin\/users/);
    const everything = logs.join('\n') + fs.readFileSync(path.join(data, 'shots', 'index.json'), 'utf8');
    assert.ok(!everything.includes(TOKEN) && !everything.includes(CODE), 'no token or code in logs or the index');
  } finally { w.close(); }
});

test('without signIn: every page asks for sign-in, and the message says what to set', { timeout: 120_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const w = await world();
  try {
    const { root, data, config } = demo(w.appUrl, { signIn: false });
    await runPipeline({ root, dataDir: data, git: false, now: NOW });
    const logs: string[] = [];
    const r = await takeShots({ root, dataDir: data, config: config(), target: 'billing', perGroup: 3, log: m => logs.push(m) });
    assert.match(r.apps[0]!.signIn ?? '', /\/login/);
    assert.ok(logs.some(l => /Every page asked for sign-in\..*live\.apps\["billing"\]\.signIn/.test(l)), logs.join('\n'));
    assert.equal(w.hits.auth, 0, 'nothing clicked');
  } finally { w.close(); }
});

test('the identity provider asks for a password: the saved sign-in expired, said plainly', { timeout: 120_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const w = await world();
  try {
    const { root, data, config } = demo(w.appUrl, { cookie: false });
    await runPipeline({ root, dataDir: data, git: false, now: NOW });
    const logs: string[] = [];
    const r = await takeShots({ root, dataDir: data, config: config(), target: 'billing', perGroup: 3, log: m => logs.push(m) });
    assert.ok(logs.some(l => /The saved sign-in expired\. Run `dsa login http:\/\/127\.0\.0\.1:\d+\/` again\./.test(l)), logs.join('\n'));
    assert.equal(r.missing, 0, 'nothing behind the wall is remembered as not found');
    assert.equal(w.hits.auth, 1, 'tried once, not on every page');
  } finally { w.close(); }
});

test('tokens in session storage: the saved session storage is put back, no clicking needed', { timeout: 120_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const w = await world();
  try {
    const { root, data, config } = demo(w.appUrl, { signIn: false, session: { 'ledger.token': TOKEN } });
    await runPipeline({ root, dataDir: data, git: false, now: NOW });
    const r = await takeShots({ root, dataDir: data, config: config(), target: 'billing', perGroup: 3 });
    assert.ok((r.apps[0]!.captured ?? 0) > 0);
    assert.equal(w.hits.auth, 0);
  } finally { w.close(); }
});

test('dsa login keeps the app\'s session storage beside its cookies, at mode 600', { timeout: 30_000 }, async ({ skip }) => {
  if (!hasBrowser) skip('no headless browser (run dsa setup)');
  const server = http.createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end(`<script>sessionStorage.setItem('ledger.token', ${JSON.stringify(TOKEN)})</script><p>Signed in</p>`); });
  const url = `http://127.0.0.1:${await listen(server)}/`;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-login-')), 'auth.json');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  let finish!: () => void;
  const until = new Promise<void>(r => { finish = r; });
  const run = login(url, out, () => {}, { browser, until, debounceMs: 200 });
  try { await new Promise(r => setTimeout(r, 800)); finish(); await run; } finally { server.close(); }
  const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(saved.sessionStorage[new URL(url).origin]['ledger.token'], TOKEN);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test('readPaths globs: the app\'s own paths, or a full URL for another host', async () => {
  const { globMatcher } = await import('../src/flows.js');
  const m = globMatcher(['/record-service/**', '/schema-registry/*/latest', 'https://gw.example.test/data/**'], 'https://app.example.test');
  assert.equal(m(new URL('https://app.example.test/record-service/v2/invoices?id=1')), true);
  assert.equal(m(new URL('https://app.example.test/schema-registry/invoice/latest')), true);
  assert.equal(m(new URL('https://app.example.test/schema-registry/invoice/v2/latest')), false, '* is one segment');
  assert.equal(m(new URL('https://other.example.test/record-service/x')), false, 'a path glob is the app\'s origin only');
  assert.equal(m(new URL('https://gw.example.test/data/a/b')), true);
  assert.equal(m(new URL('https://app.example.test/record-servicex')), false);
});
