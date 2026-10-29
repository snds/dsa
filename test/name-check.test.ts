import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve(__dirname, "..", "scripts", "name-check.mjs");
const run = (env: Record<string, string>, args: string[] = []) => {
  const base = { ...process.env };
  delete base.DSA_NAME_DENYLIST;
  return spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...base, ...env },
    encoding: "utf8",
  });
};

describe("name check", () => {
  it("skips without a pattern, and fails then when required", () => {
    expect(run({}).status).toBe(0);
    expect(run({}, ["--require"]).status).toBe(1);
  });

  it("passes when no tracked file matches", () => {
    const r = run({ DSA_NAME_DENYLIST: "zzq-no-such-name-qzz" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no denied names/);
  });

  it("fails on a match and prints where, not what", () => {
    // The fixtures are made-up acme names, so acme must match.
    const r = run({ DSA_NAME_DENYLIST: "acme" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/match(es)? for a denied name/);
    expect(r.stderr).toMatch(/^ {2}\S+:\d+$/m);
    expect(r.stderr).not.toMatch(/@acme\//);
  });

  it("rejects an invalid pattern", () => {
    expect(run({ DSA_NAME_DENYLIST: "(" }).status).toBe(2);
  });
});
