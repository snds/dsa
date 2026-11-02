// How the dashboard tells a definite fix from a recommendation, who acts on each, and how sure a number is.

/** Who usually acts on a kind of action. Shown with each action as information; nothing filters by it. */
export type Actor = "owner" | "lead" | "designer" | "engineer"
export const ACTORS: Record<Actor, string> = { owner: "DS owner", lead: "Team lead", designer: "DS designer", engineer: "DS engineer" }
export const whoActs = (rule: string | undefined) => classify(rule).roles.map((r) => ACTORS[r]).join(", ")

/**
 * Definite: the scan measured it and the fix is known (a deprecated component has a named replacement, a
 * version is behind, a hard-coded value has a token, a reviewer approved the migration). Recommendation:
 * the scan inferred it, so a person decides (a custom component looks like a system one, the same override
 * keeps appearing, a pattern recurs without a component).
 */
export type Certainty = "definite" | "recommendation"
const RULES: Record<string, { certainty: Certainty; roles: Actor[]; verb: string }> = {
  deprecated: { certainty: "definite", roles: ["engineer", "lead"], verb: "Replace" },
  "version-currency": { certainty: "definite", roles: ["lead", "engineer"], verb: "Upgrade" },
  "pin-currency": { certainty: "definite", roles: ["lead", "engineer"], verb: "Update the pin" },
  "token-compliance": { certainty: "definite", roles: ["engineer", "lead"], verb: "Use tokens" },
  approval: { certainty: "definite", roles: ["engineer", "lead"], verb: "Migrate" },
  "agent-readiness": { certainty: "definite", roles: ["owner", "engineer"], verb: "Add" },
  "misuse-isolated": { certainty: "recommendation", roles: ["engineer", "lead"], verb: "Review" },
  "misuse-cluster": { certainty: "recommendation", roles: ["owner", "designer"], verb: "Decide" },
  lookalike: { certainty: "recommendation", roles: ["designer", "engineer", "lead"], verb: "Compare" },
  "figma-lookalike": { certainty: "recommendation", roles: ["designer"], verb: "Compare" },
  "coverage-gap": { certainty: "recommendation", roles: ["owner", "designer"], verb: "Decide" },
}
export function classify(rule: string | undefined) { return RULES[rule ?? ""] ?? { certainty: "recommendation" as Certainty, roles: ["owner"] as Actor[], verb: "Review" } }

export const CERTAINTY: Record<Certainty, { label: string; hint: string }> = {
  definite: { label: "Definite", hint: "Measured by the scan, with a known fix. Do it." },
  recommendation: { label: "Recommendation", hint: "Inferred by the scan. A person decides whether it holds." },
}

// The page once had a "View as" role picker kept in localStorage; it's gone (one page serves every
// role). Forget what an older version stored.
try { localStorage.removeItem("dsa.role") } catch { /* storage off */ }

/** How a component was found, in plain words, and how far to trust it. */
export const FOUND_BY: Record<string, { label: string; trust: "high" | "medium" | "low" }> = {
  manifest: { label: "Published metadata", trust: "high" },
  declaration: { label: "Declared in source", trust: "high" },
  export: { label: "Exported by the package", trust: "high" },
  style: { label: "Stylesheet class", trust: "medium" },
  convention: { label: "Naming convention", trust: "low" },
}
