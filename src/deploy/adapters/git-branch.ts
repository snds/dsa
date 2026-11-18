import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
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

/**
 * DuckDB files sit mostly empty and grow by tens of MB a week; GitHub refuses a pushed file over 100 MB.
 * The branch holds them gzipped (about a tenth of the size): `dsa.duckdb` travels as `dsa.duckdb.gz`.
 * gzip with a fixed header, so unchanged data gives the same blob and an unchanged push is still skipped.
 */
const isDb = (name: string) => name.endsWith(".duckdb");
const GZ = ".gz";

function databasesIn(dataDir: string): string[] {
  return fs.readdirSync(dataDir, { withFileTypes: true }).filter((e) => e.isFile() && isDb(e.name)).map((e) => e.name);
}

/** The push error as GitHub gave it: every line, so a refusal (a file too large, a rule) shows its reason. */
export function pushError(branch: string, remote: string, err: string): string {
  const lines = err.split("\n").map((l) => l.replace(/^remote:\s*/, "").trim()).filter((l) => l && !/^error: Trace:/.test(l) && !/^To /.test(l));
  const why = /non-fast-forward|fetch first/.test(err)
    ? " (another run pushed first; run again)"
    : /file size limit|exceeds GitHub|GH001/.test(err)
      ? " (a file is over GitHub's 100 MB limit)"
      : /GH013|rule violations|protected branch/.test(err)
        ? ` (a branch rule refuses pushes to ${branch})`
        : "";
  return `Couldn't push ${branch} to ${remote}${why}: ${lines.slice(0, 6).join(" / ") || err}`;
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
    const fetchBranch = (): boolean => git(["fetch", "--quiet", "--no-tags", "--depth", "1", "--end-of-options", remote, `+refs/heads/${branch}:${local}`]).ok;
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
          // Databases travel gzipped; give the run the file it opens.
          for (const e of fs.readdirSync(dataDir)) {
            if (!e.endsWith(GZ) || !isDb(e.slice(0, -GZ.length))) continue;
            const gz = path.join(dataDir, e);
            fs.writeFileSync(path.join(dataDir, e.slice(0, -GZ.length)), zlib.gunzipSync(fs.readFileSync(gz)));
            fs.rmSync(gz);
          }
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
          const dbs = databasesIn(dataDir);
          const add = g(["add", "--all", "--", ".", ...skip, ...dbs.map((n) => `:(exclude)${n}`)]);
          if (!add.ok) throw new Error(`Couldn't stage the data folder: ${add.err}`);
          for (const n of dbs) {
            const gz = path.join(path.dirname(idx), `${n}${GZ}`);
            fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(path.join(dataDir, n)), { level: 6 }));
            const blob = g(["hash-object", "-w", "--", gz]);
            const staged = blob.ok ? g(["update-index", "--add", "--cacheinfo", `100644,${blob.out},${n}${GZ}`]) : blob;
            if (!staged.ok) throw new Error(`Couldn't stage ${n}: ${staged.err}`);
          }
          const tree = g(["write-tree"]).out;
          const parent = had && keep === "all" ? git(["rev-parse", local]).out : "";
          if (had && git(["rev-parse", `${local}^{tree}`]).out === tree) return `History: ${remote}/${branch} already has this data.`;
          const commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], author(git));
          if (!commit.ok) throw new Error(`Couldn't commit the data folder: ${commit.err}`);
          const push = git(["push", "--quiet", ...(keep === "latest" ? ["--force"] : []), "--end-of-options", remote, `${commit.out}:refs/heads/${branch}`]);
          if (!push.ok) throw new Error(pushError(branch, remote, push.err));
          git(["update-ref", local, commit.out]);
          return `History: saved to ${remote}/${branch} (${commit.out.slice(0, 7)}).`;
        } finally {
          cleanup(idx);
        }
      },
    };
  },
};
