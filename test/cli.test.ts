import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProgram, type CliIo } from "../src/cli.js";
import { rmrf, tempFixture } from "./helpers.js";

let dir: string;
let out: string[];
let err: string[];
let io: CliIo;

beforeEach(() => {
  dir = tempFixture();
  out = [];
  err = [];
  io = { out: (s) => out.push(s), err: (s) => err.push(s), cwd: dir };
  process.exitCode = undefined;
});
afterEach(() => {
  rmrf(dir);
  process.exitCode = undefined;
});

const run = (...args: string[]) => createProgram(io).parseAsync(["node", "dsa", ...args]);

describe("cli", () => {
  it("scan writes .dsa/scan.json and prints a summary table", async () => {
    await run("scan", ".");
    expect(fs.existsSync(path.join(dir, ".dsa/scan.json"))).toBe(true);
    const text = out.join("\n");
    expect(text).toMatch(/dsa scan — fixture/);
    expect(text).toMatch(/directory\s+ds\s+local\s+html\s+external\s+total\s+custom/);
    expect(text).toMatch(/local look-alikes\s+2/);
  });

  it("--json prints the report instead of writing it", async () => {
    await run("--json", "patterns", ".");
    expect(fs.existsSync(path.join(dir, ".dsa/patterns.json"))).toBe(false);
    const json = JSON.parse(out.join("\n")) as { candidates: { name: string }[]; meta: { dsaVersion: string } };
    expect(json.meta.dsaVersion).toBe("0.1.0");
    expect(json.candidates.map((c) => c.name)).toEqual(["FilterBar", "ActionToolbar", "CardRecipe"]);
  });

  it("patterns --all includes snowflakes", async () => {
    await run("--json", "patterns", "--all");
    const json = JSON.parse(out.join("\n")) as { candidates: { tier: string }[] };
    expect(json.candidates.some((c) => c.tier === "snowflake")).toBe(true);
  });

  it("patterns --ignore records decisions and parks after the configured count", async () => {
    await run("--json", "patterns");
    const first = JSON.parse(out.join("\n")) as { candidates: { id: string; name: string }[] };
    const id = first.candidates[0]!.id;
    for (let i = 0; i < 3; i++) {
      out = [];
      await run("--json", "patterns", "--ignore", id);
    }
    expect(err.at(-1)).toMatch(/ignored 3x -> parked/);
    const last = JSON.parse(out.join("\n")) as { candidates: { id: string }[]; parked: { id: string }[] };
    expect(last.candidates.some((c) => c.id === id)).toBe(false);
    expect(last.parked.map((p) => p.id)).toEqual([id]);
    const decisions = JSON.parse(fs.readFileSync(path.join(dir, ".dsa/decisions.json"), "utf8")) as { decisions: Record<string, { status: string }> };
    expect(decisions.decisions[id]!.status).toBe("parked");
  });

  it("ratchet sets exit code 1 on growth", async () => {
    await run("ratchet", "--init");
    expect(process.exitCode).toBeUndefined();
    const screen = path.join(dir, "src/screens/landing.tsx");
    fs.writeFileSync(screen, fs.readFileSync(screen, "utf8").replace("<PrimaryButton>", "<PrimaryButton className=\"a\">").replace('<Button variant="link"', '<Button className="b" variant="link"'));
    await run("ratchet");
    expect(process.exitCode).toBe(1);
    expect(out.join("\n")).toMatch(/FAILED/);
  });
});
