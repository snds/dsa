import { z } from "zod";
import { ConfigSchema } from "../config.js";
import { LabelSchema } from "../labels.js";

/**
 * Zod mirrors of the report types. They are the source of the JSON Schema
 * files in `schema/`, and the tests parse real reports with them so the
 * TypeScript types and the schemas cannot drift apart unnoticed.
 */

export const LocationSchema = z.object({
  file: z.string(),
  line: z.number().int().min(1),
  column: z.number().int().min(1),
});

export const AnatomyNodeSchema = z.object({
  component: z.string(),
  kind: z.enum(["ds", "local", "html"]),
  shapeProps: z.record(z.string(), z.string()),
  get children() {
    return z.array(AnatomyNodeSchema);
  },
});

export const TierSchema = z.enum(["pattern", "compound-component", "variant", "snowflake"]);

export const SuggestionRecordSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{12}$/).describe("Stable hash of the anatomy."),
    name: z.string().describe("Candidate name by intent."),
    anatomy: AnatomyNodeSchema.describe("Slot tree: component, kind, shape props, children."),
    occurrences: z.array(LocationSchema).min(1),
    hosts: z.array(z.string()).min(1).describe("Distinct hosts (files by default)."),
    tier: TierSchema,
    confidence: z.number().min(0).max(1),
    nearestExisting: z
      .object({ name: z.string(), score: z.number().min(0).max(1), source: z.enum(["catalog", "local"]) })
      .optional()
      .describe("Closest catalog pattern or already-named local component, when one is close."),
    reason: z.string().describe("One plain sentence."),
  })
  .describe("A pattern-candidate suggestion record. People decide; the tool suggests.");

export const MetaSchema = z.object({
  dsaVersion: z.string(),
  generatedAt: z.string(),
  config: ConfigSchema,
  configPath: z.string().nullable(),
});

export const CountsSchema = z.object({
  ds: z.number().int().min(0),
  local: z.number().int().min(0),
  html: z.number().int().min(0),
  external: z.number().int().min(0),
  total: z.number().int().min(0),
  customRatio: z.number().min(0).max(1),
});

export const ComponentUsageSchema = z.object({
  count: z.number().int().min(0),
  files: z.array(z.string()),
  sources: z.array(z.string()),
});

export const ViolationCountsSchema = z.object({
  classNameOverrides: z.number().int(),
  styleOverrides: z.number().int(),
  spreadProps: z.number().int(),
  lookAlikes: z.number().int(),
  rawElements: z.number().int(),
});

export const ScanReportSchema = z
  .object({
    meta: MetaSchema,
    root: z.string(),
    system: z.string(),
    files: z.array(z.string()),
    dsSourceFiles: z.array(z.string()),
    adoption: z.object({
      definition: z.literal("imports"),
      total: CountsSchema,
      byFile: z.record(z.string(), CountsSchema),
      byDir: z.record(z.string(), CountsSchema),
    }),
    inventory: z.object({
      ds: z.record(z.string(), ComponentUsageSchema),
      local: z.record(z.string(), ComponentUsageSchema),
      external: z.record(z.string(), ComponentUsageSchema),
      html: z.record(z.string(), z.number().int().min(0)),
    }),
    correctUse: z.object({
      overrides: z.array(LocationSchema.extend({ component: z.string(), prop: z.enum(["className", "style"]) })),
      spreadProps: z.array(LocationSchema.extend({ component: z.string() })),
      lookAlikes: z.array(
        z.object({
          name: z.string(),
          dsComponent: z.string(),
          score: z.number().min(0).max(1),
          declaredIn: LocationSchema.optional(),
          usages: z.number().int().min(0),
        }),
      ),
      rawElements: z.array(LocationSchema.extend({ element: z.string() })),
      counts: ViolationCountsSchema,
    }),
  })
  .describe("Output of `dsa scan`: inventory, adoption (definition 1: imports) and correct-use findings.");

export const PatternsReportSchema = z
  .object({
    meta: MetaSchema,
    root: z.string(),
    system: z.string(),
    thresholds: z.object({
      minOccurrences: z.number().int(),
      minHosts: z.number().int(),
      minComponents: z.number().int(),
      hostsBy: z.enum(["file", "dir"]),
    }),
    candidates: z.array(SuggestionRecordSchema),
    parked: z.array(z.object({ id: z.string(), name: z.string(), ignoredTimes: z.number().int() })),
    summary: z.object({
      candidates: z.number().int(),
      byTier: z.object({
        pattern: z.number().int(),
        "compound-component": z.number().int(),
        variant: z.number().int(),
        snowflake: z.number().int(),
      }),
      compositionsSeen: z.number().int(),
      parked: z.number().int(),
    }),
  })
  .describe("Output of `dsa patterns`: pattern-candidate suggestion records.");

