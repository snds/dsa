import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The agents the dashboard can talk to. Each runs headless as a child process in the session's
 * sandbox, streams JSON lines, and resumes its own conversation by id on the next turn.
 * - claude-code: `claude -p`. Tools are limited per mode (read-only to advise; edits in "try").
 * - cursor: Cursor's agent CLI (`cursor-agent`, also installed as `agent`). It can't be limited to
 *   read-only tools, so it only ever runs in a sandbox copy.
 * Anything else connects the other way: it runs `dsa mcp` itself (see the Agents settings page).
 */
export type ProviderId = 'claude-code' | 'cursor';
export type Mode = 'advise' | 'try';

export interface ProviderStatus {
  id: ProviderId | 'cursor-ide';
  label: string;
  installed: boolean;
  version?: string;
  binary?: string;
  /** Can chat inside the dashboard (a headless CLI is installed). */
  chat: boolean;
  install: { steps: string[]; docs: string };
}

const run = (bin: string, args: string[], timeout = 15000) =>
  new Promise<{ ok: boolean; out: string }>(res => execFile(bin, args, { timeout }, (err, out, errOut) => res({ ok: !err, out: String(out || errOut || '').trim() })));

export async function detectProviders(): Promise<ProviderStatus[]> {
  const claude = await run('claude', ['--version']);
  let cursor: { bin: string; version: string } | null = null;
  for (const bin of ['cursor-agent', 'agent']) {
    const v = await run(bin, ['--version']);
    if (!v.ok) continue;
    // `agent` is a common name: only take it when its help says it's Cursor's.
    if (bin === 'agent' && !/cursor/i.test((await run(bin, ['--help'])).out)) continue;
    cursor = { bin, version: v.out.split('\n')[0] };
    break;
  }
  const ide = await run('cursor', ['--version']);
  return [
    { id: 'claude-code', label: 'Claude Code', installed: claude.ok, version: claude.ok ? claude.out.split('\n')[0] : undefined, binary: 'claude', chat: claude.ok,
      install: { steps: ['curl -fsSL https://claude.ai/install.sh | bash', 'claude   # sign in once, then quit'], docs: 'https://docs.claude.com/en/docs/claude-code/setup' } },
    { id: 'cursor', label: 'Cursor (agent CLI)', installed: Boolean(cursor), version: cursor?.version, binary: cursor?.bin, chat: Boolean(cursor),
      install: { steps: ['curl https://cursor.com/install -fsS | bash', 'cursor-agent login'], docs: 'https://cursor.com/docs/cli/overview' } },
    { id: 'cursor-ide', label: 'Cursor (editor)', installed: ide.ok, version: ide.ok ? ide.out.split('\n')[0] : undefined, binary: 'cursor', chat: false,
      install: { steps: ['Install Cursor from cursor.com, then run "Shell Command: Install \'cursor\' command" from its command palette.'], docs: 'https://cursor.com/docs' } },
  ];
}

export type AgentEvent =
  | { type: 'init'; providerSession: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'result'; ok: boolean; text?: string; error?: string; costUsd?: number; providerSession?: string };

export interface TurnOptions {
  provider: ProviderId;
  binary?: string;
  cwd: string;
  prompt: string;
  mode: Mode;
  mcpConfig: string;
  persona: string;
  resume?: string;
  model?: string;
  addDirs?: string[];
  timeoutMs?: number;
}

const READ = ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite'];
const WRITE = ['Edit', 'Write', 'MultiEdit'];
const NEVER = ['Bash', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'KillShell', 'BashOutput'];

/** Keep the operator's own Claude instructions and memory out: the brief and the repo's rules are the context. */
function isolation(cwd: string) {
  const excl = [path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), '**')];
  for (let d = path.dirname(path.resolve(cwd)); ; d = path.dirname(d)) { excl.push(path.join(d, '*.md'), path.join(d, '.claude', '**')); if (path.dirname(d) === d) break; }
  return { autoMemoryEnabled: false, claudeMdExcludes: excl };
}

