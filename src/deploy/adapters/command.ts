import path from "node:path";
import { spawnSync } from "node:child_process";
import type { HistoryBackend, HistoryContext, HistoryFactory } from "../types.js";

/**
 * Run history through your own commands, for an object store or a CI artifact store:
 *
 *   "history": { "adapter": "command", "pull": "aws s3 sync s3://bucket/dsa {dir}", "push": "aws s3 sync {dir} s3://bucket/dsa --exclude 'secrets.json' --exclude 'auth/*'" }
 *
 * {dir} is the data folder's absolute path, quoted. The commands run in the config's folder. A pull
 * that fails is an error (a run on an empty history would reopen every finding); write the command
 * so a first run with nothing stored succeeds.
 */
export const commandHistory: HistoryFactory = {
  id: "command",
  create(c: HistoryContext): HistoryBackend {
    const run = (what: "pull" | "push", dir: string) => {
      const cmd = c.history[what];
      if (!cmd) throw new Error(`history.adapter is "command" but history.${what} is not set.`);
      const filled = cmd.replaceAll("{dir}", JSON.stringify(path.resolve(dir)));
      const r = spawnSync(filled, { shell: true, cwd: c.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (r.status !== 0) throw new Error(`history.${what} failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
      return `History: ${what} ran (${cmd.split(/\s+/)[0]}).`;
    };
    return { id: "command", pull: async (dir) => run("pull", dir), push: async (dir) => run("push", dir) };
  },
};
