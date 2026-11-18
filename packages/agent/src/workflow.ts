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
export function subjectForAnchor(dataDir: string, key: string, snap: Pick<Snapshot, 'evals' | 'threshold'> & Partial<Pick<Snapshot, 'issues' | 'targets' | 'queue' | 'readiness'>> | null = readSnapshot(dataDir)): Subject {
  const t = readThreadIndex(dataDir)[key];
  const own = t ? readSession(dataDir, t.session)?.subject : null;
  if (own) return own;
  // Names after the second colon may hold colons, spaces, @ and / (an app "Commerce kit", a package name).
  const [kind = '', a = '', ...rest] = key.split(':');
  const b = rest.join(':');
  if (kind === 'issue' && a) {
    // Component checks (C-…), readiness checks (R-…) and questions (Q-…) are briefed as the issue they are.
    const i = snap?.issues?.find(x => x.key === a);
    if (i) return { kind: 'issue', key: a, title: i.title, source: i.source };
    return /^[FA]-/.test(a) ? { kind: 'queue', id: a } : { kind: 'issue', key: a };
  }
  if (kind === 'component' && a) return { kind: 'component', name: nameIn(snap, [a, ...rest].join(':'), 'component') };
  if (kind === 'group' && (a === 'component' || a === 'app') && b) return a === 'app' ? { kind: 'readiness', subject: nameIn(snap, b, 'app') } : { kind: 'group', by: 'component', value: nameIn(snap, b, 'component') };
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

/**
 * Anchors lowercase names (component:datatable). Give back the name as the scan spells it (DataTable,
 * "Commerce kit"), so the brief's lookups, imports and repo match; a name the scan doesn't know stays as written.
 */
function nameIn(snap: Partial<Pick<Snapshot, 'evals' | 'issues' | 'targets' | 'queue' | 'readiness'>> | null, name: string, what: 'component' | 'app'): string {
  const lc = name.toLowerCase();
  const pool: unknown[] = what === 'app'
    ? [...(snap?.targets ?? []).map(t => t.name), ...(snap?.readiness ?? []).map((r: any) => r.subject)]
    : [...(snap?.issues ?? []).map(i => i.component), ...(snap?.evals ?? []).flatMap((e: any) => [e.use, e.decided?.decision?.use]), ...(snap?.queue ?? []).flatMap((q: any) => [q.subject, q.family])];
  for (const n of pool) if (typeof n === 'string' && n.toLowerCase() === lc) return n;
  return name;
}

/** The hidden marker a Discuss-on-GitHub issue carries, which the workflow reads. */
export const threadMarker = (anchor: string) => `<!-- dsa:thread ${anchor} -->`;
export const REPLY_MARKER = '<!-- dsa:thread-reply -->';


/** The Claude Code release the workflow installs, unless the repository variable DSA_CLAUDE_CODE_VERSION names another. */
export const CLAUDE_CODE_VERSION = '2.1.317';

/** Token shapes a reply must never carry: Anthropic keys and GitHub tokens. The workflow refuses to post one. */
export const SECRET_SHAPES = String.raw`sk-ant-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}`;

/** A GitHub Actions expression, written out (the template is a string, so `${{` can't appear in it literally). */
const E = (x: string) => '${{ ' + x + ' }}';

/**
 * What the agent may and may not touch, as Claude Code settings. It can't read the process environment
 * (/proc holds the key), the runner's hidden files (the checkout itself lives under its home) or git's
 * folder, and can't edit git's folder or the workflows (Edit rules cover every editing tool).
 */
const CLAUDE_SETTINGS = JSON.stringify({ permissions: { deny: ['Read(//proc/**)', 'Read(//sys/**)', 'Read(//home/runner/.*)', 'Read(//home/runner/.*/**)', 'Read(./.git/**)', 'Edit(./.git/**)', 'Edit(./.github/**)'] } });

/** The steps both answering jobs share; `fix` adds edit tools, the draft PR, and the write permissions its job holds. */
function answerSteps(mode: 'reply' | 'fix'): string {
  const tools = READ_TOOLS.map(t => `mcp__dsa__${t}`).join(',');
  return String.raw`    steps:
      - uses: actions/checkout@v4
        with:
          # No token left in .git/config, where the agent's folder is.
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install, scan and write the brief
        id: prep
        env:
          COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'
        run: |
          # The repo's own package manager, and its own installed dsa: never "npx dsa", which can fetch
          # an unrelated package of that name when dsa isn't installed.
          if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile
          elif [ -f yarn.lock ]; then corepack enable && yarn install --immutable
          else npm ci; fi
          dsa="$GITHUB_WORKSPACE/node_modules/.bin/dsa"
          if [ ! -x "$dsa" ]; then
            echo "dsa isn't in this repository's dependencies, so the agent can't read the scan. Add the dsa packages to devDependencies (see dsa's README, Install)." > "$RUNNER_TEMP/failed.md"
            echo "::error::node_modules/.bin/dsa not found"; exit 1
          fi
          echo "DSA_BIN=$dsa" >> "$GITHUB_ENV"
          "$dsa" run --no-history
          if ! "$dsa" brief "$ANCHOR" --out "$RUNNER_TEMP/brief.md" 2> "$RUNNER_TEMP/brief-err.txt"; then
            cat "$RUNNER_TEMP/brief-err.txt"
            { echo "The agent couldn't find what this thread is about in the latest scan:"; echo; sed 's/^/> /' "$RUNNER_TEMP/brief-err.txt"; } > "$RUNNER_TEMP/failed.md"
            exit 1
          fi
          # What was already new before the agent ran (scan output), so a draft fix leaves it out.
          git ls-files --others --exclude-standard | sort > "$RUNNER_TEMP/untracked-before.txt"
          git diff --name-only | sort > "$RUNNER_TEMP/changed-before.txt"
      - name: Read the thread (only what people with write access wrote)
        env:
          GH_TOKEN: ${E('github.token')}
        run: |
          # Anyone can comment on a public repo; their text never reaches the agent.
          can() {
            [ "$1" = "github-actions[bot]" ] && return 0
            p=$(gh api "repos/$REPO/collaborators/$1/permission" --jq .permission 2>/dev/null || echo none)
            case "$p" in admin|maintain|write) return 0 ;; *) return 1 ;; esac
          }
          gh api "repos/$REPO/issues/$ISSUE" > "$RUNNER_TEMP/issue.json"
          gh api --paginate --slurp "repos/$REPO/issues/$ISSUE/comments" | jq 'add // []' > "$RUNNER_TEMP/comments.json"
          ok=""
          for u in $( { jq -r '.user.login' "$RUNNER_TEMP/issue.json"; jq -r '.[].user.login' "$RUNNER_TEMP/comments.json"; } | sort -u); do
            if can "$u"; then ok="$ok $u"; fi
          done
          jq -nr --arg ok "$ok" --slurpfile i "$RUNNER_TEMP/issue.json" --slurpfile c "$RUNNER_TEMP/comments.json" '
            ($ok | split(" ") | map(select(. != ""))) as $w
            | ($i[0] | if (.user.login | IN($w[])) then "## The issue, by @\(.user.login)\n\n\(.title)\n\n\(.body // "")" else "## The issue\n\n(Left out: its author has no write access.)" end),
              ($c[0][] | if (.user.login | IN($w[])) then "## Comment by @\(.user.login)\n\n\(.body)" else "## Comment by @\(.user.login)\n\n(Left out: no write access.)" end)
          ' > "$RUNNER_TEMP/thread.txt"
      - name: The agent answers
        id: agent
        env:
          ANTHROPIC_API_KEY: ${E('secrets.ANTHROPIC_API_KEY')}
          WORKSPACE_ID: ${E('vars.ANTHROPIC_WORKSPACE_ID')}
          CC_VERSION: ${E(`vars.DSA_CLAUDE_CODE_VERSION || '${CLAUDE_CODE_VERSION}'`)}
        run: |
          # Whatever goes wrong, the thread gets a reply saying so, and the details go to the run log.
          if [ -z "$ANTHROPIC_API_KEY" ]; then
            echo "::error::The repository has no ANTHROPIC_API_KEY secret."
            echo "The agent isn't set up here: this repository has no ANTHROPIC_API_KEY secret. A maintainer can add it under Settings, Secrets and variables, Actions." > "$RUNNER_TEMP/answer.md"
            echo "ok=false" >> "$GITHUB_OUTPUT"; exit 0
          fi
          unset GH_TOKEN GITHUB_TOKEN
          if [ -n "$WORKSPACE_ID" ]; then export ANTHROPIC_CUSTOM_HEADERS="anthropic-workspace-id: $WORKSPACE_ID"; fi
          npm i -g "@anthropic-ai/claude-code@$CC_VERSION"
          printf '%s' '${CLAUDE_SETTINGS}' > "$RUNNER_TEMP/claude-settings.json"
          # dsa's own tools on this scan, read-only: nobody is here to accept a proposal, so proposals stay text.
          jq -n --arg dsa "$DSA_BIN" --arg anchor "$ANCHOR" '{mcpServers: {dsa: {command: $dsa, args: ["mcp", "--anchor", $anchor]}}}' > "$RUNNER_TEMP/mcp.json"
          dsa_tools="${tools}"
${mode === 'fix'
    ? String.raw`          tools="Read,Grep,Glob,Edit,Write,$dsa_tools"
          ask="Make the smallest change in this checkout that does what the latest messages in the thread below ask, then say what you changed and how to verify it. Don't touch .github or .git."`
    : String.raw`          tools="Read,Grep,Glob,$dsa_tools"
          ask="Answer the messages in the thread below that came after your last reply (the issue itself when there are no comments yet), in plain words, citing evidence. If you would change something, say so as a proposal for a person; never decide. The propose_* tools are not available here, so don't offer to record one."`}
          { cat "$RUNNER_TEMP/brief.md"; echo; echo "## The GitHub thread"; echo; cat "$RUNNER_TEMP/thread.txt"; echo; echo "$ask"; } > "$RUNNER_TEMP/prompt.md"
          if ! claude -p --settings "$RUNNER_TEMP/claude-settings.json" --strict-mcp-config --mcp-config "$RUNNER_TEMP/mcp.json" --allowedTools "$tools" < "$RUNNER_TEMP/prompt.md" > "$RUNNER_TEMP/answer.md" 2> "$RUNNER_TEMP/agent-err.txt"; then
            echo "::error::The agent failed:"; cat "$RUNNER_TEMP/agent-err.txt"
            # What it wrote, for the log, with anything shaped like a secret blanked out.
            sed -E 's/(${SECRET_SHAPES})/[redacted]/g' "$RUNNER_TEMP/answer.md" | head -50
            echo "The agent couldn't answer this time. A maintainer can see why in the run log: $RUN_URL" > "$RUNNER_TEMP/answer.md"
            echo "ok=false" >> "$GITHUB_OUTPUT"; exit 0
          fi
          # Never post something shaped like a key or token, whatever the thread asked for.
          if grep -Eq '${SECRET_SHAPES}' "$RUNNER_TEMP/answer.md" || grep -Fq "$ANTHROPIC_API_KEY" "$RUNNER_TEMP/answer.md"; then
            echo "::error::The answer contained something shaped like a secret; it was not posted."
            echo "The agent's answer contained something shaped like a key or token, so it wasn't posted. A maintainer can look at the run: $RUN_URL" > "$RUNNER_TEMP/answer.md"
            echo "ok=false" >> "$GITHUB_OUTPUT"; exit 0
          fi
          echo "ok=true" >> "$GITHUB_OUTPUT"
${mode === 'fix' ? String.raw`      - name: Open a draft PR
        id: pr
        if: steps.agent.outputs.ok == 'true'
        env:
          GH_TOKEN: ${E('github.token')}
        run: |
          # The agent's changes only: files it changed or created, not the scan's output, never .github.
          git diff --name-only | sort | comm -23 - "$RUNNER_TEMP/changed-before.txt" > "$RUNNER_TEMP/changed.txt"
          git ls-files --others --exclude-standard | sort | comm -23 - "$RUNNER_TEMP/untracked-before.txt" >> "$RUNNER_TEMP/changed.txt"
          grep -v -e '^\.github/' -e '^\.git/' "$RUNNER_TEMP/changed.txt" > "$RUNNER_TEMP/files.txt" || true
          if [ ! -s "$RUNNER_TEMP/files.txt" ]; then echo "url=" >> "$GITHUB_OUTPUT"; exit 0; fi
          branch="dsa-thread/$ISSUE-$(date -u +%Y%m%d%H%M%S)"
          git switch -qc "$branch"
          while IFS= read -r f; do git add -- "$f"; done < "$RUNNER_TEMP/files.txt"
          # No hooks: the agent could have written one, and this step holds the token.
          git -c core.hooksPath=/dev/null -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit --no-verify -qm "Draft fix from dsa thread #$ISSUE"
          auth=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)
          git -c core.hooksPath=/dev/null -c http.extraheader="AUTHORIZATION: basic $auth" push -q origin "$branch"
          # Needs "Allow GitHub Actions to create and approve pull requests" in the repo's Actions settings.
          url=$(gh pr create --repo "$REPO" --draft --head "$branch" --title "Draft fix from dsa thread #$ISSUE" --body "A draft from the dsa thread #$ISSUE, asked for by @$ACTOR. Review before marking it ready.")
          echo "url=$url" >> "$GITHUB_OUTPUT"
` : ''}      - name: Reply
        if: always()
        env:
          GH_TOKEN: ${E('github.token')}
          PR: ${E('steps.pr.outputs.url')}
        run: |
          if [ ! -s "$RUNNER_TEMP/answer.md" ]; then
            if [ -s "$RUNNER_TEMP/failed.md" ]; then cp "$RUNNER_TEMP/failed.md" "$RUNNER_TEMP/answer.md"
            else echo "The agent couldn't answer this time: a step before it failed. A maintainer can see why in the run log: $RUN_URL" > "$RUNNER_TEMP/answer.md"; fi
          fi
          { echo "${REPLY_MARKER}"; cat "$RUNNER_TEMP/answer.md"; if [ -n "$PR" ]; then printf '\n\nDraft PR: %s\n' "$PR"; fi; } > "$RUNNER_TEMP/reply.md"
          gh issue comment "$ISSUE" --repo "$REPO" --body-file "$RUNNER_TEMP/reply.md"
      - name: Mark the run failed when the agent didn't answer
        if: always() && (failure() || steps.agent.outputs.ok != 'true')
        run: exit 1
`;
}

