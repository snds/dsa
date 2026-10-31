import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { excluded } from "../history.js";
import type { HistoryBackend, HistoryContext, HistoryFactory } from "../types.js";

/**
 * Run history on a git branch of the measured repo (default "dsa-data"). The branch holds only the
 * data folder, so it never mixes with the product's code. Pull and push go through the repo's own
 * git, with a temporary index, so a CI checkout's credentials work and the working tree and current
 * branch are never touched.
 */

interface Git {
  (args: string[], env?: Record<string, string>): { ok: boolean; out: string; err: string };
}

function gitIn(root: string): Git {
  return (args, env) => {
    const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  };
}

/** The repo's git, run inside the data folder as its work tree, with a throwaway index. */
function gitOnData(root: string, dataDir: string, index: string): Git {
  const gitDir = gitIn(root)(["rev-parse", "--absolute-git-dir"]).out;
  const dir = path.resolve(dataDir);
  return (args, env) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: dir, GIT_INDEX_FILE: index, ...env } });
    return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  };
}

/** Commits need an author; a fresh CI runner has none configured. */
function author(git: Git): Record<string, string> {
  if (git(["config", "user.email"]).ok) return {};
  return { GIT_AUTHOR_NAME: "dsa", GIT_AUTHOR_EMAIL: "dsa@localhost", GIT_COMMITTER_NAME: "dsa", GIT_COMMITTER_EMAIL: "dsa@localhost" };
}

export const gitBranchHistory: HistoryFactory = {
  id: "git-branch",
  create(c: HistoryContext): HistoryBackend {
    const git = gitIn(c.root);
    const { branch, remote, keep } = { branch: c.history.branch ?? "dsa-data", remote: c.history.remote ?? "origin", keep: c.history.keep ?? "all" };
    const local = `refs/dsa/${branch}`;
    const fetchBranch = (): boolean => git(["fetch", "--quiet", "--no-tags", "--depth", "1", remote, `+refs/heads/${branch}:${local}`]).ok;
    const tmpIndex = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dsa-index-")), "index");
    const cleanup = (idx: string) => fs.rmSync(path.dirname(idx), { recursive: true, force: true });

    return {
      id: "git-branch",
      async pull(dataDir) {
        if (!fetchBranch()) return `History: no ${branch} branch on ${remote} yet; this run starts it.`;
        fs.mkdirSync(dataDir, { recursive: true });
        const idx = tmpIndex();
        try {
          const g = gitOnData(c.root, dataDir, idx);
          const r1 = g(["read-tree", local]);
          const r2 = r1.ok ? g(["checkout-index", "--all", "--force"]) : r1;
          if (!r2.ok) throw new Error(`Couldn't restore the data folder from ${branch}: ${r2.err}`);
        } finally {
          cleanup(idx);
        }
        return `History: restored ${dataDir} from ${remote}/${branch} (${git(["rev-parse", "--short", local]).out}).`;
      },
      async push(dataDir, message) {
        if (!fs.existsSync(dataDir)) return "History: no data folder to save.";
        const had = fetchBranch();
        const idx = tmpIndex();
        try {
          const g = gitOnData(c.root, dataDir, idx);
          // A name leaves out that entry (and a folder's contents); a glob is matched at any depth.
          const skip = excluded(c).map((p) => (p.includes("*") ? `:(exclude,glob)**/${p}` : `:(exclude)${p}`));
          const add = g(["add", "--all", "--", ".", ...skip]);
          if (!add.ok) throw new Error(`Couldn't stage the data folder: ${add.err}`);
          const tree = g(["write-tree"]).out;
          const parent = had && keep === "all" ? git(["rev-parse", local]).out : "";
          if (had && git(["rev-parse", `${local}^{tree}`]).out === tree) return `History: ${remote}/${branch} already has this data.`;
          const commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], author(git));
          if (!commit.ok) throw new Error(`Couldn't commit the data folder: ${commit.err}`);
          const push = git(["push", "--quiet", ...(keep === "latest" ? ["--force"] : []), remote, `${commit.out}:refs/heads/${branch}`]);
          if (!push.ok) throw new Error(`Couldn't push ${branch} to ${remote}${/rejected|non-fast-forward|fetch first/.test(push.err) ? " (another run pushed first; run again)" : ""}: ${push.err.split("\n")[0]}`);
          git(["update-ref", local, commit.out]);
          return `History: saved to ${remote}/${branch} (${commit.out.slice(0, 7)}).`;
        } finally {
          cleanup(idx);
        }
      },
    };
  },
};
