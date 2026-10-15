import fs from "node:fs";
import path from "node:path";
import { computeAdoption, type ViolationCounts } from "./metrics/adoption.js";
import { createRunContext, writeJson, type ReportMeta, type RunContext, type RunOptions } from "./run.js";

export interface Baseline {
  dsaVersion: string;
  updatedAt: string;
  counts: ViolationCounts;
}

export interface RatchetOptions extends RunOptions {
  /** Create the baseline from the current counts (fails if one exists unless `update` is also set). */
  init?: boolean;
  /** Rewrite the baseline with the current counts. */
  update?: boolean;
}

export type RatchetAction = "compared" | "initialized" | "updated";

export interface RatchetReport {
  meta: ReportMeta;
  root: string;
  baselinePath: string;
  action: RatchetAction;
  /** False when any count grew past the baseline. */
  ok: boolean;
  baseline: ViolationCounts | null;
  current: ViolationCounts;
  /** current - baseline per metric (0 when there was no baseline). */
  deltas: ViolationCounts;
  /** Metrics that grew. */
  grew: (keyof ViolationCounts)[];
}

export const VIOLATION_KEYS: (keyof ViolationCounts)[] = ["classNameOverrides", "styleOverrides", "spreadProps", "lookAlikes"];

export function readBaseline(file: string): Baseline | null {
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Baseline>;
  if (!raw.counts) throw new Error(`Baseline at ${file} has no "counts" block.`);
  return { dsaVersion: raw.dsaVersion ?? "unknown", updatedAt: raw.updatedAt ?? "unknown", counts: raw.counts };
}

export function ratchetFromContext(ctx: RunContext, options: Pick<RatchetOptions, "init" | "update"> = {}): RatchetReport {
  const baselinePath = path.resolve(ctx.root, ctx.loaded.config.ratchet.baseline);
  const current = computeAdoption(ctx.graph).correctUse.counts;
  const existing = readBaseline(baselinePath);

  if (options.init && existing && !options.update) {
    throw new Error(`Baseline already exists at ${baselinePath}. Use --update to rewrite it.`);
  }
  if (!existing && !options.init && !options.update) {
    throw new Error(`No baseline at ${baselinePath}. Run "dsa ratchet --init" to freeze today's counts.`);
  }

  const deltas = { classNameOverrides: 0, styleOverrides: 0, spreadProps: 0, lookAlikes: 0 };
  const grew: (keyof ViolationCounts)[] = [];
  if (existing) {
    for (const key of VIOLATION_KEYS) {
      deltas[key] = current[key] - existing.counts[key];
      if (deltas[key] > 0) grew.push(key);
    }
  }

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
    ok: action === "compared" ? grew.length === 0 : true,
    baseline: existing?.counts ?? null,
    current,
    deltas,
    grew,
  };
}

/** Compare correct-use violation counts against the frozen baseline; growth fails. */
export function ratchet(options: RatchetOptions = {}): RatchetReport {
  const { init, update, ...run } = options;
  const extra: Pick<RatchetOptions, "init" | "update"> = {};
  if (init !== undefined) extra.init = init;
  if (update !== undefined) extra.update = update;
  return ratchetFromContext(createRunContext(run), extra);
}
