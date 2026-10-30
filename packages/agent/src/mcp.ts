import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { readSnapshot, type Snapshot } from './snapshot.js';
import { buildBrief, type Subject } from './context.js';
import { propose, readProposals, type ProposalKind } from './proposals.js';

import { readSession } from './sessions.js';
import { tools } from './system.js';

/**
 * `dsa mcp`: the scan as MCP tools, over stdio (newline-delimited JSON-RPC 2.0, no SDK). Agents in the dashboard get it per session (DSA_SESSION set); Cursor and Claude
 * Code get it from their MCP settings and work without a session (proposals are marked "external").
 * Read tools never write. Propose tools append a proposal for a human to accept in the dashboard.
 */
export const SERVER_INFO = { name: 'dsa', title: 'dsa (scan, review, proposals)', version: '0.1.0' };
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = [
  'The design-system scan: element review, the action queue, agent readiness, screenshots.',
  'Start with get_subject (the brief for this session). Look before you claim: view_screenshot, get_element.',
  'You never decide or write hints: propose_* records a proposal and the designer accepts or rejects it in the dashboard.',
].join('\n');

export interface McpEnv { dataDir: string; session?: string; repoDir?: string }

const rec = { type: 'object', properties: { verdict: { type: 'string', enum: ['replace', 'keep', 'gap', 'ignore'] }, use: { type: 'string', description: "The design system's component, exact export name" }, props: { type: 'object', additionalProperties: { type: 'string' } }, gap: { type: 'string' } }, required: ['verdict'] };
const common = { rationale: { type: 'string', description: 'What you looked at and why, in plain words' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, evidence: { type: 'array', items: { type: 'string' }, description: 'Element ids, file:line, screenshot ids, doc paths' }, title: { type: 'string' } };
type Tool = { name: string; description: string; inputSchema: any; readOnly: boolean; run: (a: any, env: McpEnv, snap: Snapshot) => Promise<Content[]> | Content[] };
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const text = (t: unknown): Content[] => [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }];

const trimEval = (e: any) => ({
  id: e.id, target: e.target, file: e.file, line: e.line, element: e.element, verdict: e.verdict, use: e.use, props: e.props, gap: e.gap, role: e.role,
  confidence: e.confidence, needsHuman: e.needsHuman, decided: e.decided, exception: e.exception, regions: e.regions, styleKey: e.styleKey, styleSig: e.styleSig,
  reasons: e.reasons, alternatives: e.alternatives, signature: e.signature, a11y: e.a11y, hints: e.hints, source: String(e.source ?? '').slice(0, 2000),
  reach: e.reach ? { status: e.reach.status, steps: e.reach.steps?.slice?.(0, 6) } : undefined,
});

function sigs(dataDir: string): any[] { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'signatures.json'), 'utf8')); } catch { return []; } }
function subjectOf(env: McpEnv): Subject { return (env.session && readSession(env.dataDir, env.session)?.subject) || { kind: 'scan' }; }
const session = (env: McpEnv) => env.session ?? 'external';

const proposeTool = (kind: ProposalKind, name: string, description: string, props: Record<string, any>, required: string[]): Tool => ({
  name, description, readOnly: false,
  inputSchema: { type: 'object', properties: { ...props, ...common }, required: [...required, 'rationale'] },
  run: (a, env, snap) => {
    const { rationale, confidence, evidence, title, ...payload } = a ?? {};
    const p = propose(env.dataDir, snap, sigs(env.dataDir), { kind, session: session(env), rationale, confidence, evidence, title, payload });
    return text(`Proposal ${p.id} recorded: "${p.title}". The designer accepts or rejects it in the dashboard; nothing changes until then.`);
  },
});

