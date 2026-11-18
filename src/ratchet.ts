import fs from "node:fs";
import path from "node:path";
import type { ViolationCounts } from "./metrics/adoption.js";
import { adoptionFromReading } from "./metrics/model-adoption.js";
import { createRunContext, writeJson, type ReportMeta, type RunContext, type RunOptions } from "./run.js";

export interface Baseline {
  dsaVersion: string;
  updatedAt: string;
  /** A baseline from an older dsa may lack metrics added since; those aren't compared until --update. */
  counts: Partial<ViolationCounts>;
}

export interface RatchetOptions extends RunOptions {
  /** Create the baseline from the current counts (fails if one exists unless `update` is also set). */
  init?: boolean;
  /** Rewrite the baseline with the current counts. */
  update?: boolean;
  /** Pass even when some files couldn't be read (they count as nothing). Off by default. */
  allowSkipped?: boolean;
}

export type RatchetAction = "compared" | "initialized" | "updated";

export interface RatchetReport {
  meta: ReportMeta;
  root: string;
  baselinePath: string;
  action: RatchetAction;
  /** False when any count grew past the baseline. */
  ok: boolean;
  baseline: Partial<ViolationCounts> | null;
  current: ViolationCounts;
  /** current - baseline per metric (0 when there was no baseline). */
  deltas: ViolationCounts;
  /** Metrics that grew. */
  grew: (keyof ViolationCounts)[];
  /** Metrics the baseline doesn't have yet (added in a later dsa): reported, not compared. */
  untracked: (keyof ViolationCounts)[];
  /** Files the scan couldn't read: their violations aren't in `current`, so a compare fails unless allowed. */
  skipped: { file: string; message: string }[];
  /** Why a compare failed for a reason other than growth. */
  problems: string[];
}

export const VIOLATION_KEYS: (keyof ViolationCounts)[] = ["classNameOverrides", "styleOverrides", "spreadProps", "lookAlikes", "rawElements"];

export function readBaseline(file: string): Baseline | null {
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Baseline>;
  if (!raw.counts) throw new Error(`Baseline at ${file} has no "counts" block.`);
  return { dsaVersion: raw.dsaVersion ?? "unknown", updatedAt: raw.updatedAt ?? "unknown", counts: raw.counts };
}

export interface CountComparison {
  /** current - before per metric (0 when there was nothing to compare against). */
  deltas: ViolationCounts;
  /** Metrics that grew. */
  grew: (keyof ViolationCounts)[];
  /** Metrics that went down. */
  shrank: (keyof ViolationCounts)[];
  /** Metrics `before` doesn't have (added in a later dsa): not compared. */
  untracked: (keyof ViolationCounts)[];
}

/**
 * Compare correct-use counts: a baseline against today (the ratchet), or a pull request's base
 * scan against its head (`dsa pr-comment`). `before` null compares nothing.
 */
export function compareCounts(before: Partial<ViolationCounts> | null, current: ViolationCounts): CountComparison {
  const deltas: ViolationCounts = { classNameOverrides: 0, styleOverrides: 0, spreadProps: 0, lookAlikes: 0, rawElements: 0 };
  const grew: (keyof ViolationCounts)[] = [];
  const shrank: (keyof ViolationCounts)[] = [];
  const untracked: (keyof ViolationCounts)[] = [];
  if (!before) return { deltas, grew, shrank, untracked };
  for (const key of VIOLATION_KEYS) {
    const was = before[key];
    if (typeof was !== "number") {
      untracked.push(key);
      continue;
    }
    deltas[key] = current[key] - was;
    if (deltas[key] > 0) grew.push(key);
    if (deltas[key] < 0) shrank.push(key);
  }
  return { deltas, grew, shrank, untracked };
}

export function ratchetFromContext(ctx: RunContext, options: Pick<RatchetOptions, "init" | "update" | "allowSkipped"> = {}): RatchetReport {
  const baselinePath = path.resolve(ctx.root, ctx.loaded.config.ratchet.baseline);
  const current = adoptionFromReading(ctx.reading, ctx.loaded.config).correctUse.counts;
  const existing = readBaseline(baselinePath);

  if (options.init && existing && !options.update) {
    throw new Error(`Baseline already exists at ${baselinePath}. Use --update to rewrite it.`);
  }
  if (!existing && !options.init && !options.update) {
    throw new Error(`No baseline at ${baselinePath}. Run "dsa ratchet --init" to freeze today's counts.`);
  }

  const { deltas, grew, untracked } = compareCounts(existing?.counts ?? null, current);
  const skipped = ctx.reading.skipped ?? [];
  // Two ways a compare could pass without measuring anything (code review C C-04, C-18).
  const problems: string[] = [];
  if (skipped.length && !options.allowSkipped) problems.push(`${skipped.length} file${skipped.length === 1 ? "" : "s"} couldn't be read, so ${skipped.length === 1 ? "its" : "their"} violations aren't counted (first: ${skipped[0]!.file}: ${skipped[0]!.message}). Fix ${skipped.length === 1 ? "it" : "them"}, or pass --allow-skipped.`);
  if (existing && untracked.length === VIOLATION_KEYS.length) problems.push(`The baseline at ${baselinePath} tracks none of the counts. Run "dsa ratchet --update" to write them.`);

  let action: RatchetAction = "compared";
  if (options.init && !existing) action = "initialized";
  else if (options.update || options.init) action = "updated";
  if (action !== "compared") {
    const baseline: Baseline = { dsaVersion: ctx.meta.dsaVersion, updatedAt: ctx.meta.generatedAt, counts: current };
    writeJson(baselinePath, baseline);
  }

  return {
    meta: ctx.meta,
    root: ctx.root,
    baselinePath,
    action,
    // A ratchet only fails on growth; an init or update by definition sets the new bar.
    ok: action === "compared" ? grew.length === 0 && problems.length === 0 : true,
    baseline: existing?.counts ?? null,
    current,
    skipped,
    problems: action === "compared" ? problems : [],
    deltas,
    grew,
    // After an update or init the baseline has every metric.
    untracked: action === "compared" ? untracked : [],
  };
}

/** Compare correct-use violation counts against the frozen baseline; growth fails. */
export function ratchet(options: RatchetOptions = {}): RatchetReport {
  const { init, update, allowSkipped, ...run } = options;
  const extra: Pick<RatchetOptions, "init" | "update" | "allowSkipped"> = {};
  if (init !== undefined) extra.init = init;
  if (update !== undefined) extra.update = update;
  if (allowSkipped !== undefined) extra.allowSkipped = allowSkipped;
  return ratchetFromContext(createRunContext(run), extra);
}
