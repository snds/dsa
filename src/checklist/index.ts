import fs from "node:fs";
import path from "node:path";
import { adoptionFromReading } from "../metrics/model-adoption.js";
import { decisionsPath } from "../patterns.js";
import type { ReportMeta, RunContext } from "../run.js";
import { gatherFacts } from "./facts.js";
import { AREAS, ITEMS, type AreaId, type ChecklistItem, type Size } from "./items.js";

export { AREAS, ITEMS, type AreaId, type ChecklistItem, type Detection, type MeasuredStatus, type Size } from "./items.js";

/** The team's answers, kept in the repo next to the config: `dsa.checklist.json`. */
export const ANSWERS_FILENAME = "dsa.checklist.json";

export type ItemStatus = "done" | "partial" | "missing" | "na" | "unanswered";

export interface Answer {
  status: "done" | "partial" | "missing" | "na";
  note?: string;
}

export interface AnswersFile {
  $schema?: string;
  items: Record<string, Answer>;
}

export interface ChecklistResult {
  id: string;
  area: AreaId;
  title: string;
  about: string;
  size: Size;
  status: ItemStatus;
  /**
   * `measured`: the scan decided. `answered`: the team's answer, on an item the scan doesn't measure
   * (or couldn't here). `overridden`: the team's answer replaced what the scan found (`measured` keeps it).
   */
  source: "measured" | "answered" | "overridden" | "none";
  evidence: string[];
  /** What the scan found, when an answer overrode it. */
  measured?: { status: "done" | "partial" | "missing"; evidence: string[] } | undefined;
  note?: string | undefined;
}

export interface AreaScore {
  id: AreaId;
  title: string;
  /** Items that count: everything but `na` and `unanswered`. */
  applicable: number;
  done: number;
  partial: number;
  missing: number;
  unanswered: number;
  /** done + half of partial, over applicable; null when nothing applies yet. */
  score: number | null;
}

export interface ChecklistReport {
  meta: ReportMeta;
  root: string;
  system: string;
  /** The answers file that was read, or null. */
  answersPath: string | null;
  summary: { items: number; measured: number; answered: number; unanswered: number; score: number | null };
  areas: AreaScore[];
  items: ChecklistResult[];
  /** Ids in the answers file that no checklist item has. */
  unknownAnswers: string[];
}

export interface ChecklistOptions {
  /** Answers file; default `dsa.checklist.json` in the config root (missing is fine). */
  answersPath?: string | undefined;
}

const STATUSES = new Set(["done", "partial", "missing", "na"]);

export function readAnswers(file: string): AnswersFile | null {
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const items = (raw as { items?: unknown })?.items;
  if (!items || typeof items !== "object") throw new Error(`${file} needs an "items" object: { "items": { "<item id>": { "status": "done" } } }.`);
  for (const [id, a] of Object.entries(items as Record<string, unknown>)) {
    const status = (a as { status?: unknown })?.status;
    if (typeof status !== "string" || !STATUSES.has(status)) throw new Error(`${file}: item ${id} needs a status of done, partial, missing or na.`);
  }
  return raw as AnswersFile;
}

/** Score the checklist for one repo: every detector runs against one scan, then the team's answers apply. */
export function checklistFromContext(ctx: RunContext, options: ChecklistOptions = {}): ChecklistReport {
  const config = ctx.loaded.config;
  const reading = ctx.reading;
  const adoption = reading.files.some((f) => !f.inSource) ? adoptionFromReading(reading, config) : null;
  const facts = gatherFacts({
    root: ctx.root,
    config,
    profile: ctx.profile,
    reading,
    adoption: adoption && adoption.files.length ? adoption : null,
    baselinePath: path.resolve(ctx.root, config.ratchet.baseline),
    decisionsPath: decisionsPath(ctx),
    outputDir: ctx.outputDir,
  });
  const answersPath = path.resolve(ctx.root, options.answersPath ?? ANSWERS_FILENAME);
  const answers = readAnswers(answersPath);
  const given = answers?.items ?? {};
  const items = ITEMS.map((item) => resolveItem(item, item.detect?.(facts) ?? null, given[item.id]));
  const areas = AREAS.map((a) => score(a.id, a.title, items.filter((i) => i.area === a.id)));
  const counted = score("tokens", "all", items);
  const known = new Set(ITEMS.map((i) => i.id));
  return {
    meta: ctx.meta,
    root: ctx.root,
    system: config.system.name,
    answersPath: answers ? answersPath : null,
    summary: {
      items: items.length,
      measured: items.filter((i) => i.source === "measured").length,
      answered: items.filter((i) => i.source === "answered" || i.source === "overridden").length,
      unanswered: counted.unanswered,
      score: counted.score,
    },
    areas,
    items,
    unknownAnswers: Object.keys(given).filter((id) => !known.has(id)),
  };
}

function resolveItem(item: ChecklistItem, detected: ReturnType<NonNullable<ChecklistItem["detect"]>>, answer: Answer | undefined): ChecklistResult {
  const base = { id: item.id, area: item.area, title: item.title, about: item.about, size: item.size };
  const note = answer?.note;
  if (answer && detected) return { ...base, status: answer.status, source: "overridden", evidence: note ? [note] : [], measured: detected, note };
  if (answer) return { ...base, status: answer.status, source: "answered", evidence: note ? [note] : [], note };
  if (detected) return { ...base, status: detected.status, source: "measured", evidence: detected.evidence };
  return { ...base, status: "unanswered", source: "none", evidence: item.detect ? ["the scan couldn't measure this here; answer it in " + ANSWERS_FILENAME] : [] };
}

function score(id: AreaId, title: string, items: ChecklistResult[]): AreaScore {
  const n = (s: ItemStatus) => items.filter((i) => i.status === s).length;
  const done = n("done"), partial = n("partial"), missing = n("missing");
  const applicable = done + partial + missing;
  return { id, title, applicable, done, partial, missing, unanswered: n("unanswered"), score: applicable ? Math.round(((done + partial / 2) / applicable) * 1000) / 1000 : null };
}
