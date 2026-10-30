import fs from 'node:fs';
import path from 'node:path';
import { label, tools } from './system.js';

import { agentDir, type Snapshot } from './snapshot.js';

/**
 * What a session is about, and the brief an agent gets before the first message: the scan's evidence
 * for that subject, the design system's entries for every component in play, and the intent behind the
 * rules. The brief is a file the agent reads (and the MCP server serves), so a handoff to Cursor or a
 * terminal session starts from the same facts as a chat in the dashboard.
 */
export type Subject =
  | { kind: 'review'; ids: string[]; title?: string; pattern?: string | null }
  | { kind: 'queue'; id: string }
  | { kind: 'readiness'; subject: string }
  | { kind: 'scan' };

export interface Brief { key: string; title: string; markdown: string; file: string; starters: Starter[]; repo: { name: string; dir: string }; ids: string[] }
export interface Starter { label: string; prompt: string; mode?: 'try' }

/** The counterpart the designer works with. Kept short: the brief and the tools carry the facts. */
export const PERSONA = `You are the senior design-system engineer on this team, working beside a designer in the dsa dashboard.
The designer may be new to agents and to code. They need answers they can rely on to make a decision.

How you work:
- Plain language. Answer first, one idea per sentence, ordinary words; explain a term the first time you use it.
- Evidence before opinion. Read the brief, then check with the tools before you claim anything: view_screenshot before a visual claim, get_element for the code, component_signature and the design system's own tools (when it has them) before naming a component, prop, variant or token. Never invent one.
- Cite what you looked at: element ids, file:line, the screenshot, the design system's docs.
- Give a recommendation with a confidence (high / medium / low) and say what would change your mind.
- You never decide. You propose: propose_decision, propose_policy, propose_hint (teach the scanner), propose_scanner_note (a bug or idea for the scanner's code), propose_issue. The designer accepts or rejects each one in the dashboard.
- A proposal names components the design system really has, with props from its variants. check_file must pass on any code you write.
- In a sandbox session you may edit files; the sandbox is a throwaway copy of the repo. Keep changes small and say what you changed. Nothing reaches the real repo unless the designer keeps it.
- If the scanner's pick is wrong because of how it reads the page (placement, labels, handlers), say so and propose a hint, so the next scan gets it right without a human.
- When you do not know, say so and say how to find out.`;

const pct = (n: number) => `${Math.round(n * 100)}%`;
const desc = (r: any) => (r.verdict === 'replace' ? `${r.use}${Object.entries(r.props ?? {}).map(([k, v]) => ` ${k}="${v}"`).join('')}` : r.verdict === 'gap' ? `system gap${r.gap ? ` (${r.gap})` : ''}` : r.verdict);
const effective = (e: any) => e.decided?.decision ?? e;

/** The system's entry for a component (import, variants, docs), from the profile; null when it has none. */
export function componentEntry(name: string): any | null {
  try { return tools().component?.(name) ?? null; } catch { return null; }
}
function componentBlock(name: string): string {
  const c = componentEntry(name);
  if (!c) return `- **${name}**: not in the design system's component list. Check its signature (component_signature) before using it.`;
  const v = Object.entries<string[]>(c.variants ?? {}).map(([k, vals]) => `${k}: ${vals.join(' | ')}`).join('; ');
  return `- **${name}** — \`import { ${name} } from "${c.import}"\`${c.docs?.description ? `. ${c.docs.description}` : ''}${v ? `\n  - ${v}` : ''}${c.docs?.path ? `\n  - Docs: ${c.docs.path}` : ''}`;
}

export function subjectKey(s: Subject): string {
  if (s.kind === 'review') return `review-${s.ids.length === 1 ? s.ids[0] : `${s.ids[0]}+${s.ids.length - 1}`}`;
  if (s.kind === 'queue') return `queue-${s.id}`;
  if (s.kind === 'readiness') return `readiness-${s.subject.replace(/[^\w.-]+/g, '-')}`;
  return 'scan';
}

