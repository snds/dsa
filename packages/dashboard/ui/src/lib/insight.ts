// How the dashboard tells a definite fix from a recommendation, who acts on each, and how sure a number is.
import * as React from "react"

export type Role = "all" | "owner" | "lead" | "designer" | "engineer"
export const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: "all", label: "Everyone", hint: "Every action and measure" },
  { id: "owner", label: "DS owner", hint: "System gaps, adoption, what to build or retire" },
  { id: "lead", label: "Team lead", hint: "Your apps: versions, fixes waiting, adoption" },
  { id: "designer", label: "DS designer", hint: "Look-alikes, missing variants and patterns" },
  { id: "engineer", label: "DS engineer", hint: "Definite code fixes and migrations" },
]

/**
 * Definite: the scan measured it and the fix is known (a deprecated component has a named replacement, a
 * version is behind, a hard-coded value has a token, a reviewer approved the migration). Recommendation:
 * the scan inferred it, so a person decides (a custom component looks like a system one, the same override
 * keeps appearing, a pattern recurs without a component).
 */
export type Certainty = "definite" | "recommendation"
const RULES: Record<string, { certainty: Certainty; roles: Role[]; verb: string }> = {
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
export const classify = (rule: string | undefined) => RULES[rule ?? ""] ?? { certainty: "recommendation" as Certainty, roles: ["owner"] as Role[], verb: "Review" }
export const forRole = (role: Role, rule: string | undefined) => role === "all" || classify(rule).roles.includes(role)

export const CERTAINTY: Record<Certainty, { label: string; hint: string }> = {
  definite: { label: "Definite", hint: "Measured by the scan, with a known fix. Do it." },
  recommendation: { label: "Recommendation", hint: "Inferred by the scan. A person decides whether it holds." },
}

// The role a viewer picked, kept per browser. Every read and write is guarded: storage can be off.
const KEY = "dsa.role"
const listeners = new Set<() => void>()
export function getRole(): Role {
  try { const r = localStorage.getItem(KEY) as Role | null; return r && ROLES.some((x) => x.id === r) ? r : "all" } catch { return "all" }
}
export function setRole(r: Role) {
  try { localStorage.setItem(KEY, r) } catch { /* private window */ }
  for (const l of listeners) l()
}
export function useRole(): [Role, (r: Role) => void] {
  const [role, set] = React.useState<Role>(getRole)
  React.useEffect(() => { const on = () => set(getRole()); listeners.add(on); return () => { listeners.delete(on) } }, [])
  return [role, setRole]
}

/** How a component was found, in plain words, and how far to trust it. */
export const FOUND_BY: Record<string, { label: string; trust: "high" | "medium" | "low" }> = {
  manifest: { label: "Published metadata", trust: "high" },
  declaration: { label: "Declared in source", trust: "high" },
  export: { label: "Exported by the package", trust: "high" },
  style: { label: "Stylesheet class", trust: "medium" },
  convention: { label: "Naming convention", trust: "low" },
}
