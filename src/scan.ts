import path from "node:path";
import type { AdoptionMetrics } from "./metrics/adoption.js";
import { adoptionFromReading } from "./metrics/model-adoption.js";
import { styleValuesFromReading, type StyleValueFinding } from "./metrics/style-values.js";
import { createRunContext, type ReportMeta, type RunContext, type RunOptions } from "./run.js";

export interface ScanReport extends AdoptionMetrics {
  meta: ReportMeta;
  /** Absolute config root. */
  root: string;
  system: string;
  /** Colours and pixel sizes written straight into consumer code where a token belongs, by line. */
  styleValues: StyleValueFinding[];
}

export function scanFromContext(ctx: RunContext): ScanReport {
  const metrics = adoptionFromReading(ctx.reading, ctx.loaded.config);
  const within = ctx.scanDir.startsWith(ctx.root + path.sep) ? ctx.scanDir : undefined;
  const styleValues = styleValuesFromReading(ctx.root, ctx.reading, ctx.loaded.config, within);
  return { meta: ctx.meta, root: ctx.root, system: ctx.loaded.config.system.name, ...metrics, styleValues };
}

/** Component inventory, adoption counts (definition 1) and correct-use findings. */
export function scan(options: RunOptions = {}): ScanReport {
  return scanFromContext(createRunContext(options));
}
