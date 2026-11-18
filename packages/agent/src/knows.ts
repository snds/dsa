import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { componentEntry, legacyOf, type Subject } from './context.js';
import { readProposals } from './proposals.js';
import type { Snapshot } from './snapshot.js';
import { anchorKey, anchorOf, readThreadIndex } from './threads.js';
import { tools } from './system.js';

/**
 * What the agent knows about a subject (redesign stage 6), in five layers: the rules it works under,
 * the system (the component's entry, guidelines, tokens), the evidence, the memory (past decisions,
 * rejected proposals, related threads), and the repo. Each source is included, missing or stale, so a
 * reviewer can see what an answer rests on, and what it doesn't. The brief, the drawer and the MCP
 * tools all read this one list.
 */
export type Layer = 'rules' | 'system' | 'evidence' | 'memory' | 'repo';
/**
 * included: given. missing: something the agent should have and doesn't (a gap to fix). stale: old.
 * none-yet: empty, as expected on a new system (no past decisions, no hints yet): said, not a warning
 * (UX review A, B, C: every new thread warned "missing" for these).
 */
export interface Source { layer: Layer; name: string; status: 'included' | 'missing' | 'stale' | 'none-yet'; detail: string }

const STALE_DAYS = 7;

/** The component a subject is about, when it is about one. */
export function componentOf(snap: Snapshot, s: Subject): string | null {
  if (s.kind === 'component') return s.name;
  if (s.kind === 'group' && s.by === 'component') return s.value;
  if (s.kind === 'issue' && s.source?.type === 'component') return s.source.name;
  const l = legacyOf(s);
  // A finding's subject can be a key like "DataTable|className": the component is the part before "|" (UX review A U-10).
  if (l?.kind === 'queue') { const q = snap.queue.find((x: any) => x.id === l.id); return q?.decision?.use ?? (q?.subject ? String(q.subject).split('|')[0] : null) ?? null; }
  if (l?.kind === 'review') { const e = snap.evals.find((x: any) => x.id === l.ids[0]); return e?.decided?.decision?.use ?? e?.use ?? null; }
  return null;
}

/** Decisions people already made about a component: decided elements (with their notes), oldest first. */
export function pastDecisions(snap: Snapshot, component: string | null) {
  const lc = component?.toLowerCase();
  return snap.evals
    .filter((e: any) => e.decided && e.decided.by !== 'agent' && (!lc || String(e.decided.decision?.use ?? e.use ?? '').toLowerCase() === lc))
    .map((e: any) => ({ id: e.id, target: e.target, file: e.file, line: e.line, element: e.element, decision: e.decided.decision, by: e.decided.who ?? e.decided.by, date: e.decided.date ?? null, note: e.decided.note ?? null }))
}

/** The component's usage guidelines: its entry's description, and its docs file when one is readable. */
export function guidelines(component: string): { description: string | null; path: string | null; text: string | null } {
  const c = componentEntry(component);
  const p: string | null = c?.docs?.path ?? null;
  let text: string | null = null;
  if (p) {
    const root = tools().root;
    for (const f of [p, ...(root ? [path.join(root, p)] : [])]) { try { if (fs.existsSync(f)) { text = fs.readFileSync(f, 'utf8').slice(0, 6000); break; } } catch { /* unreadable */ } }
  }
  return { description: c?.docs?.description ?? null, path: p, text };
}

/** The tokens in play for a component, from the scan's model of the system and its measured signature. */
export function tokensFor(snap: Snapshot, component: string) {
  let model: any = null;
  try { model = JSON.parse(fs.readFileSync(path.join(snap.dataDir, 'model-summary.json'), 'utf8')); } catch { /* no model */ }
  const c = (model?.components ?? []).find((x: any) => String(x.name).toLowerCase() === component.toLowerCase());
  let sig: any = null;
  try { sig = JSON.parse(fs.readFileSync(path.join(snap.dataDir, 'signatures.json'), 'utf8')).find((x: any) => x.component === component) ?? null; } catch { /* none */ }
  return { component, boundTokens: c?.tokens ?? null, systemTokens: model?.tokens ?? null, axes: sig?.axes ?? null, defaults: sig?.defaults ?? null };
}

