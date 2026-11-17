import { questions } from '@snds/dsa/engine';
import { readSession } from './sessions.js';
import { READ_TOOLS } from './mcp.js';
import { readSnapshot, type Snapshot } from './snapshot.js';
import { idsKey, readThreadIndex } from './threads.js';
import type { Subject } from './context.js';

/**
 * The GitHub route for a published page (redesign stage 9). A thread continues as a GitHub issue
 * labelled dsa-thread, with its anchor in a hidden marker; this workflow replies there. It never
 * runs for someone without write access, keeps to a daily limit, holds the model key as a repository
 * secret, and only drafts: proposals are text for a person to act on, and `/dsa draft-fix` opens a
 * draft pull request, never a merge.
 */

/**
 * A review batch's key is a hash of its ids, so it can't be read back. Recompute it over the groups the
 * page builds from the same scan (its review questions and their parts, then single places) and take
 * the one that matches. This needs only the scan data, not the thread index a published copy lacks.
 */
export function batchForKey(snap: Pick<Snapshot, 'evals' | 'threshold'>, key: string): { ids: string[]; title?: string } | null {
  for (const answered of [true, false]) {
    for (const q of questions(snap.evals as any[], { answered, threshold: snap.threshold })) {
      const ids = q.items.map(e => e.id);
      if (idsKey(ids) === key) return { ids, title: q.title };
      for (const p of q.parts ?? []) { const pids = p.items.map(e => e.id); if (idsKey(pids) === key) return { ids: pids, title: q.title }; }
    }
  }
  for (const e of snap.evals) if (idsKey([e.id]) === key) return { ids: [e.id] };
  return null;
}

/** The subject an anchor key stands for: the thread's own subject when there is one, else read from the key and the scan. */
export function subjectForAnchor(dataDir: string, key: string, snap: Pick<Snapshot, 'evals' | 'threshold'> | null = readSnapshot(dataDir)): Subject {
  const t = readThreadIndex(dataDir)[key];
  const own = t ? readSession(dataDir, t.session)?.subject : null;
  if (own) return own;
  const [kind, a = '', b = ''] = key.split(':');
  if (kind === 'issue' && a) return /^[FA]-/.test(a) ? { kind: 'queue', id: a } : { kind: 'issue', key: a };
  if (kind === 'component' && a) return { kind: 'component', name: a };
  if (kind === 'group' && (a === 'component' || a === 'app') && b) return a === 'app' ? { kind: 'readiness', subject: b } : { kind: 'group', by: 'component', value: b };
  // A batch's key is a hash; written out as its ids (elements:E-1,E-2) it can still be briefed.
  if (kind === 'elements' && a && !/^E-[0-9A-F]{8}$/.test(a)) return { kind: 'review', ids: a.split(',') };
  if (kind === 'elements') {
    const b = snap ? batchForKey(snap, a) : null;
    if (b) return { kind: 'review', ids: b.ids, ...(b.title ? { title: b.title } : {}) };
    throw new Error(`No review group in this scan has the key ${a}: the scan changed since the page was published, or the data is missing. Give the ids instead: elements:E-1,E-2.`);
  }
  if (key === 'scan') return { kind: 'scan' };
  throw new Error(`Not an anchor: ${key}. Use issue:<key>, component:<name>, group:component:<name>, group:app:<name>, elements:<ids> or scan.`);
}

/** The hidden marker a Discuss-on-GitHub issue carries, which the workflow reads. */
export const threadMarker = (anchor: string) => `<!-- dsa:thread ${anchor} -->`;
export const REPLY_MARKER = '<!-- dsa:thread-reply -->';

