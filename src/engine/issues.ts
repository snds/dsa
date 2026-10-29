import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './paths.js';
import type { Config } from './config.js';
import type { Finding } from './types.js';

/**
 * Issues are rendered from a fixed template (templates/issue.md), never generated text:
 * the same finding always produces the same issue. A hidden marker carries the finding ID,
 * so re-running updates the existing issue instead of filing a duplicate.
 */
const SCOPE_LABEL: Record<string, string> = { core: 'Core', child: 'Child library', consumer: 'Consumer', triage: 'DS triage' };
const SEV_LABEL: Record<string, string> = { crit: 'Critical', serious: 'Serious', warn: 'Warning', watch: 'Watch' };
export const MARKER = (id: string) => `<!-- dsa:finding ${id} -->`;
const MARKER_RE = /<!-- dsa:finding (F-[0-9A-F]{6}) -->/;

export function labelsFor(f: Finding, config: Config): string[] {
  return ['ds-finding', `sev:${f.severity}`, `family:${f.family}`, `scope:${f.scope}`, ...(config.github?.labels ?? [])];
}

export function renderIssue(f: Finding, template = fs.readFileSync(path.join(APP_DIR, 'data', 'templates', 'issue.md'), 'utf8')): { title: string; body: string } {
  const vars: Record<string, string> = {
    id: f.id, title: f.title, owner: f.owner, scopeLabel: SCOPE_LABEL[f.scope] ?? f.scope, severityLabel: SEV_LABEL[f.severity] ?? f.severity,
    score: String(f.score), family: f.family, why: f.why, evidence: f.evidence, rule: f.rule, subject: f.subject,
    affected: f.affected.length ? f.affected.join(', ') : '—', fix: f.fix, exit: f.exit, openedAt: String(f.openedAt).slice(0, 10),
    settings: Object.entries(f.settingsUsed).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', '),
  };
  const filled = template.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => vars[k] ?? '');
  const [first, ...rest] = filled.split('\n') as [string, ...string[]];
  return { title: `[${f.id}] ${first.trim()}`, body: rest.join('\n').trim() + '\n' };
}

/** The findings that get pushed this week: open, by score, capped at the queue budget. */
export function pushedThisWeek(findings: Finding[], budget: number): Finding[] {
  return findings.filter(f => f.status === 'open').sort((a, b) => b.score - a.score).slice(0, budget);
}

export function writeDrafts(findings: Finding[], dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const f of findings) {
    const { title, body } = renderIssue(f);
    const file = path.join(dir, `${f.id}.md`);
    fs.writeFileSync(file, `# ${title}\n\n${body}`);
    written.push(file);
  }
  return written;
}

// ---------- GitHub sync ----------

export type Http = (method: string, url: string, body?: unknown) => Promise<any>;

export function githubHttp(token: string, base = 'https://api.github.com'): Http {
  return async (method, url, body) => {
    const r = await fetch(base + url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) throw new Error(`GitHub ${r.status} ${method} ${url}: ${(await r.text()).slice(0, 300)}`);
    return r.status === 204 ? null : r.json();
  };
}

export interface SyncAction { kind: 'create' | 'update' | 'close' | 'reopen' | 'skip'; id: string; repo?: string | undefined; number?: number | undefined; reason?: string | undefined; title?: string | undefined }

interface ExistingIssue { number: number; state: string; title: string; body: string; html_url: string }

async function existingIssues(http: Http, repo: string): Promise<Map<string, ExistingIssue>> {
  const map = new Map<string, ExistingIssue>();
  for (let page = 1; page < 50; page++) {
    const items: any[] = await http('GET', `/repos/${repo}/issues?labels=ds-finding&state=all&per_page=100&page=${page}`);
    for (const it of items) {
      if (it.pull_request) continue;
      const m = String(it.body ?? '').match(MARKER_RE);
      if (m) map.set(m[1]!, { number: it.number, state: it.state, title: it.title, body: it.body ?? '', html_url: it.html_url });
    }
    if (items.length < 100) break;
  }
  return map;
}

/**
 * Plan (and with apply=true, perform) the GitHub changes for a set of findings.
 * Only `pushed` findings may CREATE new issues (the weekly budget); existing issues are always kept in sync.
 */
export async function syncIssues(findings: Finding[], pushed: Set<string>, config: Config, http: Http | null, apply: boolean): Promise<{ actions: SyncAction[]; urls: Map<string, string> }> {
  const actions: SyncAction[] = [];
  const urls = new Map<string, string>();
  const repoOf = (f: Finding) => f.repo || config.github?.defaultRepo || undefined;
  const repos = [...new Set(findings.map(repoOf).filter(Boolean))] as string[];
  const existing = new Map<string, Map<string, ExistingIssue>>();
  if (http) for (const r of repos) existing.set(r, await existingIssues(http, r));

  for (const f of findings) {
    const repo = repoOf(f);
    if (!repo) { if (f.status === 'open') actions.push({ kind: 'skip', id: f.id, reason: 'no repo: set github.defaultRepo or a repo on the owner' }); continue; }
    const issue = existing.get(repo)?.get(f.id);
    const { title, body } = renderIssue(f);
    if (f.status === 'open') {
      if (!issue) {
        if (!pushed.has(f.id)) { actions.push({ kind: 'skip', id: f.id, repo, reason: 'over this week\'s queue budget' }); continue; }
        actions.push({ kind: 'create', id: f.id, repo, title });
        if (apply && http) { const r = await http('POST', `/repos/${repo}/issues`, { title, body, labels: labelsFor(f, config) }); urls.set(f.id, r.html_url); }
      } else {
        if (issue.state === 'closed') {
          // Closed by a person: the queue treats that as done (and flags it if the scan still sees it), so don't reopen it.
          actions.push({ kind: 'skip', id: f.id, repo, number: issue.number, reason: 'issue closed on GitHub (done in the queue); still detected by the scan' });
        } else if (issue.title !== title || issue.body.trim() !== body.trim()) {
          actions.push({ kind: 'update', id: f.id, repo, number: issue.number, title });
          if (apply && http) await http('PATCH', `/repos/${repo}/issues/${issue.number}`, { title, body, labels: labelsFor(f, config) });
        }
        urls.set(f.id, issue.html_url);
      }
    } else if (f.status === 'resolved' && issue && issue.state === 'open') {
      actions.push({ kind: 'close', id: f.id, repo, number: issue.number, title });
      if (apply && http) {
        await http('POST', `/repos/${repo}/issues/${issue.number}/comments`, { body: `Resolved by scan: ${f.exit}` });
        await http('PATCH', `/repos/${repo}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
      }
    }
  }
  return { actions, urls };
}
