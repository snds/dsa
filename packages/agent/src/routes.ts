import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { EngineContext, ServeRoute } from '@snds/dsa';
import { addHint, decideMany, loadHints, openStore, reevaluateElements, removeHint } from '@snds/dsa/engine';
import { DSA_CLI, contextArgs, tools, useProfile } from './system.js';

import { readSnapshot, writeSnapshot, agentDir } from './snapshot.js';
import { buildBrief, PERSONA, type IssueSource, type Subject } from './context.js';
import { anchorKey, anchorOf, threadIndex, writeThreadIndex } from './threads.js';
import { evidenceOf, whatTheAgentKnows } from './knows.js';
import { addFeedback, readFeedback, readProposals, setStatus } from './proposals.js';
import { DISMISS_LABELS, addDismissal, readDismissals, undoDismissal, type DismissLabel } from './dismissals.js';
import { githubWho, openDraftPr } from './draft-pr.js';
import { readComponentChecks, setComponentCheck } from './component-checks.js';

import { detectProviders, type Mode, type ProviderId, type ProviderStatus } from './providers.js';
import { beforeAfter, diffHash, isVisualRunning, visualFile } from './visual.js';
import { cancelTurn, createSession, deleteSession, discardSandbox, isRunning, keepChanges, listSessions, readSession, runTurn, sandboxChanges, changedCount, writeSession } from './sessions.js';

/**
 * /api/agent/*: the workbench's server side. Mounted by `dsa serve` (the dashboard add-on), which already binds 127.0.0.1,
 * checks Host, and requires `X-DSA: 1` on every POST. Agents are started only with fixed binaries and
 * argument lists; the designer's text goes to the agent on stdin (Claude) or as one argv entry (Cursor),
 * never through a shell.
 */
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Unexpected error').split('\n')[0].slice(0, 300);

/** Who accepted: the git user of the repo the dashboard serves (the person at this keyboard). */
let reviewerName: string | null = null;
function reviewer(root: string): string {
  if (reviewerName) return reviewerName;
  try { reviewerName = execFileSync('git', ['-C', root, 'config', 'user.name'], { encoding: 'utf8' }).trim() || 'reviewer'; } catch { reviewerName = 'reviewer'; }
  return reviewerName;
}

let providersCache: { at: number; list: ProviderStatus[] } | null = null;
async function providers(force = false) {
  if (!force && providersCache && Date.now() - providersCache.at < 60_000) return providersCache.list;
  providersCache = { at: Date.now(), list: await detectProviders() };
  return providersCache.list;
}

/** Bench runs under the core and every repo the readiness audit looked at (the profile's readiness provider reads them). */
async function benchRuns(ctx: EngineContext) {
  const read = ctx.profile.readiness?.benchRuns;
  if (!read) return [];
  const snap = readSnapshot(ctx.dataDir);
  const dirs = [ctx.root, ...(snap?.readiness ?? []).map((r: any) => snap!.targets.find(t => t.name === r.subject)?.dir).filter((d): d is string => Boolean(d))];
  return read([...new Set(dirs)]).catch(() => []);
}

function subjectFrom(b: any): Subject {
  const k = b?.subject?.kind;
  if (k === 'review' && Array.isArray(b.subject.ids) && b.subject.ids.length) return { kind: 'review', ids: b.subject.ids.map(String).slice(0, 500), title: b.subject.title ? String(b.subject.title) : undefined, pattern: b.subject.pattern ?? null };
  if (k === 'queue' && b.subject.id) return { kind: 'queue', id: String(b.subject.id) };
  if (k === 'readiness' && b.subject.subject) return { kind: 'readiness', subject: String(b.subject.subject) };
  if (k === 'issue' && b.subject.key) return { kind: 'issue', key: String(b.subject.key), title: b.subject.title ? String(b.subject.title) : undefined, source: issueSource(b.subject.source) };
  if (k === 'component' && b.subject.name) return { kind: 'component', name: String(b.subject.name) };
  if (k === 'group' && b.subject.value && (b.subject.by === 'component' || b.subject.by === 'app')) return { kind: 'group', by: b.subject.by, value: String(b.subject.value), title: b.subject.title ? String(b.subject.title) : undefined };
  return { kind: 'scan' };
}