export const TOOLS: Tool[] = [
  { name: 'get_subject', description: 'The brief for this session: the subject, its evidence, the design-system entries in play, and the intent behind the rules. Read it first.', readOnly: true, inputSchema: { type: 'object', properties: {} },
    run: (_a, env, snap) => text(buildBrief(snap, subjectOf(env)).markdown) },
  { name: 'scan_summary', description: 'Counts for the latest scan: elements, questions, queue, screenshots, agent readiness, scanner hints.', readOnly: true, inputSchema: { type: 'object', properties: {} },
    run: (_a, _env, snap) => text(buildBrief(snap, { kind: 'scan' }).markdown) },
  { name: 'get_element', description: 'One evaluated element: code, placement, the pick and its reasons, alternatives, signature match, decision, screenshot id.', readOnly: true,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (a, _env, snap) => { const e = snap.evals.find(x => x.id === a.id); if (!e) throw new Error(`No element ${a.id} in the latest scan.`); return text({ ...trimEval(e), screenshot: snap.shots[e.id] ? { page: snap.shots[e.id].page, revealedBy: snap.shots[e.id].revealedBy } : null }); } },
  { name: 'find_elements', description: 'Search evaluated elements. Every filter is optional; results are short rows (use get_element for detail).', readOnly: true,
    inputSchema: { type: 'object', properties: { element: { type: 'string' }, use: { type: 'string', description: 'Recommended component' }, file: { type: 'string', description: 'Substring of the file path' }, region: { type: 'string' }, text: { type: 'string', description: 'Substring of the visible text or label' }, needsHuman: { type: 'boolean' }, styleKey: { type: 'string' }, limit: { type: 'number' } } },
    run: (a, _env, snap) => {
      const rows = snap.evals.filter(e => (!a.element || e.element === a.element) && (!a.use || (e.decided?.decision?.use ?? e.use) === a.use) && (!a.file || String(e.file).includes(a.file))
        && (!a.region || (e.regions ?? []).includes(a.region)) && (a.needsHuman == null || Boolean(e.needsHuman) === a.needsHuman) && (!a.styleKey || e.styleKey === a.styleKey || e.styleSig === a.styleKey)
        && (!a.text || `${e.match?.text ?? ''} ${e.match?.ariaLabel ?? ''} ${e.match?.title ?? ''}`.toLowerCase().includes(String(a.text).toLowerCase())));
      const lim = Math.min(Number(a.limit) || 40, 200);
      return text({ total: rows.length, rows: rows.slice(0, lim).map(e => `${e.id} ${e.file}:${e.line} <${e.element}> → ${e.decided ? `[decided] ${e.decided.decision.use ?? e.decided.decision.verdict}` : e.use ?? e.verdict} ${Math.round(e.confidence * 100)}%${e.regions?.length ? ` in ${e.regions.join('›')}` : ''}${snap.shots[e.id] ? ' 📷' : ''}`) });
    } },
  { name: 'view_screenshot', description: 'The screenshot of an element in the running app (the element is outlined), with the page and the steps it took to reveal it.', readOnly: true,
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Element id' } }, required: ['id'] },
    run: (a, _env, snap) => {
      const s = snap.shots[a.id];
      if (!s || !fs.existsSync(s.abs)) return text(`No screenshot for ${a.id}.${snap.missingShots.includes(a.id) ? ' The crawler could not reach it (it may need typed input, an upload, or a backend).' : ''}`);
      return [{ type: 'text', text: `Screenshot of ${a.id} on ${s.page ?? 'a page'}${s.revealedBy ? `, after ${s.revealedBy}` : ''}. Match confidence ${Math.round((s.match ?? 0) * 100)}%.` }, { type: 'image', data: fs.readFileSync(s.abs).toString('base64'), mimeType: 'image/png' }];
    } },
  { name: 'component_signature', description: "A design-system component as the scanner measured it: variant and size options, defaults, and where it's exported from.", readOnly: true,
    inputSchema: { type: 'object', properties: { component: { type: 'string' } }, required: ['component'] },
    run: (a, env) => { const s = sigs(env.dataDir).find(x => x.component === a.component); return text(s ? { component: s.component, from: s.from, tag: s.tag, role: s.role, axes: s.axes, defaults: s.defaults } : `No signature for ${a.component}. Check the name with the design system's own tools, if it has them.`); } },
  { name: 'check_file', description: "The design system's usage checker on a file in this session's repo. Run it on every file you change; fix every error.", readOnly: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the repo root' } }, required: ['path'] },
    run: async (a, env) => {
      const root = env.repoDir;
      if (!root) throw new Error('No repo for this session.');
      const f = path.resolve(root, String(a.path));
      if (!f.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(f)) throw new Error(`${a.path} is not a file in the session repo.`);
      const check = tools().checkFile;
      if (!check) return text("The design system's profile names no usage checker, so there is nothing to run. Check the file by reading it.");
      return text(await check(root, path.relative(root, f)));
    } },
  { name: 'list_proposals', description: 'Proposals made in this session (or all, with all: true) and whether the designer accepted them.', readOnly: true,
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } },
    run: (a, env) => text(readProposals(env.dataDir).filter(p => a.all || p.session === session(env)).map(p => `${p.id} [${p.status}] ${p.kind}: ${p.title}${p.result ? ` — ${p.result}` : ''}`).join('\n') || 'None yet.') },
  proposeTool('decision', 'propose_decision', 'Propose what these elements become. The designer accepts it into the app\'s decisions file.', { ids: { type: 'array', items: { type: 'string' } }, decision: rec }, ['ids', 'decision']),
  proposeTool('policy', 'propose_policy', 'Propose one decision for every element styled by a shared class constant or style signature.', { pattern: { type: 'string', description: 'styleKey or styleSig' }, decision: rec }, ['pattern', 'decision']),
  proposeTool('hint', 'propose_hint', 'Teach the scanner: when an element matches `when`, prefer a recommendation or avoid a component. Applies on every scan once accepted. Narrow it (region, text, classes, the current pick) and list the ids you checked.',
    { when: { type: 'object', properties: { element: { type: 'string' }, role: { type: 'string' }, ruleId: { type: 'string' }, use: { type: 'string', description: 'The pick the scanner makes today' }, region: { type: 'string' }, text: { type: 'string', description: 'Regex over visible text / aria-label / title' }, classes: { type: 'array', items: { type: 'string' } }, paths: { type: 'array', items: { type: 'string' } }, styleKey: { type: 'string' } }, required: ['element'] },
      prefer: rec, avoid: { type: 'array', items: { type: 'string' } }, why: { type: 'string' }, examples: { type: 'array', items: { type: 'string' } } }, ['when', 'examples']),
  proposeTool('scanner-note', 'propose_scanner_note', "Report a scanner bug or idea that a hint can't fix (it needs a code change in the scanner).", { problem: { type: 'string' }, examples: { type: 'array', items: { type: 'string' } }, suggestion: { type: 'string' } }, ['problem']),
  proposeTool('issue', 'propose_issue', 'Draft a GitHub issue. The designer reviews it and files it.', { title: { type: 'string' }, body: { type: 'string' }, repo: { type: 'string' } }, ['title', 'body']),
];

