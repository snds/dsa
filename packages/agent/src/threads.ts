import fs from 'node:fs';
import path from 'node:path';

import type { Subject } from './context.js';
import type { Proposal } from './proposals.js';
import { agentDir } from './snapshot.js';

/**
 * Threads: an agent session pinned to what it is about (docs/redesign/04-pinned-chat.md).
 *
 * Every session has an anchor: an issue, a group of issues, a component, a batch of elements, or the
 * scan. One thread per anchor (decision D3): the newest session on an anchor is its thread, and
 * "New thread" starts a fresh one. A thread's state comes from facts already stored: whether a turn is
 * running, open proposals, the sandbox diff, a kept branch, and a pull request.
 */
export type Anchor =
  | { kind: 'issue'; key: string }
  | { kind: 'group'; by: 'component' | 'app'; value: string }
  | { kind: 'component'; name: string }
  /** An Element Review batch before it is an issue: the same ids always make the same anchor. */
  | { kind: 'elements'; key: string }
  | { kind: 'scan' };

export type ThreadState =
  | 'working'
  | 'waiting-on-you'
  | 'changes-ready'
  | 'on-a-branch'
  | 'in-pr'
  | 'settled'
  | 'out-of-date';

export const STATE_LABEL: Record<ThreadState, string> = {
  working: 'Working', 'waiting-on-you': 'Waiting on you', 'changes-ready': 'Changes ready', 'on-a-branch': 'On a branch',
  'in-pr': 'In PR', settled: 'Settled', 'out-of-date': 'Out of date',
};

const lower = (s: string) => s.trim().toLowerCase();
/**
 * A batch's key: FNV-1a (32-bit) of its sorted, unique ids. Small and the same in the browser, which
 * computes it to find a batch's thread without asking the server.
 */
export function idsKey(ids: string[]): string {
  let h = 0x811c9dc5;
  for (const ch of [...new Set(ids)].sort().join('\n')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'E-' + h.toString(16).toUpperCase().padStart(8, '0');
}

/** The anchor a subject belongs to. Today's subjects map onto it: a queue item is its issue, a review batch its elements. */
export function anchorOf(s: Subject): Anchor {
  switch (s.kind) {
    case 'issue': return { kind: 'issue', key: s.key };
    case 'queue': return { kind: 'issue', key: s.id };
    case 'review': return { kind: 'elements', key: idsKey(s.ids) };
    case 'readiness': return { kind: 'group', by: 'app', value: s.subject };
    case 'component': return { kind: 'component', name: s.name };
    case 'group': return { kind: 'group', by: s.by, value: s.value };
    default: return { kind: 'scan' };
  }
}

/** One string per anchor, for indexes and URLs: issue:F-1A2B3C, group:component:select, component:select, elements:E-…, scan. */
export function anchorKey(a: Anchor): string {
  switch (a.kind) {
    case 'issue': return `issue:${a.key}`;
    case 'group': return `group:${a.by}:${lower(a.value)}`;
    case 'component': return `component:${lower(a.name)}`;
    case 'elements': return `elements:${a.key}`;
    default: return 'scan';
  }
}

/** What a session needs for its state; Session satisfies it (sessions written before threads have no anchor). */
export interface ThreadFacts {
  id: string;
  subject: Subject;
  anchor?: Anchor;
  scanId?: string | null;
  pr?: { url: string; number?: number } | null;
  kept?: { branch: string } | undefined;
  messages?: { role: string; error?: string }[];
  turns?: number;
  updatedAt: string;
  settledAt?: string | null;
}

/**
 * The state, from stored facts, most urgent first:
 * a running turn is Working; a PR is In PR; an open proposal is Waiting on you; a sandbox diff not
 * kept is Changes ready; a kept branch is On a branch; a thread whose evidence changed since (a newer
 * scan, when the caller says so) is Out of date; a thread the person settled, or whose proposals were
 * all answered, is Settled; otherwise the agent has answered and it is Waiting on you.
 */
export function threadState(t: ThreadFacts, f: { running?: boolean; proposals?: Proposal[]; changedFiles?: number; evidenceChanged?: boolean } = {}): ThreadState {
  const mine = (f.proposals ?? []).filter(p => p.session === t.id);
  if (f.running) return 'working';
  if (t.pr) return 'in-pr';
  if (mine.some(p => p.status === 'open')) return 'waiting-on-you';
  if ((f.changedFiles ?? 0) > 0 && !t.kept) return 'changes-ready';
  if (t.kept) return 'on-a-branch';
  if (f.evidenceChanged) return 'out-of-date';
  if (t.settledAt || mine.length) return 'settled';
  return 'waiting-on-you';
}

export interface ThreadEntry {
  anchor: string;
  session: string;
  title: string;
  state: ThreadState;
  updatedAt: string;
  scanId: string | null;
  pr: { url: string; number?: number } | null;
  /** Proposals in this thread still waiting for a person. */
  openProposals: number;
  /** Older sessions on the same anchor, newest first (New thread keeps them). */
  previous: string[];
}

/**
 * The thread for each anchor: the newest session on it. `facts` gives each session's running flag
 * and sandbox diff size (the caller knows them); proposals come from proposals.jsonl.
 */
export function threadIndex(sessions: (ThreadFacts & { title: string })[], proposals: Proposal[], facts: (id: string) => { running?: boolean; changedFiles?: number; evidenceChanged?: boolean } = () => ({})): Record<string, ThreadEntry> {
  const by = new Map<string, (ThreadFacts & { title: string })[]>();
  for (const s of sessions) {
    const k = anchorKey(s.anchor ?? anchorOf(s.subject));
    by.set(k, [...(by.get(k) ?? []), s]);
  }
  const out: Record<string, ThreadEntry> = {};
  for (const [k, list] of by) {
    list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const t = list[0]!;
    out[k] = {
      anchor: k, session: t.id, title: t.title, state: threadState(t, { ...facts(t.id), proposals }), updatedAt: t.updatedAt,
      scanId: t.scanId ?? null, pr: t.pr ?? null, openProposals: proposals.filter(p => p.session === t.id && p.status === 'open').length, previous: list.slice(1).map(s => s.id),
    };
  }
  return out;
}

const indexFile = (dataDir: string) => path.join(agentDir(dataDir), 'threads.json');

/** Write the index (a published page reads it for read-only thread history, stage 9). */
export function writeThreadIndex(dataDir: string, index: Record<string, ThreadEntry>) {
  fs.mkdirSync(agentDir(dataDir), { recursive: true });
  fs.writeFileSync(indexFile(dataDir), JSON.stringify({ $comment: 'One thread per anchor: the newest agent session on it, and its state. Rebuilt by dsa serve.', updatedAt: new Date().toISOString(), threads: index }, null, 2) + '\n');
}

export function readThreadIndex(dataDir: string): Record<string, ThreadEntry> {
  try { return JSON.parse(fs.readFileSync(indexFile(dataDir), 'utf8')).threads ?? {}; } catch { return {}; }
}
