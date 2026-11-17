import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * One list of issues: the unit of work in the redesign (docs/redesign/03-information-architecture.md).
 *
 * Today one problem can appear in four places under four names: an Action (finding or review
 * approval), an Element Review question, a System "needs a check" or "not used" row, and a failed
 * agent-readiness check. This merges them into one list with one stable key, one kind and one
 * certainty word each. It reads what the report already builds; it changes none of it.
 */

/** How sure DSA is, in one word (decision D2). */
export type Certainty = 'measured' | 'inferred' | 'needs-person';

export type IssueKind =
  /** A measured problem the scan raised (queue finding). */
  | 'finding'
  /** Element migrations a person approved in Element Review (queue approval). */
  | 'approval'
  /** An Element Review question only a person can answer. */
  | 'question'
  /** A system component found by naming alone, known only from app code, or of an unclear kind. */
  | 'component-check'
  /** A system component no app uses. */
  | 'component-unused'
  /** An agent-readiness check that scored low. */
  | 'readiness';

export interface Issue {
  /** Stable across scans: the source's own id, or a hash of what identifies it. */
  key: string;
  kind: IssueKind;
  /** The finding rule, 'approval', 'question', 'component' or 'readiness'. */
  rule: string;
  title: string;
  certainty: Certainty;
  /** The component it is about, for grouping (null when it is about an app or repo as a whole). */
  component: string | null;
  apps: string[];
  owner: string | null;
  status: 'open' | 'done';
  /** A person dismissed it with a reason (stage 7): it shows under Done with the label. */
  dismissed?: { label: string; reason: string; who?: string; date: string } | null;
  /** Where the full detail lives in today's payload, so screens can open it. */
  source:
    | { type: 'queue'; id: string }
    | { type: 'question'; key: string }
    | { type: 'component'; name: string }
    | { type: 'readiness'; subject: string; check: string };
}

/**
 * Which finding rules are measured with a known fix. The same table the dashboard's Actions and
 * Overview use today (ui/src/lib/insight.ts): "definite" there is "measured" here.
 */
const MEASURED_RULES = new Set(['deprecated', 'version-currency', 'pin-currency', 'token-compliance', 'approval', 'agent-readiness']);

export const certaintyOfRule = (rule: string | undefined): Certainty => (MEASURED_RULES.has(rule ?? '') ? 'measured' : 'inferred');

/** The same test System uses for "Needs a check". */
export const needsCheck = (c: any) => Boolean(c?.inferred || c?.evidence?.tier === 'convention' || c?.kind?.ambiguous);

/** A readiness check below this score is an issue (System shows it with a warning below 80). */
export const READINESS_PASS = 80;

const hashKey = (prefix: string, s: string) => `${prefix}-${crypto.createHash('sha1').update(s).digest('hex').slice(0, 6).toUpperCase()}`;

export interface IssueInputs {
  /** queue.items (findings and approvals). */
  queue?: { items: any[] } | null;
  /** elements.questions and elements.evals (the review's open questions and what they cover). */
  elements?: { questions?: any[]; evals?: any[] } | null;
  /** model.components (what the scan believes the system is). */
  model?: { components?: any[] } | null;
  /** readiness rows, one per repo. */
  readiness?: any[] | null;
  /** Issues people dismissed, by key (the agent's dismissals.json). */
  dismissed?: Record<string, { label: string; reason: string; who?: string; date: string }> | null;
}

export function buildIssues(p: IssueInputs): Issue[] {
  const out: Issue[] = [];
  const systemNames = new Map<string, string>((p.model?.components ?? []).map((c: any) => [String(c.name).toLowerCase(), String(c.name)]));
  const componentOf = (name: unknown) => (typeof name === 'string' ? systemNames.get(name.toLowerCase()) ?? null : null);

  // ---- Actions: findings and review approvals (already one item each, with stable ids).
  for (const i of p.queue?.items ?? []) {
    const approval = i.kind === 'approval';
    out.push({
      key: i.id, kind: approval ? 'approval' : 'finding', rule: i.rule, title: i.title,
      certainty: certaintyOfRule(i.rule),
      component: approval ? componentOf(i.decision?.use) ?? i.decision?.use ?? null : componentOf(i.subject) ?? componentOf(i.family),
      apps: i.affected ?? (i.target ? [i.target] : []), owner: i.owner ?? null,
      status: i.status === 'done' ? 'done' : 'open',
      source: { type: 'queue', id: i.id },
    });
  }

  // ---- Element Review questions: open ones only; an answered question becomes an approval above.
  const appOf = new Map<string, string>((p.elements?.evals ?? []).map((e: any) => [e.id, e.target]));
  for (const q of p.elements?.questions ?? []) {
    const ids: string[] = q.ids ?? [];
    const decided = ids.length > 0 && ids.every(id => (p.elements?.evals ?? []).find((e: any) => e.id === id)?.decided);
    const use = q.options?.[0]?.decision?.use ?? q.auto?.use;
    out.push({
      key: hashKey('Q', q.key), kind: 'question', rule: 'question', title: q.title,
      certainty: 'needs-person',
      component: componentOf(use) ?? use ?? null,
      apps: [...new Set(ids.map(id => appOf.get(id)).filter((x): x is string => Boolean(x)))],
      owner: null, status: decided ? 'done' : 'open',
      source: { type: 'question', key: q.key },
    });
  }

  // ---- System: components to confirm, and components no app uses.
  for (const c of p.model?.components ?? []) {
    if (needsCheck(c)) out.push({
      key: hashKey('C', `check|${String(c.name).toLowerCase()}`), kind: 'component-check', rule: 'component', title: `Confirm ${c.name} is a system component`,
      certainty: 'needs-person', component: c.name, apps: [], owner: null, status: 'open', source: { type: 'component', name: c.name },
    });
    if (!c.uses?.consumer) out.push({
      key: hashKey('C', `unused|${String(c.name).toLowerCase()}`), kind: 'component-unused', rule: 'component', title: `${c.name} is not used by any app`,
      certainty: 'measured', component: c.name, apps: [], owner: null, status: 'open', source: { type: 'component', name: c.name },
    });
  }

  // ---- Agent readiness: each check that scored low, per repo.
  for (const r of p.readiness ?? []) for (const ch of r.checks ?? []) {
    if (typeof ch.score !== 'number' || ch.score >= READINESS_PASS) continue;
    out.push({
      key: hashKey('R', `${r.subject}|${ch.id}`), kind: 'readiness', rule: 'readiness', title: `${ch.title} (${r.subject})`,
      certainty: 'measured', component: null, apps: [r.subject], owner: null, status: 'open',
      source: { type: 'readiness', subject: r.subject, check: ch.id },
    });
  }

  // ---- Dismissed with a reason: Done, with the label kept so the list can say why.
  for (const i of out) { const d = p.dismissed?.[i.key]; if (d) { i.status = 'done'; i.dismissed = d; } }
  return out;
}

/** The agent's record of dismissed issues (agent/dismissals.json in the data folder), or none. */
export function readDismissedIssues(dataDir: string): IssueInputs['dismissed'] {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'dismissals.json'), 'utf8')).issues ?? null; } catch { return null; }
}
