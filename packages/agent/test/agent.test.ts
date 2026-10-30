import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProfile } from '@snds/dsa';
import { propose, readProposals, recommendationProblems, setStatus } from '../src/proposals.js';
import { claudeArgs, cursorArgs, parseLine } from '../src/providers.js';
import { buildBrief } from '../src/context.js';
import { createHandler } from '../src/mcp.js';
import { useProfile } from '../src/system.js';
import { revealedOf, type Snapshot } from '../src/snapshot.js';

// The agent workbench: agents propose, humans accept. These pin the guard rails (no invented components,
// no read-only agent that can edit) and what the profile's agent hooks reach. Hints and readiness
// bookkeeping are core (test/engine/hints-readiness.test.ts).

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-agent-')));
const SIGS = [{ component: 'Button', from: '@acme/ui/button', axes: { variant: ['default', 'ghost', 'link'], size: ['default', 'sm', 'xs'] } }, { component: 'ToggleGroup', axes: {} }, { component: 'SidebarMenuButton', axes: { size: ['default', 'sm'] } }];

const evalOf = (o: any = {}) => ({
  id: 'E-1', target: 'app', file: 'app/src/Nav.tsx', line: 3, col: 1, element: 'button', role: 'toggle-group', ruleId: 'button.segmented', verdict: 'replace', use: 'ToggleGroup', props: {},
  confidence: 0.93, needsHuman: false, reasons: [], alternatives: [{ verdict: 'replace', role: 'nav-item', use: 'SidebarMenuButton', confidence: 0.7 }], visualDiffs: [], a11y: [],
  fingerprint: 'x', snippet: '', source: '<button>Colours</button>', regions: ['sidebar', 'nav'], classTokens: ['px-2', 'rounded'], match: { tag: 'button', classes: [], text: 'Colours' }, ...o,
});

function snapshot(dataDir: string, extra: Partial<Snapshot> = {}): Snapshot {
  return { generatedAt: '', root: dataDir, dataDir, title: 'Test', run: { id: 'R-1', takenAt: '2026-10-13' }, threshold: 0.9,
    targets: [{ name: 'app', role: 'consumer', dir: dataDir }], evals: [evalOf(), evalOf({ id: 'E-2', styleKey: 'NAV_ROW' })], shots: {}, missingShots: [], queue: [], readiness: [], hints: [], ...extra };
}

test('proposals: invented components and variants are refused; good ones append and fold status', () => {
  assert.match(recommendationProblems({ verdict: 'replace', role: 'x', use: 'FancyButton' }, SIGS).join(), /not a component/);
  assert.match(recommendationProblems({ verdict: 'replace', role: 'x', use: 'Button', props: { variant: 'loud' } }, SIGS).join(), /no variant="loud"/);
  const dir = tmp();
  const snap = snapshot(dir);
  assert.throws(() => propose(dir, snap, SIGS, { kind: 'decision', session: 'S-1', rationale: 'r', payload: { ids: ['E-404'], decision: { verdict: 'replace', use: 'Button' } } }), /Unknown element ids/);
  assert.throws(() => propose(dir, snap, SIGS, { kind: 'hint', session: 'S-1', rationale: 'r', payload: { when: { element: 'button' }, avoid: ['ToggleGroup'] } }), /condition.*examples|examples/);
  const p = propose(dir, snap, SIGS, { kind: 'decision', session: 'S-1', rationale: 'Screenshot shows a text link.', payload: { ids: ['E-1'], decision: { verdict: 'replace', role: 'link-button', use: 'Button', props: { variant: 'link', size: 'xs' } } } });
  assert.equal(readProposals(dir)[0].status, 'open');
  setStatus(dir, p.id, 'accepted', 'sean', 'Recorded');
  assert.equal(readProposals(dir)[0].status, 'accepted');
  assert.equal(readProposals(dir)[0].result, 'Recorded');
});

test('providers: advise mode cannot edit or run commands; try mode can edit but never run commands', () => {
  const base = { provider: 'claude-code' as const, cwd: '/tmp/x', prompt: 'p', mcpConfig: '/tmp/m.json', persona: 'P' };
  const advise = claudeArgs({ ...base, mode: 'advise' });
  const allowed = (a: string[]) => a[a.indexOf('--allowedTools') + 1].split(',');
  const denied = (a: string[]) => a[a.indexOf('--disallowedTools') + 1].split(',');
  assert.ok(!allowed(advise).includes('Edit') && denied(advise).includes('Edit') && denied(advise).includes('Bash'));
  assert.ok(advise.includes('--strict-mcp-config'));
  const tryIt = claudeArgs({ ...base, mode: 'try', resume: 'abc' });
  assert.ok(allowed(tryIt).includes('Edit') && denied(tryIt).includes('Bash'));
  assert.deepEqual(tryIt.slice(tryIt.indexOf('--resume'), tryIt.indexOf('--resume') + 2), ['--resume', 'abc']);
  const cur = cursorArgs({ ...base, provider: 'cursor', mode: 'advise' });
  assert.ok(!cur.includes('--force') && cur.at(-1) === 'p', 'the prompt is one argv entry, never a shell string');
});

