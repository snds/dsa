import path from "node:path";
import { loadDecisions, type DecisionsFile } from "./detect/decisions.js";
import { detectPatterns, type DetectPatternsOutput } from "./detect/patterns.js";
import { createRunContext, type ReportMeta, type RunContext, type RunOptions } from "./run.js";

export interface PatternsOptions extends RunOptions {
  /** Include snowflakes (compositions under the occurrence / host bar). */
  all?: boolean;
  /** Decisions to honour; defaults to `<output.dir>/decisions.json` when present. */
  decisions?: DecisionsFile;
}

export interface PatternsReport extends DetectPatternsOutput {
  meta: ReportMeta;
  root: string;
  system: string;
  thresholds: { minOccurrences: number; minHosts: number; minComponents: number; hostsBy: "file" | "dir" };
}

export const DECISIONS_FILENAME = "decisions.json";

export function decisionsPath(ctx: RunContext): string {
  return path.join(ctx.outputDir, DECISIONS_FILENAME);
}

export function patternsFromContext(ctx: RunContext, options: Pick<PatternsOptions, "all" | "decisions"> = {}): PatternsReport {
  const decisions = options.decisions ?? loadDecisions(decisionsPath(ctx));
  const detectInput: Parameters<typeof detectPatterns>[0] = { graph: ctx.graph, config: ctx.loaded.config, decisions };
  if (options.all !== undefined) detectInput.all = options.all;
  const out = detectPatterns(detectInput);
  const p = ctx.loaded.config.patterns;
  return {
    meta: ctx.meta,
    root: ctx.root,
    system: ctx.loaded.config.system.name,
    thresholds: { minOccurrences: p.minOccurrences, minHosts: p.minHosts, minComponents: p.minComponents, hostsBy: ctx.loaded.config.hosts.by },
    ...out,
  };
}

/** Pattern-candidate suggestion records for a repository. */
export function patterns(options: PatternsOptions = {}): PatternsReport {
  const { all, decisions, ...run } = options;
  const extra: Pick<PatternsOptions, "all" | "decisions"> = {};
  if (all !== undefined) extra.all = all;
  if (decisions !== undefined) extra.decisions = decisions;
  return patternsFromContext(createRunContext(run), extra);
}
