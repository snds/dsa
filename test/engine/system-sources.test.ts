import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURES } from "./setup.js";
import { parseConfig } from "../../src/config.js";
import { engineConfig } from "../../src/engine/from-dsa.js";
import { expandSources } from "../../src/engine/paths.js";
import { libraryDirs, latestVersions, resolveTargets } from "../../src/engine/workspaces.js";
import { buildSignatures } from "../../src/engine/signatures.js";
import { discoverSources } from "../../src/model/discover.js";

// A design system read from another checkout (a consumer repo that vendors it) spans several
// folders: its components and its tokens package. One folder missed the tokens; several folders,
// or a glob of package folders, read them all.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** A host app and, beside it, a vendored copy of the system (ui + tokens packages). */
function layout() {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsa-sources-")));
  dirs.push(top);
  const host = path.join(top, "host");
  fs.mkdirSync(path.join(host, "src"), { recursive: true });
  fs.writeFileSync(path.join(host, "package.json"), JSON.stringify({ name: "host-app", dependencies: { "@acme/ui": "1.0.0" } }));
  fs.cpSync(path.join(FIXTURES, "acme-ui"), path.join(top, "vendor", "acme-ui", "packages"), { recursive: true });
  return { top, host, vendor: path.join(top, "vendor", "acme-ui") };
}

const engine = (system: Record<string, unknown>) => engineConfig(parseConfig({ system: { name: "Acme UI", packages: ["@acme/ui", "@acme/tokens"], ...system } }));

describe("system sources across folders", () => {
  it("expands plain folders and package globs, in another checkout too", () => {
    const { host, vendor } = layout();
    expect(expandSources(host, ["../vendor/acme-ui/packages/ui"])).toEqual([path.join(vendor, "packages", "ui")]);
    expect(expandSources(host, ["../vendor/acme-ui/packages/*"])).toEqual([path.join(vendor, "packages", "tokens"), path.join(vendor, "packages", "ui")]);
    // A glob keeps package folders only, and a missing base is simply nothing.
    fs.mkdirSync(path.join(vendor, "packages", "notes"));
    expect(expandSources(host, ["../vendor/acme-ui/packages/*"])).toHaveLength(2);
    expect(expandSources(host, ["../nowhere/*"])).toEqual([]);
  });

  it("the core target spans every source folder, so its tokens package is read", () => {
    const { host, vendor } = layout();
    const oneFolder = engine({ path: "../vendor/acme-ui/packages/ui" });
    const allFolders = engine({ sources: ["../vendor/acme-ui/packages/*"] });
    const coreDirs = (c: ReturnType<typeof engine>) => resolveTargets(host, c).filter((t) => t.role === "core").map((t) => t.dir);
    expect(coreDirs(oneFolder)).toEqual([path.join(vendor, "packages", "ui")]);
    expect(coreDirs(allFolders)).toEqual([path.join(vendor, "packages", "tokens"), path.join(vendor, "packages", "ui")]);
    // More token aliases with the tokens package than with the components alone.
    const aliases = (c: ReturnType<typeof engine>) => buildSignatures(libraryDirs(host, c.designSystem.core).map((dir) => ({ dir, name: JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name }))).aliases.size;
    expect(aliases(allFolders)).toBeGreaterThan(aliases(oneFolder));
    // Versions come from whichever source folder publishes the package.
    expect(latestVersions(host, allFolders)).toMatchObject({ "@acme/ui": "1.0.0", "@acme/tokens": "1.0.0" });
    // path and sources together: both.
    expect(coreDirs(engine({ path: "../vendor/acme-ui/packages/ui", sources: ["../vendor/acme-ui/packages/tokens"] }))).toHaveLength(2);
  });

  it("a system cloned from git reads its sources inside the clone", () => {
    const { host, vendor } = layout();
    const lib = { ...engine({ sources: ["packages/*"] }).designSystem.core, path: vendor, remote: true };
    expect(libraryDirs(host, lib)).toEqual([path.join(vendor, "packages", "tokens"), path.join(vendor, "packages", "ui")]);
  });

  it("the system model reads the same folders", () => {
    const { host } = layout();
    const found = discoverSources(host, parseConfig({ system: { name: "Acme UI", sources: ["../vendor/acme-ui/packages/*"] } }));
    expect(found.how).toBe("pinned");
    expect(found.accepted).toEqual(["../vendor/acme-ui/packages/tokens", "../vendor/acme-ui/packages/ui"]);
  });
});
