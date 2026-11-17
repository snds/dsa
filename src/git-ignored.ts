import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Leaves out the files git ignores, such as build output (a built Storybook, `.next/`, `out/`) that a
 * scan would otherwise count as authored code. Files git tracks are kept even when an ignore rule
 * matches them. Outside a git checkout, or when git isn't available, every file is kept.
 *
 * `cwd` is where the files were listed from; files in another checkout (a sibling repo) are checked
 * against that checkout's own ignore rules.
 */
export function dropGitIgnored(cwd: string, files: string[]): string[] {
  if (files.length === 0) return files;
  const byTop = new Map<string, string[]>();
  const topOf = new Map<string, string | null>();
  const top = (dir: string): string | null => {
    if (!topOf.has(dir)) {
      const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      topOf.set(dir, r.status === 0 ? r.stdout.trim() : null);
    }
    return topOf.get(dir)!;
  };
  // git reports real paths (on macOS /var is /private/var), so compare real paths.
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  const base = real(path.resolve(cwd));
  // One git call for the checkout the files were listed from; others only for files outside it.
  const home = top(base);
  const inside = (abs: string, dir: string) => abs === dir || abs.startsWith(dir + path.sep);
  for (const f of files) {
    const abs = real(path.resolve(base, f));
    let t: string | null;
    if (home && inside(abs, home)) t = home;
    else try { t = top(path.dirname(abs)); } catch { t = null; }
    if (!t) continue;
    const list = byTop.get(t) ?? [];
    list.push(abs);
    byTop.set(t, list);
  }
  const ignored = new Set<string>();
  for (const [t, list] of byTop) {
    // Exit 0: some are ignored; 1: none are; anything else: git couldn't tell, so keep them all.
    const r = spawnSync("git", ["check-ignore", "--stdin", "-z"], { cwd: t, input: list.join("\0") + "\0", encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] });
    if (r.status !== 0) continue;
    for (const p of r.stdout.split("\0")) if (p) ignored.add(path.resolve(t, p));
  }
  if (ignored.size === 0) return files;
  return files.filter((f) => !ignored.has(real(path.resolve(base, f))));
}
