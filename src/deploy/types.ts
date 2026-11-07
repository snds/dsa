import type { DsaConfig } from "../config.js";

/**
 * The seams that let dsa run wherever the product it measures is deployed. Core code talks only to
 * these interfaces; adapters (src/deploy/adapters/, or an add-on's `hosts` / `histories`) fill them in,
 * and the config picks one by name. Nothing here knows a hosting service.
 */

export type LiveConfig = NonNullable<DsaConfig["live"]>;
export type HostConfig = NonNullable<DsaConfig["host"]>;
export type HistoryConfig = NonNullable<DsaConfig["history"]>;
export type SurfaceConfig = NonNullable<LiveConfig["app"]>;

/** The commit that is live in production, and how dsa learned it. */
export interface LiveRevision {
  sha: string;
  /** When it went live (ISO), when the source knows. */
  liveAt?: string | undefined;
  /** Which source said so ("env GITHUB_SHA", "endpoint https://…/version.json"). */
  via: string;
}

export interface RevisionContext {
  root: string;
  live: LiveConfig;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** Cookies for a URL, from the saved sign-in states the config names (for a private version endpoint). */
  cookies: (url: string) => string | undefined;
}

/** One way to learn the live revision. Returns null when it has nothing to say (not configured, not a deploy). */
export interface RevisionSource {
  id: string;
  resolve(c: RevisionContext): Promise<LiveRevision | null>;
}

/**
 * How the checkout being scanned relates to what is live:
 * - live: HEAD is the live commit (or has the same tree) and nothing tracked is modified
 * - other-commit: HEAD is a different commit
 * - modified: HEAD is live but tracked files have uncommitted changes
 * - unknown: no live revision could be found, or this isn't a git checkout
 * - unchecked: the config has no `live` section (a local run, as before)
 */
export type TreeState = "live" | "other-commit" | "modified" | "unknown" | "unchecked";

export interface LiveCheck {
  state: TreeState;
  revision: LiveRevision | null;
  /** The checkout's HEAD commit. */
  head: string | null;
  /** True when the scan reflects only what is live. */
  ok: boolean;
  /** One line for people: "Scanned 1a2b3c4, live since …" or what's wrong. */
  label: string;
  /** Set when a run went ahead although `ok` is false (onMismatch "label", or --allow-unreleased). */
  unreleased?: boolean;
}

/** A surface opened for one run: a URL a browser can load, and how to put it away. */
export interface OpenSurface {
  url: string;
  /** Saved sign-in (Playwright storage state file) to load before visiting. */
  storageState?: string | undefined;
  /** Let the crawler GET the site's own /api/ routes. */
  readApi: boolean;
  /** Data paths the crawler may also GET (globs; a full URL for another host). */
  readPaths?: string[] | undefined;
  /** How to sign in an app that keeps its tokens in memory: click `click` on `path`. */
  signIn?: { path: string; click: string; idp?: string | undefined } | undefined;
  /** "live https://…", "built folder dist" */
  how: string;
  /** True for a deployed URL, false for a local copy of the build. */
  deployed: boolean;
  stop(): void;
}

/**
 * What starts a scan and follows it. Each `type` has a runner with the same contract (src/relay/runners.ts):
 * trigger() → a run, status(run id) → where it stands, listActive() → runs already going (a
 * scheduled one included). The scan relay (src/relay/) runs them with its own credential; a webhook
 * runner may also be called straight from the page when it needs no secret.
 */
export type RunnerSpec =
  | {
      type: "github";
      /** API and web addresses (GitHub Enterprise Server differs). */
      api: string;
      server: string;
      repo: string;
      /** The workflow file that scans and deploys; it needs a workflow_dispatch trigger. */
      workflow: string;
      /** Branch to run on; the repo's default branch when unset. */
      ref?: string | undefined;
    }
  | {
      type: "webhook";
      /** POSTed to start a scan. It may answer { id, url } for the run. */
      trigger: string;
      /** GET for one run; {id} is filled in. Answers { status, steps?, url?, startedAt?, error? }. */
      status?: string | undefined;
      /** GET for runs going now; answers { runs: [...] } in the same shape. */
      active?: string | undefined;
    };

/** What the static dashboard's live buttons do. Embedded in the published page as `D.actions`. */
export interface PageActions {
  /** The adapter that made them, for the page's wording. */
  host: string;
  /** When scans run by themselves (cron lines, UTC), so the page can show the next one. */
  schedule?: string[] | undefined;
  rescan: {
    /**
     * relay: the page signs the viewer in at the scan relay (`url`), which starts the scan and reports its progress;
     * run: the page calls a webhook runner itself (`runner`); link: opens a page; post: sends a request and can't
     * follow it; none: no button (`help` says how to enable one).
     */
    kind: "relay" | "run" | "link" | "post" | "none";
    url?: string | undefined;
    label: string;
    help: string;
    runner?: RunnerSpec | undefined;
    /** How long a scan usually takes, from earlier runs (the page fills in better when the host knows). */
    estimateSeconds?: number | null | undefined;
    /** The scan job takes a setting for earlier photos, so the page offers one. */
    shots?: boolean | undefined;
    /** link: the terminal command that does the same, for the viewer to copy. */
    command?: string | undefined;
  };
  decisions: {
    kind: "export" | "post" | "issue";
    /** post: the webhook. issue: the new-issue page (title, label and body are added by the page). */
    url?: string | undefined;
    label: string;
    help: string;
    /** The issue title and labels (issue kind). */
    title?: string | undefined;
    labels?: string[] | undefined;
    /** What applies them once they arrive, for the page's help text. */
    apply: string;
  };
}

export interface HostContext {
  root: string;
  host: HostConfig;
  /** The config's github.defaultRepo and similar, for adapters that need a default. */
  config: { github?: { defaultRepo?: string | undefined } | undefined };
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
}

/**
 * A hosting service. `actions` says what the static dashboard's Re-scan and decision buttons do;
 * `readDecisions` fetches decisions the page sent (an issue, a file, a URL) for `dsa apply-decisions`;
 * `revisionSources` add ways to learn the live revision (a deployments API).
 */
export interface HostAdapter {
  id: string;
  actions(c: HostContext): PageActions;
  /** Read a decisions file from where this host's page sends it. `ref` is what the person or workflow passed. */
  readDecisions(ref: string, c: HostContext): Promise<unknown>;
  /** After decisions from `ref` are applied: close the issue, comment. Optional. */
  applied?(ref: string, summary: string, c: HostContext): Promise<void>;
  /** When scans run by themselves, as cron lines in UTC. Default: host.schedule. */
  schedule?(c: HostContext): string[];
  /** Ways to learn the live revision this host offers, for this run's settings (a deployments API). */
  revisionSources?(c: HostContext): RevisionSource[];
}

/** Where the data folder (run history, screenshots, renderings) persists between runs. */
export interface HistoryBackend {
  id: string;
  /** Bring the persisted data folder into `dataDir`. Returns a line for the log. */
  pull(dataDir: string): Promise<string>;
  /** Save `dataDir`. Returns a line for the log. */
  push(dataDir: string, message: string): Promise<string>;
}

export interface HistoryContext {
  root: string;
  history: HistoryConfig;
  log: (m: string) => void;
}

export type HistoryFactory = { id: string; create(c: HistoryContext): HistoryBackend };
