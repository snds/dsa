import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DECISIONS_FILE, openStore, clearMappingCache, effectiveSettings, githubHttp, githubToken, labelsFor, loadCatalog, mapInstance, materializeRemotes, pushedThisWeek, renderIssue, resolveTargets, rowToFinding, targetRelative, type Config, type ElementEval, type Finding, type Http, type Mapping, type Recommendation, type Target } from '@snds/dsa/engine';

/**
 * The Action Queue: every item that needs someone to do something.
 * - Findings: measured problems the scan raises (and resolves) on its own.
 * - Review approvals: element migrations a human approved (or changed and approved) in Element Review.
 *   One item per app and decision, so "these 23 <button>s become Button ghost/sm" is one piece of work.
 * Each item can carry a GitHub issue. Closing the issue marks the item done; a later scan that still
 * sees the problem says so on the completed item instead of quietly reopening it.
 *
 * State the scan doesn't own (issue links, approval memory) lives in <data>/queue.json.
 */

export interface IssueLink {
  repo: string; number: number; url: string;
  state: 'open' | 'closed'; stateReason?: string | null;
  title?: string; assignees?: string[]; comments?: number;
  updatedAt?: string; closedAt?: string | null; syncedAt?: string;
  /** Approvals: the element ids the issue was written for (more approvals later make a new item of work). */
  covers?: string[];
}
interface ApprovalMemo { title: string; target: string; ids: string[]; firstSeen: string; doneAt?: string | null; doneReason?: string | null }
interface QueueState { links: Record<string, IssueLink>; approvals: Record<string, ApprovalMemo>; events: Record<string, { at: string; event: string; detail?: string }[]>; syncedAt?: string | null }

/** This package's folder (templates live beside dist/). */
export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const stateFile = (dataDir: string) => path.join(dataDir, 'queue.json');
export function readState(dataDir: string): QueueState {
  try { const s = JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf8')); return { links: s.links ?? {}, approvals: s.approvals ?? {}, events: s.events ?? {}, syncedAt: s.syncedAt ?? null }; }
  catch { return { links: {}, approvals: {}, events: {}, syncedAt: null }; }
}
function writeState(dataDir: string, s: QueueState) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(stateFile(dataDir), JSON.stringify(s, null, 2) + '\n');
}
const note = (s: QueueState, id: string, event: string, detail?: string) => { (s.events[id] ??= []).push({ at: new Date().toISOString(), event, ...(detail ? { detail } : {}) }); };

export interface Instance { id: string; file: string; line: number; element: string; jsx: string; flags: string[]; status: Mapping['status'] }

export interface QueueItem {
  id: string;
  kind: 'finding' | 'approval';
  title: string;
  owner: string;
  scope: string;
  repo: string | null;
  severity?: string; score?: number; family?: string; pushed?: boolean;
  why: string; evidence: string; fix: string; exit: string;
  affected: string[];
  status: 'open' | 'done';
  doneReason?: string | null;
  doneAt?: string | null;
  /** Done (issue closed by hand) but the last scan still sees it. */
  stillDetected?: boolean;
  /** Approvals added after the linked issue closed: the item is open again for those. */
  newSinceIssue?: number;
  history: { at: string; event: string; detail?: string }[];
  issue: { title: string; body: string };
  link: IssueLink | null;
  // Approvals
  target?: string; ids?: string[]; elements?: string[]; decision?: Recommendation; approvedBy?: string; approvedAt?: string;
  from?: string | null; instances?: Instance[];
}

const SCOPE_LABEL: Record<string, string> = { core: 'Core', child: 'Child library', consumer: 'Consumer', triage: 'DS triage' };
export const APPROVAL_MARKER = (id: string) => `<!-- dsa:approval ${id} -->`;
const ANY_MARKER = /<!-- dsa:(?:finding|approval) ([FA]-[0-9A-F]{6}) -->/;

