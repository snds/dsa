import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NEUTRAL_PROFILE, defineProfile, isProfileSource, loadProfile, resolveProfile } from "../src/profile.js";
import { createRunContext, loadRunContext } from "../src/run.js";
import { FIXTURE, rmrf, tempFixture } from "./helpers.js";

const PROFILES = path.resolve(FIXTURE, "../profiles");

describe("profile", () => {
  it("falls back to the neutral profile", () => {
    expect(resolveProfile()).toBe(NEUTRAL_PROFILE);
    expect(NEUTRAL_PROFILE.label).toBe("design system");
  });

  it("fills a partial profile's gaps and uses its name as the label", () => {
    const p = resolveProfile(defineProfile({ name: "kit" }));
    expect(p).toMatchObject({ name: "kit", label: "kit", sources: [], roles: {}, files: {}, labPaths: [] });
  });

  it("rejects a profile without a name", () => {
    expect(() => resolveProfile({ name: "" })).toThrow(/needs a name/);
  });

  it("loads a profile file's default export, relative to a directory", async () => {
    const p = await loadProfile("./acme.mjs", PROFILES);
    expect(p.label).toBe("Acme");
    expect(p.components?.(PROFILES)).toEqual([{ name: "Button", from: "@acme/ui/button", kind: "own" }]);
    expect(p.files.exceptions).toBe("docs/raw-elements.exceptions.json");
  });

  it("accepts a named `profile` export", async () => {
    expect((await loadProfile("./named.mjs", PROFILES)).name).toBe("named");
  });

  it("says which file or package is missing", async () => {
    await expect(loadProfile("./nope.mjs", PROFILES)).rejects.toThrow(/not found/);
    await expect(loadProfile("@nope/dsa-profile", PROFILES)).rejects.toThrow(/can't be resolved/);
  });

  it("runs carry the neutral profile when the config names none", async () => {
    expect(createRunContext({ dir: FIXTURE }).profile).toBe(NEUTRAL_PROFILE);
    expect((await loadRunContext({ dir: FIXTURE })).profile).toBe(NEUTRAL_PROFILE);
  });

  it("a run loads the config's profile, relative to the config file", async () => {
    const dir = tempFixture();
    try {
      fs.copyFileSync(path.join(PROFILES, "acme.mjs"), path.join(dir, "dsa.profile.mjs"));
      const cfgFile = path.join(dir, "dsa.config.json");
      fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, "utf8")), profile: "./dsa.profile.mjs" }));
      expect((await loadRunContext({ dir })).profile.label).toBe("Acme");
      // The sync path can't import a module: it says so, or takes the profile already loaded.
      expect(() => createRunContext({ dir })).toThrow(/loadRunContext/);
      expect(createRunContext({ dir, profile: { name: "given" } }).profile.name).toBe("given");
    } finally {
      rmrf(dir);
    }
  });

  it("matches scopes as prefixes and packages as entry or subpath", () => {
    const p = resolveProfile({ name: "x", sources: ["@acme/", "kit-ui"] });
    expect(isProfileSource(p, "@acme/ui/button")).toBe(true);
    expect(isProfileSource(p, "kit-ui")).toBe(true);
    expect(isProfileSource(p, "kit-ui/button")).toBe(true);
    expect(isProfileSource(p, "kit-ui-extra")).toBe(false);
    expect(isProfileSource(p, "@acmex/ui")).toBe(false);
  });
});
