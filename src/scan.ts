import { computeAdoption, type AdoptionMetrics } from "./metrics/adoption.js";
import { createRunContext, type ReportMeta, type RunContext, type RunOptions } from "./run.js";

export interface ScanReport extends AdoptionMetrics {
  meta: ReportMeta;
  /** Absolute config root. */
  root: string;
  system: string;
}

export function scanFromContext(ctx: RunContext): ScanReport {
  const metrics = computeAdoption(ctx.graph);
  return { meta: ctx.meta, root: ctx.root, system: ctx.loaded.config.system.name, ...metrics };
}

/** Component inventory, adoption counts (definition 1) and correct-use findings. */
export function scan(options: RunOptions = {}): ScanReport {
  return scanFromContext(createRunContext(options));
}