const propText = (p?: Record<string, string>) => Object.entries(p ?? {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}="${v}"`).join(' ');
const propShort = (p?: Record<string, string>) => Object.values(p ?? {}).filter(Boolean).join(', ');
const decisionKey = (d: Recommendation) => JSON.stringify([d.verdict, d.use ?? '', Object.entries(d.props ?? {}).sort(), d.gap ?? '', d.content ?? null]);
const hashId = (prefix: string, s: string) => `${prefix}-${crypto.createHash('sha1').update(s).digest('hex').slice(0, 6).toUpperCase()}`;

/** Group human-approved migrations into queue items: one per app and decision. */
function approvalGroups(evals: ElementEval[]) {
  const m = new Map<string, { id: string; target: string; decision: Recommendation; items: ElementEval[] }>();
  for (const e of evals) {
    const d = e.decided;
    if (!d || d.by === 'agent' || e.exception) continue;
    if (d.decision.verdict !== 'replace' && d.decision.verdict !== 'gap') continue;
    const key = `${e.target}|${decisionKey(d.decision)}`;
    const g = m.get(key) ?? { id: hashId('A', key), target: e.target, decision: d.decision, items: [] };
    g.items.push(e);
    m.set(key, g);
  }
  return [...m.values()];
}

/** Flags every instance shares are said once; each instance lists only its own. */
function splitFlags(inst: Instance[]) {
  const common = inst.length > 1 ? inst[0].flags.filter(f => inst.every(i => i.flags.includes(f))) : [];
  return { common, own: (i: Instance) => i.flags.filter(f => !common.includes(f)) };
}

function renderApproval(item: QueueItem, template = fs.readFileSync(path.join(PKG_DIR, 'templates', 'approval.md'), 'utf8')): { title: string; body: string } {
  const inst = item.instances ?? [];
  const { common, own } = splitFlags(inst);
  const cap = 40;
  const vars: Record<string, string> = {
    id: item.id, title: item.title, owner: item.owner, scopeLabel: SCOPE_LABEL[item.scope] ?? item.scope,
    approvedBy: item.approvedBy ?? 'a reviewer', approvedAt: item.approvedAt ?? '', count: String(item.ids?.length ?? 0),
    why: item.why, fix: item.fix, exit: item.exit,
    where: (common.length ? `Check on every instance: ${common.join(' ')}\n\n` : '') + inst.map(i => `- \`${i.file}:${i.line}\` <${i.element}>${own(i).length ? ` — check: ${own(i).join(' ')}` : ''}`).join('\n'),
    becomes: inst.slice(0, cap).filter(i => i.jsx).map(i => `**\`${i.file}:${i.line}\`**\n\n\`\`\`tsx\n${i.jsx}\n\`\`\``).join('\n\n') + (inst.length > cap ? `\n\n…and ${inst.length - cap} more; the full list is in the DS queue's agent prompt.` : ''),
  };
  const filled = template.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => vars[k] ?? '');
  const [first, ...rest] = filled.split('\n');
  return { title: `[${item.id}] ${first.trim()}`, body: rest.join('\n').trim() + '\n' };
}

function linkFromUrl(url: string): IssueLink | null {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  return m ? { repo: m[1], number: Number(m[2]), url, state: 'open' } : null;
}

