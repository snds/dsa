import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseConfig } from "../src/config.js";
import {
  BUILTIN_HISTORIES,
  NotLiveError,
  checkLive,
  commandHistory,
  compareTree,
  cookiesFor,
  decisionsIn,
  deployFor,
  genericHost,
  gitBranchHistory,
  githubHost,
  historyBackend,
  hostAdapter,
  issueNumber,
  localHistory,
  normalizeBase,
  openSurface,
  resolveLiveRevision,
  serveStatic,
  type HostAdapter,
  type HostContext,
  type LiveConfig,
  type RevisionContext,
} from "../src/deploy/index.js";

// The seams that let dsa run where the product is deployed: the live revision, the checkout check,
// live surfaces, host adapters (generic, github) and history backends (local, git-branch, command).

// Real git repos: slow on some machines, so these get room beyond the default 30 s.
const GIT_TIMEOUT = 120_000;

const dirs: string[] = [];
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsa-deploy-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A repo with two commits; returns the folder and both SHAs. */
function repo() {
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(d, "a.txt"), "one\n");
  git(d, "add", ".");
  git(d, "commit", "-q", "-m", "one");
  const first = git(d, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(d, "a.txt"), "two\n");
  git(d, "commit", "-q", "-am", "two");
  return { dir: d, first, second: git(d, "rev-parse", "HEAD") };
}

const live = (over: Partial<LiveConfig> = {}): LiveConfig => parseConfig({ live: { ...over } }).live!;

