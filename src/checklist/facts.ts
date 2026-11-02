import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { DsaConfig } from "../config.js";
import type { AdoptionMetrics } from "../metrics/adoption.js";
import type { RepoReading } from "../model/index.js";
import type { ResolvedProfile } from "../profile.js";

/**
 * What the checklist's detectors read, gathered once: every file path in the repo, every
 * package.json, the system model's reading and the adoption metrics. Detectors only look things up
 * here; nothing below runs the scan twice.
 */
export interface Facts {
  root: string;
  config: DsaConfig;
  profile: ResolvedProfile;
  /** Every file in the repo, root-relative with forward slashes (build output and dependencies left out). */
  files: string[];
  packages: PackageInfo[];
  /** Every dependency name any package.json in the repo lists (dependencies, dev and peer). */
  deps: Set<string>;
  reading: RepoReading;
  /** Adoption and correct use in consumer code; null when the repo has no consumer files. */
  adoption: AdoptionMetrics | null;
  /** The ratchet baseline file exists. */
  baseline: boolean;
  /** Root-relative path of the pattern decisions file, when reviewers have recorded any. */
  patternDecisions: string | null;
  /** Matching files, by a test on their root-relative path. */
  find(test: RegExp): string[];
  /** A file's text (first 256 KB), or "" when it can't be read. */
  read(file: string): string;
  /** Files among `files` whose text matches, reading at most `limit` of them. */
  grep(files: string[], test: RegExp, limit?: number): string[];
}

export interface PackageInfo {
  /** Root-relative folder ("" for the root). */
  dir: string;
  name?: string | undefined;
  version?: string | undefined;
  private: boolean;
  deps: string[];
  scripts: Record<string, string>;
}

const IGNORE = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/coverage/**", "**/.next/**", "**/.nuxt/**", "**/.svelte-kit/**", "**/.turbo/**", "**/.cache/**", "**/out/**"];

export interface FactsInput {
  root: string;
  config: DsaConfig;
  profile: ResolvedProfile;
  reading: RepoReading;
  adoption: AdoptionMetrics | null;
  baselinePath: string;
  decisionsPath: string;
  outputDir: string;
}

export function gatherFacts(input: FactsInput): Facts {
  const { root } = input;
  const output = path.relative(root, input.outputDir).split(path.sep).join("/");
  const ignore = output && !output.startsWith("..") ? [...IGNORE, `${output}/**`] : IGNORE;
  const files = fg.sync("**/*", { cwd: root, dot: true, onlyFiles: true, ignore, followSymbolicLinks: false, suppressErrors: true }).sort();
  const packages: PackageInfo[] = [];
  const deps = new Set<string>();
  for (const f of files) {
    if (path.posix.basename(f) !== "package.json") continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, f), "utf8")) as Record<string, unknown>;
      const names = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => Object.keys((j[k] as Record<string, string> | undefined) ?? {}));
      for (const n of names) deps.add(n);
      packages.push({
        dir: path.posix.dirname(f) === "." ? "" : path.posix.dirname(f),
        name: typeof j.name === "string" ? j.name : undefined,
        version: typeof j.version === "string" ? j.version : undefined,
        private: j.private === true,
        deps: names,
        scripts: (j.scripts as Record<string, string> | undefined) ?? {},
      });
    } catch {
      // A package.json that doesn't parse adds nothing.
    }
  }
  const cache = new Map<string, string>();
  const read = (file: string): string => {
    let text = cache.get(file);
    if (text === undefined) {
      try {
        const fd = fs.openSync(path.join(root, file), "r");
        const buf = Buffer.alloc(256 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        text = buf.subarray(0, n).toString("utf8");
      } catch {
        text = "";
      }
      cache.set(file, text);
    }
    return text;
  };
  return {
    root,
    config: input.config,
    profile: input.profile,
    files,
    packages,
    deps,
    reading: input.reading,
    adoption: input.adoption,
    baseline: fs.existsSync(input.baselinePath),
    patternDecisions: fs.existsSync(input.decisionsPath) ? path.relative(root, input.decisionsPath).split(path.sep).join("/") : null,
    find: (test) => files.filter((f) => test.test(f)),
    read,
    grep: (list, test, limit = 400) => list.slice(0, limit).filter((f) => test.test(read(f))),
  };
}

/** Lowercase letters and digits only: the form concept keys are compared in. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The name a file speaks for: its base name without extensions and suffixes (`button.stories.tsx` →
 * `button`), or its folder's name for an index, README or docs file (`button/README.md` → `button`).
 */
export function subjectOf(file: string): string {
  const base = path.posix.basename(file).replace(/\.(stories|story|test|spec|docs|figma|examples?)\b.*$/i, "").replace(/\..*$/, "");
  if (/^(index|readme|docs?|usage|api|overview)$/i.test(base)) return norm(path.posix.basename(path.posix.dirname(file)));
  return norm(base);
}
