import { describe, expect, it } from "vitest";
import { createRelay, relayEnvProblems, relayFromEnv, relayOptionsFromEnv, sign, verify, type RelayHandler } from "../src/relay/index.js";
import { startRelayServer } from "../src/relay/node.js";

// The scan relay: sign-in with GitHub's web flow, signed sessions, who may scan, CSRF and origin
// checks, one scan at a time, a rate limit, and progress read from the workflow's run. GitHub is
// faked at the HTTP level, so these run the handler exactly as a host would.

/** A JSON answer, untyped (the shapes are what the tests check). */
const j = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

const SECRET = "s".repeat(40);
const RELAY = "https://relay.example.test/";
const PAGE = "https://acme.example.test";
const GH_TOKEN = "relay-runner-token";

/** GitHub as the relay sees it: OAuth, who signed in, their access, and one workflow's runs. */
function fakeGithub(o: { access?: Record<string, string>; running?: boolean } = {}) {
  const access: Record<string, string> = o.access ?? { ada: "write", rex: "read" };
  let runs: any[] = o.running ? [{ id: 50, status: "in_progress", conclusion: null, event: "schedule", run_started_at: "2026-11-01T10:00:00Z", html_url: "https://github.test/acme/site/actions/runs/50" }] : [];
  const calls: { method: string; url: string; auth: string | null }[] = [];
  const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const auth = new Headers(init.headers).get("authorization");
    const method = init.method ?? "GET";
    calls.push({ method, url: url.toString(), auth });
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (url.href === "https://github.test/login/oauth/access_token") {
      if (body.client_secret !== "client-secret") return json({ error: "incorrect_client_credentials" });
      return body.code.startsWith("code-") ? json({ access_token: `viewer-${body.code.slice(5)}` }) : json({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
    }
    if (url.pathname === "/user") return auth?.startsWith("Bearer viewer-") ? json({ login: auth.slice("Bearer viewer-".length) }) : json({}, 401);
    const perm = url.pathname.match(/^\/repos\/acme\/site\/collaborators\/([^/]+)\/permission$/);
    if (perm) {
      if (auth !== `Bearer ${GH_TOKEN}`) return json({}, 401);
      const p = access[decodeURIComponent(perm[1]!)];
      return p ? json({ permission: p === "maintain" ? "write" : p, role_name: p }) : json({ message: "Not Found" }, 404);
    }
    if (auth !== `Bearer ${GH_TOKEN}`) return json({ message: "Bad credentials" }, 401);
    const wf = "/repos/acme/site/actions/workflows/dsa.yml";
    if (url.pathname === "/repos/acme/site") return json({ default_branch: "main" });
    if (url.pathname === `${wf}/runs`) {
      const st = url.searchParams.get("status");
      return json({ workflow_runs: runs.filter((r) => !st || (st === "success" ? r.conclusion === "success" : r.status === st)) });
    }
    if (url.pathname === `${wf}/dispatches` && method === "POST") {
      runs = [{ id: 77, status: "queued", conclusion: null, event: "workflow_dispatch", created_at: "2026-11-01T11:00:00Z", html_url: "https://github.test/acme/site/actions/runs/77" }, ...runs];
      return json({ workflow_run_id: 77 });
    }
    const run = url.pathname.match(/^\/repos\/acme\/site\/actions\/runs\/(\d+)(\/jobs)?$/);
    if (run) {
      const r = runs.find((x) => String(x.id) === run[1]);
      if (!r) return json({ message: "Not Found" }, 404);
      return run[2] ? json({ jobs: [{ name: "scan", steps: [{ name: "Set up job", status: "completed", conclusion: "success" }, { name: "Scan", status: "in_progress" }, { name: "Deploy", status: "queued" }] }] }) : json(r);
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return { f, calls, finish: (id: number) => { runs = runs.map((r) => (r.id === id ? { ...r, status: "completed", conclusion: "success" } : r)); } };
}

const ENV = {
  DSA_RELAY_URL: RELAY,
  DSA_RELAY_ORIGINS: PAGE,
  DSA_RELAY_SESSION_SECRET: SECRET,
  DSA_RELAY_CLIENT_ID: "client-id",
  DSA_RELAY_CLIENT_SECRET: "client-secret",
  DSA_RELAY_REPO: "acme/site",
  DSA_RELAY_RUNNER_TOKEN: GH_TOKEN,
  DSA_RELAY_GITHUB_SERVER: "https://github.test",
  DSA_RELAY_GITHUB_API: "https://api.github.test",
};

function relay(env: Record<string, string> = {}, gh = fakeGithub(), now = () => Date.parse("2026-11-01T12:00:00Z")) {
  const opts = relayOptionsFromEnv({ ...ENV, ...env }, { fetch: gh.f });
  return { handler: createRelay({ ...opts, now }), gh };
}

const get = (h: RelayHandler, path: string, headers: Record<string, string> = {}) => h(new Request(new URL(path, RELAY), { headers }));
const post = (h: RelayHandler, path: string, headers: Record<string, string> = { Origin: PAGE, "X-DSA-Relay": "1" }) => h(new Request(new URL(path, RELAY), { method: "POST", headers }));

/** Go through sign-in as `login`; returns the session the page receives and the cookie the relay set. */
async function signIn(h: RelayHandler, login: string) {
  const start = await get(h, `auth/start?return=${encodeURIComponent(`${PAGE}/dsa/#overview`)}`);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = start.headers.getSetCookie()[0]!.split(";")[0]!;
  const back = await get(h, `auth/callback?code=code-${login}&state=${encodeURIComponent(state)}`, { Cookie: stateCookie });
  const to = new URL(back.headers.get("location")!);
  return { to, session: decodeURIComponent(to.hash.match(/dsa-relay=([^&]+)/)?.[1] ?? ""), error: decodeURIComponent(to.hash.match(/dsa-relay-error=([^&]+)/)?.[1] ?? ""), cookies: back.headers.getSetCookie() };
}

describe("signed tokens", () => {
  it("verify only what this secret signed, for this kind, before it expires", async () => {
    const t = await sign(SECRET, "session", { sub: "ada" }, 2_000_000);
    expect(await verify(SECRET, "session", t, 1_000_000)).toMatchObject({ sub: "ada" });
    expect(await verify(SECRET, "state", t, 1_000_000), "a session can't pass as a sign-in state").toBeNull();
    expect(await verify("x".repeat(40), "session", t, 1_000_000), "another secret").toBeNull();
    expect(await verify(SECRET, "session", t, 3_000_000), "expired").toBeNull();
    const [v, body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "mallory", k: "session", exp: 9_999_999_999 })).toString("base64url");
    expect(await verify(SECRET, "session", `${v}.${forged}.${sig}`, 1_000_000)).toBeNull();
    expect(await verify(SECRET, "session", `${v}.${body}`, 1_000_000)).toBeNull();
    expect(await verify(SECRET, "session", undefined, 1_000_000)).toBeNull();
  });
});

describe("the relay's settings", () => {
  it("name what's missing or wrong, never the values", () => {
    const problems = relayEnvProblems({ DSA_RELAY_SESSION_SECRET: "short-secret-value", DSA_RELAY_REPO: "not a repo", DSA_RELAY_ORIGINS: "acme.example.test" });
    expect(problems).toEqual(expect.arrayContaining([
      "DSA_RELAY_URL is not set.",
      "DSA_RELAY_CLIENT_SECRET is not set.",
      "DSA_RELAY_RUNNER_TOKEN is not set (the github runner needs it).",
      "DSA_RELAY_SESSION_SECRET is shorter than 32 characters.",
      'DSA_RELAY_REPO must be "owner/name".',
    ]));
    expect(problems.join(" ")).not.toContain("short-secret-value");
    expect(relayEnvProblems(ENV)).toEqual([]);
    expect(relayEnvProblems({ ...ENV, DSA_RELAY_RUNNER: "webhook", DSA_RELAY_RUNNER_TOKEN: "" })).toEqual(["DSA_RELAY_WEBHOOK_TRIGGER is not set (the webhook runner needs it)."]);
    expect(() => createRelay({ ...relayOptionsFromEnv(ENV), sessionSecret: "short" })).toThrow(/at least 32 characters/);
  });

  it("answer 503 with the missing names until they're complete (a worker reads env per request)", async () => {
    const worker = relayFromEnv({ fetch: fakeGithub().f });
    const r = await worker(new Request(`${RELAY}session`), { DSA_RELAY_URL: RELAY });
    expect(r.status).toBe(503);
    expect((await j(r)).missing).toContain("DSA_RELAY_CLIENT_ID is not set.");
    expect((await worker(new Request(`${RELAY}session`), ENV)).status).toBe(200);
  });
});

describe("sign-in", () => {
  it("goes to GitHub with a signed state and returns only to the dashboard", async () => {
    const { handler } = relay();
    const start = await get(handler, `auth/start?return=${encodeURIComponent(`${PAGE}/dsa/`)}`);
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://github.test/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("client-id");
    expect(to.searchParams.get("redirect_uri")).toBe(`${RELAY}auth/callback`);
    expect(to.searchParams.get("scope"), "no scopes: the relay only learns who signed in").toBeNull();
    expect(start.headers.getSetCookie()[0]).toMatch(/^dsa_relay_state=[\w-]+; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
    // Not an open redirect.
    expect((await get(handler, `auth/start?return=${encodeURIComponent("https://evil.example.test/")}`)).status).toBe(400);
    expect((await get(handler, "auth/start")).status).toBe(400);
  });

  it("gives a writer a signed session (fragment + HttpOnly cookie) and keeps no GitHub token", async () => {
    const { handler, gh } = relay();
    const s = await signIn(handler, "ada");
    expect(s.to.origin + s.to.pathname).toBe(`${PAGE}/dsa/`);
    expect(s.session).toMatch(/^v1\./);
    const cookie = s.cookies.find((c) => c.startsWith("dsa_relay="))!;
    expect(cookie).toMatch(/HttpOnly; SameSite=None; Secure$/);
    expect(s.cookies.find((c) => c.startsWith("dsa_relay_state="))).toMatch(/Max-Age=0/);
    expect(JSON.stringify(s)).not.toContain("viewer-ada");
    // The viewer's GitHub token asked only who they are; access came from the relay's own token.
    expect(gh.calls.filter((c) => c.auth === "Bearer viewer-ada").map((c) => new URL(c.url).pathname)).toEqual(["/user"]);
    const who = await j(get(handler, "session", { Authorization: `Bearer ${s.session}` }));
    expect(who).toMatchObject({ signedIn: true, login: "ada", permission: "write", canScan: true, minPermission: "write", resource: "acme/site" });
    // The cookie alone works too (same-site hosting).
    expect((await j(get(handler, "session", { Cookie: cookie.split(";")[0]! }))).login).toBe("ada");
  });

  it("refuses a viewer without the access, a state from another browser, and a bad code", async () => {
    const { handler } = relay();
    const reader = await signIn(handler, "rex");
    expect(reader.session).toBe("");
    expect(reader.error).toBe("Signed in as rex, who has read access to acme/site. Re-scan needs write access.");
    expect((await signIn(handler, "nobody")).error).toMatch(/nobody, who has none access/);
    // Login CSRF: someone else's sign-in link, finished in this browser.
    const start = await get(handler, `auth/start?return=${encodeURIComponent(PAGE)}`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    expect((await get(handler, `auth/callback?code=code-ada&state=${encodeURIComponent(state)}`, { Cookie: "dsa_relay_state=someone-elses" })).status).toBe(400);
    expect((await get(handler, `auth/callback?code=code-ada&state=forged`, { Cookie: "dsa_relay_state=x" })).status).toBe(400);
    const bad = await get(handler, `auth/callback?code=wrong&state=${encodeURIComponent(state)}`, { Cookie: start.headers.getSetCookie()[0]!.split(";")[0]! });
    expect(decodeURIComponent(new URL(bad.headers.get("location")!).hash)).toMatch(/The code passed is incorrect or expired/);
    // A lower bar when the operator sets one.
    expect((await signIn(relay({ DSA_RELAY_MIN_PERMISSION: "read" }).handler, "rex")).session).toMatch(/^v1\./);
  });
});

describe("starting a scan", () => {
  it("only from the dashboard's origin, with the relay's header (CSRF), and CORS for that origin only", async () => {
    const { handler } = relay();
    const { session } = await signIn(handler, "ada");
    const auth = { Authorization: `Bearer ${session}` };
    expect((await post(handler, "scan", { ...auth, "X-DSA-Relay": "1" })).status, "no Origin").toBe(403);
    expect((await post(handler, "scan", { ...auth, Origin: "https://evil.example.test", "X-DSA-Relay": "1" })).status, "another site").toBe(403);
    expect((await post(handler, "scan", { ...auth, Origin: PAGE })).status, "a plain form post can't add the header").toBe(403);
    expect((await post(handler, "auth/sign-out", { Origin: "https://evil.example.test", "X-DSA-Relay": "1" })).status).toBe(403);
    const pre = await handler(new Request(`${RELAY}scan`, { method: "OPTIONS", headers: { Origin: PAGE, "Access-Control-Request-Method": "POST" } }));
    expect([pre.status, pre.headers.get("access-control-allow-origin"), pre.headers.get("access-control-allow-credentials")]).toEqual([204, PAGE, "true"]);
    expect(pre.headers.get("access-control-allow-headers")).toMatch(/X-DSA-Relay/);
    const evil = await handler(new Request(`${RELAY}scan`, { method: "OPTIONS", headers: { Origin: "https://evil.example.test" } }));
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("needs a signed-in viewer who still has the access", async () => {
    const access: Record<string, string> = { ada: "write" };
    const gh = fakeGithub({ access });
    const { handler } = relay({}, gh);
    const anon = await post(handler, "scan");
    expect(anon.status).toBe(401);
    expect(await j(anon)).toMatchObject({ error: "Sign in with GitHub to re-scan.", signIn: `${RELAY}auth/start` });
    const { session } = await signIn(handler, "ada");
    // Removed from the repo after signing in: the relay checks again before each scan.
    access.ada = "read";
    const r = await post(handler, "scan", { Origin: PAGE, "X-DSA-Relay": "1", Authorization: `Bearer ${session}` });
    expect(r.status).toBe(403);
    expect((await j(r)).error).toBe("ada has read access to acme/site. Re-scan needs write access.");
  });

  it("passes on a photo setting it knows, and starts nothing for one it doesn't", async () => {
    const gh = fakeGithub();
    const { handler } = relay({}, gh);
    const { session } = await signIn(handler, "ada");
    const h = { Origin: PAGE, "X-DSA-Relay": "1", Authorization: `Bearer ${session}`, "Content-Type": "application/json" };
    const send = (shots: unknown) => handler(new Request(new URL("scan", RELAY), { method: "POST", headers: h, body: JSON.stringify({ shots }) }));
    const bad = await send("fresh --allow-unreleased");
    expect(bad.status).toBe(400);
    expect(gh.calls.filter((c) => c.url.endsWith("/dispatches"))).toHaveLength(0);
    expect((await send("fresh")).status).toBe(202);
    expect(gh.calls.filter((c) => c.url.endsWith("/dispatches"))).toHaveLength(1);
  });

  it("starts the workflow, refuses a second while one runs (answering with it), and rate-limits", async () => {
    let t = Date.parse("2026-11-01T12:00:00Z");
    const gh = fakeGithub();
    const { handler } = relay({ DSA_RELAY_RATE: "2/600" }, gh, () => t);
    const { session } = await signIn(handler, "ada");
    const h = { Origin: PAGE, "X-DSA-Relay": "1", Authorization: `Bearer ${session}` };
    const first = await post(handler, "scan", h);
    expect(first.status).toBe(202);
    expect(first.headers.get("access-control-allow-origin")).toBe(PAGE);
    expect((await j(first)).run).toMatchObject({ id: "77", status: "queued", steps: { done: 1, total: 3, current: "Scan" } });
    expect(gh.calls.filter((c) => c.url.endsWith("/dispatches")).map((c) => c.auth)).toEqual([`Bearer ${GH_TOKEN}`]);
    const second = await post(handler, "scan", h);
    expect(second.status).toBe(409);
    expect(await j(second)).toMatchObject({ error: "A scan is already running.", run: { id: "77" } });
    expect(gh.calls.filter((c) => c.url.endsWith("/dispatches"))).toHaveLength(1);
    // Finished; another is fine, then the limit.
    gh.finish(77);
    t += 1000;
    expect((await post(handler, "scan", h)).status).toBe(202);
    gh.finish(77);
    const limited = await post(handler, "scan", h);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("599");
    expect((await j(limited)).error).toMatch(/started 2 scans in the last 10 minutes. Try again in 10 minutes/);
    t += 600_000;
    expect((await post(handler, "scan", h)).status).toBe(202);
  });

  it("refuses when a scheduled scan is already going", async () => {
    const { handler } = relay({}, fakeGithub({ running: true }));
    const { session } = await signIn(handler, "ada");
    const r = await post(handler, "scan", { Origin: PAGE, "X-DSA-Relay": "1", Authorization: `Bearer ${session}` });
    expect(r.status).toBe(409);
    expect((await j(r)).run).toMatchObject({ id: "50", event: "schedule", status: "running" });
  });
});

describe("progress", () => {
  it("maps the run and its steps server-side; public views leave out the run link", async () => {
    const { handler } = relay({}, fakeGithub({ running: true }));
    const active = await j(get(handler, "scan/active", { Origin: PAGE }));
    expect(active.runs).toEqual([{ id: "50", status: "running", event: "schedule", startedAt: "2026-11-01T10:00:00Z", finishedAt: null, url: null, steps: { done: 1, total: 3, current: "Scan" }, error: null }]);
    const { session } = await signIn(handler, "ada");
    const status = await j(get(handler, "scan/status?id=50", { Authorization: `Bearer ${session}` }));
    expect(status.run).toMatchObject({ id: "50", url: "https://github.test/acme/site/actions/runs/50" });
    expect((await get(handler, "scan/status?id=../../x")).status).toBe(400);
    expect((await get(handler, "scan/status?id=999")).status).toBe(404);
  });

  it("can require sign-in to see scans at all", async () => {
    const { handler } = relay({ DSA_RELAY_STATUS: "signed-in" }, fakeGithub({ running: true }));
    expect((await get(handler, "scan/active")).status).toBe(401);
    const { session } = await signIn(handler, "ada");
    expect((await get(handler, "scan/active", { Authorization: `Bearer ${session}` })).status).toBe(200);
  });

  it("reuses answers for a few seconds, so many viewers polling don't spend the relay's API allowance", async () => {
    let t = 0;
    const gh = fakeGithub({ running: true });
    const { handler } = relay({}, gh, () => t);
    for (let i = 0; i < 5; i++) await get(handler, "scan/status?id=50");
    expect(gh.calls.filter((c) => c.url.endsWith("/runs/50"))).toHaveLength(1);
    t += 5000;
    await get(handler, "scan/status?id=50");
    expect(gh.calls.filter((c) => c.url.endsWith("/runs/50"))).toHaveLength(2);
  });
});

describe("on Node", () => {
  it("serves the same handler over http, cookies and all, under a sub-path", async () => {
    const gh = fakeGithub();
    const port = 41000 + Math.floor(Math.random() * 2000);
    const publicUrl = `http://localhost:${port}/dsa/relay/`;
    const handler = createRelay(relayOptionsFromEnv({ ...ENV, DSA_RELAY_URL: publicUrl, DSA_RELAY_ORIGINS: `http://localhost:${port}` }, { fetch: gh.f }));
    const s = await startRelayServer(handler, { port, publicUrl });
    try {
      const start = await fetch(`http://localhost:${port}/dsa/relay/auth/start?return=${encodeURIComponent(`http://localhost:${port}/dsa/`)}`, { redirect: "manual" });
      expect(start.status).toBe(302);
      expect(start.headers.getSetCookie()[0]).toMatch(/Path=\/dsa\/relay\//);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const back = await fetch(`http://localhost:${port}/dsa/relay/auth/callback?code=code-ada&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { Cookie: start.headers.getSetCookie()[0]!.split(";")[0]! } });
      expect(back.headers.getSetCookie()).toHaveLength(2);
      const session = decodeURIComponent(new URL(back.headers.get("location")!).hash.split("=")[1]!);
      const scan = await fetch(`http://localhost:${port}/dsa/relay/scan`, { method: "POST", headers: { Origin: `http://localhost:${port}`, "X-DSA-Relay": "1", Authorization: `Bearer ${session}` } });
      expect(scan.status).toBe(202);
      expect((await fetch(`http://localhost:${port}/elsewhere`)).status).toBe(404);
    } finally {
      await s.close();
    }
  });
});