/** A fetch that answers from a table of URL → response. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown } | ((init?: RequestInit) => { status?: number; body: unknown })>) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url === k || url.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const r = routes[key]!;
    const v = typeof r === "function" ? r(init) : r;
    return new Response(typeof v.body === "string" ? v.body : JSON.stringify(v.body), { status: v.status ?? 200 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const rc = (l: LiveConfig, env: Record<string, string> = {}, f: typeof fetch = fetch, cookies: (u: string) => string | undefined = () => undefined): RevisionContext => ({ root: "/", live: l, env, fetch: f, cookies });

describe("live revision sources", () => {
  it("takes a configured value first", async () => {
    const r = await resolveLiveRevision(rc(live({ revision: { value: "abc1234", liveAt: "2026-10-01T00:00:00Z" } } as never), { GITHUB_SHA: "f".repeat(40) }));
    expect(r).toEqual({ sha: "abc1234", liveAt: "2026-10-01T00:00:00Z", via: "config live.revision.value" });
  });

  it("reads common CI variables, but not on a pull-request build", async () => {
    const sha = "a".repeat(40);
    expect((await resolveLiveRevision(rc(live(), { CI_COMMIT_SHA: sha })))?.via).toBe("env CI_COMMIT_SHA");
    expect(await resolveLiveRevision(rc(live(), { GITHUB_SHA: sha, GITHUB_EVENT_NAME: "pull_request" }))).toBeNull();
    expect(await resolveLiveRevision(rc(live(), { CI_COMMIT_SHA: sha, CI_MERGE_REQUEST_IID: "7" }))).toBeNull();
    expect(await resolveLiveRevision(rc(live({ revision: { env: ["DEPLOYED_SHA"] } } as never), { GITHUB_SHA: sha, DEPLOYED_SHA: "b".repeat(40) }))).toMatchObject({ sha: "b".repeat(40), via: "env DEPLOYED_SHA" });
    expect(await resolveLiveRevision(rc(live({ revision: { env: false } } as never), { GITHUB_SHA: sha }))).toBeNull();
  });

  it("asks the live site's version endpoint (JSON or text), signed in with the saved session", async () => {
    const { fetch: f, calls } = fakeFetch({
      "https://site.test/version.json": { body: { build: { commit: "c0ffee1" }, deployedAt: "2026-10-02T08:00:00Z" } },
      "https://site.test/version.txt": { body: "release c0ffee2 built today" },
    });
    const j = await resolveLiveRevision(rc(live({ revision: { endpoint: "https://site.test/version.json", field: "build.commit" } } as never), {}, f, () => "sid=1"));
    expect(j).toEqual({ sha: "c0ffee1", liveAt: "2026-10-02T08:00:00Z", via: "endpoint https://site.test/version.json" });
    expect((calls[0]!.init!.headers as Record<string, string>).Cookie).toBe("sid=1");
    expect((await resolveLiveRevision(rc(live({ revision: { endpoint: "https://site.test/version.txt" } } as never), {}, f)))?.sha).toBe("c0ffee2");
  });

  it("stops at a source that fails instead of falling through to a CI variable", async () => {
    const { fetch: f } = fakeFetch({ "https://site.test/version.json": { status: 403, body: "no" } });
    await expect(resolveLiveRevision(rc(live({ revision: { endpoint: "https://site.test/version.json" } } as never), { GITHUB_SHA: "a".repeat(40) }, f))).rejects.toThrow(/answered 403.*dsa login/);
  });

  it("follows live.revision.sources and rejects a name no adapter provides", async () => {
    const extra = { id: "mine", resolve: async () => ({ sha: "1234567", via: "mine" }) };
    expect((await resolveLiveRevision(rc(live({ revision: { sources: ["mine", "env"] } } as never), { GITHUB_SHA: "a".repeat(40) }), [extra]))?.via).toBe("mine");
    await expect(resolveLiveRevision(rc(live({ revision: { sources: ["nope"] } } as never)))).rejects.toThrow(/"nope"/);
  });

  it("builds a Cookie header from saved sign-ins whose domain, path and expiry match", () => {
    const d = tmp();
    const f = path.join(d, "auth.json");
    fs.writeFileSync(f, JSON.stringify({ cookies: [
      { name: "sid", value: "1", domain: ".site.test", path: "/", expires: -1, secure: true },
      { name: "app", value: "2", domain: "site.test", path: "/app", expires: Date.now() / 1000 + 60 },
      { name: "old", value: "3", domain: "site.test", path: "/", expires: 1 },
      { name: "other", value: "4", domain: "elsewhere.test", path: "/" },
    ] }));
    expect(cookiesFor("https://www.site.test/app/x", [f])).toBe("sid=1; app=2");
    expect(cookiesFor("http://site.test/", [f])).toBeUndefined();
  });
});

describe("the checkout against the live revision", () => {
  it("live when HEAD is the live commit (or has its tree), not when it is another commit or modified", () => {
    const { dir, first, second } = repo();
    expect(compareTree(dir, { sha: second.slice(0, 7), via: "t" }).state).toBe("live");
    expect(compareTree(dir, { sha: first, via: "t" }).state).toBe("other-commit");
    // A commit that changes nothing has the live tree.
    git(dir, "commit", "-q", "--allow-empty", "-m", "merge");
    expect(compareTree(dir, { sha: second, via: "t" }).state).toBe("live");
    fs.writeFileSync(path.join(dir, "a.txt"), "edited\n");
    expect(compareTree(dir, { sha: second, via: "t" }).state).toBe("modified");
    // Untracked files (a build's output) don't count.
    git(dir, "checkout", "-q", "a.txt");
    fs.writeFileSync(path.join(dir, "dist.js"), "x");
    expect(compareTree(dir, { sha: second, via: "t" }).state).toBe("live");
    expect(compareTree(dir, null).state).toBe("unknown");
    expect(compareTree(tmp(), { sha: second, via: "t" }).state).toBe("unknown");
  }, GIT_TIMEOUT);

  it("refuses a checkout that isn't live, or labels it when told to", async () => {
    const { dir, first, second } = repo();
    const cfg = (onMismatch: "refuse" | "label") => live({ revision: { value: first }, onMismatch } as never);
    const err = await checkLive({ root: dir, live: cfg("refuse"), env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(NotLiveError);
    expect(err.check.state).toBe("other-commit");
    expect(err.message).toMatch(/--allow-unreleased/);
    const labelled = await checkLive({ root: dir, live: cfg("label"), env: {} });
    expect(labelled).toMatchObject({ ok: false, unreleased: true, state: "other-commit" });
    expect(labelled.label).toMatch(/^NOT LIVE: The checkout is/);
    expect((await checkLive({ root: dir, live: cfg("refuse"), env: {}, allowUnreleased: true })).unreleased).toBe(true);
    const ok = await checkLive({ root: dir, live: live({ revision: { value: second } } as never), env: {} });
    expect(ok).toMatchObject({ ok: true, state: "live" });
    expect(ok.label).toMatch(/the live revision/);
    // No live section: a local run as before, said plainly.
    expect(await checkLive({ root: dir, live: undefined })).toMatchObject({ ok: true, state: "unchecked", head: second });
    // A live section that finds no revision refuses: it can't promise the scan is what shipped.
    await expect(checkLive({ root: dir, live: live({ revision: { env: false } } as never), env: {} })).rejects.toThrow(/No live revision found/);
  }, GIT_TIMEOUT);
});

describe("live surfaces", () => {
  const get = async (url: string) => { const r = await fetch(url); return { status: r.status, body: await r.text(), type: r.headers.get("content-type") }; };

  it("serves a built folder under its mount path, as a static host does", async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, "assets"));
    fs.writeFileSync(path.join(d, "index.html"), "<p>shell</p>");
    fs.writeFileSync(path.join(d, "assets", "app.js"), "1");
    fs.writeFileSync(path.join(path.dirname(d), "secret.txt"), "no");
    const s = await serveStatic(d, "/app");
    try {
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/app\/$/);
      const origin = new URL(s.url).origin;
      expect(await get(`${origin}/app/`)).toMatchObject({ status: 200, body: "<p>shell</p>" });
      expect(await get(`${origin}/app/assets/app.js`)).toMatchObject({ status: 200, type: "text/javascript" });
      expect((await get(`${origin}/app/materials/12`)).body).toBe("<p>shell</p>"); // a client-side route
      expect((await get(`${origin}/app/missing.js`)).status).toBe(404);
      expect((await get(`${origin}/elsewhere`)).status).toBe(404);
      expect((await get(`${origin}/app/..%2f..%2fsecret.txt`)).status).toBe(404);
    } finally {
      s.stop();
      fs.rmSync(path.join(path.dirname(d), "secret.txt"), { force: true });
    }
  });

  it("opens a URL as it is, a folder on localhost, and insists the saved sign-in exists", async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist", "index.html"), "x");
    fs.writeFileSync(path.join(root, "auth.json"), "{}");
    const u = await openSurface({ url: "https://site.test/app", auth: "auth.json" }, root);
    expect(u).toMatchObject({ url: "https://site.test/app/", deployed: true, readApi: true, storageState: path.join(root, "auth.json") });
    const f = await openSurface({ dir: "dist" }, root);
    try {
      expect(f).toMatchObject({ deployed: false, readApi: false, how: "built folder dist" });
      expect((await fetch(f.url)).status).toBe(200);
    } finally {
      f.stop();
    }
    await expect(openSurface({ url: "https://site.test/", auth: "nope.json" }, root)).rejects.toThrow(/dsa login/);
    await expect(openSurface({ dir: "build" }, root)).rejects.toThrow(/Build it first/);
    expect(() => parseConfig({ live: { app: { url: "https://x.test", dir: "dist" } } })).toThrow(/not both/);
    expect(normalizeBase("dsa")).toBe("/dsa/");
    expect(normalizeBase(undefined)).toBe("/");
  });
});

const hostCtx = (host: unknown, over: Partial<HostContext> = {}): HostContext => ({ root: "/", host: parseConfig({ host }).host!, config: {}, env: {}, fetch, ...over });

describe("host adapters", () => {
  it("generic: no Re-scan without a configured job; a link or a webhook when there is one; decisions as a file or a POST", () => {
    expect(genericHost.actions(hostCtx({})).rescan.kind).toBe("none");
    expect(genericHost.actions(hostCtx({})).decisions).toMatchObject({ kind: "export", apply: expect.stringMatching(/apply-decisions --file/) });
    const a = genericHost.actions(hostCtx({ rescan: { url: "https://ci.test/hook", method: "post" }, decisions: { mode: "post", url: "https://ci.test/decisions" } }));
    expect(a.rescan).toMatchObject({ kind: "post", url: "https://ci.test/hook" });
    expect(a.decisions).toMatchObject({ kind: "post", url: "https://ci.test/decisions" });
    expect(genericHost.actions(hostCtx({ rescan: { url: "https://ci.test/run" } })).rescan.kind).toBe("link");
  });

  it("generic: reads decisions from a file or a URL", async () => {
    const d = tmp();
    const f = path.join(d, "d.json");
    fs.writeFileSync(f, JSON.stringify({ dsa: "decisions", decisions: [] }));
    expect(await genericHost.readDecisions(f, hostCtx({}))).toEqual({ dsa: "decisions", decisions: [] });
    const { fetch: ff } = fakeFetch({ "https://ci.test/d.json": { body: { dsa: "decisions", decisions: [1] } } });
    expect(await genericHost.readDecisions("https://ci.test/d.json", hostCtx({}, { fetch: ff }))).toEqual({ dsa: "decisions", decisions: [1] });
  });

  it("picks the adapter by name, a later one with the same name winning, and refuses an unknown one", () => {
    const mine: HostAdapter = { ...genericHost, id: "generic", actions: () => ({ ...genericHost.actions(hostCtx({})), host: "mine" }) };
    expect(hostAdapter(undefined, [genericHost, githubHost]).id).toBe("generic");
    expect(hostAdapter("generic", [genericHost, mine]).actions(hostCtx({})).host).toBe("mine");
    expect(() => hostAdapter("netlify", [genericHost, githubHost])).toThrow(/known: generic, github/);
  });

  it("finds a decisions file in an issue body or comment", () => {
    expect(decisionsIn('Some text\n\n```json\n{"dsa":"decisions","decisions":[]}\n```\n')).toEqual({ dsa: "decisions", decisions: [] });
    expect(decisionsIn('```json\n{"other":1}\n```')).toBeNull();
    expect(decisionsIn('{"dsa":"decisions","decisions":[]}')).toEqual({ dsa: "decisions", decisions: [] });
    expect(issueNumber("#12")).toBe(12);
    expect(issueNumber("https://github.com/o/r/issues/34")).toBe(34);
  });

  it("github: Re-scan opens the workflow, decisions become a labelled issue; the repo comes from config, then GITHUB_REPOSITORY", () => {
    const a = githubHost.actions(hostCtx({ adapter: "github", github: { repo: "acme/site", workflow: "scan.yml", ref: "main" } }));
    expect(a.rescan).toMatchObject({ kind: "link", url: "https://github.com/acme/site/actions/workflows/scan.yml" });
    expect(a.decisions).toMatchObject({ kind: "issue", url: "https://github.com/acme/site/issues/new", labels: ["dsa-decisions"], apply: "dsa apply-decisions --issue <number>" });
    const ghes = githubHost.actions(hostCtx({ adapter: "github", github: { server: "https://git.corp.test/" }, decisions: { mode: "pr" } }, { env: { GITHUB_REPOSITORY: "team/app" } }));
    expect(ghes.rescan.url).toBe("https://git.corp.test/team/app/actions/workflows/dsa.yml");
    expect(ghes.decisions.help).toMatch(/pull request/);
    expect(githubHost.actions(hostCtx({ adapter: "github" }, { config: { github: { defaultRepo: "x/y" } } })).decisions.url).toBe("https://github.com/x/y/issues/new");
    // No repo anywhere: the generic buttons, with a note.
    expect(githubHost.actions(hostCtx({ adapter: "github" })).rescan).toMatchObject({ kind: "none", help: expect.stringMatching(/host.github.repo/) });
    // decisions.mode export keeps the download.
    expect(githubHost.actions(hostCtx({ adapter: "github", github: { repo: "a/b" }, decisions: { mode: "export" } })).decisions.kind).toBe("export");
  });

  it("github: reads decisions from an issue (the newest comment wins) and closes it when applied", async () => {
    const file = (n: number) => `\`\`\`json\n${JSON.stringify({ dsa: "decisions", decisions: Array(n).fill({ ids: ["x"], decision: { verdict: "keep" } }) })}\n\`\`\``;
    const writes: { url: string; method: string; body: any }[] = [];
    const { fetch: f } = fakeFetch({
      "https://api.github.com/repos/acme/site/issues/7/comments": (init) => {
        if (init?.method === "POST") { writes.push({ url: "comment", method: "POST", body: JSON.parse(String(init.body)) }); return { status: 201, body: {} }; }
        return { body: [{ body: file(2) }, { body: "thanks" }, { body: file(3) }] };
      },
      "https://api.github.com/repos/acme/site/issues/7": (init) => {
        if (init?.method === "PATCH") { writes.push({ url: "issue", method: "PATCH", body: JSON.parse(String(init.body)) }); return { body: {} }; }
        return { body: { body: file(1), comments: 3 } };
      },
    });
    const c = hostCtx({ adapter: "github", github: { repo: "acme/site" } }, { fetch: f, env: { GITHUB_TOKEN: "t" } });
    const d = (await githubHost.readDecisions("#7", c)) as { decisions: unknown[] };
    expect(d.decisions).toHaveLength(3);
    await githubHost.applied!("7", "Applied 3.", c);
    expect(writes).toEqual([{ url: "comment", method: "POST", body: { body: "Applied 3." } }, { url: "issue", method: "PATCH", body: { state: "closed", state_reason: "completed" } }]);
    // A path still reads a file.
    const tmpFile = path.join(tmp(), "d.json");
    fs.writeFileSync(tmpFile, '{"dsa":"decisions","decisions":[]}');
    expect(await githubHost.readDecisions(tmpFile, c)).toEqual({ dsa: "decisions", decisions: [] });
  });

  it("github: the live revision is the newest deployment that finished, with when it went live", async () => {
    const { fetch: f } = fakeFetch({
      "https://api.github.com/repos/acme/site/deployments?": { body: [{ id: 2, sha: "b".repeat(40), created_at: "2026-10-03" }, { id: 1, sha: "a".repeat(40), created_at: "2026-10-01" }] },
      "https://api.github.com/repos/acme/site/deployments/2/statuses": { body: [{ state: "in_progress" }] },
      "https://api.github.com/repos/acme/site/deployments/1/statuses": { body: [{ state: "success", created_at: "2026-10-01T09:30:00Z" }] },
    });
    const c = hostCtx({ adapter: "github", github: { repo: "acme/site" } }, { fetch: f });
    const [src] = githubHost.revisionSources!(c);
    const r = await resolveLiveRevision(rc(live({ revision: { sources: ["github-deployment"] } } as never), {}, f), [src!]);
    expect(r).toEqual({ sha: "a".repeat(40), liveAt: "2026-10-01T09:30:00Z", via: "github-pages deployment 1 on acme/site" });
  });
});

describe("history backends", () => {
  const hctx = (history: unknown, root = "/") => ({ root, history: parseConfig({ history }).history!, log: () => {} });

  it("local keeps the data folder where it is; an unknown adapter is an error", async () => {
    const b = historyBackend(hctx({}), BUILTIN_HISTORIES);
    expect(b.id).toBe("local");
    expect(await b.pull("/x")).toMatch(/local/);
    expect(() => historyBackend(hctx({ adapter: "s3" }), [localHistory])).toThrow(/known: local/);
  });

  it("git-branch: pushes the data folder to its own branch (no secrets), pulls it into a fresh job, and skips an unchanged push", async () => {
    const remote = tmp();
    git(remote, "init", "-q", "--bare", "-b", "main");
    const { dir: a } = repo();
    git(a, "remote", "add", "origin", remote);
    git(a, "push", "-q", "origin", "main");
    const data = path.join(a, ".dsa");
    fs.mkdirSync(path.join(data, "shots"), { recursive: true });
    fs.mkdirSync(path.join(data, "auth"));
    fs.writeFileSync(path.join(data, "dsa.duckdb"), "db-1");
    fs.writeFileSync(path.join(data, "shots", "s.png"), "png");
    fs.writeFileSync(path.join(data, "secrets.json"), '{"githubToken":"x"}');
    fs.writeFileSync(path.join(data, "auth", "site.json"), "{}");
    fs.writeFileSync(path.join(data, "dsa.duckdb.wal"), "wal");
    const branch = gitBranchHistory.create(hctx({ adapter: "git-branch" }, a));
    expect(await branch.pull(data)).toMatch(/no dsa-data branch/);
    expect(await branch.push(data, "run 1")).toMatch(/saved to origin\/dsa-data/);
    expect(git(remote, "ls-tree", "-r", "--name-only", "dsa-data").split("\n").sort()).toEqual(["dsa.duckdb", "shots/s.png"]);
    expect(await branch.push(data, "run 1 again")).toMatch(/already has this data/);
    // The product's branch and working tree are untouched.
    expect(git(a, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(a, "status", "--porcelain", "--untracked-files=no")).toBe("");

    // A fresh CI job: clone, pull, run, push.
    const b = tmp();
    git(b, "clone", "-q", remote, ".");
    const dataB = path.join(b, ".dsa");
    const fresh = gitBranchHistory.create(hctx({ adapter: "git-branch" }, b));
    expect(await fresh.pull(dataB)).toMatch(/restored/);
    expect(fs.readFileSync(path.join(dataB, "dsa.duckdb"), "utf8")).toBe("db-1");
    expect(fs.existsSync(path.join(dataB, "secrets.json"))).toBe(false);
    fs.writeFileSync(path.join(dataB, "dsa.duckdb"), "db-2");
    await fresh.push(dataB, "run 2");
    expect(git(remote, "rev-list", "--count", "dsa-data")).toBe("2");
    expect(git(remote, "log", "-1", "--format=%s", "dsa-data")).toBe("run 2");

    // keep: latest holds the branch at one commit.
    fs.writeFileSync(path.join(dataB, "dsa.duckdb"), "db-3");
    await gitBranchHistory.create(hctx({ adapter: "git-branch", keep: "latest" }, b)).push(dataB, "run 3");
    expect(git(remote, "rev-list", "--count", "dsa-data")).toBe("1");
    expect(git(remote, "show", "dsa-data:dsa.duckdb")).toBe("db-3");
  }, GIT_TIMEOUT);

  it("command: runs your pull and push commands with the folder filled in, and fails loudly", async () => {
    const root = tmp();
    const store = path.join(root, "bucket");
    fs.mkdirSync(store);
    fs.writeFileSync(path.join(store, "dsa.duckdb"), "from-store");
    const node = JSON.stringify(process.execPath);
    const cp = (from: string, to: string) => `${node} -e "require('fs').cpSync(process.argv[1], process.argv[2], { recursive: true })" ${from} ${to}`;
    const b = commandHistory.create(hctx({ adapter: "command", pull: cp(JSON.stringify(store), "{dir}"), push: cp("{dir}", JSON.stringify(path.join(root, "saved"))) }, root));
    const data = path.join(root, "data");
    await b.pull(data);
    expect(fs.readFileSync(path.join(data, "dsa.duckdb"), "utf8")).toBe("from-store");
    await b.push(data, "x");
    expect(fs.readFileSync(path.join(root, "saved", "dsa.duckdb"), "utf8")).toBe("from-store");
    await expect(commandHistory.create(hctx({ adapter: "command", pull: `${node} -e "process.exit(3)"` }, root)).pull(data)).rejects.toThrow(/exit 3/);
    await expect(commandHistory.create(hctx({ adapter: "command" }, root)).push(data, "x")).rejects.toThrow(/history.push is not set/);
  });
});

describe("deployFor", () => {
  it("resolves the host and history the config names, with add-on adapters on top", async () => {
    const { dir, second } = repo();
    const config = { designSystem: { core: { name: "c", packages: [] } }, ...parseConfig({ host: { adapter: "github", github: { repo: "a/b" } }, history: { adapter: "git-branch" }, live: { revision: { value: second } } }) } as never;
    const d = deployFor({ root: dir, config, env: {} });
    expect(d.host.id).toBe("github");
    expect(d.history.id).toBe("git-branch");
    expect(d.actions().rescan.url).toBe("https://github.com/a/b/actions/workflows/dsa.yml");
    expect((await d.check()).state).toBe("live");
    const custom = { id: "custom", create: () => ({ id: "custom", pull: async () => "p", push: async () => "q" }) };
    const withAddon = deployFor({ root: dir, config: { designSystem: { core: { name: "c", packages: [] } }, history: { adapter: "custom" } } as never, histories: [custom] });
    expect(await withAddon.history.pull("/x")).toBe("p");
    // Nothing configured: generic host, local history, an unchecked run.
    const plain = deployFor({ root: dir, config: { designSystem: { core: { name: "c", packages: [] } } } as never });
    expect([plain.host.id, plain.history.id, (await plain.check()).state]).toEqual(["generic", "local", "unchecked"]);
  }, GIT_TIMEOUT);
});
