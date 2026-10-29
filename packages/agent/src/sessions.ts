import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DSA_CLI, label, tools } from './system.js';

import { agentDir, type Snapshot } from './snapshot.js';
import { buildBrief, PERSONA, type Starter, type Subject } from './context.js';
import { readProposals, type Proposal } from './proposals.js';

import { startTurn, type AgentEvent, type Mode, type ProviderId, type RunningTurn } from './providers.js';

/**
 * A session is one conversation about one subject, with one agent, in one sandbox: a git worktree of
 * the subject's repo at its last commit, outside every repo (~/.cache/dsa/sandboxes). The agent
 * works there, never in the real checkout. Changes reach the real repo only as a local branch, and only
 * when the designer presses Keep; nothing is ever pushed from here.
 */
export interface Msg { role: 'user' | 'assistant'; text: string; at: string; tools?: { name: string; summary: string }[]; error?: string; costUsd?: number; proposals?: string[] }
export interface Session {
  id: string;
  subject: Subject;
  title: string;
  provider: ProviderId;
  model?: string;
  mode: Mode;
  repo: { name: string; dir: string; top: string; sub: string };
  sandbox: string | null;
  brief: string;
  starters: Starter[];
  providerSession?: string;
  messages: Msg[];
  createdAt: string;
  updatedAt: string;
  kept?: { branch: string; commit: string; at: string };
  /** The last before/after screenshot run (visual.ts). */
  visual?: import('./visual.js').VisualRun;
}

const dir = (dataDir: string) => path.join(agentDir(dataDir), 'sessions');
const fileOf = (dataDir: string, id: string) => path.join(dir(dataDir), `${id.replace(/[^\w-]/g, '')}.json`);
export const SANDBOXES = path.join(os.homedir(), '.cache', 'dsa', 'sandboxes');