/** Every MCP server in the session's config (dsa and the design system's own), as allowed tool prefixes. */
function mcpServers(file: string): string[] {
  try { return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers ?? {}).map(n => `mcp__${n}`); } catch { return ['mcp__dsa']; }
}

export function claudeArgs(o: TurnOptions): string[] {
  const allowed = [...READ, ...mcpServers(o.mcpConfig), ...(o.mode === 'try' ? WRITE : [])];
  const denied = [...NEVER, ...(o.mode === 'try' ? [] : WRITE)];
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', o.mode === 'try' ? 'acceptEdits' : 'default',
    '--allowedTools', allowed.join(','), '--disallowedTools', denied.join(','),
    '--strict-mcp-config', '--mcp-config', o.mcpConfig,
    '--setting-sources', 'project', '--settings', JSON.stringify(isolation(o.cwd)),
    '--append-system-prompt', o.persona];
  for (const d of o.addDirs ?? []) a.push('--add-dir', d);
  if (o.model) a.push('--model', o.model);
  if (o.resume) a.push('--resume', o.resume);
  return a;
}

export function cursorArgs(o: TurnOptions): string[] {
  const a = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--workspace', o.cwd, '--trust', '--approve-mcps'];
  if (o.mode === 'try') a.push('--force');
  if (o.model) a.push('--model', o.model);
  if (o.resume) a.push('--resume', o.resume);
  a.push(o.prompt);
  return a;
}

/** A tool call in words a designer can follow. */
export function toolSummary(name: string, input: any = {}): string {
  const n = name.replace(/^mcp__[\w-]+?__/, '');
  const f = (p: any) => (p ? path.basename(String(p)) : '');
  const m: Record<string, () => string> = {
    Read: () => `Read ${f(input.file_path ?? input.path)}`, Grep: () => `Searched the code for “${input.pattern ?? ''}”`, Glob: () => `Listed files matching ${input.pattern ?? ''}`, LS: () => `Listed ${f(input.path)}`,
    Edit: () => `Edited ${f(input.file_path)}`, MultiEdit: () => `Edited ${f(input.file_path)}`, Write: () => `Wrote ${f(input.file_path)}`, TodoWrite: () => 'Planned the steps',
    get_subject: () => 'Read the brief', scan_summary: () => 'Read the scan summary', get_element: () => `Opened element ${input.id ?? ''}`, find_elements: () => 'Searched the scan',
    view_screenshot: () => `Looked at the screenshot of ${input.id ?? ''}`, component_signature: () => `Checked ${input.component ?? ''}'s variants`, check_file: () => `Checked ${f(input.path)} with the usage checker`,
    list_proposals: () => 'Listed proposals', propose_decision: () => 'Proposed a decision', propose_policy: () => 'Proposed a policy', propose_hint: () => 'Proposed a scanner hint',
    propose_scanner_note: () => 'Wrote a scanner note', propose_issue: () => 'Drafted an issue',
    get_component: () => `Looked up ${input.name ?? input.component ?? ''} in the design system`, resolve_component: () => `Resolved “${input.name ?? ''}” to a design-system component`,
    search_components: () => `Searched the design system for “${input.query ?? ''}”`, get_guidance: () => `Read the design system's guidance${input.topic ? ` on ${input.topic}` : ''}`, get_pattern: () => `Read the ${input.name ?? ''} pattern`,
    find_token: () => 'Looked up a token', list_tokens: () => 'Listed tokens', get_migration: () => 'Read a migration note',
  };
  return (m[n] ?? (() => `Used ${n}`))();
}

/** Harness plumbing, not work the designer needs to see. */
const HIDDEN = new Set(['ToolSearch', 'TodoWrite']);