function issueSource(x: any): IssueSource | undefined {
  if (x?.type === 'queue' && x.id) return { type: 'queue', id: String(x.id) };
  if (x?.type === 'question' && Array.isArray(x.ids)) return { type: 'question', ids: x.ids.map(String).slice(0, 500) };
  if (x?.type === 'readiness' && x.subject) return { type: 'readiness', subject: String(x.subject) };
  if (x?.type === 'component' && x.name) return { type: 'component', name: String(x.name) };
  return undefined;
}

/** Every anchor's thread and its state; written to threads.json for the published page. */
/** The issue a thread is about, for the draft PR's body: its key, title and GitHub link when it has one. */
function issueOf(dataDir: string, s: { subject: Subject; title: string }) {
  const sub = s.subject;
  const id = sub.kind === 'queue' ? sub.id : sub.kind === 'issue' && sub.source?.type === 'queue' ? sub.source.id : null;
  const q: any = id ? readSnapshot(dataDir)?.queue.find((x: any) => x.id === id) : null;
  if (sub.kind === 'issue') return { key: sub.key, title: sub.title ?? q?.title ?? s.title, url: q?.link?.url ?? null };
  if (sub.kind === 'queue') return { key: sub.id, title: q?.title ?? s.title, url: q?.link?.url ?? null };
  return null;
}

function threads(dataDir: string) {
  const proposals = readProposals(dataDir);
  const snap = readSnapshot(dataDir);
  const index = threadIndex(listSessions(dataDir) as any[], proposals, id => {
    const s = readSession(dataDir, id);
    // Out of date: a newer scan changed the evidence the thread started on (stage 6).
    const evidenceChanged = Boolean(s && snap?.run && s.scanId && s.evidence && s.scanId !== snap.run.id && evidenceOf(snap, s.subject) !== s.evidence);
    return { running: isRunning(id), changedFiles: s?.sandbox ? changedCount(s) : 0, evidenceChanged };
  });
  writeThreadIndex(dataDir, index);
  return index;
}

async function snapshot(ctx: EngineContext, fresh = false) {
  return (!fresh && readSnapshot(ctx.dataDir)) || writeSnapshot(ctx);
}

/** MCP server entries for clients outside the dashboard (no session: proposals arrive as "external"). */
function externalServers(ctx: EngineContext, repoDir?: string): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
  const out: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {
    dsa: { command: 'node', args: [DSA_CLI, 'mcp', ...contextArgs(ctx), ...(repoDir ? ['--repo', repoDir] : [])] },
  };
  const own = tools().mcpServer?.(repoDir ?? ctx.root);
  if (own) out[own.name] = { command: own.command, args: own.args, ...(own.env ? { env: own.env } : {}) };
  return out;
}

/** The design system's own MCP server name, when the profile has one. */
const systemServer = (servers: Record<string, unknown>) => Object.keys(servers).find(k => k !== 'dsa');

function setup(ctx: EngineContext) {
  const servers = externalServers(ctx);
  const own = systemServer(servers);
  // Quote anything but plain path characters: &, ;, |, ( and the like break or chain a pasted command (code review A C-18, C C-40).
  const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
  return {
    claudeCode: {
      add: `claude mcp add --scope user dsa -- ${['node', ...servers.dsa!.args].map(q).join(' ')}`,
      addSystem: own ? `claude mcp add --scope user ${own} -- ${[servers[own]!.command, ...servers[own]!.args].map(q).join(' ')}` : null,
    },
    cursor: {
      installDsa: `cursor://anysphere.cursor-deeplink/mcp/install?name=dsa&config=${encodeURIComponent(b64(servers.dsa))}`,
      installSystem: own ? `cursor://anysphere.cursor-deeplink/mcp/install?name=${own}&config=${encodeURIComponent(b64(servers[own]))}` : null,
    },
    json: JSON.stringify({ mcpServers: servers }, null, 2),
  };
}