export async function buildQueue(root: string, config: Config, dataDir: string): Promise<{ items: QueueItem[]; prompt: string; github: { token: boolean; defaultRepo: string | null }; syncedAt: string | null }> {
  const st = readState(dataDir);
  let dirty = false;
  const store = await openStore(dataDir, 'queue');
  let findingsRaw: any[] = [], fEvents: any[] = [], evals: ElementEval[] = [], runId: string | null = null, budget = 10;
  try {
    runId = await store.latestRunId();
    findingsRaw = await store.all<any>(`select * from findings where status <> 'resolved' or resolved_at >= now() - interval 30 day order by score desc`);
    if (runId) evals = (await store.all<any>('select data from element_evals where run_id=$1 order by target, file, line', [runId])).map(r => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
    fEvents = await store.all<any>(`select id, ts as at, event, detail from finding_events order by ts`);
    budget = effectiveSettings(loadCatalog(), config, dataDir).weekly_queue_budget;
  } finally { store.close(); }

  let targets: Target[] = [];
  try { targets = resolveTargets(root, materializeRemotes(config, root, dataDir, false, () => {}).config); } catch { /* a missing child path shouldn't break the queue */ }
  const repoFor = (repo?: string | null) => repo || config.github?.defaultRepo || null;
  const items: QueueItem[] = [];

  // ---- findings
  const findings: Finding[] = findingsRaw.map(rowToFinding);
  const pushed = new Set(pushedThisWeek(findings, budget).map(f => f.id));
  for (const f of findings) {
    if (f.rule === 'figma-lookalike' && config.modules?.figma !== true) continue;
    const raw = findingsRaw.find(r => r.id === f.id);
    let link: IssueLink | null = st.links[f.id] ?? null;
    if (!link && raw?.issue_url) { link = linkFromUrl(raw.issue_url); if (link) { st.links[f.id] = link; dirty = true; } }
    const closed = link?.state === 'closed';
    const done = f.status === 'resolved' || closed;
    items.push({
      id: f.id, kind: 'finding', title: f.title, owner: f.owner, scope: f.scope, repo: repoFor(f.repo),
      severity: f.severity, score: f.score, family: f.family, pushed: pushed.has(f.id),
      why: f.why, evidence: f.evidence, fix: f.fix, exit: f.exit, affected: f.affected,
      status: done ? 'done' : 'open',
      doneReason: f.status === 'resolved' ? 'Resolved by scan' : closed ? `Issue #${link!.number} closed` : null,
      doneAt: f.status === 'resolved' ? f.resolvedAt ?? null : closed ? link!.closedAt ?? null : null,
      stillDetected: closed && f.status !== 'resolved',
      history: [
        ...fEvents.filter(e => e.id === f.id).map(e => { const d = typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail; return { at: e.at, event: e.event, ...(d?.reason ? { detail: d.reason } : {}) }; }),
        ...(st.events[f.id] ?? []),
      ],
      issue: renderIssue(f), link,
    });
  }

  // ---- review approvals
  clearMappingCache();
  let comps: any[] = [];
  try { comps = JSON.parse(fs.readFileSync(path.join(dataDir, 'signatures.json'), 'utf8')); } catch { /* none yet */ }
  const coreRepo = config.designSystem.core.repo ?? null;
  const present = new Set(evals.map(e => e.id));
  const seen = new Set<string>();
  for (const g of approvalGroups(evals)) {
    seen.add(g.id);
    const t = targets.find(x => x.name === g.target);
    const d = g.decision;
    const gap = d.verdict === 'gap';
    const els = [...new Set(g.items.map(e => e.element))];
    const tags = els.map(x => `<${x}>`).join(', ');
    const n = g.items.length;
    const title = gap
      ? `System gap: ${d.gap || `no component for ${tags}`} (${n} in ${g.target})`
      : `Replace ${n} raw ${tags} with ${d.use}${propShort(d.props) ? ` (${propShort(d.props)})` : ''} in ${g.target}`;
    const dates = g.items.map(e => e.decided?.date).filter(Boolean).sort() as string[];
    const who = [...new Set(g.items.map(e => e.decided?.who).filter(Boolean))].join(', ') || (g.items.some(e => e.decided?.by === 'policy') ? 'a reviewer (pattern decision)' : 'a reviewer');
    const comp = comps.find(c => c.component === d.use);
    const from = d.from ?? comp?.from ?? g.items[0].from ?? null;
    const instances: Instance[] = gap ? g.items.map(e => ({ id: e.id, file: e.file, line: e.line, element: e.element, jsx: '', flags: [], status: 'clean' as const })) : g.items.map(e => {
      const abs = [path.resolve(root, e.file), ...(t ? [path.join(t.dir, targetRelative(root, e.file, t.dir))] : [])].find(f => fs.existsSync(f)) ?? '';
      const m = mapInstance(e, abs, t?.dir ?? root, d, comp);
      return { id: e.id, file: e.file, line: e.line, element: e.element, jsx: m.jsx, flags: m.flags, status: m.status };
    });
    const check = instances.filter(i => i.status !== 'clean').length;
    const memo = st.approvals[g.id];
    if (!memo) { st.approvals[g.id] = { title, target: g.target, ids: g.items.map(e => e.id), firstSeen: new Date().toISOString() }; note(st, g.id, 'approved', `${n} element${n === 1 ? '' : 's'}`); dirty = true; }
    else if (memo.ids.length !== n || memo.title !== title || memo.doneAt) {
      const added = g.items.filter(e => !memo.ids.includes(e.id)).length;
      if (added) note(st, g.id, 'more approved', `+${added}`);
      st.approvals[g.id] = { ...memo, title, ids: g.items.map(e => e.id), doneAt: null, doneReason: null };
      dirty = true;
    }
    const link: IssueLink | null = st.links[g.id] ?? null;
    const fresh = link?.covers ? g.items.filter(e => !link.covers!.includes(e.id)).length : 0;
    const closed = link?.state === 'closed';
    const done = closed && !fresh;
    const item: QueueItem = {
      id: g.id, kind: 'approval', title, owner: gap ? config.designSystem.core.name : (t?.owner ?? g.target), scope: gap ? 'core' : (t?.role ?? 'consumer'),
      repo: repoFor(gap ? coreRepo : t?.repo),
      why: gap
        ? `A reviewer confirmed that ${n} ${tags} in ${g.target} have no matching component: ${d.gap || 'the system is missing one'}. It's design system work, not a consumer fix.`
        : `A reviewer approved replacing ${n} hand-built ${tags} in ${g.target} with ${d.use}. Until they're swapped, they miss the system's fixes and accessibility work.`,
      evidence: `${n} element${n === 1 ? '' : 's'} in ${new Set(g.items.map(e => e.file)).size} file${new Set(g.items.map(e => e.file)).size === 1 ? '' : 's'}${check ? `; ${check} flagged to check by hand` : ''}. Examples: ${g.items.slice(0, 5).map(e => `${e.file}:${e.line}`).join(', ')}`,
      fix: gap
        ? `Design and add the missing component or variant (${d.gap || 'see the elements'}), then re-review these elements against it.`
        : `Replace each element with \`<${d.use}${propText(d.props) ? ' ' + propText(d.props) : ''}>\`${from ? ` imported from \`${from}\`` : ''}. The JSX for each instance is below: it keeps handlers, aria, data attributes, and layout classes, and drops the visual classes the component now owns. Anything marked "check" needs a look before applying.`,
      exit: gap ? `The component exists and the elements are re-reviewed in Element Review.` : `None of these elements remain as raw ${tags} on the next scan.`,
      affected: [g.target], status: done ? 'done' : 'open', doneReason: done ? `Issue #${link!.number} closed` : null, doneAt: done ? link!.closedAt ?? null : null,
      stillDetected: done, newSinceIssue: closed && fresh ? fresh : undefined,
      history: st.events[g.id] ?? [], issue: { title: '', body: '' }, link,
      target: g.target, ids: g.items.map(e => e.id), elements: els, decision: d, approvedBy: who, approvedAt: dates.at(-1), from, instances,
    };
    item.issue = renderApproval(item);
    items.push(item);
  }
  // Approvals no longer in the scan: migrated (their elements are gone) or withdrawn (undone in review).
  for (const [id, memo] of Object.entries(st.approvals)) {
    if (seen.has(id)) continue;
    if (memo.ids.some(x => present.has(x))) { delete st.approvals[id]; dirty = true; continue; }
    if (!memo.doneAt) { memo.doneAt = new Date().toISOString(); memo.doneReason = 'Migrated: no longer in the code'; note(st, id, 'migrated'); dirty = true; }
    const link: IssueLink | null = st.links[id] ?? null;
    items.push({ id, kind: 'approval', title: memo.title, owner: memo.target, scope: 'consumer', repo: link?.repo ?? null, why: '', evidence: `${memo.ids.length} element(s)`, fix: '', exit: '', affected: [memo.target],
      status: 'done', doneReason: memo.doneReason, doneAt: memo.doneAt, history: st.events[id] ?? [], issue: { title: memo.title, body: '' }, link, target: memo.target, ids: memo.ids });
  }
  if (dirty) writeState(dataDir, st);

  const open = items.filter(i => i.status === 'open');
  return { items, prompt: agentPrompt(open, config.report?.title || config.designSystem?.core?.name || path.basename(root), config.rawElementDecisions ?? DEFAULT_DECISIONS_FILE), github: { token: Boolean(githubToken(dataDir)), defaultRepo: config.github?.defaultRepo ?? null }, syncedAt: st.syncedAt ?? null };
}