test('providers: stream lines from Claude and Cursor become the same events', () => {
  const st = { said: '' };
  assert.deepEqual(parseLine('claude-code', '{"type":"system","subtype":"init","session_id":"s1"}', st), [{ type: 'init', providerSession: 's1' }]);
  assert.deepEqual(parseLine('claude-code', '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}', st), [{ type: 'text', delta: 'Hi' }]);
  assert.deepEqual(parseLine('claude-code', '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}', st), [{ type: 'text', delta: '\n\n' }]);
  const tool = parseLine('claude-code', '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__dsa__view_screenshot","input":{"id":"E-1"}},{"type":"tool_use","name":"ToolSearch","input":{}}]}}', st);
  assert.deepEqual(tool, [{ type: 'tool', name: 'mcp__dsa__view_screenshot', summary: 'Looked at the screenshot of E-1' }]);
  const cs = { said: '' };
  assert.deepEqual(parseLine('cursor', '{"type":"assistant","message":{"content":[{"type":"text","text":"Hel"}]}}', cs), [{ type: 'text', delta: 'Hel' }]);
  assert.deepEqual(parseLine('cursor', '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}', cs), [{ type: 'text', delta: 'lo' }], 'a repeated full message only adds what is new');
  assert.deepEqual(parseLine('cursor', '{"type":"result","is_error":false,"result":"Hello","session_id":"c1"}', cs), [{ type: 'result', ok: true, text: 'Hello', error: undefined, costUsd: undefined, providerSession: 'c1' }]);
});

