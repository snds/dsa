import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ACME_ROOT, FIXTURES } from "./setup.js";
import { createProgram, type CliIo } from "../../src/cli.js";
import { resetAddons, useAddons } from "../../src/cli-engine.js";
import { hasStore, registerStore } from "../../src/engine/store.js";
import { openDuckStore } from "../../packages/history/src/index.js";

// The CLI on a deployed product: `dsa run` refuses a checkout that isn't live (or labels it),
// `dsa live` reports the check, history moves through a git branch, and `dsa apply-decisions`
// applies a file the static dashboard exported.

const NOW = "2026-10-06T12:00:00.000Z";
const GIT_TIMEOUT = 180_000;
/** CI sets these on pull-request builds, and the env source rightly ignores CI variables then. */
const PR_VARS = ["GITHUB_EVENT_NAME", "CI_MERGE_REQUEST_IID", "BITBUCKET_PR_ID", "CIRCLE_PULL_REQUEST", "BUILDKITE_PULL_REQUEST", "TRAVIS_PULL_REQUEST", "SYSTEM_PULLREQUEST_PULLREQUESTID", "DRONE_PULL_REQUEST"];
let savedPr: Record<string, string | undefined> = {};
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

describe("cli: runs against what is live", () => {
  let dir: string;
  let repo: string;
  let out: string[];
  let io: CliIo;
  const profile = path.join(FIXTURES, "profiles", "acme-suite.mjs");
  const config = (extra: Record<string, unknown>) => {
    const f = path.join(repo, "dsa.config.json");
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), ...extra }, null, 2));
    git(repo, "commit", "-q", "-am", "config");
    return git(repo, "rev-parse", "HEAD");
  };
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsa-cli-live-")));
    repo = path.join(dir, "repo");
    fs.cpSync(ACME_ROOT, repo, { recursive: true });
    fs.writeFileSync(path.join(repo, ".gitignore"), ".dsa/\n");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "product");
    out = [];
    io = { out: (s) => out.push(s), err: (s) => out.push(s), cwd: repo };
    resetAddons();
    savedPr = Object.fromEntries(PR_VARS.map((k) => [k, process.env[k]]));
    for (const k of PR_VARS) delete process.env[k];
  }, GIT_TIMEOUT);
  afterEach(() => {
    for (const [k, v] of Object.entries(savedPr)) if (v !== undefined) process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
    registerStore(openDuckStore);
  });
  const run = async (...args: string[]) => {
    await useAddons(io.cwd);
    if (!hasStore()) registerStore(openDuckStore);
    return createProgram(io).parseAsync(["node", "dsa", ...args]);
  };

  it("refuses a checkout that isn't the live revision, runs labelled when allowed, and records the live one", async () => {
    const product = git(repo, "rev-parse", "HEAD");
    config({ live: { revision: { value: product } } }); // HEAD is now a later commit than the live one
    await expect(run("run", "--profile", profile, "--no-git", "--now", NOW)).rejects.toThrow(/is live .*--allow-unreleased/s);
    expect(fs.existsSync(path.join(repo, ".dsa", "dsa.duckdb"))).toBe(false);
    await expect(run("live")).rejects.toThrow(/Check out the live commit/);

    out.length = 0;
    await run("run", "--profile", profile, "--no-git", "--now", NOW, "--allow-unreleased");
    expect(out.join("\n")).toMatch(/NOT LIVE: The checkout is/);
    const latestLive = async () => {
      const s = await openDuckStore(path.join(repo, ".dsa"));
      try {
        const [r] = await s.all<{ sources: string }>("select sources from runs order by taken_at desc limit 1");
        return JSON.parse(r!.sources).live;
      } finally {
        s.close();
      }
    };
    expect(await latestLive()).toMatchObject({ state: "other-commit", unreleased: true });

    // Deployed: the live revision is HEAD (here from a CI variable, as in the deploy job).
    process.env.DSA_TEST_DEPLOYED = config({ live: { revision: { env: ["DSA_TEST_DEPLOYED"] } } });
    try {
      out.length = 0;
      await run("live");
      expect(out.join("\n")).toMatch(/the live revision \(env DSA_TEST_DEPLOYED\)/);
      await run("run", "--profile", profile, "--no-git", "--now", "2026-10-07T12:00:00.000Z");
      expect(await latestLive()).toMatchObject({ state: "live", ok: true, revision: { via: "env DSA_TEST_DEPLOYED" } });
    } finally {
      delete process.env.DSA_TEST_DEPLOYED;
    }
  }, GIT_TIMEOUT);

  it("keeps history on a git branch between jobs, and applies decisions exported from the static dashboard", async () => {
    const remote = path.join(dir, "remote.git");
    git(dir, "init", "-q", "--bare", "-b", "main", remote);
    git(repo, "remote", "add", "origin", remote);
    config({ history: { adapter: "git-branch" } });
    git(repo, "push", "-q", "origin", "main");
    await run("run", "--profile", profile, "--no-git", "--now", NOW);
    expect(out.join("\n")).toMatch(/History: no dsa-data branch on origin yet/);
    expect(out.join("\n")).toMatch(/History: saved to origin\/dsa-data/);
    expect(git(remote, "ls-tree", "--name-only", "dsa-data")).toMatch(/dsa\.duckdb/);

    // The next job starts from a fresh clone: no data folder until it pulls.
    const job = path.join(dir, "job");
    git(dir, "clone", "-q", remote, job);
    io = { ...io, cwd: job };
    resetAddons();
    const s = await openDuckStore(path.join(repo, ".dsa"));
    let id: string;
    try {
      id = (await s.all<{ id: string }>("select id from element_evals where verdict = 'replace' order by id limit 1"))[0]!.id;
    } finally {
      s.close();
    }
    const file = path.join(dir, "dsa-decisions.json");
    fs.writeFileSync(file, JSON.stringify({ dsa: "decisions", version: 1, decisions: [{ ids: [id], decision: { verdict: "keep" }, note: "from the static page" }] }));
    out.length = 0;
    await run("apply-decisions", "--file", file, "--profile", profile, "--who", "reviewer");
    const text = out.join("\n");
    expect(text).toMatch(/History: restored/);
    expect(text).toMatch(/Applied 1 decision\(s\) covering 1 element\(s\)/);
    // The decision lands in the app's decisions file in the repo (a workflow commits it or opens a PR).
    expect(git(job, "status", "--porcelain", "--untracked-files=all")).toMatch(/decisions\.json/);
    expect(text).toMatch(/History: saved to origin\/dsa-data/);
    await expect(run("apply-decisions", "--profile", profile)).rejects.toThrow(/one of --file, --url or --issue/);
  }, GIT_TIMEOUT);
});
