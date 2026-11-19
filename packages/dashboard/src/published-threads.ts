import fs from 'node:fs';
import path from 'node:path';

/**
 * Thread history for a published page (redesign stage 9, decision D6: summaries only). A static page
 * can't run an agent, but it can show what each thread was about, where it stands, what the agent
 * proposed and what people decided. Read from the agent's files as `dsa serve` left them; nothing
 * here runs the agent, and full transcripts stay on the machine that ran them.
 */
export interface PublishedThread {
  anchor: string;
  title: string;
  state: string;
  updatedAt: string;
  turns: number;
  openProposals: number;
  pr: { url: string; number?: number } | null;
  asked: string | null;
  answer: string | null;
  proposals: { id: string; kind: string; title: string; status: string }[];
  /** What the conversation is about: its issues (with their apps), for chips and for finding it. */
  about?: { key?: string; label: string; app?: string }[];
}

/** The chips for a conversation's subject (the dashboard's agent/history.tsx aboutOf, for what a summary needs). */
function aboutOf(s: any): { key?: string; label: string; app?: string }[] | undefined {
  if (s?.kind === 'set') return (s.items ?? []).map((i: any) => ({ key: String(i.key), label: String(i.title ?? i.key), ...(i.app ? { app: String(i.app) } : {}) }));
  if (s?.kind === 'issue') return [{ key: String(s.key), label: String(s.title ?? s.key) }];
  if (s?.kind === 'queue') return [{ key: String(s.id), label: String(s.id) }];
  return undefined;
}

const firstPara = (t: unknown) => String(t ?? '').trim().split(/\n\s*\n/)[0] ?? '';
const clip = (t: unknown, n: number) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s ? (s.length > n ? s.slice(0, n).trimEnd() + '…' : s) : null; };

export function readPublishedThreads(dataDir: string): Record<string, PublishedThread> {
  const dir = path.join(dataDir, 'agent');
  let index: Record<string, any> = {};
  try { index = JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8')).threads ?? {}; } catch { return {}; }
  const proposals = new Map<string, any>();
  try {
    for (const line of fs.readFileSync(path.join(dir, 'proposals.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.type === 'status') { const p = proposals.get(r.id); if (p) p.status = r.status; } else proposals.set(r.id, { ...r }); } catch { /* a torn line */ }
    }
  } catch { /* none yet */ }
  const out: Record<string, PublishedThread> = {};
  for (const [anchor, t] of Object.entries(index)) {
    if (!t?.turns) continue;
    let s: any = null;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${String(t.session).replace(/[^\w-]/g, '')}.json`), 'utf8')); } catch { /* the session was deleted */ }
    const msgs: any[] = s?.messages ?? [];
    out[anchor] = {
      anchor, title: String(t.title ?? ''), state: String(t.state ?? 'settled'), updatedAt: String(t.updatedAt ?? ''), turns: Number(t.turns) || msgs.length,
      openProposals: Number(t.openProposals) || 0, pr: t.pr ?? null,
      // A summary, not the transcript (decision D6; code review B, C, UX C): the first paragraph, kept short.
      asked: clip(firstPara(msgs.find(m => m.role === 'user')?.text), 240),
      answer: clip(firstPara([...msgs].reverse().find(m => m.role === 'assistant' && m.text)?.text), 280),
      proposals: [...proposals.values()].filter(p => p.session === t.session).map(p => ({ id: p.id, kind: p.kind, title: clip(p.title, 160) ?? '', status: p.status ?? 'open' })),
      ...(aboutOf(s?.subject) ? { about: aboutOf(s?.subject) } : {}),
    };
  }
  return out;
}
