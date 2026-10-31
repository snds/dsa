import { authFiles, checkLive, cookiesFor } from "./revision.js";
import { genericHost, hostAdapter } from "./host.js";
import { historyBackend, localHistory } from "./history.js";
import { githubHost } from "./adapters/github.js";
import { gitBranchHistory } from "./adapters/git-branch.js";
import { commandHistory } from "./adapters/command.js";
import type { Config } from "../engine/config.js";
import type { HistoryBackend, HistoryFactory, HostAdapter, HostContext, LiveCheck, PageActions } from "./types.js";

export * from "./types.js";
export { CI_REVISION_VARS, BUILTIN_REVISION_SOURCES, NotLiveError, authFiles, checkLive, compareTree, cookiesFor, describeCheck, endpointSource, envSource, resolveLiveRevision, valueSource, type CheckLiveOptions } from "./revision.js";
export { appSurface, normalizeBase, openSurface, serveStatic } from "./surface.js";
export { decisionsIn, genericHost, hostAdapter, hostOf } from "./host.js";
export { NEVER_PERSIST, excluded, historyBackend, localHistory } from "./history.js";
export { githubHost, issueNumber } from "./adapters/github.js";
export { gitBranchHistory } from "./adapters/git-branch.js";
export { commandHistory } from "./adapters/command.js";

/** Adapters that ship with dsa. Add-ons add theirs (DsaAddon.hosts / .histories); a later one with the same id wins. */
export const BUILTIN_HOSTS: HostAdapter[] = [genericHost, githubHost];
export const BUILTIN_HISTORIES: HistoryFactory[] = [localHistory, gitBranchHistory, commandHistory];

export interface DeployOptions {
  root: string;
  config: Config;
  hosts?: HostAdapter[];
  histories?: HistoryFactory[];
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  log?: (m: string) => void;
}

/** One run's view of where it is deployed: the host adapter, the history backend, and the live check. */
export interface Deploy {
  host: HostAdapter;
  hostContext: HostContext;
  history: HistoryBackend;
  /** What the static dashboard's buttons do. */
  actions(): PageActions;
  /** Check the checkout against the live revision (throws NotLiveError when it must refuse). */
  check(o?: { allowUnreleased?: boolean }): Promise<LiveCheck>;
}

/** Resolve the adapters the config names. Nothing is contacted until a method is called. */
export function deployFor(o: DeployOptions): Deploy {
  const env = o.env ?? process.env;
  const get = o.fetch ?? fetch;
  const hostCfg = o.config.host ?? { adapter: "generic", github: { workflow: "dsa.yml", label: "dsa-decisions", server: "https://github.com" } };
  const host = hostAdapter(hostCfg.adapter, [...BUILTIN_HOSTS, ...(o.hosts ?? [])]);
  const hostContext: HostContext = { root: o.root, host: hostCfg, config: { github: o.config.github }, env, fetch: get };
  const history = historyBackend({ root: o.root, history: o.config.history ?? { adapter: "local", branch: "dsa-data", remote: "origin", keep: "all" }, log: o.log ?? (() => {}) }, [...BUILTIN_HISTORIES, ...(o.histories ?? [])]);
  return {
    host,
    hostContext,
    history,
    actions: () => host.actions(hostContext),
    check: (c = {}) =>
      checkLive({
        root: o.root,
        live: o.config.live,
        env,
        fetch: get,
        sources: host.revisionSources?.(hostContext) ?? [],
        ...(c.allowUnreleased ? { allowUnreleased: true } : {}),
        ...(o.config.live ? { cookies: (url: string) => cookiesFor(url, authFiles(o.root, o.config.live!)) } : {}),
      }),
  };
}
