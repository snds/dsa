import path from "node:path";
import { displayPath } from "./paths.js";
import type { RepoReading } from "../model/index.js";
import type { Framework, Instance, Target } from "./types.js";

// Utility classes that place a component (margin, size, flex and grid placement) without changing how it
// looks. A className made only of these is layout, not an override of the system's styling.
const LAYOUT = /^(?:[a-z0-9]+:)*-?(?:m[trblxyse]?|w|h|size|min-w|max-w|min-h|max-h|basis|grow|shrink|flex|flex-\w+|order|col-span|col-start|col-end|row-span|row-start|row-end|self|justify-self|place-self|inset|inset-[xy]|top|right|bottom|left|z|hidden|block|inline|inline-block|inline-flex|contents|relative|absolute|sticky|fixed|static|shrink-0|grow-0|truncate|sr-only|not-sr-only|visible|invisible|overflow|overflow-[xy]|aspect|container|float|clear|isolate)(?:-[\w./[\]%-]+)?$/;
export function layoutOnly(className: string): boolean {
  if (className === "{expr}" || className === "true") return false; // computed: can't tell, so it counts
  const tokens = className.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => LAYOUT.test(t));
}

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
        // A part is a use of its component (DialogTitle → Dialog.Title), so counts roll up.
        const parent = c.role === "part" && c.partOf ? role.get(c.partOf) : undefined;
        const name = parent ? `${parent.name}.${c.name.startsWith(parent.name) ? c.name.slice(parent.name.length) : c.name}` : `${c.name}${u.part ? `.${u.part}` : ""}`;
        const lib = u.library ?? library;
        // A child library rendering its own components isn't consumption.
        if (target.role !== "consumer" && lib === target.name) continue;
        const overrides: string[] = [];
        if (u.form !== "class" && u.form !== "macro") {
          const cls = el.attributes.className ?? (u.form !== "selector" ? el.attributes.class : undefined);
          if (cls !== undefined && !layoutOnly(cls)) overrides.push("className");
          if ("style" in el.attributes || "sx" in el.attributes || "css" in el.attributes) overrides.push("style");
        }
        if (el.spread) overrides.push("spread");
        out.push({ target: target.name, library: lib, pkg: el.importSource ?? u.form, component: name, file: displayPath(root, abs, target.dir), line: el.line, framework, overrides: overrides.sort() });
      }
    }
  }
  return out;
}
