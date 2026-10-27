import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProgram, type CliIo } from "../src/cli.js";
import { parseConfig } from "../src/config.js";
import { isSuiteConfig, migrateSuiteConfig } from "../src/migrate.js";
import { FIXTURE, rmrf, tempFixture } from "./helpers.js";

const FULL = path.resolve(FIXTURE, "../suite-configs/full.json");
const full = () => JSON.parse(fs.readFileSync(FULL, "utf8")) as Record<string, unknown>;

describe("migrateSuiteConfig", () => {
  it("tells a suite config from a dsa one", () => {
    expect(isSuiteConfig(full())).toBe(true);
    expect(isSuiteConfig({ system: { name: "x" } })).toBe(false);
    expect(() => migrateSuiteConfig({ system: {} })).toThrow(/designSystem/);
  });

  it("moves every key to its new home", () => {
    const { config } = migrateSuiteConfig(full(), { profile: "./dsa.profile.mjs" });
    const c = parseConfig(config);
    expect(c.profile).toBe("./dsa.profile.mjs");
    expect(c.system).toMatchObject({ name: "Acme", packages: ["@acme/ui", "@acme/tokens"], tagPrefixes: ["ds-"], repo: "acme/design-system", mainRef: "origin/main" });
    expect(c.system.children?.[0]).toMatchObject({ name: "Prototype", path: "../prototype", pin: { file: "ds.pin" }, git: { ref: "main" } });
    expect(c.consumers?.[0]?.owner).toBe("team-checkout");
    expect(c.extraRepos?.[0]?.path).toBe("../legacy-admin");
    expect(c.internalConsumers).toEqual(["@acme/docs", "@acme/storybook"]);
    expect(c.correctUse).toMatchObject({
      rawElements: ["button"],
      elementMap: "packages/lint/raw-elements.json",
      nativeLookalikes: { select: "Select", "input[checkbox]": "Checkbox" },
      exceptionsFile: "docs/raw-elements.exceptions.json",
      deprecated: { OldModal: "Modal" },
    });
    expect(c.tokens?.patterns).toEqual(["var\\(--ds-"]);
    expect(c.review).toEqual({ threshold: 0.85, labPaths: ["**/labs/**"], decisionsFile: "docs/raw-elements.decisions.json" });
    expect(c.scan.exclude).toEqual(expect.arrayContaining(["**/node_modules/**", "apps/storybook/**", "labs/**"]));
    expect(c.apps?.["Prototype"]?.flows?.[0]?.steps).toHaveLength(3);
    expect(c.tailwind?.semanticCss).toBe("packages/tokens/semantic.css");
    expect(c.figma?.libraries?.[0]?.fileKey).toBe("AbC123");
    expect(c.github?.labels).toEqual(["ds"]);
    expect(c.report?.timeZone).toBe("America/Los_Angeles");
    expect(c.settings).toEqual({ misuse_cluster_threshold: 3 });
  });

  it("lists what it couldn't carry over and leaves it out of the output", () => {
    const r = migrateSuiteConfig(full());
    expect(r.dropped).toEqual(expect.arrayContaining(["telemetry", "shots.maxTriggers"]));
    expect((r.config as { shots: Record<string, unknown> }).shots).not.toHaveProperty("maxTriggers");
    expect(r.notes.some((n) => /No profile set/.test(n))).toBe(true);
  });

  it("converts a minimal config", () => {
    const r = migrateSuiteConfig({ designSystem: { core: { name: "Core", packages: ["@acme/ds-react"] } } });
    expect(r.config).toMatchObject({ system: { name: "Core", packages: ["@acme/ds-react"] } });
    expect(r.dropped).toEqual([]);
  });
});

describe("cli: config migrate", () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let io: CliIo;
  beforeEach(() => {
    dir = tempFixture();
    out = [];
    err = [];
    io = { out: (s) => out.push(s), err: (s) => err.push(s), cwd: dir };
  });
  afterEach(() => rmrf(dir));
  const run = (...args: string[]) => createProgram(io).parseAsync(["node", "dsa", ...args]);

  it("prints the converted config and puts the summary on stderr", async () => {
    await run("config", "migrate", FULL);
    expect(JSON.parse(out.join("\n")).system.name).toBe("Acme");
    expect(err.join("\n")).toMatch(/keys moved, 2 left out/);
  });

  it("writes with --write and refuses to overwrite without --force", async () => {
    await run("config", "migrate", FULL, "--write", "migrated/dsa.config.json", "--profile", "./dsa.profile.mjs");
    const written = JSON.parse(fs.readFileSync(path.join(dir, "migrated/dsa.config.json"), "utf8"));
    expect(written.profile).toBe("./dsa.profile.mjs");
    await expect(run("config", "migrate", FULL, "--write", "migrated/dsa.config.json")).rejects.toThrow(/--force/);
    await run("config", "migrate", FULL, "--write", "migrated/dsa.config.json", "--force");
  });
});
