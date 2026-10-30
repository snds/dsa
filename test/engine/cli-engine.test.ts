import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACME_PROFILE, ACME_ROOT, FIXTURES } from "./setup.js";
import { createProgram, type CliIo } from "../../src/cli.js";
import { resetAddons, useAddons } from "../../src/cli-engine.js";
import { findAddons, defineAddon } from "../../src/addons.js";
import { registerStore, hasStore, MissingStoreError, openStore } from "../../src/engine/store.js";
import { engineConfig, engineExcludes, loadEngineContext } from "../../src/engine/from-dsa.js";
import { loadConfig } from "../../src/config.js";
import { runPipeline, type PipelineStage } from "../../src/engine/pipeline.js";
import { NEUTRAL_PROFILE } from "../../src/profile.js";
import { openDuckStore } from "../../packages/history/src/index.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsa-cli-")));
const NOW = "2026-10-06T12:00:00.000Z";

describe("engine config", () => {
  it("reads an analytics-suite config as the suite did", () => {
    const loaded = loadConfig({ cwd: ACME_ROOT });
    expect(loaded.migrated?.moved).toContain("designSystem.core.packages -> system.packages");
    const c = engineConfig(loaded.config, ACME_PROFILE);
    expect(c.designSystem.core).toMatchObject({ name: "Core", packages: ["@acme/ds-react", "@acme/ds-vue", "@acme/ds-angular", "@acme/tokens"], tagPrefixes: ["ds-"], repo: "acme/design-system" });
    expect(c.designSystem.children?.[0]).toMatchObject({ name: "Commerce kit", owner: "team-commerce" });
    expect(c.deprecated).toEqual({ OldModal: "Modal" });
    // The profile's files fill what the config leaves out.
    expect(c.rawElementExceptions).toBe("docs/raw-elements.exceptions.json");
  });

  it("a config value wins over the profile's", () => {
    const loaded = loadConfig({ cwd: ACME_ROOT, overrides: { correctUse: { exceptionsFile: "x.json" }, review: { decisionsFile: "d.json" } } });
    const c = engineConfig(loaded.config, ACME_PROFILE);
    expect(c.rawElementExceptions).toBe("x.json");
    expect(c.rawElementDecisions).toBe("d.json");
  });

  it("takes whole-folder excludes from scan.exclude and leaves the graph's globs alone", () => {
    expect(engineExcludes(["**/node_modules/**", "**/dist/**", "**/*.test.tsx", "**/*.spec.tsx", "**/*.stories.tsx", "vendor/**", "**/legacy/**", "src/*.gen.ts"])).toEqual(["vendor"]);
  });
});

describe("add-ons", () => {
  afterEach(() => registerStore(openDuckStore));

  it("finds the history add-on in this checkout", () => {
    expect(findAddons([]).map((a) => a.name)).toContain("@snds/dsa-history");
  });

  it("a command that keeps history says what to install when no store is there", async () => {
    registerStore(null);
    expect(hasStore()).toBe(false);
    await expect(openStore("/nowhere", "run")).rejects.toThrow(MissingStoreError);
    await expect(openStore("/nowhere", "run")).rejects.toThrow(/npm install --save-dev @snds\/dsa-history/);
  });

  it("stages run in their phase and can add metrics; a failing stage is a note", async () => {
    const seen: string[] = [];
    const stages: PipelineStage[] = [
      defineAddon({ name: "x", stages: [{ id: "scan-stage", phase: "scan", run: (ctx) => void seen.push(`scan:${ctx.metrics.length}`) }] }).stages![0]!,
      { id: "metrics-stage", phase: "metrics", run: (ctx) => { seen.push(`metrics:${ctx.metrics.length > 0}`); ctx.metrics.push({ metric_id: "extra_metric", scope: "core", subject: "Core", value: 1, detail: {} }); } },
      { id: "broken", phase: "scan", run: () => { throw new Error("no network"); } },
    ];
    const ctx = await loadEngineContext({ cwd: ACME_ROOT, profile: path.join(FIXTURES, "profiles", "acme-suite.mjs") });
    const data = tmp();
    const res = await runPipeline({ root: ctx.root, dataDir: data, config: ctx.config, profile: ctx.profile, store: openDuckStore, stages, git: false, now: new Date(NOW) });
    expect(seen).toEqual(["scan:0", "metrics:true"]);
    expect(res.notes).toContain("broken skipped: no network");
    const s = await openDuckStore(data);
    try {
      expect(await s.all("select value from metrics where metric_id='extra_metric'")).toEqual([{ value: 1 }]);
    } finally {
      s.close();
    }
  });

  it("the neutral profile reads the fixture with neutral wording", async () => {
    const loaded = loadConfig({ cwd: ACME_ROOT });
    const data = tmp();
    const res = await runPipeline({ root: ACME_ROOT, dataDir: data, config: engineConfig(loaded.config), profile: NEUTRAL_PROFILE, store: openDuckStore, git: false, now: new Date(NOW) });
    expect(res.data.elementEvals?.length).toBeGreaterThan(0);
    expect(res.data.elementEvals!.every((e) => !e.from)).toBe(true);
  });
});

