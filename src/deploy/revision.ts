import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { LiveCheck, LiveConfig, LiveRevision, RevisionContext, RevisionSource } from "./types.js";

/**
 * Which commit is live, and whether the checkout being scanned is that commit. A scan of anything
 * else (a branch, uncommitted work) would show unreleased code as if it shipped, so a run refuses it,
 * or labels it loudly when the config says so.
 */

/**
 * CI variables that hold the commit a job builds. They mean "live" only in the job that deploys,
 * so the env source ignores them on pull-request builds (PR_SIGNALS).
 */
export const CI_REVISION_VARS = [
  "GITHUB_SHA",
  "CI_COMMIT_SHA", // GitLab
  "BITBUCKET_COMMIT",
  "CIRCLE_SHA1",
  "BUILDKITE_COMMIT",
  "TRAVIS_COMMIT",
  "DRONE_COMMIT_SHA",
  "BUILD_SOURCEVERSION", // Azure Pipelines
  "GIT_COMMIT", // Jenkins
  "CODEBUILD_RESOLVED_SOURCE_VERSION",
  "VERCEL_GIT_COMMIT_SHA",
  "CF_PAGES_COMMIT_SHA",
  "COMMIT_REF", // Netlify
  "RENDER_GIT_COMMIT",
  "SOURCE_VERSION", // Heroku, Scalingo
];

/** A build for a pull request or merge request: its commit is not live. [variable, test]. */
const PR_SIGNALS: [string, (v: string) => boolean][] = [
  ["GITHUB_EVENT_NAME", (v) => /^pull_request/.test(v)],
  ["CI_MERGE_REQUEST_IID", Boolean],
  ["BITBUCKET_PR_ID", Boolean],
  ["CIRCLE_PULL_REQUEST", Boolean],
  ["BUILDKITE_PULL_REQUEST", (v) => v !== "false" && v !== ""],
  ["TRAVIS_PULL_REQUEST", (v) => v !== "false" && v !== ""],
  ["SYSTEM_PULLREQUEST_PULLREQUESTID", Boolean],
  ["DRONE_PULL_REQUEST", Boolean],
];

const SHA = /^[0-9a-f]{7,40}$/i;

export const valueSource: RevisionSource = {
  id: "value",
  async resolve({ live }) {
    const v = live.revision.value?.trim();
    return v ? { sha: v, liveAt: live.revision.liveAt, via: "config live.revision.value" } : null;
  },
};

export const envSource: RevisionSource = {
  id: "env",
  async resolve({ live, env }) {
    if (live.revision.env === false) return null;
    const pr = PR_SIGNALS.find(([k, test]) => env[k] !== undefined && test(String(env[k])));
    if (pr) return null;
    for (const k of live.revision.env ?? CI_REVISION_VARS) {
      const v = env[k]?.trim();
      if (v && SHA.test(v)) return { sha: v, liveAt: live.revision.liveAt, via: `env ${k}` };
    }
    return null;
  },
};

export const endpointSource: RevisionSource = {
  id: "endpoint",
  async resolve({ live, fetch: get, cookies }) {
    const url = live.revision.endpoint;
    if (!url) return null;
    const cookie = cookies(url);
    const r = await get(url, { headers: { Accept: "application/json, text/plain;q=0.9", ...(cookie ? { Cookie: cookie } : {}) }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`The version endpoint ${url} answered ${r.status}${r.status === 401 || r.status === 403 || r.status === 404 ? " (a private site needs live.app.auth from dsa login)" : ""}.`);
    const text = await r.text();
    let sha: string | undefined;
    let liveAt: string | undefined;
    try {
      const j = JSON.parse(text) as unknown;
      sha = pick(j, live.revision.field ? [live.revision.field] : ["sha", "commit", "revision", "version", "git.sha", "git.commit", "commitSha", "gitSha"]);
      liveAt = pick(j, live.revision.liveAtField ? [live.revision.liveAtField] : ["deployedAt", "deployed_at", "builtAt", "built_at", "time", "timestamp", "date"]);
    } catch {
      sha = text.match(/\b[0-9a-f]{7,40}\b/i)?.[0];
    }
    if (!sha || !SHA.test(sha)) throw new Error(`The version endpoint ${url} didn't report a commit SHA${live.revision.field ? ` at "${live.revision.field}"` : ""}.`);
    return { sha, liveAt: liveAt ?? live.revision.liveAt, via: `endpoint ${url}` };
  },
};

export const BUILTIN_REVISION_SOURCES: RevisionSource[] = [valueSource, endpointSource, envSource];

/** A string at the first dotted path that has one. */
function pick(j: unknown, paths: string[]): string | undefined {
  for (const p of paths) {
    let cur: unknown = j;
    for (const k of p.split(".")) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
    if (typeof cur === "string" && cur.trim()) return cur.trim();
    if (typeof cur === "number") return String(cur);
  }
  return undefined;
}

/**
 * Ask each source in order (live.revision.sources, default value → endpoint → env, then any the
 * host adapter adds). The first that answers wins. A source that fails stops the search: a broken
 * version endpoint must not fall through to a CI variable that may name some other commit.
 */
export async function resolveLiveRevision(c: RevisionContext, extra: RevisionSource[] = []): Promise<LiveRevision | null> {
  const all = [...BUILTIN_REVISION_SOURCES, ...extra];
  const order = c.live.revision.sources ?? [...BUILTIN_REVISION_SOURCES.map((s) => s.id), ...extra.map((s) => s.id)];
  for (const id of order) {
    const s = all.find((x) => x.id === id);
    if (!s) throw new Error(`live.revision.sources names "${id}", which no installed adapter provides (known: ${all.map((x) => x.id).join(", ")}).`);
    const r = await s.resolve(c);
    if (r) return r;
  }
  return null;
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

/**
 * Compare the checkout with the live revision. Same commit, or a commit with the same tree (a merge
 * that changed nothing the scan reads), counts as live. Tracked changes count as not live; untracked
 * files outside the data folder don't, so a CI build's own output never trips it.
 */
export function compareTree(root: string, revision: LiveRevision | null): Omit<LiveCheck, "ok" | "label"> {
  const headR = git(root, ["rev-parse", "HEAD"]);
  const head = headR.ok ? headR.out : null;
  if (!revision || !head) return { state: "unknown", revision, head };
  const same = head.toLowerCase().startsWith(revision.sha.toLowerCase()) || revision.sha.toLowerCase().startsWith(head.toLowerCase());
  const sameTree = !same && git(root, ["cat-file", "-e", `${revision.sha}^{commit}`]).ok && git(root, ["diff", "--quiet", revision.sha, "HEAD"]).ok;
  if (!same && !sameTree) return { state: "other-commit", revision, head };
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]).out;
  return { state: dirty ? "modified" : "live", revision, head };
}