function handoff(ctx: EngineContext, snapBrief: ReturnType<typeof buildBrief>, question: string) {
  const { dataDir } = ctx;
  const ask = question.trim().slice(0, 3000) || 'Walk me through this and recommend what to do.';
  const servers = externalServers(ctx, snapBrief.repo.dir);
  const own = systemServer(servers);
  const mcp = own ? `the dsa and ${own} MCP tools` : 'the dsa MCP tools';
  const long = `${PERSONA}\n\nRead the dsa brief first: ${snapBrief.file}. ${mcp[0]!.toUpperCase() + mcp.slice(1)} have everything else.\n\n${ask}`;
  const short = `Read the dsa brief at ${snapBrief.file}, then use ${mcp}. Act as a senior design-system engineer: plain words, evidence first, never invent a component, propose rather than decide.\n\n${ask}`;
  const dir = path.join(agentDir(dataDir), 'context');
  const promptFile = path.join(dir, `${snapBrief.key}.prompt.md`);
  fs.writeFileSync(promptFile, long);
  const mcpFile = path.join(agentDir(dataDir), 'handoff.mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: servers }, null, 2));
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return {
    prompt: short,
    brief: snapBrief.file,
    repo: snapBrief.repo,
    claudeCode: `cd ${q(snapBrief.repo.dir)} && claude --mcp-config ${q(mcpFile)} "$(cat ${q(promptFile)})"`,
    cursor: { open: `cursor ${q(snapBrief.repo.dir)}`, prompt: `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(short.slice(0, 6000))}` },
  };
}

/** Proposals being accepted right now. */
const accepting = new Set<string>();

export const agentRoutes: ServeRoute = async ({ req, res, url, body, send, context }) => {
  const p = url.pathname;
  if (!p.startsWith('/api/agent/')) return false;
  const ctx = await context();
  useProfile(ctx.profile);
  const { root, dataDir, config, configDir } = ctx;
  const rescore = () => reevaluateElements({ root, dataDir, config, profile: ctx.profile, configDir, store: d => openStore(d) });
  const a = config.agents ?? {};
  const POST = req.method === 'POST', GET = req.method === 'GET';
  try {
    if (GET && p === '/api/agent/status') {
      const list = await providers(url.searchParams.get('refresh') === '1');
      return send(200, { providers: list, settings: { provider: a.provider ?? (list.find(x => x.id === 'claude-code')?.installed ? 'claude-code' : list.find(x => x.id === 'cursor')?.installed ? 'cursor' : 'claude-code'), model: a.model ?? '', cursorModel: a.cursorModel ?? '', mode: a.mode ?? 'advise', timeoutMinutes: a.timeoutMinutes ?? 10 }, setup: setup(ctx), hints: loadHints(configDir).hints, feedback: readFeedback(configDir), bench: await benchRuns(ctx) }), true;
    }
    if (POST && p === '/api/agent/settings') {
      const b = await body();
      const file = ctx.loaded.configPath;
      if (!file) return send(400, { error: 'No dsa.config.json to save to.' }), true;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const prov = ['claude-code', 'cursor'].includes(b.provider) ? b.provider : undefined;
      const mode = ['advise', 'try'].includes(b.mode) ? b.mode : undefined;
      const t = Number(b.timeoutMinutes);
      raw.agents = { provider: prov, model: String(b.model ?? '').trim() || undefined, cursorModel: String(b.cursorModel ?? '').trim() || undefined, mode, timeoutMinutes: t > 0 && t <= 60 ? t : undefined };
      fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
      return send(200, { saved: true }), true;
    }
    // What the agent knows for a subject: the drawer beside a thread (stage 6).
    if (POST && p === '/api/agent/context') {
      // Fresh: a decision made a minute ago is a past decision now (UX review C U-22).
      const snap = await snapshot(ctx, true);
      return send(200, { sources: whatTheAgentKnows(snap, subjectFrom(await body())) }), true;
    }
    if (GET && p === '/api/agent/threads') return send(200, { threads: threads(dataDir) }), true;
    // Who a draft PR would open as: the person's own gh sign-in, read before the click.
    if (GET && p === '/api/agent/github') return send(200, githubWho(root)), true;
    if (GET && p === '/api/agent/component-checks') return send(200, { checks: readComponentChecks(dataDir) }), true;
    // Confirm or Correct a component that "needs a check" (stage 8). A correction says what it really is.
    if (POST && p === '/api/agent/component-check') {
      const b = await body();
      const name = String(b.name ?? '').trim().slice(0, 200);
      if (!name) return send(400, { error: 'Which component?' }), true;
      if (b.verdict === 'undo') { setComponentCheck(dataDir, name, null); return send(200, { check: null }), true; }
      if (b.verdict !== 'confirmed' && b.verdict !== 'corrected') return send(400, { error: 'Confirm or correct.' }), true;
      const note = String(b.note ?? '').trim().slice(0, 600);
      if (b.verdict === 'corrected' && !note) return send(400, { error: 'Say what it really is, so the next scan can learn it.' }), true;
      const check = { verdict: b.verdict, ...(note ? { note } : {}), who: String(b.who ?? '').trim() || reviewer(root), date: new Date().toISOString().slice(0, 10) } as const;
      setComponentCheck(dataDir, name, check);
      return send(200, { check }), true;
    }
    if (GET && p === '/api/agent/dismissals') return send(200, { dismissals: readDismissals(dataDir) }), true;
    // A person dismisses an issue directly, with a reason (the agent can only propose one).
    if (POST && p === '/api/agent/dismissal') {
      const b = await body();
      const key = String(b.key ?? '').trim().slice(0, 40), label = String(b.label ?? ''), reason = String(b.reason ?? '').trim().slice(0, 600);
      if (!key) return send(400, { error: 'Which issue?' }), true;
      if (!Object.hasOwn(DISMISS_LABELS, label)) return send(400, { error: `Pick a reason: ${Object.values(DISMISS_LABELS).join(', ')}.` }), true;
      const d = { label: label as DismissLabel, reason, who: String(b.who ?? '').trim() || reviewer(root), date: new Date().toISOString().slice(0, 10), ...(b.title ? { title: String(b.title).slice(0, 200) } : {}) };
      addDismissal(dataDir, key, d);
      return send(200, { dismissal: d }), true;
    }
    if (POST && p === '/api/agent/dismissal/undo') { const ok = undoDismissal(dataDir, String((await body()).key)); return send(ok ? 200 : 404, ok ? { undone: true } : { error: 'Not dismissed.' }), true; }
    if (POST && p === '/api/agent/thread/settle') {
      const b = await body();
      const s = readSession(dataDir, String(b.id));
      if (!s) return send(404, { error: 'No such session.' }), true;
      s.settledAt = b.undo === true ? null : new Date().toISOString();
      writeSession(dataDir, s);
      return send(200, { settledAt: s.settledAt }), true;
    }
    if (GET && p === '/api/agent/sessions') return send(200, { sessions: listSessions(dataDir).map(s => ({ ...s, running: isRunning(s.id) })) }), true;
    if (GET && p === '/api/agent/session') {
      const s = readSession(dataDir, String(url.searchParams.get('id')));
      if (!s) return send(404, { error: 'No such session.' }), true;
      const changes = s.mode === 'try' || s.sandbox ? sandboxChanges(s) : null;
      const visualStale = Boolean(s.visual && changes && diffHash(changes.diff) !== s.visual.diffHash);
      return send(200, { session: s, running: isRunning(s.id), changes, visualRunning: isVisualRunning(s.id), visualStale, proposals: readProposals(dataDir).filter(x => x.session === s.id) }), true;
    }
    if (POST && p === '/api/agent/session') {
      const b = await body();
      const snap = await snapshot(ctx, true);
      const list = await providers();
      const provider: ProviderId = b.provider === 'cursor' || b.provider === 'claude-code' ? b.provider : (a.provider ?? 'claude-code');
      const st = list.find(x => x.id === provider);
      if (!st?.chat) return send(400, { error: `${st?.label ?? provider} isn't installed here. See Settings › Agents.` }), true;
      const subject = subjectFrom(b);
      // One thread per anchor (D3): `reuse` opens the anchor's thread when it has one; New thread leaves it out.
      if (b.reuse === true) {
        const t = threads(dataDir)[anchorKey(anchorOf(subject))];
        const existing = t ? readSession(dataDir, t.session) : null;
        if (existing) return send(200, { session: existing, reused: true }), true;
      }
      const s = createSession(snap, subject, { provider, model: provider === 'cursor' ? a.cursorModel : a.model, mode: (b.mode as Mode) ?? a.mode ?? 'advise' });
      return send(200, { session: s }), true;
    }
    if (POST && p === '/api/agent/handoff') {
      const b = await body();
      const snap = await snapshot(ctx, true);
      return send(200, handoff(ctx, buildBrief(snap, subjectFrom(b)), String(b.question ?? ''))), true;
    }
    if (POST && p === '/api/agent/send') {
      const b = await body();
      const s = readSession(dataDir, String(b.id));
      if (!s) return send(404, { error: 'No such session.' }), true;
      const text = String(b.text ?? '').trim().slice(0, 8000);
      if (!text) return send(400, { error: 'Say something first.' }), true;
      if (isRunning(s.id)) return send(409, { error: 'The agent is still answering the last message.' }), true;
      if (isVisualRunning(s.id)) return send(409, { error: 'Wait for the before/after pictures to finish.' }), true;
      const bin = (await providers()).find(x => x.id === s.provider)?.binary;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const write = (e: unknown) => { try { res.write(JSON.stringify(e) + '\n'); } catch { /* the page went away; the turn still finishes and saves */ } };
      try {
        await runTurn({ dataDir, args: contextArgs(ctx), id: s.id, text, mode: b.mode === 'try' || b.mode === 'advise' ? b.mode : undefined, binary: bin, timeoutMs: (a.timeoutMinutes ?? 10) * 60_000 }, write);
      } catch (e) { write({ type: 'result', ok: false, error: errText(e) }); }
      res.end();
      return true;
    }
    if (POST && p === '/api/agent/cancel') { cancelTurn(String((await body()).id)); return send(200, { cancelled: true }), true; }
    if (POST && p === '/api/agent/session/delete') { deleteSession(dataDir, String((await body()).id)); return send(200, { deleted: true }), true; }
    if (POST && p === '/api/agent/changes') {
      const b = await body();
      const s = readSession(dataDir, String(b.id));
      if (!s) return send(404, { error: 'No such session.' }), true;
      if (isRunning(s.id)) return send(409, { error: 'Wait for the agent to finish.' }), true;
      if (isVisualRunning(s.id)) return send(409, { error: 'Wait for the before/after pictures to finish.' }), true;
      if (b.action === 'keep') return send(200, keepChanges(dataDir, s, b.message)), true;
      if (b.action === 'pr') return send(200, openDraftPr(dataDir, s, { issue: issueOf(dataDir, s), dashboardUrl: typeof b.link === 'string' && /^https?:\/\//.test(b.link) ? b.link : null })), true;
      if (b.action === 'discard') { discardSandbox(dataDir, s); return send(200, { discarded: true }), true; }
      if (b.action === 'mode') { s.mode = b.mode === 'try' ? 'try' : 'advise'; writeSession(dataDir, s); return send(200, { mode: s.mode }), true; }
      return send(400, { error: 'Unknown action.' }), true;
    }
    // Before/after pictures of a sandbox change: opt-in, slow (it starts the app twice), streamed as progress lines.
    if (POST && p === '/api/agent/visual') {
      const b = await body();
      const s = readSession(dataDir, String(b.id));
      if (!s) return send(404, { error: 'No such session.' }), true;
      if (isRunning(s.id)) return send(409, { error: 'Wait for the agent to finish.' }), true;
      if (isVisualRunning(s.id)) return send(409, { error: 'Already taking before/after pictures for this session.' }), true;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const write = (e: unknown) => { try { res.write(JSON.stringify(e) + '\n'); } catch { /* the page went away; the run still finishes and saves */ } };
      try {
        const run = await beforeAfter({ root, dataDir, config, id: s.id, max: Number(b.max) || undefined, log: m => write({ type: 'log', text: m.trim() }) });
        write({ type: 'done', run });
      } catch (e) { write({ type: 'error', error: errText(e) }); }
      res.end();
      return true;
    }
    if (GET && p === '/api/agent/visual/img') {
      const s = readSession(dataDir, String(url.searchParams.get('id')));
      const f = s ? visualFile(dataDir, s, String(url.searchParams.get('f'))) : null;
      if (!f) return send(404, { error: 'No such picture.' }), true;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(f));
      return true;
    }
    if (GET && p === '/api/agent/proposals') {
      const status = url.searchParams.get('status');
      return send(200, { proposals: readProposals(dataDir).filter(x => !status || x.status === status).sort((x, y) => y.createdAt.localeCompare(x.createdAt)) }), true;
    }
    if (POST && p === '/api/agent/proposal') {
      const b = await body();
      const pr = readProposals(dataDir).find(x => x.id === b.id);
      if (!pr) return send(404, { error: 'No such proposal.' }), true;
      if (pr.status !== 'open') return send(409, { error: `Already ${pr.status}.` }), true;
      const who = String(b.who ?? '').trim() || reviewer(root);
      if (b.action === 'reject') { setStatus(dataDir, pr.id, 'rejected', who, String(b.note ?? '').slice(0, 300) || undefined); return send(200, { status: 'rejected' }), true; }
      if (b.action !== 'accept') return send(400, { error: 'Unknown action.' }), true;
      // One accept at a time per proposal: a double click must not apply it twice (code review C C-27).
      if (accepting.has(pr.id)) return send(409, { error: 'Already being accepted.' }), true;
      accepting.add(pr.id);
      try {
      const note = `Agent proposal ${pr.id} (${pr.session}), accepted by ${who}: ${pr.rationale}`.slice(0, 600);
      let result = '';
      if (pr.kind === 'decision' || pr.kind === 'policy') {
        const r = await decideMany(root, config, dataDir, pr.kind === 'policy' ? { pattern: pr.payload.pattern } : { ids: pr.payload.ids }, pr.payload.decision, who, note);
        result = `Recorded for ${r.reduce((n: number, x: any) => n + (x.count ?? 1), 0)} element(s).`;
      } else if (pr.kind === 'hint') {
        const h = addHint(configDir, { when: pr.payload.when, prefer: pr.payload.prefer, avoid: pr.payload.avoid, confidence: pr.payload.confidence, why: pr.payload.why ?? pr.rationale, by: 'agent', who, source: { session: pr.session, examples: pr.payload.examples } });
        const r = await rescore();
        result = `Hint ${h.id} saved to dsa.hints.json; the review re-scored ${r.changed} of ${r.total} elements.`;
      } else if (pr.kind === 'scanner-note') {
        addFeedback(configDir, { ...pr.payload, rationale: pr.rationale, proposal: pr.id, session: pr.session, who, date: new Date().toISOString().slice(0, 10) });
        result = 'Saved to dsa.feedback.json for the scanner backlog.';
      } else if (pr.kind === 'dismissal') {
        addDismissal(dataDir, pr.payload.issue, { label: pr.payload.label, reason: String(pr.payload.reason).slice(0, 600), who, date: new Date().toISOString().slice(0, 10), proposal: pr.id, title: pr.title });
        result = pr.payload.label === 'scanner-misread'
          ? 'Dismissed. The scanner read this wrong: ask the agent for a scanner hint, so the next scan doesn\'t raise it again.'
          : 'Dismissed. The issue moves to Done.';
      } else if (pr.kind === 'issue') {
        const repo = pr.payload.repo || config.github?.defaultRepo;
        result = repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}/issues/new?title=${encodeURIComponent(pr.payload.title)}&body=${encodeURIComponent(String(pr.payload.body).slice(0, 6000))}` : 'No repo: copy the text.';
      }
      setStatus(dataDir, pr.id, 'accepted', who, result);
      await writeSnapshot(ctx).catch(() => null);
      return send(200, { status: 'accepted', result }), true;
      } finally { accepting.delete(pr.id); }
    }
    if (POST && p === '/api/agent/hint/delete') {
      const ok = removeHint(configDir, String((await body()).id));
      if (ok) await rescore();
      return send(ok ? 200 : 404, ok ? { removed: true } : { error: 'No such hint.' }), true;
    }
    return send(404, { error: 'Not found.' }), true;
  } catch (e) {
    console.error(`Agent request failed: ${errText(e)}`);
    return send(400, { error: errText(e) }), true;
  }
};
