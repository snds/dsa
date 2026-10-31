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
  /** "live https://…", "built folder dist" */
  how: string;
  /** True for a deployed URL, false for a local copy of the build. */
  deployed: boolean;
  stop(): void;
}

/** What the static dashboard's live buttons do. Embedded in the published page as `D.actions`. */
export interface PageActions {
  /** The adapter that made them, for the page's wording. */
  host: string;
  rescan: { kind: "link" | "post" | "none"; url?: string | undefined; label: string; help: string };
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