export function readSession(dataDir: string, id: string): Session | null {
  try { return JSON.parse(fs.readFileSync(fileOf(dataDir, id), 'utf8')); } catch { return null; }
}
export function writeSession(dataDir: string, s: Session) {
  fs.mkdirSync(dir(dataDir), { recursive: true });
  s.updatedAt = new Date().toISOString();
  fs.writeFileSync(fileOf(dataDir, s.id), JSON.stringify(s, null, 2));
}
export function listSessions(dataDir: string): Omit<Session, 'messages' | 'brief'>[] {
  try {
    return fs.readdirSync(dir(dataDir)).filter(f => f.endsWith('.json') && !f.endsWith('.mcp.json')).map(f => { try { const { messages, brief, ...rest } = JSON.parse(fs.readFileSync(path.join(dir(dataDir), f), 'utf8')); return { ...rest, turns: messages.length }; } catch { return null; } })
      .filter(Boolean).sort((a: any, b: any) => String(b.updatedAt).localeCompare(String(a.updatedAt))) as any;
  } catch { return []; }
}

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function createSession(snap: Snapshot, subject: Subject, opts: { provider: ProviderId; model?: string; mode: Mode }): Session {
  const brief = buildBrief(snap, subject);
  let top = brief.repo.dir;
  try { top = git(brief.repo.dir, ['rev-parse', '--show-toplevel']); } catch { /* not a git repo: no sandbox */ }
  const s: Session = {
    id: 'S-' + crypto.randomBytes(4).toString('hex'), subject, title: brief.title, provider: opts.provider, model: opts.model, mode: opts.mode,
    repo: { name: brief.repo.name, dir: brief.repo.dir, top, sub: path.relative(top, brief.repo.dir) }, sandbox: null,
    brief: brief.file, starters: brief.starters, messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  writeSession(snap.dataDir, s);
  return s;
}

/** The sandbox: a detached worktree at HEAD, with the repo's installed dependencies linked in (read-only use). */
export function ensureSandbox(dataDir: string, s: Session): string {
  if (s.sandbox && fs.existsSync(s.sandbox)) return s.sandbox;
  const sb = path.join(SANDBOXES, s.id);
  fs.mkdirSync(SANDBOXES, { recursive: true });
  addWorktree(s, sb, 'HEAD');
  s.sandbox = sb;
  writeSession(dataDir, s);
  return sb;
}

/** A detached worktree of the session's repo at `ref`, with the repo's installed dependencies linked in. */
export function addWorktree(s: Session, at: string, ref: string) {
  try { git(s.repo.top, ['worktree', 'add', '--detach', at, ref]); }
  catch (e: any) { throw new Error(`Couldn't make a sandbox copy of ${s.repo.name}: ${String(e.stderr ?? e.message).split('\n')[0]}`); }
  for (const link of depLinks()) {
    const from = path.join(s.repo.top, link), to = path.join(at, link);
    if (fs.existsSync(from) && !fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.symlinkSync(fs.realpathSync(from), to); }
  }
}
/** Installed dependencies the sandbox links to the real checkout: node_modules and the profile's sandboxLinks (a vendored copy of the system). */
export const depLinks = () => ['node_modules', ...(tools().sandboxLinks ?? [])];
/** Where the before/after run keeps the sandbox's starting point and the dev servers' caches. */
export const baseOf = (s: Session) => path.join(SANDBOXES, `${s.id}-base`);
export const VITE_WRAPPER = '.dsa-visual.vite.config.mjs';

const ours = () => [VITE_WRAPPER, ...depLinks().map(l => l.split(path.sep).join('/')), '.cursor/mcp.json', '.cursor/rules/dsa-counterpart.mdc'];

/**
 * Pathspecs that keep our own files (linked dependencies, agent config) out of the diff and a kept branch.
 * `git add` refuses a pathspec that names an ignored path ("paths are ignored"), and many repos ignore
 * node_modules and vendor/, so those are left out: an ignored path is out of the diff anyway.
 */
export function excludes(cwd: string): string[] {
  let out = '';
  const OURS = ours();
  try { out = execFileSync('git', ['-C', cwd, 'check-ignore', '--', ...OURS], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e: any) { out = String(e.stdout ?? ''); /* exit 1: none ignored */ }
  const ignored = new Set(out.split('\n').filter(Boolean));
  // The Vite wrapper sits next to the app's config, at any depth.
  return OURS.filter(p => !ignored.has(p)).map(p => (p === VITE_WRAPPER ? `:(exclude,glob)**/${p}` : `:(exclude)${p}`));
}

/** Files the agent changed in the sandbox, and the diff (capped). */
export function sandboxChanges(s: Session): { files: { file: string; status: string }[]; stat: string; diff: string } | null {
  if (!s.sandbox || !fs.existsSync(s.sandbox)) return null;
  const EXCLUDE = excludes(s.sandbox);
  try {
    // -z keeps each entry whole (a trimmed porcelain line would lose its leading status space).
    const raw = execFileSync('git', ['-C', s.sandbox, 'status', '--porcelain', '-z', '--', '.', ...EXCLUDE], { encoding: 'utf8' });
    const files = raw.split('\0').filter(Boolean).map(l => ({ status: l.slice(0, 2).trim(), file: l.slice(3) }));
    if (!files.length) return { files: [], stat: '', diff: '' };
    git(s.sandbox, ['add', '--intent-to-add', '-A', '--', '.', ...EXCLUDE]);
    return { files, stat: git(s.sandbox, ['diff', '--stat', '--', '.', ...EXCLUDE]), diff: git(s.sandbox, ['diff', '--', '.', ...EXCLUDE]).slice(0, 200_000) };
  } catch { return null; }
}

/** Keep: commit the sandbox's changes on a new local branch in the real repo. Never pushes. */
export function keepChanges(dataDir: string, s: Session, message?: string): { branch: string; commit: string } {
  if (!s.sandbox) throw new Error('This session has no sandbox.');
  const ch = sandboxChanges(s);
  if (!ch?.files.length) throw new Error('There are no changes to keep.');
  const slug = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'changes';
  let branch = `dsa-agent/${slug}`;
  for (let i = 2; (() => { try { git(s.repo.top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch { return false; } })(); i++) branch = `dsa-agent/${slug}-${i}`;
  const EXCLUDE = excludes(s.sandbox);
  git(s.sandbox, ['switch', '-c', branch]);
  git(s.sandbox, ['add', '-A', '--', '.', ...EXCLUDE]);
  git(s.sandbox, ['commit', '-m', message?.trim() || `${s.title}\n\nDrafted with an agent in the dsa dashboard (session ${s.id}); reviewed by a human before merge.`]);
  const commit = git(s.sandbox, ['rev-parse', '--short', 'HEAD']);
  s.kept = { branch, commit, at: new Date().toISOString() };
  writeSession(dataDir, s);
  return { branch, commit };
}

/** Throw the sandbox away (the kept branch, if any, stays), with the before/after copy, caches, and pictures. */
export function discardSandbox(dataDir: string, s: Session) {
  const base = baseOf(s);
  for (const wt of [s.sandbox, fs.existsSync(base) ? base : null]) {
    if (!wt) continue;
    try { git(s.repo.top, ['worktree', 'remove', '--force', wt]); } catch { fs.rmSync(wt, { recursive: true, force: true }); try { git(s.repo.top, ['worktree', 'prune']); } catch { /* gone */ } }
  }
  for (const side of ['before', 'after']) fs.rmSync(path.join(SANDBOXES, `${s.id}-vite-${side}`), { recursive: true, force: true });
  fs.rmSync(path.join(agentDir(dataDir), 'visual', s.id.replace(/[^\w-]/g, '')), { recursive: true, force: true });
  s.sandbox = null;
  delete s.visual;
  writeSession(dataDir, s);
}

export function deleteSession(dataDir: string, id: string) {
  const s = readSession(dataDir, id);
  if (!s) return;
  discardSandbox(dataDir, s);
  for (const f of [fileOf(dataDir, id), fileOf(dataDir, id).replace(/\.json$/, '.mcp.json')]) fs.rmSync(f, { force: true });
}

/**
 * MCP servers for the session's agent: this scan (dsa) and the design system's own server when the
 * profile names one, both pointed at the sandbox. `args` reproduce the run context (contextArgs).
 */
export function mcpConfig(dataDir: string, args: string[], s: Session, sandbox: string): { file: string; servers: any } {
  const repoInSandbox = path.join(sandbox, s.repo.sub);
  const own = tools().mcpServer?.(repoInSandbox, sandbox) ?? null;
  const servers: Record<string, unknown> = {
    dsa: { command: process.execPath, args: [DSA_CLI, 'mcp', ...args, '--session', s.id, '--repo', repoInSandbox] },
  };
  if (own) servers[own.name] = { command: own.command, args: own.args, ...(own.env ? { env: own.env } : {}) };
  const file = fileOf(dataDir, s.id).replace(/\.json$/, '.mcp.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2));
  return { file, servers };
}

/** Cursor reads MCP servers and rules from the workspace: write them into the sandbox (excluded from diffs). */
function cursorWorkspace(sandbox: string, servers: any) {
  fs.mkdirSync(path.join(sandbox, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
  fs.writeFileSync(path.join(sandbox, '.cursor', 'rules', 'dsa-counterpart.mdc'), `---\ndescription: dsa counterpart\nalwaysApply: true\n---\n\n${PERSONA}\n`);
}

const running = new Map<string, RunningTurn>();
export const isRunning = (id: string) => running.has(id);
export function cancelTurn(id: string) { running.get(id)?.cancel(); }

export type TurnEvent = AgentEvent | { type: 'proposals'; items: Proposal[] } | { type: 'changes'; files: { file: string; status: string }[]; stat: string } | { type: 'saved'; message: Msg };

/** One user message → one agent turn, streamed. The session file holds the transcript. */
export async function runTurn(opts: { dataDir: string; args: string[]; id: string; text: string; mode?: Mode; binary?: string; timeoutMs?: number }, onEvent: (e: TurnEvent) => void): Promise<Msg> {
  const s = readSession(opts.dataDir, opts.id);
  if (!s) throw new Error('No such session.');
  if (running.has(s.id)) throw new Error('The agent is still answering the last message.');
  const switched = Boolean(opts.mode && opts.mode !== s.mode);
  if (opts.mode) s.mode = opts.mode;
  const sandbox = ensureSandbox(opts.dataDir, s);
  const cwd = path.join(sandbox, s.repo.sub);
  const { file, servers } = mcpConfig(opts.dataDir, opts.args, s, sandbox);
  if (s.provider === 'cursor') cursorWorkspace(sandbox, servers);
  const first = !s.providerSession;
  const kind = s.mode === 'try' ? 'a sandbox session: you may edit files in this copy of the repo' : 'a review session: read and advise, do not edit files';
  const prompt = (first ? `Start by reading the brief (the get_subject tool; the same text is in ${s.brief}). This is ${kind}.\n\n` : switched ? `(The designer switched modes. This is now ${kind}.)\n\n` : '') + opts.text;
  s.messages.push({ role: 'user', text: opts.text, at: new Date().toISOString() });
  writeSession(opts.dataDir, s);
  const before = new Set(readProposals(opts.dataDir).map(p => p.id));
  const msg: Msg = { role: 'assistant', text: '', at: new Date().toISOString(), tools: [] };
  const turn = startTurn({ provider: s.provider, binary: opts.binary, cwd, prompt, mode: s.mode, mcpConfig: file, persona: PERSONA, resume: s.providerSession, model: s.model, addDirs: [...(tools().root ? [tools().root!] : []), path.dirname(s.brief)], timeoutMs: opts.timeoutMs }, e => {
    if (e.type === 'init') { s.providerSession = e.providerSession; }
    if (e.type === 'text') msg.text += e.delta;
    if (e.type === 'tool') msg.tools!.push({ name: e.name, summary: e.summary });
    onEvent(e);
  });
  running.set(s.id, turn);
  try {
    const r = await turn.done;
    if (r.providerSession) s.providerSession = r.providerSession;
    if (!msg.text && r.text) msg.text = r.text;
    if (!r.ok) msg.error = r.error;
    msg.costUsd = r.costUsd;
    const fresh = readProposals(opts.dataDir).filter(p => !before.has(p.id) && p.session === s.id);
    msg.proposals = fresh.map(p => p.id);
    if (fresh.length) onEvent({ type: 'proposals', items: fresh });
    if (s.mode === 'try') { const ch = sandboxChanges(s); if (ch?.files.length) onEvent({ type: 'changes', files: ch.files, stat: ch.stat }); }
    onEvent({ type: 'result', ok: r.ok, error: r.error, costUsd: r.costUsd });
  } finally {
    running.delete(s.id);
    const latest = readSession(opts.dataDir, s.id) ?? s;
    latest.messages = [...s.messages, msg];
    latest.providerSession = s.providerSession;
    latest.mode = s.mode;
    writeSession(opts.dataDir, latest);
  }
  onEvent({ type: 'saved', message: msg });
  return msg;
}