/** The repo a session's sandbox copies: the app the elements live in, the finding's owner, or the core. */
export function repoFor(snap: Snapshot, s: Subject): { name: string; dir: string } {
  const core = { name: snap.targets.find(t => t.role === 'core')?.name ?? path.basename(snap.root), dir: snap.root };
  const byName = (n?: string) => { const t = snap.targets.find(x => x.name === n); return t ? { name: t.name, dir: t.dir } : null; };
  if (s.kind === 'review') return byName(snap.evals.find(e => e.id === s.ids[0])?.target) ?? core;
  if (s.kind === 'queue') { const i = snap.queue.find(q => q.id === s.id); return byName(i?.target) ?? byName(i?.affected?.[0]) ?? byName(i?.owner) ?? core; }
  if (s.kind === 'readiness') return byName(s.subject) ?? core;
  return core;
}

export function buildBrief(snap: Snapshot, s: Subject): Brief {
  const key = subjectKey(s);
  const repo = repoFor(snap, s);
  const head = [`# Brief: ${titleOf(snap, s)}`, '', `Scan of **${snap.title}**${snap.run ? `, run ${snap.run.id} (${snap.run.takenAt})` : ''}. Review threshold ${pct(snap.threshold)}: below it, a human decides.`, `Repo for this session: ${repo.name} (${repo.dir}).`, ''];
  const body = s.kind === 'review' ? reviewBody(snap, s) : s.kind === 'queue' ? queueBody(snap, s) : s.kind === 'readiness' ? readinessBody(snap, s) : scanBody(snap);
  const markdown = [...head, ...body.lines, '', ...intent(snap, repo), '', toolsSection()].join('\n');
  const dir = path.join(agentDir(snap.dataDir), 'context');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}.md`);
  fs.writeFileSync(file, markdown);
  return { key, title: titleOf(snap, s), markdown, file, starters: body.starters, repo, ids: body.ids };
}

export function titleOf(snap: Snapshot, s: Subject): string {
  if (s.kind === 'review') {
    if (s.title) return s.title;
    const e = snap.evals.find(x => x.id === s.ids[0]);
    return e ? `<${e.element}> ×${s.ids.length} → ${desc(effective(e))}` : `${s.ids.length} elements`;
  }
  if (s.kind === 'queue') return snap.queue.find(q => q.id === s.id)?.title ?? s.id;
  if (s.kind === 'readiness') return `Agent readiness: ${s.subject}`;
  return `The ${snap.title} scan`;
}

function reviewBody(snap: Snapshot, s: Extract<Subject, { kind: 'review' }>) {
  const items = s.ids.map(id => snap.evals.find(e => e.id === id)).filter(Boolean) as any[];
  const lines: string[] = [];
  const starters: Starter[] = [];
  if (!items.length) return { lines: ['No elements with those ids in the latest scan. Re-run the scan, then start again.'], starters, ids: [] };
  const rec = effective(items[0]);
  const lo = Math.min(...items.map(e => e.confidence)), hi = Math.max(...items.map(e => e.confidence));
  const ask = items.some(e => e.needsHuman && !e.decided);
  lines.push('## The change', '', `\`<${items[0].element}>\` ×${items.length} in ${new Set(items.map(e => e.file)).size} file(s) → **${desc(rec)}**${rec.from ? ` from ${rec.from}` : ''}.`,
    `Confidence ${lo === hi ? pct(lo) : `${pct(lo)}–${pct(hi)}`}. ${items[0].decided ? `Decided by ${items[0].decided.by}${items[0].decided.who ? ` (${items[0].decided.who})` : ''}: ${desc(items[0].decided.decision)}.` : ask ? 'Below the threshold: it needs a human decision.' : 'At or above the threshold: ready to migrate.'}`);
  if (s.pattern) lines.push(`Shared style: \`${s.pattern}\` (one decision can cover every element styled by it: a policy).`);
  const regionCount = new Map<string, number>();
  for (const e of items) for (const r of new Set<string>(e.regions ?? [])) regionCount.set(r, (regionCount.get(r) ?? 0) + 1);
  const regions = [...regionCount].sort((a, b) => b[1] - a[1]).filter(([, n]) => n * 2 >= items.length).map(([r]) => r);
  if (regionCount.size) lines.push(`Where they sit: ${[...regionCount].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} (${n} of ${items.length})`).join(', ')}${items.length > 1 && !regions.length ? '. No single place holds most of them' : ''}.`);
  lines.push('', '## How the scanner made the pick', '', ...items[0].reasons.map((r: any) => `- ${r.text}${r.delta ? ` (${r.delta > 0 ? '+' : ''}${Math.round(r.delta * 100)})` : ''}`));
  if (items[0].alternatives?.length) lines.push('', `Alternatives: ${items[0].alternatives.slice(0, 4).map((a: any) => `${desc(a)} (${pct(a.confidence)})`).join(' · ')}`);
  if (items[0].signature) lines.push(`Closest signature: ${items[0].signature.component} ${items[0].signature.variant}/${items[0].signature.size}, parity ${pct(items[0].signature.score)}. Differences: ${items[0].signature.mismatched.slice(0, 6).join('; ') || 'none'}.`);
  if (items.some(e => e.hints?.length)) lines.push(`Scanner hints applied: ${[...new Set(items.flatMap(e => e.hints ?? []))].join(', ')}.`);
  lines.push('', '## The elements (grouped by look: same classes render the same)', '');
  const looks = new Map<string, any[]>();
  for (const e of items) { const k = e.styleSig ?? e.styleKey ?? e.id; looks.set(k, [...(looks.get(k) ?? []), e]); }
  let n = 0;
  for (const [, list] of looks) {
    if (++n > 8) { lines.push(`…and ${looks.size - 8} more looks. Use get_element for any id.`); break; }
    const shot = list.map(e => ({ e, s: snap.shots[e.id] })).find(x => x.s);
    lines.push(`### Look ${n}: ${list.length} element(s)`, `- Ids: ${list.slice(0, 12).map(e => e.id).join(', ')}${list.length > 12 ? ` …+${list.length - 12}` : ''}`,
      `- Where: ${list.slice(0, 4).map(e => `${e.file}:${e.line}`).join(', ')}${list.length > 4 ? ' …' : ''}`,
      shot ? `- Screenshot: ${shot.e.id} on ${shot.s!.page ?? 'a page'}${shot.s!.revealedBy ? ` after ${shot.s!.revealedBy}` : ''} (view_screenshot "${shot.e.id}")${(shot.s!.match ?? 1) < 0.7 ? `. Match only ${pct(shot.s!.match ?? 0)}: the outline may be on a similar element, so check it shows this one` : ''}` : `- No screenshot${list.some(e => snap.missingShots.includes(e.id)) ? ': the crawler could not reach it' : ''}.`,
      '', '```tsx', String(list[0].source ?? list[0].snippet ?? '').slice(0, 900), '```', '');
  }
  const comps = [...new Set([rec.use, ...items[0].alternatives?.map((a: any) => a.use) ?? []].filter(Boolean))].slice(0, 5) as string[];
  lines.push('## Design-system entries in play', '', ...comps.map(componentBlock));

  const alt = items[0].alternatives?.filter((a: any) => a.use && a.use !== rec.use).slice(0, 2) ?? [];
  starters.push({ label: 'Walk me through it', prompt: 'Walk me through this change in plain terms. What would a person using the app notice, and what stays the same?' });
  if (ask) starters.push({ label: 'Why is this a question?', prompt: 'Why did the scanner stop short of a confident answer here? What evidence would settle it? Check the screenshot and the code.' });
  for (const r of regions.filter(r => ['sidebar', 'nav', 'toolbar', 'dialog', 'menu', 'table', 'header'].includes(r)).slice(0, 1)) starters.push({ label: `Right for a ${r}?`, prompt: `These sit in a ${r}. Is ${rec.use ?? 'this'} the right component there? Look at the screenshot and the design system's guidance for that pattern before you answer.` });
  if (alt.length) starters.push({ label: `Compare with ${alt.map((a: any) => a.use).join(' / ')}`, prompt: `Compare ${rec.use} with ${alt.map((a: any) => desc(a)).join(' and ')}. Which fits the screenshot, the behavior in the code, and the design system's intent? Give me your pick and confidence.` });
  if (!items.some(e => snap.shots[e.id])) starters.push({ label: 'No screenshot: read the code', prompt: "There's no screenshot for these. From the code, how do they look and behave? Tell me what you're unsure of." });
  if (items.length > 1 && (s.pattern || looks.size === 1)) starters.push({ label: 'One decision for all?', prompt: `Should all ${items.length} share one decision${s.pattern ? ` (a policy on ${s.pattern})` : ''}? Check a few of them for exceptions first.` });
  starters.push({ label: 'Propose a decision', prompt: 'Propose the decision you would make, with your confidence and the evidence. Use propose_decision (or propose_policy if one rule should cover them all).' });
  starters.push({ label: 'Teach the scanner', prompt: 'If the scanner read these wrong, tell me what it missed and propose a scanner hint so it gets this right next time. If it was right, say so.' });
  starters.push({ label: 'Try it in the sandbox', prompt: `Make this change in the sandbox for ${Math.min(items.length, 3)} of the elements, run check_file on what you touched, and show me the result.`, mode: 'try' });
  return { lines, starters, ids: items.map(e => e.id) };
}