/** One prompt an agent can work the whole open queue from: rules first, then every item with what "done" means. */
export function agentPrompt(open: QueueItem[], rootName: string, decisionsFile = DEFAULT_DECISIONS_FILE): string {
  const approvals = open.filter(i => i.kind === 'approval');
  const findings = open.filter(i => i.kind === 'finding').sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (!open.length) return 'The design system queue is empty. Nothing to do.';
  const out: string[] = [];
  out.push(
    `# Design system queue: ${open.length} open item${open.length === 1 ? '' : 's'}`, '',
    `You're working through the open items in the design system queue for ${rootName}. There are two kinds:`,
    `- **Review approvals (A-…)**: a human already decided which design system component replaces a set of hand-built elements. Apply the decision exactly. Don't re-decide it.`,
    `- **Findings (F-…)**: measured problems, routed to an owner, with a suggested fix and a "done when" test.`, '',
    '## Ground rules', '',
    '1. Use the design system\'s real components and tokens. Never hand-build a look-alike or restyle a component with one-off classes.',
    '2. For approvals, use the JSX given for each instance. It keeps handlers, aria, data attributes, and layout classes, and drops the visual classes the component now owns. If an instance is marked "check", read the note; if it still doesn\'t fit, leave that instance as is and say why in your summary. Don\'t improvise a different component.',
    '3. Import from the path given (or the app\'s own ui/ wrapper for that component, if it has one).',
    '4. Don\'t change behavior, copy, or layout beyond what the item asks.',
    `5. Don't edit \`${decisionsFile}\`, \`dsa.config.json\`, or anything under the analytics data folder.`,
    `6. Keep each item to its own commit (or PR), titled with the item id, e.g. "${approvals[0]?.id ?? findings[0]?.id}: …". If the item has an issue, reference it ("Refs #12"); don\'t close it from the commit. A human closes it after review.`,
    '7. After each item, run the app\'s type check and tests. When you\'re done, re-run the scan (`dsa run --no-shots`) and check each item\'s "done when".',
    '8. Finish with a summary: done, skipped (and why), and anything that needs a human.', '',
    `Paths are relative to the root of the ${rootName} repo. Work the approvals first (they\'re decided and mechanical), then the findings by score.`, '',
  );
  if (approvals.length) {
    out.push(`## Review approvals (${approvals.length})`, '');
    for (const a of approvals) {
      out.push(`### ${a.id} · ${a.title}`, '');
      if (a.link) out.push(`Issue: ${a.link.url}`);
      out.push(`Owner: ${a.owner} · Approved by ${a.approvedBy}${a.approvedAt ? ` on ${a.approvedAt}` : ''}`);
      if (a.decision?.verdict === 'replace') out.push(`Decision: \`<${a.decision.use}${propText(a.decision.props) ? ' ' + propText(a.decision.props) : ''}>\`${a.from ? ` from \`${a.from}\`` : ''}`);
      out.push('', a.fix, '', `Done when: ${a.exit}`, '');
      const { common, own } = splitFlags(a.instances ?? []);
      if (common.length) out.push(`Check on every instance: ${common.join(' ')}`, '');
      for (const i of a.instances ?? []) {
        out.push(`- \`${i.file}:${i.line}\` <${i.element}>${own(i).length ? ` — check: ${own(i).join(' ')}` : ''}`);
        if (i.jsx) out.push('', '  ```tsx', ...i.jsx.split('\n').map(l => '  ' + l), '  ```', '');
      }
      out.push('');
    }
  }
  if (findings.length) {
    out.push(`## Findings (${findings.length})`, '');
    for (const f of findings) {
      out.push(`### ${f.id} · ${f.title}`, '');
      if (f.link) out.push(`Issue: ${f.link.url}`);
      out.push(`Owner: ${f.owner} (${SCOPE_LABEL[f.scope] ?? f.scope}) · Severity: ${f.severity} · score ${Math.round(f.score ?? 0)}`, '',
        `Why: ${f.why}`, '', `Evidence: ${f.evidence}`, '', `Suggested fix: ${f.fix}`, '', `Done when: ${f.exit}`, '');
    }
  }
  return out.join('\n');
}