test('brief and MCP: the agent gets the evidence, and the MCP server refuses invented components', async () => {
  const dir = tmp();
  const snap = snapshot(dir);
  fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent', 'snapshot.json'), JSON.stringify(snap));
  fs.writeFileSync(path.join(dir, 'signatures.json'), JSON.stringify(SIGS));
  const b = buildBrief(snap, { kind: 'review', ids: ['E-1', 'E-2'] });
  assert.match(b.markdown, /<button>` ×2/);
  assert.match(b.markdown, /Where they sit: sidebar \(2 of 2\), nav \(2 of 2\)/);
  assert.ok(b.starters.some(s => /sidebar/.test(s.prompt)), 'placement shapes the starter prompts');
  assert.ok(fs.existsSync(b.file));
  const h = createHandler({ dataDir: dir });
  const list = await h({ method: 'tools/list' });
  assert.ok(list.tools.some((t: any) => t.name === 'propose_hint' && t.annotations.readOnlyHint === false));
  const el = await h({ method: 'tools/call', params: { name: 'get_element', arguments: { id: 'E-1' } } });
  assert.match(el.content[0].text, /ToggleGroup/);
  const bad = await h({ method: 'tools/call', params: { name: 'propose_decision', arguments: { ids: ['E-1'], decision: { verdict: 'replace', use: 'MagicNav' }, rationale: 'r' } } });
  assert.equal(bad.isError, true);
  assert.equal(readProposals(dir).length, 0);
});

test('brief and MCP: a screenshot revealed by a click or a flow (a string in shots/index.json) is described, not crashed on', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shots', 'E-1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const shot = { file: 'E-1.png', abs: path.join(dir, 'shots', 'E-1.png'), page: '/costs', match: 0.92, revealedBy: 'flow “Add image”: waiting 600 ms' };
  const snap = snapshot(dir, { shots: { 'E-1': shot } });
  fs.writeFileSync(path.join(dir, 'agent', 'snapshot.json'), JSON.stringify(snap));
  fs.writeFileSync(path.join(dir, 'signatures.json'), JSON.stringify(SIGS));
  const b = buildBrief(snap, { kind: 'review', ids: ['E-1'] });
  assert.match(b.markdown, /Screenshot: E-1 on \/costs after flow “Add image”: waiting 600 ms/);
  const h = createHandler({ dataDir: dir });
  const view = await h({ method: 'tools/call', params: { name: 'view_screenshot', arguments: { id: 'E-1' } } });
  assert.match(view.content[0].text, /after flow “Add image”: waiting 600 ms\. Match confidence 92%/);
  const el = await h({ method: 'tools/call', params: { name: 'get_element', arguments: { id: 'E-1' } } });
  assert.match(el.content[0].text, /"revealedBy": ?"flow “Add image”: waiting 600 ms"/);
  assert.equal(revealedOf(['opening “Add Image”', '“Upload”']), 'opening “Add Image” › “Upload”', 'an older list of steps still reads as one phrase');
  assert.equal(revealedOf(undefined), null);
});

test('sandbox: the agent edits a worktree copy; Keep makes a local branch; the real checkout never changes', async () => {
  const { createSession, ensureSandbox, sandboxChanges, keepChanges, discardSandbox, readSession } = await import('../src/sessions.js');
  const { execFileSync } = await import('node:child_process');
  const repo = tmp();
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'Nav.tsx'), 'export const Nav = () => <button>Colours</button>\n');
  g('add', '.'); g('commit', '-qm', 'init');
  const data = tmp();
  const snap = snapshot(data, { root: repo, targets: [{ name: 'app', role: 'consumer', dir: repo }] });
  const s = createSession(snap, { kind: 'review', ids: ['E-1'] }, { provider: 'claude-code', mode: 'try' });
  const sb = ensureSandbox(data, s);
  try {
    assert.notEqual(sb, repo);
    fs.writeFileSync(path.join(sb, 'Nav.tsx'), 'export const Nav = () => <SidebarMenuButton>Colours</SidebarMenuButton>\n');
    const ch = sandboxChanges(readSession(data, s.id)!);
    assert.deepEqual(ch?.files.map(f => f.file), ['Nav.tsx']);
    assert.match(fs.readFileSync(path.join(repo, 'Nav.tsx'), 'utf8'), /<button>/, 'the real checkout is untouched');
    const k = keepChanges(data, readSession(data, s.id)!);
    assert.match(k.branch, /^dsa-agent\//);
    assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the real checkout stays on its branch');
    assert.match(g('show', `${k.branch}:Nav.tsx`), /SidebarMenuButton/);
  } finally {
    discardSandbox(data, readSession(data, s.id)!);
  }
  assert.equal(fs.existsSync(sb), false);
});

test("profile hooks: the system's tools, component entries and MCP server reach briefs, proposals and sessions", async () => {
  const { mcpConfig } = await import('../src/sessions.js');
  useProfile(resolveProfile({
    name: 'acme', label: 'Acme',
    agent: {
      root: '/acme', tools: 'acme_lookup, acme_check.',
      component: n => (n === 'Banner' ? { import: '@acme/ui/banner', variants: { tone: ['info', 'warn'] } } : null),
      intent: () => ['- Acme contract: /acme/AGENTS.md'],
      mcpServer: repo => ({ name: 'acme', command: 'node', args: ['/acme/mcp.mjs'], env: { ACME_ROOT: repo } }),
      checkFile: async (_root, rel) => `checked ${rel}`,
    },
  }));
  try {
    const dir = tmp();
    const snap = snapshot(dir);
    const b = buildBrief(snap, { kind: 'review', ids: ['E-1'] });
    assert.match(b.markdown, /Acme \(the design system\): acme_lookup, acme_check\./);
    assert.match(b.markdown, /Acme contract/);
    // A component only the profile knows passes; its variants are checked.
    assert.deepEqual(recommendationProblems({ verdict: 'replace', role: 'x', use: 'Banner', props: { tone: 'warn' } }, SIGS), []);
    assert.match(recommendationProblems({ verdict: 'replace', role: 'x', use: 'Banner', props: { tone: 'loud' } }, SIGS).join(), /no tone="loud"/);
    const s = { id: 'S-1', repo: { sub: '' } } as any;
    const { servers } = mcpConfig(dir, ['--root', dir, '--data', dir], s, dir);
    assert.deepEqual(Object.keys(servers), ['dsa', 'acme']);
    assert.ok(servers.dsa.args.includes('mcp') && servers.dsa.args.includes('--session'));
    // check_file runs the profile's checker, on files inside the session repo only.
    fs.writeFileSync(path.join(dir, 'Nav.tsx'), 'x');
    fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent', 'snapshot.json'), JSON.stringify(snap));
    const h = createHandler({ dataDir: dir, repoDir: dir });
    const ok = await h({ method: 'tools/call', params: { name: 'check_file', arguments: { path: 'Nav.tsx' } } });
    assert.equal(ok.content[0].text, 'checked Nav.tsx');
    const out = await h({ method: 'tools/call', params: { name: 'check_file', arguments: { path: '../x.tsx' } } });
    assert.equal(out.isError, true);
  } finally { useProfile(resolveProfile({ name: 'neutral' })); }
});