function queueBody(snap: Snapshot, s: Extract<Subject, { kind: 'queue' }>) {
  const i = snap.queue.find(q => q.id === s.id);
  if (!i) return { lines: ['That queue item is not in the latest scan.'], starters: [], ids: [] };
  const lines = ['## The queue item', '', `**${i.title}** (${i.kind === 'finding' ? `finding, ${i.severity}, score ${Math.round(i.score)}` : 'review approval'}). Routed to ${i.owner}${i.repo ? ` (${i.repo})` : ''}.`];
  if (i.why) lines.push(`Why them: ${i.why}`);
  if (i.evidence) lines.push(`Evidence: ${i.evidence}`);
  if (i.fix) lines.push(`Suggested fix: ${i.fix}`);
  if (i.exit) lines.push(`Done when: ${i.exit}`);
  if (i.decision) lines.push(`Approved decision: ${desc(i.decision)}${i.from ? ` from ${i.from}` : ''}.`);
  if (i.ids?.length) lines.push(`Elements: ${i.ids.slice(0, 30).join(', ')}${i.ids.length > 30 ? ' …' : ''} (get_element for any).`);
  if (i.issue?.body) lines.push('', '## Drafted issue', '', i.issue.title, '', i.issue.body.slice(0, 4000));
  if (i.decision?.use) lines.push('', '## Design-system entry', '', componentBlock(i.decision.use));
  const starters: Starter[] = i.kind === 'finding' ? [
    { label: 'Explain it', prompt: 'Explain this finding in plain terms: what is wrong, why it matters, and who should act on it.' },
    { label: 'Cheapest correct fix', prompt: "What's the cheapest correct fix? Name the files and the change, and what could go wrong." },
    { label: 'False positive?', prompt: 'Could this be the scanner being wrong? Check the evidence against the code. If it is, propose a scanner note or hint.' },
    { label: 'Draft the fix', prompt: 'Draft the fix in the sandbox, run check_file on what you touched, and summarize the diff.', mode: 'try' },
    { label: 'Draft the issue', prompt: 'Write the GitHub issue the owner should get: plain title, what to change, how to verify. Use propose_issue.' },
  ] : [
    { label: 'Check the approved change', prompt: 'Check the approved decision against every element: does it fit each one, or are there exceptions to call out?' },
    { label: 'Apply it in the sandbox', prompt: 'Apply the approved change in the sandbox, run check_file on each file, and summarize the diff and anything you had to judge.', mode: 'try' },
  ];
  return { lines, starters, ids: i.ids ?? [] };
}