// ---------- GitHub ----------

/** Pull the live state of every linked issue (and adopt issues the CLI filed). At most once a minute unless forced. */
export async function syncLinks(root: string, config: Config, dataDir: string, opts: { force?: boolean; http?: Http } = {}): Promise<{ synced: boolean; error?: string }> {
  const st = readState(dataDir);
  if (!opts.force && st.syncedAt && Date.now() - new Date(st.syncedAt).getTime() < 55_000) return { synced: false };
  const token = githubToken(dataDir);
  if (!token && !opts.http) return { synced: false, error: 'No GitHub token.' };
  const http = opts.http ?? githubHttp(token!);
  const { items } = await buildQueue(root, config, dataDir);
  const repos = new Set<string>([...Object.values(st.links).map(l => l.repo), ...items.map(i => i.repo).filter(Boolean) as string[]]);
  const now = new Date().toISOString();
  const errors: string[] = [];
  for (const repo of repos) {
    for (const label of ['ds-finding', 'ds-approval']) {
      try {
        for (let page = 1; page < 20; page++) {
          const list: any[] = await http('GET', `/repos/${repo}/issues?labels=${label}&state=all&per_page=100&page=${page}`);
          for (const it of list) {
            if (it.pull_request) continue;
            const id = String(it.body ?? '').match(ANY_MARKER)?.[1];
            if (!id) continue;
            const cur = st.links[id];
            // Keep the newest issue for an item (an approval can get a second issue after the first closed).
            if (cur && cur.repo === repo && cur.number > it.number) continue;
            const was = cur?.state;
            st.links[id] = { ...(cur?.number === it.number && cur.repo === repo ? cur : {}), repo, number: it.number, url: it.html_url, state: it.state, stateReason: it.state_reason ?? null,
              title: it.title, assignees: (it.assignees ?? []).map((a: any) => a.login), comments: it.comments ?? 0, updatedAt: it.updated_at, closedAt: it.closed_at ?? null, syncedAt: now };
            if (was && was !== it.state) note(st, id, it.state === 'closed' ? `issue #${it.number} closed` : `issue #${it.number} reopened`);
          }
          if (list.length < 100) break;
        }
      } catch (e: any) { errors.push(String(e.message).split('\n')[0]); }
    }
  }
  st.syncedAt = now;
  writeState(dataDir, st);
  // Keep open issues in step with their item (more approvals, a re-scored finding).
  const fresh = await buildQueue(root, config, dataDir);
  for (const i of fresh.items) {
    const l = i.link;
    if (!l || l.state !== 'open' || i.status !== 'open' || !i.issue.body) continue;
    if (l.title === i.issue.title) continue;
    try {
      await http('PATCH', `/repos/${l.repo}/issues/${l.number}`, { title: i.issue.title, body: i.issue.body });
      const s2 = readState(dataDir);
      s2.links[i.id] = { ...s2.links[i.id], title: i.issue.title, covers: i.ids };
      writeState(dataDir, s2);
    } catch (e: any) { errors.push(String(e.message).split('\n')[0]); }
  }
  return { synced: true, ...(errors.length ? { error: [...new Set(errors)].join(' · ') } : {}) };
}

