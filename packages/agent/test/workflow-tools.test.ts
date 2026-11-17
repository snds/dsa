import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { ACME_PROFILE, NOW, fixtureCopy, loadConfig, runPipeline, tmp } from '../../../test/engine/fixture.js';
import { buildBrief, componentEntry } from '../src/context.js';
import { whatTheAgentKnows } from '../src/knows.js';
import { READ_TOOLS, TOOLS, createHandler } from '../src/mcp.js';
import { writeSnapshot } from '../src/snapshot.js';
import { useProfile } from '../src/system.js';
import { THREAD_WORKFLOW } from '../src/workflow.js';

// From the live test of Discuss on GitHub: the workflow's agent said it had no dsa tools, and the brief
// said the profile had "no entry" for a component the profile maps in its role map.

test('the workflow agent gets dsa\'s read-only tools for the thread\'s anchor, never the propose tools', () => {
  assert.ok(READ_TOOLS.includes('get_subject') && READ_TOOLS.includes('find_elements') && READ_TOOLS.includes('check_file'));
  assert.equal(READ_TOOLS.some(t => t.startsWith('propose_')), false, 'nobody is there to accept a proposal');
  assert.deepEqual(READ_TOOLS, TOOLS.filter(t => t.readOnly).map(t => t.name));

  const agent = parse(THREAD_WORKFLOW).jobs.reply.steps.find((s: any) => s.id === 'agent');
  assert.equal(agent.env.ANCHOR, '${{ steps.ask.outputs.anchor }}');
  // The MCP config is built by jq from the anchor (already limited to [A-Za-z0-9:,._-]), never pasted into JSON.
  assert.match(agent.run, /jq -n --arg anchor "\$ANCHOR" '\{mcpServers: \{dsa: \{command: "npx", args: \["dsa", "mcp", "--anchor", \$anchor\]\}\}\}'/);
  assert.match(agent.run, /claude -p --strict-mcp-config --mcp-config "\$RUNNER_TEMP\/mcp\.json" --allowedTools "\$tools"/);
  const list = agent.run.match(/dsa_tools="([^"]+)"/)![1] as string;
  assert.deepEqual(list.split(','), READ_TOOLS.map(t => `mcp__dsa__${t}`));
  assert.match(agent.run, /tools="Read,Grep,Glob,\$dsa_tools"/);
  assert.match(agent.run, /tools="Read,Grep,Glob,Edit,Write,\$dsa_tools"/, 'draft-fix keeps them too');
  assert.match(agent.run, /propose_\* tools are not available here, so don't offer to record one/);
});

test('on the fixture: dsa mcp --anchor answers get_subject for the thread, and a role-map component has an entry', async () => {
  const root = fixtureCopy();
  const dataDir = tmp();
  const { config } = loadConfig(root);
  await runPipeline({ root, dataDir, git: false, now: NOW });
  useProfile(ACME_PROFILE);
  const snap = await writeSnapshot({ root, config, dataDir, configDir: root, profile: ACME_PROFILE } as any);

  const h = createHandler({ dataDir, subject: { kind: 'component', name: 'Select' } });
  const subj = await h({ method: 'tools/call', params: { name: 'get_subject', arguments: {} } });
  assert.match(subj.content[0].text, /Select/);
  const scan = await createHandler({ dataDir })({ method: 'tools/call', params: { name: 'get_subject', arguments: {} } });
  assert.notEqual(scan.content[0].text, subj.content[0].text, 'without --anchor it is the whole scan, as before');

  // The acme profile lists no components, but its role map has select → Select.
  const entry = componentEntry('Select');
  assert.ok(entry, 'a component the role map names has an entry');
  assert.equal(entry.fromRoles, true);
  assert.ok(entry.roles.includes('select'));
  const known = whatTheAgentKnows(snap, { kind: 'component', name: 'Select' }).find(s => s.layer === 'system' && /entry/.test(s.name))!;
  assert.equal(known.status, 'included');
  assert.match(known.detail, /role map/);
  const brief = buildBrief(snap, { kind: 'component', name: 'Select' }).markdown;
  assert.doesNotMatch(brief, /has no entry for Select/);
  assert.doesNotMatch(brief, /\*\*Select\*\*: not in the design system's component list/);
  assert.equal(componentEntry('NoSuchThing'), null, 'a name nothing maps still has none');
});