const short = (s: string | null | undefined) => (s ? s.slice(0, 7) : "?");

export function describeCheck(c: Omit<LiveCheck, "ok" | "label">): string {
  const r = c.revision;
  const since = r?.liveAt ? `, live since ${r.liveAt}` : "";
  switch (c.state) {
    case "live":
      return `Scanned ${short(c.head)}, the live revision (${r!.via}${since}).`;
    case "modified":
      return `The checkout is the live revision ${short(r!.sha)} but has uncommitted changes, which aren't live.`;
    case "other-commit":
      return `The checkout is ${short(c.head)} but ${short(r!.sha)} is live (${r!.via}). Check out the live commit (git checkout ${r!.sha}) or deploy first.`;
    case "unknown":
      return c.head ? "No live revision found: set live.revision (a value, a version endpoint, or run in the deploy job)." : "Not a git checkout, so dsa can't tell whether it is the live revision.";
    case "unchecked":
      return "Scanned the checkout as it is (no live section in the config, so not checked against production).";
  }
}

/** Thrown when a run would scan code that isn't live and the config says to refuse. */
export class NotLiveError extends Error {
  constructor(readonly check: LiveCheck) {
    super(`${check.label}\nThis scan would show unreleased code as live. Fix the checkout, or pass --allow-unreleased (or set live.onMismatch to "label") to run anyway with the report labelled.`);
    this.name = "NotLiveError";
  }
}

export interface CheckLiveOptions {
  root: string;
  live: LiveConfig | undefined;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Run even when the checkout isn't live, labelled. */
  allowUnreleased?: boolean;
  /** Revision sources from the host adapter. */
  sources?: RevisionSource[];
  /** Data folder (default cookie lookups resolve auth files against `root`). */
  cookies?: (url: string) => string | undefined;
}

/**
 * The check every run makes before it reads code or takes a screenshot. Without a `live` section it
 * passes, labelled "unchecked". With one, a checkout that isn't the live revision throws NotLiveError
 * unless onMismatch is "label" or allowUnreleased is set; then it passes with `unreleased: true`.
 */
export async function checkLive(o: CheckLiveOptions): Promise<LiveCheck> {
  if (!o.live) {
    const base = { state: "unchecked" as const, revision: null, head: git(o.root, ["rev-parse", "HEAD"]).ok ? git(o.root, ["rev-parse", "HEAD"]).out : null };
    return { ...base, ok: true, label: describeCheck(base) };
  }
  const live = o.live;
  const ctx: RevisionContext = {
    root: o.root,
    live,
    env: o.env ?? process.env,
    fetch: o.fetch ?? fetch,
    cookies: o.cookies ?? ((url) => cookiesFor(url, authFiles(o.root, live))),
  };
  const revision = await resolveLiveRevision(ctx, o.sources ?? []);
  const cmp = compareTree(o.root, revision);
  const check: LiveCheck = { ...cmp, ok: cmp.state === "live", label: describeCheck(cmp) };
  if (check.ok) return check;
  if (o.allowUnreleased || live.onMismatch === "label") return { ...check, unreleased: true, label: `NOT LIVE: ${check.label}` };
  throw new NotLiveError(check);
}

/** Every saved sign-in the live section names, as absolute paths. */
export function authFiles(root: string, live: LiveConfig): string[] {
  const all = [live.app, live.storybook, ...Object.values(live.apps ?? {})].map((s) => s?.auth).filter((x): x is string => Boolean(x));
  return [...new Set(all.map((f) => path.resolve(root, f)))];
}

/** A Cookie header for `url` from Playwright storage-state files (name=value pairs whose domain and path match). */
export function cookiesFor(url: string, files: string[]): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const pairs: string[] = [];
  for (const f of files) {
    let state: { cookies?: { name: string; value: string; domain: string; path?: string; expires?: number; secure?: boolean }[] };
    try {
      state = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    for (const c of state.cookies ?? []) {
      const d = c.domain.replace(/^\./, "");
      const domainOk = u.hostname === d || u.hostname.endsWith(`.${d}`);
      const pathOk = u.pathname.startsWith(c.path ?? "/");
      const fresh = !c.expires || c.expires < 0 || c.expires * 1000 > Date.now();
      if (domainOk && pathOk && fresh && (!c.secure || u.protocol === "https:")) pairs.push(`${c.name}=${c.value}`);
    }
  }
  return pairs.length ? pairs.join("; ") : undefined;
}