/** The workflow template, printed by `dsa agent workflow`. Nothing writes it into a repo for you. */
export const THREAD_WORKFLOW = String.raw`# dsa-thread: the agent replies on GitHub issues opened from a published dsa page.
# Copy to .github/workflows/dsa-thread.yml. Needs:
# - the repository secret ANTHROPIC_API_KEY (and the variable ANTHROPIC_WORKSPACE_ID for a key not scoped to a workspace);
# - dsa installed in the repo's devDependencies, so node_modules/.bin/dsa exists after install;
# - for /dsa draft-fix, Settings > Actions > General > "Allow GitHub Actions to create and approve pull requests".
# Optional variables: DSA_THREAD_DAILY_LIMIT (default 30 replies a day), DSA_CLAUDE_CODE_VERSION.
# It acts on issues labelled dsa-thread or carrying the page's hidden marker, so it works where the label
# doesn't exist (a new-issue link drops a label the repo lacks). Only people with write access start it, and
# only their words reach the agent; the agent can't read the job's tokens, and its answer is checked for
# anything shaped like a secret before it is posted.
name: dsa-thread
on:
  issues:
    types: [opened]
  issue_comment:
    types: [created]
permissions: {}
concurrency:
  # Queued, not cancelled; each run answers everything since the last reply, so a skipped run loses nothing.
  group: dsa-thread-${E('github.event.issue.number')}
  cancel-in-progress: false
env:
  REPO: ${E('github.repository')}
  ISSUE: ${E('github.event.issue.number')}
  ACTOR: ${E('github.event.sender.login')}
  RUN_URL: ${E('github.server_url')}/${E('github.repository')}/actions/runs/${E('github.run_id')}
jobs:
  gate:
    if: >-
      (contains(github.event.issue.labels.*.name, 'dsa-thread') || contains(github.event.issue.body, 'dsa:thread ')) &&
      github.event.sender.type != 'Bot' &&
      !contains(github.event.comment.body || '', '${REPLY_MARKER}')
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      issues: write   # the daily-limit and no-access notes
    outputs:
      ok: ${E('steps.ask.outputs.ok')}
      mode: ${E('steps.ask.outputs.mode')}
      anchor: ${E('steps.ask.outputs.anchor')}
    env:
      GH_TOKEN: ${E('github.token')}
      # User text only ever reaches the steps as environment variables, never inside the script.
      ISSUE_BODY: ${E('github.event.issue.body')}
      TEXT: ${E('github.event.comment.body || github.event.issue.body')}
      LIMIT: ${E("vars.DSA_THREAD_DAILY_LIMIT || '30'")}
    steps:
      - name: Keep to the daily limit
        id: limit
        run: |
          # Only the bot's own replies count: anyone could post a comment that merely contains the marker.
          since=$(date -u +%Y-%m-%dT00:00:00Z)
          n=$(gh api --paginate "repos/$REPO/issues/comments?since=$since&per_page=100" --jq '[.[] | select(.user.login == "github-actions[bot]" and (.body | contains("dsa:thread-reply")))] | length' | awk '{s+=$1} END {print s+0}')
          if [ "$n" -ge "$LIMIT" ]; then
            echo "ok=false" >> "$GITHUB_OUTPUT"
            gh issue comment "$ISSUE" --repo "$REPO" --body "${REPLY_MARKER}
          The agent has replied $n times today, the daily limit. It answers again tomorrow, or a maintainer can raise DSA_THREAD_DAILY_LIMIT."
          else echo "ok=true" >> "$GITHUB_OUTPUT"; fi
      - name: Only people with write access run the agent
        id: gate
        if: steps.limit.outputs.ok == 'true'
        run: |
          perm=$(gh api "repos/$REPO/collaborators/$ACTOR/permission" --jq .permission 2>/dev/null || echo none)
          case "$perm" in
            admin|maintain|write) echo "ok=true" >> "$GITHUB_OUTPUT" ;;
            *)
              echo "ok=false" >> "$GITHUB_OUTPUT"
              echo "$ACTOR has $perm access; the agent only answers people with write access."
              # Say so once per issue, so the person isn't left wondering.
              if ! gh api "repos/$REPO/issues/$ISSUE/comments" --jq '.[].body' | grep -q 'dsa:thread-noaccess'; then
                gh issue comment "$ISSUE" --repo "$REPO" --body "${REPLY_MARKER}
          <!-- dsa:thread-noaccess -->
          The dsa agent only answers people with write access to this repository. A maintainer can ask it here."
              fi ;;
          esac
      - name: Read the thread's anchor and the ask
        id: ask
        if: steps.gate.outputs.ok == 'true'
        run: |
          # The page writes <!-- dsa:thread <anchor> -->; names in an anchor can hold spaces, @ and /.
          anchor=$(printf '%s\n' "$ISSUE_BODY" | sed -n 's/.*<!-- dsa:thread \(.*\) -->.*/\1/p' | head -1)
          [ -n "$anchor" ] || anchor=scan
          case "$anchor" in
            issue:*|component:*|group:component:*|group:app:*|elements:*|scan) ;;
            *) echo "Not a dsa anchor: $anchor"; anchor=scan ;;
          esac
          # One line, a sane length, no leading dash, no control characters.
          anchor=$(printf '%s' "$anchor" | tr -d '\000-\037' | cut -c1-200)
          echo "anchor=$anchor" >> "$GITHUB_OUTPUT"
          if printf '%s' "$TEXT" | grep -q '^/dsa draft-fix'; then echo "mode=fix" >> "$GITHUB_OUTPUT"; else echo "mode=reply" >> "$GITHUB_OUTPUT"; fi
          echo "ok=true" >> "$GITHUB_OUTPUT"
  reply:
    needs: gate
    if: needs.gate.outputs.ok == 'true' && needs.gate.outputs.mode == 'reply'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      issues: write   # the reply
    env:
      ANCHOR: ${E('needs.gate.outputs.anchor')}
${answerSteps('reply')}  fix:
    needs: gate
    if: needs.gate.outputs.ok == 'true' && needs.gate.outputs.mode == 'fix'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: write        # pushes the draft's branch
      issues: write          # the reply
      pull-requests: write   # opens the draft PR
    env:
      ANCHOR: ${E('needs.gate.outputs.anchor')}
${answerSteps('fix')}`;
