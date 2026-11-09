import fs from "node:fs";
import { z } from "zod";

/**
 * Ground truth for `dsa bench`: one line of `labels.jsonl` per element, saying what the right answer
 * is and how that was decided. Labels live outside the scanned repo (they describe someone's code), and
 * never carry secrets.
 *
 * `method` says where the answer came from:
 *   human      a person looked at it
 *   migrated   the element was already on a system component; stripped back to raw markup, the true
 *              answer is the component that was there
 *   history    a commit turned this raw element into a system component
 *   lint       the system's own lint rule names the component
 *   consensus  independent judges agreed
 */
export const LABEL_METHODS = ["human", "migrated", "history", "lint", "consensus"] as const;

/** How a person gave a label: on its own, as one answer for several elements, or as a spot check of a sure answer. */
export const LABEL_HOW = ["alone", "batch", "spot-check"] as const;

export const LabelPickSchema = z.object({
  use: z.string().min(1).describe("The system component."),
  props: z.record(z.string(), z.string()).optional().describe("Props that matter (variant, size…), as strings."),
});

export const LabelSchema = z
  .object({
    id: z.string().min(1).describe("The element's id (E-…) when known, else a stable id of the label's own."),
    app: z.string().min(1).describe("The app (consumer) the element is in."),
    file: z.string().min(1).describe("Its file, as the scan records it."),
    line: z.number().int().min(1),
    sourceRef: z.string().min(1).describe('The source revision labelled: a git commit, or "worktree".'),
    elementHash: z.string().min(1).describe("A hash of the element's source text, to tell when the code changed under the label."),
    truth: z.object({
      verdict: z.enum(["replace", "keep", "gap"]).describe("replace: a system component; keep: stays native; gap: the system has nothing for it yet."),
      use: z.string().min(1).optional().describe("The component, for replace."),
      props: z.record(z.string(), z.string()).optional(),
    }),
    acceptableAlts: z.array(LabelPickSchema).default([]).describe("Other answers that are also right."),
    labeler: z.string().min(1).describe("Who or what labelled it (a person's handle, or the tool and its version)."),
    method: z.enum(LABEL_METHODS),
    at: z.iso.datetime({ offset: true }).describe("When it was labelled (ISO 8601)."),
    notes: z.string().optional(),
    how: z.enum(LABEL_HOW).optional().describe("How a person gave it: alone (one element, looked at on its own), batch (one answer for several elements), or spot-check (a random check of an answer dsa was already sure of)."),
    judgment: z.string().min(1).optional().describe("Shared by every label one answer produced (a batch), so scoring can count that answer once."),
    proposed: z
      .object({
        verdict: z.string().min(1),
        use: z.string().min(1).optional(),
        props: z.record(z.string(), z.string()).optional(),
        confidence: z.number().min(0).max(1),
      })
      .optional()
      .describe("What dsa proposed when the person answered, and how sure it was."),
  })
  .superRefine((l, ctx) => {
    if (l.truth.verdict === "replace" && !l.truth.use) ctx.addIssue({ code: "custom", path: ["truth", "use"], message: "a replace label names the component" });
  });

export type Label = z.output<typeof LabelSchema>;
export type LabelMethod = (typeof LABEL_METHODS)[number];

/** Parse labels.jsonl text: every valid label, and each bad line with why (1-based line numbers). */
export function parseLabels(text: string): { labels: Label[]; errors: { line: number; message: string }[] } {
  const labels: Label[] = [];
  const errors: { line: number; message: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith("//")) return;
    let json: unknown;
    try { json = JSON.parse(t); } catch (e) { errors.push({ line: i + 1, message: `not JSON: ${(e as Error).message}` }); return; }
    const r = LabelSchema.safeParse(json);
    if (r.success) labels.push(r.data);
    else errors.push({ line: i + 1, message: r.error.issues.map((x) => `${x.path.join(".") || "(label)"}: ${x.message}`).join("; ") });
  });
  return { labels, errors };
}

/** Read a labels.jsonl file. */
export function readLabels(file: string) {
  return parseLabels(fs.readFileSync(file, "utf8"));
}

/** Labels as JSONL text, one per line. */
export const labelsJsonl = (labels: Label[]) => labels.map((l) => JSON.stringify(l)).join("\n") + (labels.length ? "\n" : "");
