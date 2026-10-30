import path from "node:path";
import { displayPath } from "./paths.js";
import type { RepoReading } from "../model/index.js";
import type { Framework, Instance, Target } from "./types.js";

const FRAMEWORK: [RegExp, Framework][] = [[/\.(tsx|jsx|ts|js|mjs)$/, "react"], [/\.vue$/, "vue"], [/\.(html?)$/, "angular"]];

/**
 * A target's design-system instances from the system model: every use of a component (not a style
 * object) in a file under the target's folder, in the engine's row format. Uses inside the system's
 * own source are composition, not consumption, and are left out.
 */
export function instancesFromReading(reading: RepoReading, root: string, target: Target, library: string): Instance[] {
  const role = new Map(reading.concepts.map((c) => [c.key, c]));
  const out: Instance[] = [];
  for (const f of reading.files) {
    const abs = path.resolve(root, f.file);
    const rel = path.relative(target.dir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const framework = FRAMEWORK.find(([re]) => re.test(f.file))?.[1] ?? "unknown";
    for (const { element: el, uses } of f.elements) {
      if (el.inAttribute) continue;
      for (const u of uses) {
        if (u.internal) continue; // a library's own code using its own component
        const c = role.get(u.concept);
        if (!c || c.role === "style") continue;
        const lib = u.library ?? library;
        // A child library rendering its own components isn't consumption.
        if (target.role !== "consumer" && lib === target.name) continue;
        const overrides: string[] = [];
        if (u.form !== "class" && u.form !== "macro") {
          if ("className" in el.attributes || ("class" in el.attributes && u.form !== "selector")) overrides.push("className");
          if ("style" in el.attributes || "sx" in el.attributes || "css" in el.attributes) overrides.push("style");
        }
        if (el.spread) overrides.push("spread");
        out.push({ target: target.name, library: lib, pkg: el.importSource ?? u.form, component: `${c.name}${u.part ? `.${u.part}` : ""}`, file: displayPath(root, abs, target.dir), line: el.line, framework, overrides: overrides.sort() });
      }
    }
  }
  return out;
}
