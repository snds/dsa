import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hintProblems, type HintMatch, type Recommendation } from '@snds/dsa/engine';

import { agentDir, type Snapshot } from './snapshot.js';
import { componentEntry } from './context.js';

/**
 * What an agent proposes and a human accepts or rejects. Agents never write decisions, hints, or issues
 * themselves: the MCP server appends a proposal here, and the dashboard applies it on Accept.
 * The file is append-only JSON lines (proposals, then status changes), so several agent processes and
 * the dashboard can write to it at once without a lock.
 */
export type ProposalKind = 'decision' | 'policy' | 'hint' | 'scanner-note' | 'issue';
export interface Proposal {
  id: string;
  kind: ProposalKind;
  session: string;
  title: string;
  rationale: string;
  confidence?: 'high' | 'medium' | 'low';
  evidence?: string[];
  payload: any;
  status: 'open' | 'accepted' | 'rejected';
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  result?: string;
}

const file = (dataDir: string) => path.join(agentDir(dataDir), 'proposals.jsonl');

export function readProposals(dataDir: string): Proposal[] {
  let text = '';
  try { text = fs.readFileSync(file(dataDir), 'utf8'); } catch { return []; }
  const byId = new Map<string, Proposal>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.type === 'status') { const p = byId.get(r.id); if (p) Object.assign(p, { status: r.status, resolvedAt: r.at, resolvedBy: r.by, result: r.result }); }
      else byId.set(r.id, r);
    } catch { /* a torn line */ }
  }
  return [...byId.values()];
}

function append(dataDir: string, rec: object) {
  fs.mkdirSync(agentDir(dataDir), { recursive: true });
  fs.appendFileSync(file(dataDir), JSON.stringify(rec) + '\n');
}

export function setStatus(dataDir: string, id: string, status: Proposal['status'], by?: string, result?: string) {
  append(dataDir, { type: 'status', id, status, at: new Date().toISOString(), by, result });
}

const VERDICTS = new Set(['replace', 'keep', 'gap', 'ignore']);

/** A recommendation that names only what the design system has. Returns problems, empty when sound. */
export function recommendationProblems(r: Recommendation | undefined, sigs: any[]): string[] {
  if (!r) return ['A recommendation is required.'];
  const p: string[] = [];
  if (!VERDICTS.has(r.verdict)) p.push(`verdict must be one of ${[...VERDICTS].join(', ')}.`);
  if (r.verdict === 'gap' && !r.gap) p.push('A gap needs `gap`: what the system is missing.');
  if (r.verdict !== 'replace') return p;
  if (!r.use) return [...p, 'A replace needs `use`: the design system\'s component.'];
  const sig = sigs.find(s => s.component === r.use);
  const entry = componentEntry(r.use);
  if (!sig && !entry) return [...p, `${r.use} is not a component the design system exports. Check component_signature and use its exact name.`];
  const axes: Record<string, string[]> = sig?.axes ?? entry?.variants ?? {};
  for (const [k, v] of Object.entries(r.props ?? {})) {
    if (axes[k] && !axes[k].includes(String(v))) p.push(`${r.use} has no ${k}="${v}". Options: ${axes[k].join(', ')}.`);
  }
  return p;
}

export interface ProposeInput { kind: ProposalKind; session: string; title?: string; rationale?: string; confidence?: Proposal['confidence']; evidence?: string[]; payload: any }

/** Validate and record. Throws with every problem at once, so the agent can fix them in one go. */
export function propose(dataDir: string, snap: Snapshot, sigs: any[], input: ProposeInput): Proposal {
  const problems: string[] = [];
  const pl = input.payload ?? {};
  if (!String(input.rationale ?? '').trim()) problems.push('Give a `rationale` the designer can check: what you looked at and why.');
  if (input.kind === 'decision') {
    const ids: string[] = pl.ids ?? [];
    if (!ids.length) problems.push('`ids` lists the elements the decision covers.');
    const unknown = ids.filter(id => !snap.evals.some(e => e.id === id));
    if (unknown.length) problems.push(`Unknown element ids: ${unknown.slice(0, 5).join(', ')}.`);
    problems.push(...recommendationProblems(pl.decision, sigs));
  } else if (input.kind === 'policy') {
    if (!pl.pattern) problems.push('`pattern` is the shared class constant or style signature the policy covers.');
    else if (!snap.evals.some(e => e.styleKey === pl.pattern || e.styleSig === pl.pattern)) problems.push(`No element is styled by ${pl.pattern}.`);
    problems.push(...recommendationProblems(pl.decision, sigs));
  } else if (input.kind === 'hint') {
    problems.push(...hintProblems({ when: pl.when as HintMatch, prefer: pl.prefer, avoid: pl.avoid, why: pl.why ?? input.rationale ?? '' }));
    if (pl.prefer) problems.push(...recommendationProblems(pl.prefer, sigs));
    for (const a of pl.avoid ?? []) if (!sigs.some(s => s.component === a) && !componentEntry(a)) problems.push(`avoid: ${a} is not a design-system component.`);
    const examples: string[] = pl.examples ?? [];
    if (!examples.length) problems.push('`examples`: the element ids you checked this on.');
  } else if (input.kind === 'scanner-note') {
    if (!pl.problem) problems.push('`problem`: what the scanner does wrong.');
  } else if (input.kind === 'issue') {
    if (!pl.title || !pl.body) problems.push('An issue needs `title` and `body`.');
  } else problems.push(`Unknown proposal kind ${input.kind}.`);
  if (problems.length) throw new Error(problems.join(' '));
  const p: Proposal = {
    id: 'P-' + crypto.randomBytes(3).toString('hex').toUpperCase(), kind: input.kind, session: input.session,
    title: input.title?.trim() || defaultTitle(input.kind, pl), rationale: String(input.rationale).trim(), confidence: input.confidence,
    evidence: input.evidence?.slice(0, 12), payload: pl, status: 'open', createdAt: new Date().toISOString(),
  };
  append(dataDir, p);
  return p;
}

function defaultTitle(kind: ProposalKind, pl: any): string {
  const d = (r: any) => (r?.verdict === 'replace' ? `${r.use}${Object.entries(r.props ?? {}).map(([k, v]) => ` ${k}=${v}`).join('')}` : r?.verdict ?? '');
  if (kind === 'decision') return `${pl.ids?.length ?? 0} element(s) → ${d(pl.decision)}`;
  if (kind === 'policy') return `Everything styled by ${pl.pattern} → ${d(pl.decision)}`;
  if (kind === 'hint') return pl.prefer ? `Scanner: prefer ${d(pl.prefer)} for <${pl.when?.element}>` : `Scanner: never ${(pl.avoid ?? []).join('/')} for <${pl.when?.element}>`;
  if (kind === 'scanner-note') return `Scanner note: ${String(pl.problem).slice(0, 80)}`;
  return String(pl.title ?? 'Issue');
}

/** Accepted scanner notes, kept next to dsa.config.json (`configDir`) for whoever works on the scanner next. */
export function feedbackPath(configDir: string) {
  return path.join(configDir, 'dsa.feedback.json');
}
export function readFeedback(root: string): any[] {
  try { return JSON.parse(fs.readFileSync(feedbackPath(root), 'utf8')).notes ?? []; } catch { return []; }
}
export function addFeedback(root: string, note: any) {
  const notes = readFeedback(root);
  notes.push(note);
  fs.writeFileSync(feedbackPath(root), JSON.stringify({ $comment: 'Scanner notes accepted from agent sessions: bugs and ideas for the scanner code.', notes }, null, 2) + '\n');
}
