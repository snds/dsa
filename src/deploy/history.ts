import type { HistoryBackend, HistoryContext, HistoryFactory } from "./types.js";

/**
 * Where the data folder (run history in DuckDB, screenshots, renderings, the review queue) lives
 * between runs. On a long-running server it simply stays put ("local"). A CI job starts empty, so
 * it pulls the folder before the run and pushes it after: to a git branch, or with your own
 * commands (an object store, a CI artifact).
 */

/** Never persisted: secrets, saved sign-ins, things rebuilt from the rest, and clones of other repos. */
export const NEVER_PERSIST = ["secrets.json", "auth", "site", "report", "remotes", "agent", "serve", "*.wal", "*.tmp"];

export const localHistory: HistoryFactory = {
  id: "local",
  create: (): HistoryBackend => ({
    id: "local",
    pull: async (dir) => `History: local (${dir}).`,
    push: async (dir) => `History: kept in ${dir}.`,
  }),
};

/** The backend the config names (history.adapter, default "local"). An unknown name is an error. */
export function historyBackend(c: HistoryContext, available: HistoryFactory[]): HistoryBackend {
  const want = c.history.adapter ?? "local";
  const f = [...available].reverse().find((x) => x.id === want);
  if (!f) throw new Error(`history.adapter is "${want}", and no installed adapter has that name (known: ${[...new Set(available.map((x) => x.id))].join(", ")}).`);
  return f.create(c);
}

/** Entries of the data folder to leave out: the fixed list plus history.exclude. */
export function excluded(c: HistoryContext): string[] {
  return [...NEVER_PERSIST, ...(c.history.exclude ?? [])];
}