function readinessBody(snap: Snapshot, s: Extract<Subject, { kind: 'readiness' }>) {
  const r = snap.readiness.find(x => x.subject === s.subject);
  if (!r) return { lines: ['No readiness data for that repo in the latest scan.'], starters: [], ids: [] };
  const lines = ['## Agent readiness', '', `${r.subject}: ${r.score}/100 (${r.tier}; best seen ${r.bestTier}). Agent kit ${r.kit ? 'installed' : 'missing'}.`, '', ...r.checks.map((c: any) => `- **${c.title}** ${c.score}/100 (weight ${c.weight}): ${c.evidence.join('; ')}${c.fixes.length ? `\n  - Fix: ${c.fixes.join(' · ')}` : ''}`)];
  if (r.usage) lines.push('', '## The usage checker', '', `${r.usage.errors} errors in ${r.usage.files - r.usage.clean} of ${r.usage.files} files. By kind: ${Object.entries(r.usage.byRule).sort((a: any, b: any) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}.`, `Worst files: ${r.usage.byFile.slice(0, 8).map((f: any) => `${f.file} (${f.errors})`).join(', ')}.`);
  if (r.reconcile) lines.push('', `Against the scan: ${r.reconcile.note}`);
  return { lines, ids: [], starters: [
    { label: 'Biggest lift', prompt: "What would raise this repo's agent readiness the most, for the least work? Order the steps." },
    { label: 'Walk the errors', prompt: 'Walk me through the usage checker\'s errors by kind: what each means, an example, and the fix.' },
    { label: 'Why the counts differ', prompt: "Explain why the usage checker's raw-element count and the scan's look-alike count differ, using the numbers in the brief." },
  ] as Starter[] };
}