/** Other threads about the same component or issue: their titles and states. */
export function relatedThreads(snap: Snapshot, s: Subject) {
  const own = anchorKey(anchorOf(s));
  const comp = componentOf(snap, s)?.toLowerCase();
  const index = readThreadIndex(snap.dataDir);
  return Object.values(index).filter(t => t.anchor !== own && (comp ? t.anchor.endsWith(`:${comp}`) || t.title.toLowerCase().includes(comp) : false))
    .map(t => ({ anchor: t.anchor, title: t.title, state: t.state, updatedAt: t.updatedAt }));
}

/** Every source the agent gets for this subject, by layer, with what is missing said plainly. */
export function whatTheAgentKnows(snap: Snapshot, s: Subject): Source[] {
  const out: Source[] = [];
  const comp = componentOf(snap, s);
  const l = legacyOf(s);

  // Rules
  out.push({ layer: 'rules', name: 'How the agent works', status: 'included', detail: 'Plain words, evidence first, propose and never decide.' });
  out.push({ layer: 'rules', name: 'Scanner hints', status: snap.hints.length ? 'included' : 'none-yet', detail: snap.hints.length ? `${snap.hints.length} from dsa.hints.json` : 'None yet: accepted hints land in dsa.hints.json.' });

  // System
  if (comp) {
    const g = guidelines(comp);
    const entry = componentEntry(comp);
    out.push({ layer: 'system', name: `${comp}: the system's entry`, status: entry ? 'included' : 'missing', detail: entry ? `Import ${entry.import ?? '?'}${entry.variants ? `, ${Object.keys(entry.variants).length} variant axes` : ''}${entry.fromRoles ? ` (from the profile's role map: ${entry.roles.join(', ')}; no fuller entry)` : ''}` : `The design system's profile has no entry for ${comp}.` });
    out.push({ layer: 'system', name: 'Usage guidelines', status: g.text || g.description ? 'included' : 'missing', detail: g.text ? `From ${g.path}` : g.description ? 'The entry\'s description only.' : `No guidelines found for ${comp}.` });
    const t = tokensFor(snap, comp);
    out.push({ layer: 'system', name: 'Tokens in play', status: t.boundTokens != null || t.axes ? 'included' : 'missing', detail: t.boundTokens != null ? `${t.boundTokens} bound to ${comp}` : t.axes ? 'Its measured variants and defaults.' : 'The scan has no tokens for it.' });
  } else out.push({ layer: 'system', name: 'The component', status: 'none-yet', detail: 'This is not about one component.' });

  // Evidence
  if (l?.kind === 'queue') {
    const q = snap.queue.find((x: any) => x.id === l.id);
    out.push({ layer: 'evidence', name: 'The finding', status: q ? 'included' : 'missing', detail: q ? `${q.places?.length ?? 0} place(s) cited` : 'Not in the latest scan.' });
  } else if (l?.kind === 'review') {
    const items = l.ids.map(id => snap.evals.find((e: any) => e.id === id)).filter(Boolean);
    const shots = l.ids.filter(id => snap.shots[id]).length;
    out.push({ layer: 'evidence', name: 'The places', status: items.length ? 'included' : 'missing', detail: `${items.length} of ${l.ids.length} in the latest scan` });
    out.push({ layer: 'evidence', name: 'Photos', status: shots ? 'included' : 'missing', detail: shots ? `${shots} of ${l.ids.length} photographed` : 'No photos: the scan ran without a browser, or the places could not be reached.' });
  } else if (l?.kind === 'readiness') {
    out.push({ layer: 'evidence', name: 'Readiness checks', status: snap.readiness.some((r: any) => r.subject === l.subject) ? 'included' : 'missing', detail: l.subject });
  } else if (comp) {
    const n = snap.evals.filter((e: any) => String(e.use ?? '').toLowerCase() === comp.toLowerCase()).length;
    out.push({ layer: 'evidence', name: `Places proposed to become ${comp}`, status: n ? 'included' : 'missing', detail: `${n} in the latest scan` });
  } else out.push({ layer: 'evidence', name: 'The scan', status: snap.run ? 'included' : 'missing', detail: snap.run ? `Run ${snap.run.id}` : 'No scan yet.' });

  // Memory
  const past = pastDecisions(snap, comp);
  out.push({ layer: 'memory', name: 'Past decisions', status: past.length ? 'included' : 'none-yet', detail: past.length ? `${past.length} decided by people${comp ? ` about ${comp}` : ''}` : 'None yet.' });
  const rejected = readProposals(snap.dataDir).filter(p => p.status === 'rejected' && (!comp || JSON.stringify(p.payload ?? {}).toLowerCase().includes(comp.toLowerCase())));
  out.push({ layer: 'memory', name: 'Rejected proposals', status: rejected.length ? 'included' : 'none-yet', detail: rejected.length ? `${rejected.length}, with the reasons given` : 'None rejected yet.' });
  const related = relatedThreads(snap, s);
  out.push({ layer: 'memory', name: 'Related threads', status: related.length ? 'included' : 'none-yet', detail: related.length ? related.slice(0, 3).map(t => t.title).join('; ') : 'No other thread on this.' });

  // Repo
  const age = snap.run ? (Date.now() - new Date(snap.run.takenAt).getTime()) / 86_400_000 : Infinity;
  out.push({ layer: 'repo', name: 'The code', status: !snap.run ? 'missing' : age > STALE_DAYS ? 'stale' : 'included', detail: snap.run ? `Read by scan ${snap.run.id}, ${((d) => (d === 0 ? 'today' : d === 1 ? 'a day ago' : `${d} days ago`))(Math.max(0, Math.round(age)))}` : 'No scan yet.' });
  return out;
}

/** The brief's section: the same sources, and the memory written out so the agent can use it. */
export function knowsSection(snap: Snapshot, s: Subject): string[] {
  const src = whatTheAgentKnows(snap, s);
  const comp = componentOf(snap, s);
  const lines = ['## What you were given', '', 'Say when an answer rests on something missing or stale below.', '',
    ...src.map(x => `- ${x.layer} · ${x.name}: ${x.status}${x.detail ? ` (${x.detail})` : ''}`)];
  const past = pastDecisions(snap, comp).slice(-8);
  if (past.length) lines.push('', '## Past decisions people made' + (comp ? ` about ${comp}` : ''), '', ...past.map(p => `- ${p.id} ${p.file}:${p.line} <${p.element}> → ${p.decision?.verdict === 'replace' ? p.decision.use : p.decision?.verdict}${p.by ? ` (by ${p.by})` : ''}${p.note ? `: "${String(p.note).slice(0, 200)}"` : ''}`));
  const rejected = readProposals(snap.dataDir).filter(p => p.status === 'rejected').slice(-5);
  if (rejected.length) lines.push('', '## Proposals people rejected (do not repeat them without new evidence)', '', ...rejected.map(p => `- ${p.title}${p.result ? `: "${String(p.result).slice(0, 200)}"` : ''}`));
  if (comp) { const g = guidelines(comp); if (g.text) lines.push('', `## Usage guidelines for ${comp} (${g.path})`, '', g.text.slice(0, 3000)); }
  return lines;
}

/**
 * The evidence a thread rests on, as a short fingerprint. A newer scan that changes it makes the
 * thread Out of date (stage 6); one that leaves it alone does not.
 */
export function evidenceOf(snap: Snapshot, s: Subject): string {
  const l = legacyOf(s);
  const comp = componentOf(snap, s);
  let basis: unknown;
  if (l?.kind === 'queue') { const q = snap.queue.find((x: any) => x.id === l.id); basis = q ? [q.status, q.evidence, (q.places ?? []).map((p: any) => `${p.file}:${p.line}`)] : null; }
  else if (l?.kind === 'review') basis = l.ids.map(id => { const e = snap.evals.find((x: any) => x.id === id); return e ? [e.id, e.use, e.verdict, Math.round(e.confidence * 100), Boolean(e.decided)] : [id, null]; });
  else if (l?.kind === 'readiness') basis = (snap.readiness.find((r: any) => r.subject === l.subject)?.checks ?? []).map((c: any) => [c.id, c.score]);
  else if (comp) basis = snap.evals.filter((e: any) => String(e.use ?? '').toLowerCase() === comp.toLowerCase()).map((e: any) => [e.id, Boolean(e.decided)]);
  else basis = snap.run?.id ?? null;
  return crypto.createHash('sha1').update(JSON.stringify(basis)).digest('hex').slice(0, 12);
}