/** Turn one JSON line from either CLI into events. `state` carries what the Cursor stream has already said. */
export function parseLine(provider: ProviderId, line: string, state: { said: string }): AgentEvent[] {
  let e: any;
  try { e = JSON.parse(line); } catch { return []; }
  const out: AgentEvent[] = [];
  if (e.type === 'system' && e.subtype === 'init' && e.session_id) out.push({ type: 'init', providerSession: e.session_id });
  if (provider === 'claude-code') {
    // A new text block after earlier text starts a new paragraph.
    if (e.type === 'stream_event' && e.event?.type === 'content_block_start' && e.event.content_block?.type === 'text' && state.said) { state.said += '\n\n'; out.push({ type: 'text', delta: '\n\n' }); }
    if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') { state.said += e.event.delta.text; out.push({ type: 'text', delta: e.event.delta.text }); }
    if (e.type === 'assistant') for (const c of e.message?.content ?? []) if (c.type === 'tool_use' && !HIDDEN.has(c.name)) out.push({ type: 'tool', name: c.name, summary: toolSummary(c.name, c.input) });
  } else {
    if (e.type === 'assistant') {
      const t = (e.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      // Partial output sends deltas; a final full message repeats what was said: send only what's new.
      const delta = t.startsWith(state.said) && state.said ? t.slice(state.said.length) : t;
      if (delta) { state.said += delta; out.push({ type: 'text', delta }); }
    }
    if (e.type === 'tool_call' && e.subtype === 'started') {
      const [kind, body] = Object.entries<any>(e.tool_call ?? {})[0] ?? [];
      const name = String(kind ?? 'tool').replace(/ToolCall$/, '');
      const map: Record<string, string> = { read: 'Read', grep: 'Grep', glob: 'Glob', ls: 'LS', edit: 'Edit', write: 'Write', mcp: body?.args?.toolName ?? body?.args?.name ?? 'mcp' };
      out.push({ type: 'tool', name: map[name] ?? name, summary: toolSummary(map[name] ?? name, body?.args?.args ?? body?.args ?? {}) });
    }
  }
  if (e.type === 'result') out.push({ type: 'result', ok: !e.is_error, text: e.result, error: e.is_error ? String(e.result ?? e.error ?? 'The agent stopped with an error.').slice(0, 500) : undefined, costUsd: e.total_cost_usd, providerSession: e.session_id });
  return out;
}

export interface RunningTurn { child: ChildProcess; cancel: () => void; done: Promise<AgentEvent & { type: 'result' }> }

export function startTurn(o: TurnOptions, onEvent: (e: AgentEvent) => void): RunningTurn {
  const bin = o.binary ?? (o.provider === 'claude-code' ? 'claude' : 'cursor-agent');
  const args = o.provider === 'claude-code' ? claudeArgs(o) : cursorArgs(o);
  const child = spawn(bin, args, { cwd: o.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'dsa-workbench' } });
  const kill = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { child.kill(sig); } };
  const state = { said: '' };
  let result: (AgentEvent & { type: 'result' }) | null = null;
  let buf = '', tail = '', timedOut = false, cancelled = false;
  const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 5000).unref(); }, o.timeoutMs ?? 10 * 60_000);
  child.stdout!.on('data', chunk => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      for (const ev of parseLine(o.provider, line, state)) { if (ev.type === 'result') result = ev; else onEvent(ev); }
    }
  });
  child.stderr!.on('data', c => { tail = (tail + c).slice(-3000); });
  const done = new Promise<AgentEvent & { type: 'result' }>(res => {
    const finish = (code: number | null) => {
      clearTimeout(timer);
      const r = result ?? { type: 'result' as const, ok: false, error: cancelled ? 'Stopped.' : timedOut ? 'The agent took too long and was stopped.' : (tail.trim().split('\n').slice(-3).join(' ') || `The agent exited (${code}).`).slice(0, 500) };
      res(r);
    };
    child.on('error', (err: any) => { result = { type: 'result', ok: false, error: err.code === 'ENOENT' ? `${bin} is not installed or not on PATH.` : err.message }; });
    child.on('close', finish);
  });
  if (o.provider === 'claude-code') child.stdin!.end(o.prompt); else child.stdin!.end();
  return { child, done, cancel: () => { cancelled = true; kill('SIGTERM'); } };
}
