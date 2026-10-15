import { z } from "zod";
import { ConfigSchema } from "../config.js";

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
    baseline: ViolationCountsSchema.nullable(),
    current: ViolationCountsSchema,
    deltas: ViolationCountsSchema,
    grew: z.array(z.enum(["classNameOverrides", "styleOverrides", "spreadProps", "lookAlikes"])),
  })
  .describe("Output of `dsa ratchet`.");

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
];

export function toJsonSchema(entry: SchemaFile): Record<string, unknown> {
  const json = z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "output" }) as Record<string, unknown>;
  return { $id: `${SCHEMA_BASE_URL}/${entry.file}`, title: entry.title, ...json };
}
