import path from 'node:path';
import type { Command } from 'commander';
import { defineAddon, type AddonApi } from '@snds/dsa';
import { buildBrief, type Subject } from './context.js';
import { serveMcp } from './mcp.js';
import { agentRoutes } from './routes.js';
import { readSnapshot, writeSnapshot } from './snapshot.js';
import { useProfile } from './system.js';
import { THREAD_WORKFLOW, subjectForAnchor } from './workflow.js';
import fs from 'node:fs';

export { buildBrief, componentEntry, legacyOf, repoFor, subjectKey, titleOf, PERSONA, type Brief, type IssueSource, type Starter, type Subject } from './context.js';
export { componentOf, evidenceOf, guidelines, pastDecisions, relatedThreads, tokensFor, whatTheAgentKnows, type Layer, type Source } from './knows.js';
export { anchorKey, anchorOf, idsKey, readThreadIndex, STATE_LABEL, threadIndex, threadState, writeThreadIndex, type Anchor, type ThreadEntry, type ThreadFacts, type ThreadState } from './threads.js';
export { createHandler, serveMcp, TOOLS, SERVER_INFO, type McpEnv } from './mcp.js';
export { propose, readProposals, setStatus, recommendationProblems, readFeedback, addFeedback, feedbackPath, type Proposal, type ProposalKind } from './proposals.js';
export { claudeArgs, cursorArgs, detectProviders, startTurn, toolSummary, type AgentEvent, type Mode, type ProviderId } from './providers.js';
export { agentRoutes } from './routes.js';
export { subjectForAnchor, threadMarker, REPLY_MARKER, THREAD_WORKFLOW } from './workflow.js';
export { addDismissal, readDismissals, undoDismissal, DISMISS_LABELS, type Dismissal, type DismissLabel } from './dismissals.js';
export { readComponentChecks, setComponentCheck, type ComponentCheck } from './component-checks.js';
export { githubWho, openDraftPr, prText, type PrContext, type Run } from './draft-pr.js';
export { createSession, readSession, writeSession, listSessions, deleteSession, discardSandbox, keepChanges, sandboxChanges, mcpConfig, addWorktree, excludes, depLinks, runTurn, SANDBOXES, VITE_WRAPPER, type Session } from './sessions.js';
export { readSnapshot, writeSnapshot, agentDir, revealedOf, type Snapshot } from './snapshot.js';
export { beforeAfter, pickElements, routesFor, viteWrapper, visualFile, diffHash, type VisualRun } from './visual.js';
export { useProfile, contextArgs, DSA_CLI } from './system.js';

/** "E-1,E-2" (review), "R:<repo>" (readiness), anything else a queue item; nothing: the whole scan. */
export function subjectOf(id?: string): Subject {
  if (!id) return { kind: 'scan' };
  if (id.startsWith('E-')) return { kind: 'review', ids: id.split(',') };
  if (id.startsWith('R:')) return { kind: 'readiness', subject: id.slice(2) };
  return { kind: 'queue', id };
}

export default defineAddon({
  name: '@snds/dsa-agent',
  routes: agentRoutes,
  afterRun: [
    {
      // What an agent reads (the MCP server, briefs): refreshed after each scan the dashboard runs.
      id: 'Agent snapshot',
      order: 90,
      async run({ kind, ctx, options, log }) {
        if (kind !== 'run' || options.from !== 'serve') return;
        useProfile(ctx.profile);
        await writeSnapshot(ctx).catch((e: any) => log(`Agent snapshot skipped: ${String(e?.message ?? e).split('\n')[0]}`));
      },
    },
  ],
  commands(program: Command, api: AddonApi) {
    program
      .command('mcp')
      .description('the scan as MCP tools over stdio, for Claude Code, Cursor or any MCP client')
      .option('--session <id>', 'a dashboard session (proposals are tied to it)')
      .option('--repo <dir>', "the repo the agent works in (check_file reads from it)")
      .action(async (o: { session?: string; repo?: string }, cmd: Command) => {
        // MCP over stdio: stdout is the protocol, so nothing else may print there.
        const ctx = await api.context(cmd);
        useProfile(ctx.profile);
        await serveMcp({ dataDir: ctx.dataDir, session: o.session, repoDir: o.repo ? path.resolve(api.cwd, o.repo) : ctx.root });
      });

    // dsa brief <anchor>: the brief a thread's agent gets, for a workflow or a terminal (stage 9).
    program
      .command('brief')
      .argument('<anchor>', 'issue:<key>, component:<name>, group:component:<name>, group:app:<name>, elements:<ids>, or scan')
      .option('--out <file>', 'write it to a file instead of printing it')
      .description("write the brief a thread's agent gets, the same one the dashboard's chat uses")
      .action(async (anchor: string, o: { out?: string }, cmd: Command) => {
        const ctx = await api.context(cmd);
        await api.requireStore('brief');
        useProfile(ctx.profile);
        const snap = readSnapshot(ctx.dataDir) ?? (await writeSnapshot(ctx));
        const md = buildBrief(snap, subjectForAnchor(ctx.dataDir, anchor)).markdown;
        if (o.out) { fs.mkdirSync(path.dirname(path.resolve(api.cwd, o.out)), { recursive: true }); fs.writeFileSync(path.resolve(api.cwd, o.out), md); api.out(`Wrote the brief for ${anchor} to ${o.out}`); }
        else api.out(md);
      });

    const agent = program.command('agent').description('agents working with the scan');
    agent
      .command('workflow')
      .description('print the GitHub workflow that lets the agent reply on dsa-thread issues from a published page')
      .action(() => api.out(THREAD_WORKFLOW));
    agent
      .command('brief')
      .argument('[id]', 'E-id,E-id (a review group), F-id or A-id (a queue item), R:<repo> (readiness); nothing: the whole scan')
      .description('print the brief an agent gets for a review group, a queue item or a repo')
      .action(async (id: string | undefined, _o: unknown, cmd: Command) => {
        const ctx = await api.context(cmd);
        await api.requireStore('agent brief');
        useProfile(ctx.profile);
        const snap = readSnapshot(ctx.dataDir) ?? (await writeSnapshot(ctx));
        api.out(buildBrief(snap, subjectOf(id)).markdown);
      });
  },
});
