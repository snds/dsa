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
}

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
      asked: clip(msgs.find(m => m.role === 'user')?.text, 400),
      answer: clip([...msgs].reverse().find(m => m.role === 'assistant' && m.text)?.text, 900),
      proposals: [...proposals.values()].filter(p => p.session === t.session).map(p => ({ id: p.id, kind: p.kind, title: clip(p.title, 160) ?? '', status: p.status ?? 'open' })),
    };
  }
  return out;
}
