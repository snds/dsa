import fs from "node:fs";
import type { Concept } from "./types.js";

/**
 * Type each concept by the name-free archetypes in data/archetypes.json: which kind of component it is
 * (dialog, tabs, button…), how sure, the runner-up, and the evidence. Evidence weights:
 *
 *   name     0.5  its name is the kind's preferred or alternative name (exact), or carries one (IconButton)
 *   parts    0.3  its parts match the kind's part aliases (title, trigger, panel…)
 *   variants 0.2  its axes use the kind's variant vocabulary (emphasis, tone, size, shape)
 *
 * A false friend (Dropdown may be a select or a menu) lowers confidence and marks the result ambiguous.
 * Sub-components (DialogTitle) are parts of their parent, not typed.
 */

interface Part { part: string; aliases: string[]; required?: boolean }
interface Kind { prefLabel: string; altLabels: string[]; falseFriends?: { label: string; mayDenote: string[] }[]; native: string[]; roles: string[]; parts: Part[]; axes: string[] }
interface Vocabulary { axisNames: string[]; values: Record<string, string[]> }
export interface Archetypes { version: number; variantVocabulary: Record<string, Vocabulary>; kinds: Record<string, Kind> }

let cache: Archetypes | undefined;
export function archetypes(): Archetypes {
  cache ??= JSON.parse(fs.readFileSync(new URL("../../data/archetypes.json", import.meta.url), "utf8")) as Archetypes;
  return cache;
}

const norm = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
const MIN = 0.35;

export function typeConcepts(concepts: Concept[], data: Archetypes = archetypes()) {
  const exact = new Set(Object.values(data.kinds).flatMap((k) => [k.prefLabel, ...k.altLabels].map(norm)));
  // A class named exactly for a kind (btn, card, badge) is a component even beside declared ones: Tailwind
  // systems ship class components alongside framework components.
  for (const c of concepts) if (c.role === "style" && (exact.has(norm(c.key)) || exact.has(norm(c.name)))) c.role = "component";
  const components = concepts.filter((c) => c.role === "component");
  const names = components.map((c) => c.name);
  for (const c of components) {
    // Exported constants and plumbing (ButtonKinds, ThemeProvider, DialogContext) aren't components.
    if (/(Kinds?|Sizes|Types|Variants|Props|Context|Provider|Config|Options|Constants|Utils|Hook|Store|Theme)$/.test(c.name)) continue;
    // A sub-component (its name extends another component's: DialogTitle) is a part, not a kind of its own,
    // unless its name is itself a name for a kind (TextInput beside Text, TabGroup beside Tab).
    const sub = names.some((n) => n !== c.name && c.name.startsWith(n) && /^[A-Z]/.test(c.name.slice(n.length)));
    if (sub && !exact.has(norm(c.key)) && !exact.has(norm(c.name))) continue;
    const scored = Object.entries(data.kinds).map(([kind, k]) => ({ kind, ...score(c, k, data) })).sort((a, b) => b.score - a.score);
    const best = scored[0]!;
    if (best.score < MIN) continue;
    const runner = scored[1];
    const ambiguous = best.falseFriend || (runner !== undefined && best.score - runner.score < 0.1);
    c.kind = {
      kind: best.kind,
      confidence: Math.round(best.score * 100) / 100,
      ...(runner && runner.score >= MIN ? { runnerUp: runner.kind } : {}),
      ...(ambiguous ? { ambiguous: true } : {}),
      evidence: best.evidence,
    };
  }
}

function score(c: Concept, k: Kind, data: Archetypes): { score: number; evidence: string[]; falseFriend: boolean } {
  const evidence: string[] = [];
  const key = norm(c.key);
  const nameKey = norm(c.name);
  const labels = [k.prefLabel, ...k.altLabels].map(norm);

  // Name: exact (key or declared name), else its last or first words are a label (IconButton, DataTable),
  // compared word by word so Table never reads as Tab.
  let name = 0;
  let falseFriend = false;
  const words = c.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const labelWords = [k.prefLabel, ...k.altLabels].map((l) => l.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const tail = (lw: string[]) => lw.length < words.length && lw.every((w, i) => words[words.length - lw.length + i] === w);
  const head = (lw: string[]) => lw.length < words.length && lw.every((w, i) => words[i + (words.length > 1 && words[0]!.length <= 3 ? 1 : 0)] === w);
  let hitLabel: string | undefined;
  if (labels.includes(key) || labels.includes(nameKey)) { name = 1; evidence.push(`name "${c.name}" is a name for this kind`); }
  else {
    const hit = labelWords.find((lw) => tail(lw)) ?? labelWords.find((lw) => head(lw));
    if (hit) { name = 0.6; hitLabel = hit.join(""); evidence.push(`name "${c.name}" carries "${hit.join(" ")}"`); }
  }
  // A false friend (a name that may mean another kind) marks the result ambiguous. When the word is also
  // this kind's own name (Menu may be site navigation), it only trims confidence; otherwise it caps it.
  const ff = k.falseFriends?.find((f) => norm(f.label) === key || norm(f.label) === nameKey || norm(f.label) === hitLabel);
  if (ff) { falseFriend = true; name = labels.includes(norm(ff.label)) ? Math.min(name, 0.85) : Math.min(name, 0.5); }

  // Parts: how many of the kind's parts the concept has, by alias.
  const cParts = (c.parts ?? []).map((p) => norm(p.name)).filter(Boolean);
  let partHits = 0;
  for (const p of k.parts) {
    const aliases = p.aliases.map(norm);
    if (cParts.some((x) => aliases.includes(x) || aliases.some((a) => a.length >= 4 && (x.endsWith(a) || a.endsWith(x) && x.length >= 4)))) partHits++;
  }
  const parts = k.parts.length ? Math.min(1, partHits / Math.min(4, k.parts.length)) : 0;
  if (partHits) evidence.push(`${partHits} of its parts match (${k.parts.length} known)`);

  // Variants: axis names and values in the kind's vocabulary.
  const vocab = k.axes.map((a) => data.variantVocabulary[a]).filter(Boolean) as Vocabulary[];
  const axisNames = new Set(vocab.flatMap((v) => v.axisNames.map(norm)));
  const values = new Set(vocab.flatMap((v) => Object.values(v.values).flat().map(norm)));
  const cAxes = c.axes ?? [];
  const named = cAxes.filter((a) => axisNames.has(norm(a.name))).length;
  const vals = cAxes.flatMap((a) => a.values.map(norm));
  const valHits = vals.filter((v) => values.has(v)).length;
  const variants = cAxes.length ? Math.min(1, 0.5 * Math.min(1, named / 2) + 0.5 * (vals.length ? valHits / vals.length : 0)) : 0;
  if (named || valHits) evidence.push(`${named} axis names and ${valHits} values in its variant vocabulary`);

  // Without a name signal, structure alone must be strong to count.
  const total = 0.5 * name + 0.3 * parts + 0.2 * variants;
  // With no name signal, structure must be strong on its own.
  return { score: name ? total : total >= 0.45 ? total * 0.8 : 0, evidence, falseFriend };
}