describe("cli: run and the history commands", () => {
  let dir: string;
  let out: string[];
  let io: CliIo;
  beforeEach(() => {
    dir = tmp();
    fs.cpSync(ACME_ROOT, path.join(dir, "repo"), { recursive: true });
    out = [];
    io = { out: (s) => out.push(s), err: (s) => out.push(s), cwd: path.join(dir, "repo") };
    resetAddons();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    registerStore(openDuckStore);
  });
  const run = async (...args: string[]) => {
    await useAddons(io.cwd);
    if (!hasStore()) registerStore(openDuckStore);
    return createProgram(io).parseAsync(["node", "dsa", ...args]);
  };
  const profile = path.join(FIXTURES, "profiles", "acme-suite.mjs");

  it("run, findings, elements, explain, decide, plan, issues, snooze, settings", async () => {
    await run("run", "--profile", profile, "--no-git", "--now", NOW);
    const text = out.join("\n");
    expect(text).toMatch(/Run R-\d{14}-[0-9a-f]{4}: 7 opened/);
    expect(text).toMatch(/Issue drafts: 7 in /);
    const data = path.join(dir, "repo", ".dsa");
    expect(fs.existsSync(path.join(data, "dsa.duckdb"))).toBe(true);
    expect(fs.existsSync(path.join(data, "signatures.json"))).toBe(true);

    out.length = 0;
    await run("findings", "--json");
    const findings = JSON.parse(out.join("\n")) as { id: string; status: string }[];
    expect(findings).toHaveLength(7);

    out.length = 0;
    await run("explain", "--json", "--profile", profile, (await firstEval(data)).id);
    expect(JSON.parse(out.join("\n")).element).toBeDefined();

    const e = await firstEval(data, true);
    out.length = 0;
    await run("decide", e.id, "--keep", "--note", "a test", "--profile", profile);
    expect(out.join("\n")).toMatch(/Recorded for 1 element\(s\)/);

    out.length = 0;
    await run("plan", "--profile", profile);
    expect(out.join("\n")).toMatch(/Wrote .*plans\/all\.md/);

    out.length = 0;
    await run("issues", "draft");
    expect(out.join("\n")).toMatch(/^7 drafts in /);

    out.length = 0;
    await run("snooze", findings[0]!.id, "--days", "7", "--reason", "next sprint");
    expect(out.join("\n")).toBe(`Snoozed ${findings[0]!.id}.`);

    out.length = 0;
    await run("settings", "set", "misuse_cluster_threshold", "4", "--note", "test");
    expect(out.join("\n")).toMatch(/misuse_cluster_threshold: 3 -> 4 \(logged\)/);

    out.length = 0;
    await run("where");
    expect(out.join("\n")).toMatch(/Add-ons: {2}.*@snds\/dsa-history/);
  });

  it("init writes a first config and refuses to overwrite it", async () => {
    const repo = path.join(dir, "repo");
    fs.rmSync(path.join(repo, "dsa.config.json"));
    await run("init", "--root", repo);
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, "dsa.config.json"), "utf8"));
    expect(cfg.system.packages).toContain("@acme/ds-react");
    out.length = 0;
    await run("init", "--root", repo);
    expect(out.join("\n")).toMatch(/already exists/);
  });
});

async function firstEval(data: string, replaceable = false): Promise<{ id: string }> {
  const s = await openDuckStore(data);
  try {
    const rows = await s.all<{ id: string; verdict: string }>("select id, verdict from element_evals order by id");
    return rows.find((r) => !replaceable || r.verdict === "replace") ?? rows[0]!;
  } finally {
    s.close();
  }
}