export const RatchetReportSchema = z
  .object({
    meta: MetaSchema,
    root: z.string(),
    baselinePath: z.string(),
    action: z.enum(["compared", "initialized", "updated"]),
    ok: z.boolean(),
    baseline: ViolationCountsSchema.partial().nullable(),
    current: ViolationCountsSchema,
    deltas: ViolationCountsSchema,
    grew: z.array(z.enum(["classNameOverrides", "styleOverrides", "spreadProps", "lookAlikes", "rawElements"])),
    untracked: z
      .array(z.enum(["classNameOverrides", "styleOverrides", "spreadProps", "lookAlikes", "rawElements"]))
      .describe("Metrics the baseline doesn't have yet (added in a later dsa): reported, not compared, until --update."),
  })
  .describe("Output of `dsa ratchet`.");

const ItemStatusSchema = z.enum(["done", "partial", "missing", "na", "unanswered"]);
const MeasuredStatusSchema = z.enum(["done", "partial", "missing"]);

export const ChecklistAnswersSchema = z
  .object({
    $schema: z.string().optional(),
    items: z.record(
      z.string().describe("A checklist item id, such as agents.genUi."),
      z.object({
        status: z.enum(["done", "partial", "missing", "na"]),
        note: z.string().optional().describe("Shown as the item's evidence."),
      }),
    ),
  })
  .describe("dsa.checklist.json: the team's answers for checklist items the scan can't measure, or overrides of what it measured.");

export const ChecklistReportSchema = z
  .object({
    meta: MetaSchema,
    root: z.string(),
    system: z.string(),
    answersPath: z.string().nullable(),
    summary: z.object({
      items: z.number().int().min(0),
      measured: z.number().int().min(0),
      answered: z.number().int().min(0),
      unanswered: z.number().int().min(0),
      score: z.number().min(0).max(1).nullable().describe("done + half of partial, over items that apply."),
    }),
    areas: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        applicable: z.number().int().min(0),
        done: z.number().int().min(0),
        partial: z.number().int().min(0),
        missing: z.number().int().min(0),
        unanswered: z.number().int().min(0),
        score: z.number().min(0).max(1).nullable(),
      }),
    ),
    items: z.array(
      z.object({
        id: z.string(),
        area: z.string(),
        title: z.string(),
        about: z.string(),
        size: z.enum(["S", "M", "L"]),
        status: ItemStatusSchema,
        source: z.enum(["measured", "answered", "overridden", "none"]),
        evidence: z.array(z.string()),
        measured: z.object({ status: MeasuredStatusSchema, evidence: z.array(z.string()) }).optional().describe("What the scan found, when an answer overrode it."),
        note: z.string().optional(),
      }),
    ),
    unknownAnswers: z.array(z.string()),
  })
  .describe("Output of `dsa checklist`.");

export const SCHEMA_BASE_URL = "https://github.com/snds/dsa/schema";

export interface SchemaFile {
  file: string;
  title: string;
  schema: z.ZodType;
}

export const SCHEMA_FILES: SchemaFile[] = [
  { file: "config.json", title: "dsa.config.json", schema: ConfigSchema },
  { file: "scan-report.json", title: "dsa scan report", schema: ScanReportSchema },
  { file: "patterns-report.json", title: "dsa patterns report", schema: PatternsReportSchema },
  { file: "suggestion-record.json", title: "dsa suggestion record", schema: SuggestionRecordSchema },
  { file: "ratchet-report.json", title: "dsa ratchet report", schema: RatchetReportSchema },
  { file: "checklist-report.json", title: "dsa checklist report", schema: ChecklistReportSchema },
  { file: "checklist-answers.json", title: "dsa.checklist.json", schema: ChecklistAnswersSchema },
  { file: "label.json", title: "dsa labels.jsonl (one line)", schema: LabelSchema },
];

export function toJsonSchema(entry: SchemaFile): Record<string, unknown> {
  const json = z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "output" }) as Record<string, unknown>;
  return { $id: `${SCHEMA_BASE_URL}/${entry.file}`, title: entry.title, ...json };
}