function scanBody(snap: Snapshot) {
  const open = snap.queue.filter(q => q.status === 'open');
  const qs = snap.evals.filter(e => e.needsHuman && !e.decided && !e.exception);
  const lines = ['## The scan at a glance', '', `${snap.evals.length} native elements evaluated; ${qs.length} need a human; ${snap.evals.filter(e => e.decided).length} decided.`,
    `${open.length} open queue items: ${open.slice(0, 8).map(q => `${q.id} ${q.title}`).join(' · ')}${open.length > 8 ? ' …' : ''}`,
    `Screenshots: ${Object.keys(snap.shots).length}; not reached: ${snap.missingShots.length}.`,
    ...snap.readiness.map(r => `Agent readiness, ${r.subject}: ${r.score}/100 (${r.tier}).`),
    `Scanner hints in force: ${snap.hints.length}.`];
  return { lines, ids: [], starters: [
    { label: 'Tour this scan', prompt: 'Give me a tour of this scan: what matters most this week, and what can wait?' },
    { label: 'Quickest questions', prompt: 'Which review questions could I answer fastest with your help? List five with your recommended answer.' },
    { label: 'Where is the scanner weak?', prompt: 'Where is the scanner least reliable right now? Look at low-confidence groups and repeated close calls, and propose hints where they are justified.' },
  ] as Starter[] };
}

/** The why behind the rules: pointers, not copies, so the agent reads the current text. */
function intent(snap: Snapshot, repo: { dir: string }): string[] {
  void snap;
  const hostAgents = ['AGENTS.md'].map(f => path.join(repo.dir, f)).filter(f => fs.existsSync(f));
  let system: string[] = [];
  try { system = tools().intent?.(repo.dir) ?? []; } catch { /* the profile's problem: leave it out */ }
  return ['## Intent: why things are the way they are', '',
    ...system,
    ...hostAgents.map(f => `- Repo rules: ${f}`),
    '- Review rules: decisions live in each app\'s decisions file. A decision covers elements; a policy covers a shared style; a scanner hint (dsa.hints.json) corrects how the scanner reads elements everywhere.',
    '- Below the review threshold an agent may not decide; it proposes and a human accepts.'];
}

function toolsSection(): string {
  const own = tools().tools;
  return ['## Tools', '',
    '- dsa (this scan): get_subject, scan_summary, get_element, find_elements, view_screenshot, component_signature, check_file, and the propose_* tools.',
    ...(own ? [`- ${label()} (the design system): ${own}`] : [])].join('\n');
}