/** File issues for these items (all open items without an open issue when ids is omitted). */
export async function createIssues(root: string, config: Config, dataDir: string, ids?: string[], opts: { http?: Http } = {}): Promise<{ created: { id: string; url: string }[]; skipped: { id: string; reason: string }[] }> {
  const token = githubToken(dataDir);
  if (!token && !opts.http) throw new Error('Add a GitHub token in Settings first (it needs issues: write on the target repos).');
  const http = opts.http ?? githubHttp(token!);
  const { items } = await buildQueue(root, config, dataDir);
  const want = items.filter(i => i.status === 'open' && (ids ? ids.includes(i.id) : true));
  const created: { id: string; url: string }[] = [], skipped: { id: string; reason: string }[] = [];
  for (const i of want) {
    if (i.link && i.link.state === 'open') { skipped.push({ id: i.id, reason: `already has #${i.link.number}` }); continue; }
    if (!i.repo) { skipped.push({ id: i.id, reason: 'no repo: set github.defaultRepo in Settings, or a repo on the app' }); continue; }
    const labels = i.kind === 'finding'
      ? labelsFor({ severity: i.severity, family: i.family, scope: i.scope } as Finding, config)
      : ['ds-approval', `scope:${i.scope}`, ...(config.github?.labels ?? [])];
    try {
      const r = await http('POST', `/repos/${i.repo}/issues`, { title: i.issue.title, body: i.issue.body, labels });
      const st = readState(dataDir);
      if (st.links[i.id]) note(st, i.id, `issue #${st.links[i.id].number} replaced`, `${i.newSinceIssue ?? 0} new since it closed`);
      st.links[i.id] = { repo: i.repo, number: r.number, url: r.html_url, state: 'open', title: r.title, assignees: [], comments: 0, updatedAt: r.updated_at, closedAt: null, syncedAt: new Date().toISOString(), ...(i.ids ? { covers: i.ids } : {}) };
      note(st, i.id, `issue #${r.number} opened`);
      writeState(dataDir, st);
      if (i.kind === 'finding') {
        const store = await openStore(dataDir, 'queue');
        try { await store.exec('update findings set issue_url=$2 where id=$1', [i.id, r.html_url]); } finally { store.close(); }
      }
      created.push({ id: i.id, url: r.html_url });
    } catch (e: any) { skipped.push({ id: i.id, reason: String(e.message).split('\n')[0] }); }
  }
  return { created, skipped };
}