class RpcError extends Error { constructor(public code: number, msg: string) { super(msg); } }

export function createHandler(env: McpEnv) {
  const snapshot = () => { const s = readSnapshot(env.dataDir); if (!s) throw new Error('No scan snapshot yet. Open the dashboard (dsa serve) or run a scan first.'); return s; };
  const methods: Record<string, (p: any) => any> = {
    initialize: p => ({ protocolVersion: PROTOCOLS.includes(p?.protocolVersion) ? p.protocolVersion : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }),
    ping: () => ({}),
    'tools/list': () => ({ tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.readOnly, openWorldHint: false } })) }),
    'tools/call': async p => {
      const t = TOOLS.find(x => x.name === p?.name);
      if (!t) return { content: text(`Unknown tool ${p?.name}.`), isError: true };
      try { return { content: await t.run(p?.arguments ?? {}, env, snapshot()) }; }
      catch (e: any) { return { content: text(`Error: ${e.message}`), isError: true }; }
    },
  };
  return async (m: any) => { const fn = methods[m.method]; if (!fn) throw new RpcError(-32601, `Method not found: ${m.method}`); return fn(m.params); };
}

export function serveMcp(env: McpEnv, input = process.stdin, output = process.stdout): Promise<void> {
  const handle = createHandler(env);
  const send = (msg: unknown) => output.write(JSON.stringify(msg) + '\n');
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async line => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      if (!m || m.id == null || typeof m.method !== 'string') continue;
      try { send({ jsonrpc: '2.0', id: m.id, result: await handle(m) }); }
      catch (e: any) { send({ jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32603, message: e.message } }); }
    }
  });
  process.stderr.write(`[dsa-mcp] serving ${env.dataDir}${env.session ? ` for session ${env.session}` : ''}\n`);
  return new Promise(r => rl.on('close', () => r()));
}
