import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ratchet } from "../src/ratchet.js";
import { RatchetReportSchema } from "../src/schema/index.js";
import { rmrf, tempFixture } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = tempFixture();
});
afterEach(() => rmrf(dir));

describe("ratchet", () => {
  it("refuses to compare without a baseline", () => {
    expect(() => ratchet({ dir })).toThrow(/--init/);
  });

  it("initializes a baseline from the current counts", () => {
    const r = ratchet({ dir, init: true });
    expect(r.action).toBe("initialized");
    expect(r.ok).toBe(true);
    const file = path.join(dir, ".dsa/baseline.json");
    expect(fs.existsSync(file)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { counts: unknown };
    expect(saved.counts).toEqual(r.current);
    expect(() => ratchet({ dir, init: true })).toThrow(/already exists/);
  });

  it("passes when nothing grew and fails when something did", () => {
    ratchet({ dir, init: true });
    expect(ratchet({ dir }).ok).toBe(true);

    // Add a new className override to a screen: the ratchet must catch it.
    const screen = path.join(dir, "src/screens/contacts.tsx");
    fs.writeFileSync(screen, fs.readFileSync(screen, "utf8").replace("<Toolbar>\n        <Button variant=\"outline\">Import", "<Toolbar>\n        <Button className=\"x\" variant=\"outline\">Import"));
    const failed = ratchet({ dir });
    expect(failed.ok).toBe(false);
    expect(failed.grew).toEqual(["classNameOverrides"]);
    expect(failed.deltas.classNameOverrides).toBe(1);
    expect(RatchetReportSchema.safeParse(failed).success).toBe(true);

    // Accepting it in review: --update rewrites the bar and the next run passes.
    expect(ratchet({ dir, update: true }).action).toBe("updated");
    expect(ratchet({ dir }).ok).toBe(true);
  });

  it("lets counts go down without complaint", () => {
    ratchet({ dir, init: true });
    const landing = path.join(dir, "src/screens/landing.tsx");
    fs.writeFileSync(landing, fs.readFileSync(landing, "utf8").replace(' style={{ marginTop: 8 }}', ""));
    const r = ratchet({ dir });
    expect(r.ok).toBe(true);
    expect(r.deltas.styleOverrides).toBe(-1);
  });
});
