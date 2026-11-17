import { execFileSync } from 'node:child_process';

import { writeSession, type Session } from './sessions.js';

/**
 * Open a draft pull request from a thread's kept branch (redesign stage 7). It runs only on the
 * person's click, with their own `git` and `gh` sign-in: DSA holds no token. The PR is always a
 * draft, its body says who opened it, links the issue, and summarizes the thread.
 */
export type Run = (cmd: string, args: string[], cwd: string, input?: string) => string;

const realRun: Run = (cmd, args, cwd, input) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', input, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout: 60_000 }).trim();

const errOf = (e: any) => String(e?.stderr || e?.message || e).trim().split('\n').slice(-3).join(' ');

/** Who `gh` is signed in as, or why it can't say. Read before the click so the button can say "Opens as @…". */
export function githubWho(cwd: string, run: Run = realRun): { login: string | null; why?: string } {
  try { return { login: run('gh', ['api', 'user', '--jq', '.login'], cwd) || null }; }
  catch (e: any) {
    if (e?.code === 'ENOENT') return { login: null, why: 'The GitHub CLI (gh) isn\'t installed. Install it and run `gh auth login`.' };
    return { login: null, why: 'gh isn\'t signed in. Run `gh auth login` in a terminal.' };
  }
}

export interface PrContext { issue?: { key: string; title: string; url?: string | null } | null; dashboardUrl?: string | null }

/** The PR's title and body: plain, short, with the issue linked and the thread summarized. */
export function prText(s: Session, login: string, ctx: PrContext = {}): { title: string; body: string } {
  const firstAsk = s.messages.find(m => m.role === 'user')?.text ?? '';
  const lastAnswer = [...s.messages].reverse().find(m => m.role === 'assistant' && m.text)?.text ?? '';
  const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n).trimEnd() + '…' : t);
  const issue = ctx.issue;
  const body = [
    `Opened as a **draft** by @${login} from a DSA agent thread. Review it before marking it ready.`,
    '',
    '## The issue',
    '',
    issue ? `${issue.key}: ${issue.title}${issue.url ? ` (${issue.url})` : ''}` : s.title,
    '',
    '## The thread',
    '',
    firstAsk ? `**Asked:** ${clip(firstAsk, 600)}` : '',
    lastAnswer ? `\n**Last answer:** ${clip(lastAnswer, 1500)}` : '',
    '',
    '## The change',
    '',
    `Branch \`${s.kept?.branch}\`, commit ${s.kept?.commit}. The agent made it in a throwaway copy; a person kept it.`,
    ctx.dashboardUrl ? `\nThread: ${ctx.dashboardUrl}` : '',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  return { title: clip(issue?.title ?? s.title, 120), body };
}

/** Push the kept branch and open the draft. Idempotent: a thread with a PR returns it. */
export function openDraftPr(dataDir: string, s: Session, ctx: PrContext = {}, run: Run = realRun): { url: string; number?: number; login: string } {
  if (!s.kept) throw new Error('Keep the change as a branch first.');
  const who = githubWho(s.repo.top, run);
  if (!who.login) throw new Error(who.why ?? 'gh isn\'t signed in.');
  if (s.pr?.url) return { ...s.pr, login: who.login };
  const { title, body } = prText(s, who.login, ctx);
  try { run('git', ['push', '--set-upstream', 'origin', s.kept.branch], s.repo.top); }
  catch (e) { throw new Error(`Couldn't push ${s.kept.branch}: ${errOf(e)}`); }
  let out: string;
  try { out = run('gh', ['pr', 'create', '--draft', '--head', s.kept.branch, '--title', title, '--body-file', '-'], s.repo.top, body); }
  catch (e) { throw new Error(`The branch is pushed, but the draft PR didn't open: ${errOf(e)}`); }
  const url = out.split('\n').map(l => l.trim()).find(l => /^https:\/\/\S+\/pull\/\d+/.test(l));
  if (!url) throw new Error(`gh didn't return a pull request link: ${out.slice(0, 200)}`);
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1]) || undefined;
  s.pr = { url, number };
  s.updatedAt = new Date().toISOString();
  writeSession(dataDir, s);
  return { url, number, login: who.login };
}