/** The workflow template, printed by `dsa agent workflow`. Nothing writes it into a repo for you. */
export const THREAD_WORKFLOW = String.raw`# dsa-thread: the agent replies on GitHub issues opened from a published dsa page.
# Copy to .github/workflows/dsa-thread.yml. Needs the repository secret ANTHROPIC_API_KEY, and
# Settings > Actions > General > "Allow GitHub Actions to create and approve pull requests" for /dsa draft-fix.
# A key that isn't scoped to a workspace also needs the repository variable ANTHROPIC_WORKSPACE_ID.
# It acts on issues labelled dsa-thread or carrying the page's hidden marker, so it works where the
# label doesn't exist (a new-issue link drops a label the repo lacks).
# Optional repository variable DSA_THREAD_DAILY_LIMIT (default 30 replies a day).
name: dsa-thread
on:
  issues:
    types: [opened]
  issue_comment:
    types: [created]
permissions:
  contents: write        # /dsa draft-fix pushes a branch
  issues: write          # replies
  pull-requests: write   # /dsa draft-fix opens a draft PR
concurrency:
  group: dsa-thread-${'$'}{{ github.event.issue.number }}
jobs:
  reply:
    if: >-
      (contains(github.event.issue.labels.*.name, 'dsa-thread') || contains(github.event.issue.body, 'dsa:thread ')) &&
      github.event.sender.type != 'Bot' &&
      !contains(github.event.comment.body || '', '${REPLY_MARKER}')
    runs-on: ubuntu-latest
    timeout-minutes: 20
    env:
      GH_TOKEN: ${'$'}{{ github.token }}
      REPO: ${'$'}{{ github.repository }}
      ISSUE: ${'$'}{{ github.event.issue.number }}
      ACTOR: ${'$'}{{ github.event.sender.login }}
      RUN_URL: ${'$'}{{ github.server_url }}/${'$'}{{ github.repository }}/actions/runs/${'$'}{{ github.run_id }}
      # User text only ever reaches the steps as environment variables, never inside the script.
      ISSUE_BODY: ${'$'}{{ github.event.issue.body }}
      TEXT: ${'$'}{{ github.event.comment.body || github.event.issue.body }}
      LIMIT: ${'$'}{{ vars.DSA_THREAD_DAILY_LIMIT || '30' }}
    steps:
      - name: Only people with write access run the agent
        id: gate
        run: |
          perm=$(gh api "repos/$REPO/collaborators/$ACTOR/permission" --jq .permission 2>/dev/null || echo none)
          case "$perm" in
            admin|maintain|write) echo "ok=true" >> "$GITHUB_OUTPUT" ;;
            *) echo "ok=false" >> "$GITHUB_OUTPUT"; echo "$ACTOR has $perm access; the agent only answers people with write access." ;;
          esac
      - name: Keep to the daily limit
        id: limit
        if: steps.gate.outputs.ok == 'true'
        run: |
          since=$(date -u +%Y-%m-%dT00:00:00Z)
          n=$(gh api --paginate "repos/$REPO/issues/comments?since=$since&per_page=100" --jq '[.[] | select(.body | contains("dsa:thread-reply"))] | length' | awk '{s+=$1} END {print s+0}')
          if [ "$n" -ge "$LIMIT" ]; then
            echo "ok=false" >> "$GITHUB_OUTPUT"
            gh issue comment "$ISSUE" --repo "$REPO" --body "${REPLY_MARKER}
          The agent has replied $n times today, the daily limit. It answers again tomorrow, or a maintainer can raise DSA_THREAD_DAILY_LIMIT."
          else echo "ok=true" >> "$GITHUB_OUTPUT"; fi
      - name: Read the thread's anchor and the ask
        id: ask
        if: steps.limit.outputs.ok == 'true'
        run: |
          anchor=$(printf '%s' "$ISSUE_BODY" | grep -o 'dsa:thread [A-Za-z0-9:,._-]*' | head -1 | cut -d' ' -f2)
          [ -n "$anchor" ] || anchor=scan
          echo "anchor=$anchor" >> "$GITHUB_OUTPUT"
          if printf '%s' "$TEXT" | grep -q '^/dsa draft-fix'; then echo "mode=fix" >> "$GITHUB_OUTPUT"; else echo "mode=reply" >> "$GITHUB_OUTPUT"; fi
      - uses: actions/checkout@v4
        if: steps.limit.outputs.ok == 'true'
      - uses: actions/setup-node@v4
        if: steps.limit.outputs.ok == 'true'
        with:
          node-version: 22
      - name: Scan and write the brief
        if: steps.limit.outputs.ok == 'true'
        env:
          ANCHOR: ${'$'}{{ steps.ask.outputs.anchor }}
        run: |
          npm ci
          npx dsa run --no-history
          npx dsa brief "$ANCHOR" --out "$RUNNER_TEMP/brief.md"
          # The issue's description (a new thread's question is there), then its comments.
          { gh issue view "$ISSUE" --repo "$REPO"; echo; echo "--- comments ---"; gh issue view "$ISSUE" --repo "$REPO" --comments; } > "$RUNNER_TEMP/thread.txt"
      - name: The agent answers
        id: agent
        if: steps.limit.outputs.ok == 'true'
        env:
          ANTHROPIC_API_KEY: ${'$'}{{ secrets.ANTHROPIC_API_KEY }}
          WORKSPACE_ID: ${'$'}{{ vars.ANTHROPIC_WORKSPACE_ID }}
          ANCHOR: ${'$'}{{ steps.ask.outputs.anchor }}
          MODE: ${'$'}{{ steps.ask.outputs.mode }}
        run: |
          # Whatever goes wrong, the thread gets a reply saying so, and the details go to the run log.
          if [ -z "$ANTHROPIC_API_KEY" ]; then
            echo "::error::The repository has no ANTHROPIC_API_KEY secret."
            echo "The agent isn't set up here: this repository has no ANTHROPIC_API_KEY secret. A maintainer can add it under Settings, Secrets and variables, Actions." > "$RUNNER_TEMP/answer.md"
            echo "ok=false" >> "$GITHUB_OUTPUT"; exit 0
          fi
          if [ -n "$WORKSPACE_ID" ]; then export ANTHROPIC_CUSTOM_HEADERS="anthropic-workspace-id: $WORKSPACE_ID"; fi
          npm i -g @anthropic-ai/claude-code
          # dsa's own tools on this scan, read-only: nobody is here to accept a proposal, so proposals stay text.
          jq -n --arg anchor "$ANCHOR" '{mcpServers: {dsa: {command: "npx", args: ["dsa", "mcp", "--anchor", $anchor]}}}' > "$RUNNER_TEMP/mcp.json"
          dsa_tools="${READ_TOOLS.map(t => `mcp__dsa__${t}`).join(',')}"
          tools="Read,Grep,Glob,$dsa_tools"
          ask="Answer the latest message in the thread below (the issue's description when it has no comments yet), in plain words, citing evidence. If you would change something, say so as a proposal for a person; never decide."
          if [ "$MODE" = fix ]; then
            tools="Read,Grep,Glob,Edit,Write,$dsa_tools"
            ask="Make the smallest change in this checkout that fixes what the thread asks, then say what you changed and how to verify it."
          fi
          { cat "$RUNNER_TEMP/brief.md"; echo; echo "## The GitHub thread"; cat "$RUNNER_TEMP/thread.txt"; echo; echo "$ask"; } > "$RUNNER_TEMP/prompt.md"
          if claude -p --strict-mcp-config --mcp-config "$RUNNER_TEMP/mcp.json" --allowedTools "$tools" < "$RUNNER_TEMP/prompt.md" > "$RUNNER_TEMP/answer.md" 2> "$RUNNER_TEMP/agent-err.txt"; then
            echo "ok=true" >> "$GITHUB_OUTPUT"
          else
            echo "::error::The agent failed:"; cat "$RUNNER_TEMP/answer.md" "$RUNNER_TEMP/agent-err.txt"
            echo "The agent couldn't answer this time. A maintainer can see why in the run log: $RUN_URL" > "$RUNNER_TEMP/answer.md"
            echo "ok=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Open a draft PR (/dsa draft-fix)
        id: pr
        if: steps.limit.outputs.ok == 'true' && steps.ask.outputs.mode == 'fix' && steps.agent.outputs.ok == 'true'
        run: |
          if git diff --quiet; then echo "url=" >> "$GITHUB_OUTPUT"; exit 0; fi
          branch="dsa-thread/$ISSUE-$(date -u +%Y%m%d%H%M)"
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git switch -c "$branch"
          git commit -qam "Draft fix from dsa thread #$ISSUE"
          git push -q origin "$branch"
          # Needs "Allow GitHub Actions to create and approve pull requests" in the repo's Actions settings.
          url=$(gh pr create --repo "$REPO" --draft --head "$branch" --title "Draft fix from dsa thread #$ISSUE" --body "A draft from the dsa thread #$ISSUE, asked for by @$ACTOR. Review before marking it ready.")
          echo "url=$url" >> "$GITHUB_OUTPUT"
      - name: Reply
        if: steps.limit.outputs.ok == 'true'
        env:
          PR: ${'$'}{{ steps.pr.outputs.url }}
        run: |
          { echo "${REPLY_MARKER}"; cat "$RUNNER_TEMP/answer.md"; if [ -n "$PR" ]; then printf '\n\nDraft PR: %s\n' "$PR"; fi; } > "$RUNNER_TEMP/reply.md"
          gh issue comment "$ISSUE" --repo "$REPO" --body-file "$RUNNER_TEMP/reply.md"
      - name: Mark the run failed when the agent didn't answer
        if: steps.limit.outputs.ok == 'true' && steps.agent.outputs.ok == 'false'
        run: exit 1
`;
