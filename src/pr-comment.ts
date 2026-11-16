import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DsaConfig } from "./config.js";
import { BUILTIN_HOSTS, hostAdapter, type HostAdapter, type HostContext } from "./deploy/index.js";
import type { ViolationCounts } from "./metrics/adoption.js";
import type { StyleValueFinding } from "./metrics/style-values.js";
import { compareCounts, type CountComparison } from "./ratchet.js";
import { loadRunContext, type RunContext } from "./run.js";
import { scanFromContext, type ScanReport } from "./scan.js";

/**
 * `dsa pr-comment`: what a pull request does to design-system use, as one short comment.
 *
 * It compares two scans (the pull request's base and its head). Counts are compared the way the
 * ratchet compares them (compareCounts); the items behind the counts are matched by what they are
 * and where (file, component, value), so a line moving doesn't read as new.
 */

export const PR_COMMENT_MARKER = "<!-- dsa:pr-comment -->";

export type DeltaCategory = "hardCoded" | "lookAlike" | "guidelines";

export interface DeltaItem {
  category: DeltaCategory;
  /** What the item is, ignoring its line: two items with the same key are the same problem. */
  key: string;
  /** One plain phrase, Markdown. */
  text: string;
  file?: string | undefined;
  line?: number | undefined;
}

export interface ScanDelta {
  /** Problems the head has that the base didn't. */
  added: DeltaItem[];
  /** Problems the base had that the head doesn't: improvements. */
  removed: DeltaItem[];
  /** Correct-use counts, compared as the ratchet compares them. */
  counts: CountComparison & { before: ViolationCounts; after: ViolationCounts };
  styleValues: { before: number; after: number };
}

/** The parts of a scan report the comparison reads (a scan.json from an older dsa may lack styleValues). */
export type ComparableScan = Pick<ScanReport, "correctUse"> & { styleValues?: StyleValueFinding[] | undefined };

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** Every problem in a scan, as comparable items. */
export function scanItems(scan: ComparableScan): DeltaItem[] {
  const items: DeltaItem[] = [];
  for (const v of scan.styleValues ?? []) {
    items.push({ category: "hardCoded", key: `value|${v.file}|${v.value.toLowerCase()}`, text: `hard-coded ${v.kind === "color" ? "colour" : "size"} ${code(v.value)}`, file: v.file, line: v.line });
  }
  for (const l of scan.correctUse.lookAlikes) {
    items.push({ category: "lookAlike", key: `look|${l.name}|${l.dsComponent}`, text: `${code(l.name)} is a custom version of the system's ${code(l.dsComponent)}`, file: l.declaredIn?.file, line: l.declaredIn?.line });
  }
  for (const r of scan.correctUse.rawElements) {
    items.push({ category: "lookAlike", key: `raw|${r.file}|${r.element}`, text: `plain ${code(`<${r.element}>`)} where the system has a component`, file: r.file, line: r.line });
  }
  for (const o of scan.correctUse.overrides) {
    items.push({
      category: "guidelines",
      key: `override|${o.file}|${o.component}|${o.prop}`,
      text: o.prop === "className" ? `${code(o.component)} is given its own ${code("className")}, which changes its look` : `${code(o.component)} is given an inline ${code("style")}, which changes its look`,
      file: o.file,
      line: o.line,
    });
  }
  for (const s of scan.correctUse.spreadProps) {
    items.push({ category: "guidelines", key: `spread|${s.file}|${s.component}`, text: `${code(s.component)} is given spread props (${code("{...props}")}), so its use can't be checked`, file: s.file, line: s.line });
  }
  return items;
}

/**
 * Items in `after` that `before` doesn't account for. Items are matched by key; when a key has more
 * items than before, the ones on lines `before` didn't have are the new ones.
 */
function surplus(before: DeltaItem[], after: DeltaItem[]): DeltaItem[] {
  const group = (list: DeltaItem[]) => {
    const m = new Map<string, DeltaItem[]>();
    for (const i of list) m.set(i.key, [...(m.get(i.key) ?? []), i]);
    return m;
  };
  const b = group(before);
  const out: DeltaItem[] = [];
  for (const [key, items] of group(after)) {
    const was = b.get(key) ?? [];
    const extra = items.length - was.length;
    if (extra <= 0) continue;
    const oldLines = was.map((i) => i.line);
    const moved: DeltaItem[] = [];
    const fresh: DeltaItem[] = [];
    for (const i of items) {
      const at = oldLines.indexOf(i.line);
      if (at >= 0) { oldLines.splice(at, 1); moved.push(i); } else fresh.push(i);
    }
    out.push(...[...fresh, ...moved].slice(0, extra));
  }
  return out.sort((x, y) => (x.file ?? "").localeCompare(y.file ?? "") || (x.line ?? 0) - (y.line ?? 0));
}

/** What changed between a pull request's base scan and its head scan. */
export function compareScans(base: ComparableScan, head: ComparableScan): ScanDelta {
  const b = scanItems(base);
  const h = scanItems(head);
  const counts = compareCounts(base.correctUse.counts, head.correctUse.counts);
  return {
    added: surplus(b, h),
    removed: surplus(h, b),
    counts: { ...counts, before: base.correctUse.counts, after: head.correctUse.counts },
    styleValues: { before: (base.styleValues ?? []).length, after: (head.styleValues ?? []).length },
  };
}

export interface MarkdownOptions {
  /** Turns a scan path and line into a link, e.g. to the file on the pull request's head commit. */
  link?: ((file: string, line?: number) => string | undefined) | undefined;
  /** Items listed per section before "and N more". Default 10. */
  limit?: number | undefined;
  /** What the base was, for the footnote ("main at 1a2b3c4"). */
  baseLabel?: string | undefined;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const SECTIONS: { category: DeltaCategory; title: string; advice: string }[] = [
  { category: "hardCoded", title: "New hard-coded style values", advice: "Use a design token instead." },
  { category: "lookAlike", title: "New custom look-alikes", advice: "Use the system component instead." },
  { category: "guidelines", title: "Components used against their guidelines", advice: "Use the component's own props and variants." },
];

const COUNT_NAMES: Record<keyof ViolationCounts, string> = {
  classNameOverrides: "className overrides",
  styleOverrides: "inline style overrides",
  spreadProps: "spread props",
  lookAlikes: "custom look-alikes",
  rawElements: "plain HTML controls",
};

/** True when the change does nothing to design-system use. */
export function isClean(delta: ScanDelta): boolean {
  return delta.added.length === 0 && delta.removed.length === 0;
}

/** The comment: the headline first, then the new problems by kind, then improvements. */
export function prCommentMarkdown(delta: ScanDelta, options: MarkdownOptions = {}): string {
  const limit = options.limit ?? 10;
  if (isClean(delta)) return `${PR_COMMENT_MARKER}\n**Design system:** no change to design-system use.\n`;

  const where = (i: DeltaItem) => {
    if (!i.file) return "";
    const label = code(`${i.file}${i.line ? `:${i.line}` : ""}`);
    const url = options.link?.(i.file, i.line);
    return url ? `[${label}](${url}) ` : `${label} `;
  };
  const list = (items: DeltaItem[], prefix = "") => {
    const shown = items.slice(0, limit).map((i) => `- ${where(i)}${prefix}${i.text}`);
    if (items.length > limit) shown.push(`- …and ${items.length - limit} more.`);
    return shown;
  };

  const added = delta.added.length;
  const fixed = delta.removed.length;
  const headline = added
    ? `**Design system:** this change adds ${plural(added, "problem")}${fixed ? ` and fixes ${fixed}` : ""}.`
    : `**Design system:** this change fixes ${plural(fixed, "problem")} and adds none.`;
  const out = [PR_COMMENT_MARKER, headline];

  const kinds = SECTIONS.map((s) => [s, delta.added.filter((i) => i.category === s.category)] as const).filter(([, items]) => items.length);
  if (kinds.length > 1) out.push("", kinds.map(([s, items]) => `${s.title.replace(/^New /, "").toLowerCase()}: ${items.length}`).join(" · "));
  for (const [s, items] of kinds) {
    out.push("", `**${s.title} (${items.length}).** ${s.advice}`, ...list(items));
  }
  if (fixed) out.push("", `**Improvements (${fixed}).** Thank you.`, ...list(delta.removed, "removed "));

  const moved = (Object.keys(COUNT_NAMES) as (keyof ViolationCounts)[])
    .filter((k) => delta.counts.deltas[k] !== 0)
    .map((k) => `${COUNT_NAMES[k]} ${delta.counts.before[k]} → ${delta.counts.after[k]}`);
  if (delta.styleValues.after !== delta.styleValues.before) moved.push(`hard-coded style values ${delta.styleValues.before} → ${delta.styleValues.after}`);
  const base = options.baseLabel ? ` with ${options.baseLabel}` : " with its base";
  out.push("", `<sub>dsa compared this pull request${base}.${moved.length ? ` Totals: ${moved.join(", ")}.` : ""}</sub>`);
  return out.join("\n") + "\n";
}

/** The pull request a GitHub Actions run is for, from its environment and event file. */
export interface PullRequestEnv {
  number?: number | undefined;
  repo?: string | undefined;
  baseSha?: string | undefined;
  baseRef?: string | undefined;
  headSha?: string | undefined;
  server?: string | undefined;
}

export function pullRequestFromEnv(env: Record<string, string | undefined>): PullRequestEnv {
  let event: any = null;
  if (env.GITHUB_EVENT_PATH) {
    try { event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")); } catch { event = null; }
  }
  const pr = event?.pull_request ?? null;
  const n = pr?.number ?? (event?.issue?.pull_request ? event.issue.number : undefined) ?? event?.number;
  return {
    number: typeof n === "number" ? n : undefined,
    repo: env.GITHUB_REPOSITORY || pr?.base?.repo?.full_name || undefined,
    baseSha: pr?.base?.sha,
    baseRef: env.GITHUB_BASE_REF || pr?.base?.ref || undefined,
    headSha: pr?.head?.sha,
    server: env.GITHUB_SERVER_URL || undefined,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

/** The repo's top folder, or null outside git. */
export function gitTop(dir: string): string | null {
  return tryGit(dir, ["rev-parse", "--show-toplevel"]);
}

/**
 * What to compare against when nothing is named. Actions checks out a pull request as a merge
 * commit, whose first parent is the base it merges into; otherwise the point the branch left the base.
 */
export function defaultBase(dir: string, pr: PullRequestEnv): string | null {
  const parents = tryGit(dir, ["rev-list", "--parents", "-n", "1", "HEAD"])?.split(/\s+/) ?? [];
  if (parents.length === 3) return parents[1]!;
  for (const ref of [pr.baseSha, pr.baseRef ? `origin/${pr.baseRef}` : undefined]) {
    if (!ref) continue;
    const mb = tryGit(dir, ["merge-base", ref, "HEAD"]);
    if (mb) return mb;
    if (tryGit(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return ref;
  }
  return null;
}

/**
 * Scan the repo as it was at `ref`, in a temporary git worktree, with the head's config and profile.
 * Installed packages are shared from the head checkout (a worktree has none of its own).
 */
export async function scanAtRef(ref: string, head: RunContext): Promise<ScanReport> {
  const found = gitTop(head.scanDir);
  const top = found ? fs.realpathSync(found) : null;
  if (!top) throw new Error(`${head.scanDir} isn't in a git checkout, so the base can't be read. Pass --base-scan <scan.json> instead.`);
  const sha = tryGit(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!sha) throw new Error(`Can't find ${ref} in this checkout. Fetch it first (actions/checkout with fetch-depth: 0), or pass --base-scan <scan.json>.`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-base-"));
  // git answers with real paths (macOS's /var is /private/var): compare real with real.
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  const inTop = (p: string) => real(p) === top || real(p).startsWith(top + path.sep);
  const at = (p: string) => path.join(tmp, path.relative(top, real(p)));
  try {
    git(top, ["worktree", "add", "--detach", "--quiet", tmp, sha]);
    for (const dir of new Set([top, head.root])) {
      const modules = path.join(dir, "node_modules");
      if (fs.existsSync(modules) && !fs.existsSync(at(modules))) fs.symlinkSync(modules, at(modules), "dir");
    }
    // A pull request that adds dsa has no config on its base: read the base with the head's.
    const headConfig = head.loaded.configPath;
    const configPath = headConfig && inTop(headConfig) ? at(headConfig) : headConfig ?? undefined;
    if (headConfig && configPath && !fs.existsSync(configPath)) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.copyFileSync(headConfig, configPath);
    }
    const dir = inTop(head.scanDir) ? at(head.scanDir) : head.scanDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ctx = await loadRunContext({ dir, ...(configPath ? { configPath } : {}), profile: head.profile });
    return scanFromContext(ctx);
  } finally {
    tryGit(top, ["worktree", "remove", "--force", tmp]);
    fs.rmSync(tmp, { recursive: true, force: true });
    tryGit(top, ["worktree", "prune"]);
  }
}

/** The checkout's HEAD commit, or null outside git. */
export function headCommit(dir: string): string | null {
  return tryGit(dir, ["rev-parse", "HEAD"]);
}

/**
 * The host adapter that posts the comment: --host, else the config's host.adapter, else the one
 * named "github" when the run is in a GitHub Actions pull request (GITHUB_REPOSITORY is set).
 */
export function prHost(o: { root: string; config: DsaConfig; env: Record<string, string | undefined>; fetch?: typeof fetch; id?: string | undefined; hosts?: HostAdapter[] }): { host: HostAdapter; context: HostContext } {
  const configured = o.config.host?.adapter;
  const id = o.id ?? (configured && configured !== "generic" ? configured : o.env.GITHUB_REPOSITORY ? "github" : configured ?? "generic");
  const hostCfg = { ...(o.config.host ?? { github: { workflow: "dsa.yml", label: "dsa-decisions", server: "https://github.com" } }), adapter: id } as HostContext["host"];
  const host = hostAdapter(id, [...BUILTIN_HOSTS, ...(o.hosts ?? [])]);
  return { host, context: { root: o.root, host: hostCfg, config: { github: o.config.github }, env: o.env, fetch: o.fetch ?? fetch } };
}
