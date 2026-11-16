# 4. The pinned agent thread

**Short version:** today's agent session becomes a thread pinned to an issue, a group or a component.
It keeps its state across visits and scans. It tells you what it knows. Every change it wants is a
proposal a person approves, step by step, up to a draft pull request.

This builds on what exists. It does not start over:

- `packages/agent/src/context.ts` builds the brief (evidence, design-system entries, intent,
  starters).
- `packages/agent/src/sessions.ts` stores sessions as JSON under `<data>/agent/sessions` and runs
  turns through Claude Code or Cursor.
- `packages/agent/src/proposals.ts` holds the five proposal kinds.
- `packages/agent/src/mcp.ts` serves the dsa tools to the agent.
- `packages/dashboard/ui/src/agent/` holds the store, the side panel, `AskAgent` and `canChat()`.

## What a thread attaches to

A thread has one **anchor**. The anchor is the `Subject` that already exists, with three new kinds.

| Anchor | Use it for | Subject today | Subject after |
| --- | --- | --- | --- |
| **One issue** | "Is this right? Fix it." Default for every issue | `queue` (findings) or `review` (element ids) | `{ kind: "issue", key }` |
| **A group** | "One decision for all 12 `Select` places?" | `review` with many ids | `{ kind: "group", by: "component" \| "kind", key }` |
| **A component** | "Why does everyone override `DataTable`?" | none | `{ kind: "component", name }` |
| **The scan** | "What matters most this week?" | `scan` | `scan` (unchanged) |

Old `queue`, `review` and `readiness` subjects map to an issue key, so existing sessions show up on
the right issue after the change.

**One thread per anchor.** Opening an issue opens its thread, or offers to start it. A person can
start a fresh thread on the same anchor (*New thread*). The old one stays in that anchor's thread
list. This keeps the common case simple and the history whole.

## What the agent knows

The brief grows from three sections to five. Each section is a block in the brief file, so Cursor
and a terminal session get the same facts.

| Layer | Holds | Status |
| --- | --- | --- |
| **Rules of the room** | The persona: plain language, evidence first, propose don't decide | Exists (`PERSONA`) |
| **The system** | Each component in play: import, variants, docs; its **usage guidelines** in full; the **tokens** in play (names, values, the token a hard-coded value should be) | Import, variants and the docs path exist. Guidelines and tokens are new, read through the profile |
| **The evidence** | Places, code, photos, proposal drawings, scanner reasons, alternatives, signature match | Exists for review and queue subjects. Added for groups and components |
| **The memory** | Past decisions and labels for this component or pattern; accepted **and rejected** proposals with their reasons; scanner hints; team Notes and Rules; other threads on this component (their summaries) | New. Each item is cited by ID |
| **The repo** | `AGENTS.md`, the design system's own agent tools, `check_file` | Exists |

**The person can see it.** A *What the agent knows* drawer in the thread header lists every source,
with a count and a link: "12 places · 3 photos · Select docs · 2 past decisions · 1 rejected proposal
· team notes". When a source is missing (no photos, no guidelines), the drawer says so. This is the
main trust lever: a reviewer can spot that the agent never saw a photo before believing a visual
claim.

**Pinned to a scan.** The brief records the scan it was built from. When a newer scan changes the
evidence, the thread shows "The evidence changed since this thread started: 3 places were fixed, 1
is new." One button rebuilds the brief and tells the agent what changed.

**New tools for the memory layer** (read-only, in `mcp.ts`): `past_decisions`, `component_guidelines`,
`tokens_for`, `related_threads`. Each returns cited items, so the persona's "cite what you looked
at" rule still holds.

## What the agent can do

Five actions, each a step on a ladder. Every step up needs a person's click. The agent can suggest
the next step, never take it.

| Step | What the agent does | What the person approves | Exists today? |
| --- | --- | --- | --- |
| 1. **Explain** | Answers in the thread, citing evidence | Nothing | Yes |
| 2. **Propose** | A decision, policy, scanner hint, scanner note, issue text, or a **dismissal with a reason** | Accept or reject each proposal card | Yes, except dismissal |
| 3. **Try** | Edits a throwaway copy (the sandbox), runs `check_file`, takes before-and-after photos | *Allow sandbox* for this thread | Yes |
| 4. **Keep** | Commits the sandbox diff to a local branch | *Keep as branch* | Yes |
| 5. **Draft PR** | Pushes the branch and opens a **draft** pull request with the evidence and the thread linked | *Open draft PR*, with the person's own GitHub sign-in | New |

Rules for the ladder:

- **Proposals show on the issue, not only in the chat.** An open proposal puts the issue in *Waiting
  on you*. Its accept and reject buttons sit in the decision bar too.
- **Answering a review** is step 2: `propose_decision` or `propose_policy`. Accepting it saves the
  answer the same way Element Review does today. On a published copy, it goes through the
  PR-based review screen another session is building.
- **A pull request is always a draft and always the person's.** DSA pushes with the person's own
  credentials, only after the click. The PR body links the issue and summarizes the thread.
- **Dismissing teaches.** *Dismiss with a reason* records a label. If the reason is "the scanner read
  this wrong", the agent proposes a hint, so the next scan doesn't raise it again.

## Thread state

Each thread has one state. It shows as a small badge on the issue row, the group header and the
component page, so nobody has to open a thread to know where it stands.

| State | Means | Badge |
| --- | --- | --- |
| *None* | No thread yet | No badge; *Ask* on hover |
| **Working** | The agent is mid-turn | Spinner |
| **Waiting on you** | An open proposal or a question for the person | Filled dot, counts in the *Waiting on you* filter |
| **Changes ready** | A sandbox diff exists, not kept | Branch icon, outline |
| **On a branch** | Kept to a local branch | Branch icon |
| **In PR** | A draft PR is open | PR icon with its number, linked |
| **Settled** | Every proposal decided, no open changes | Check |
| **Out of date** | A newer scan changed the evidence | Clock |

State is computed on the server from what it already stores: running turns, open proposals,
sandbox changes, `kept`, and the PR link. It is not a separate field to keep in sync.

## How threads persist

- **Where:** session JSON files under `<data>/agent/sessions`, as today. Each gains `anchor`,
  `scanId` (the brief's scan) and `pr`.
- **Index:** a small `<data>/agent/threads.json` maps anchor keys to thread IDs and state. The server
  rebuilds it if it goes missing. The Inbox reads it with one request:
  `GET /api/agent/threads` → `{ [anchorKey]: { id, state, open, updatedAt } }`.
- **Across scans:** anchors use stable keys (finding IDs, review hashes, component names), so a
  thread follows its issue. When an issue is done, its thread is kept and marked *Settled*.
- **On a published copy:** at `dsa publish`, each thread's summary, proposals and outcome are written
  into the page as read-only history. Reviewers see *why* a decision was made, not only that it was.
  Full transcripts stay local unless the team opts in.
- **Cleanup:** sandboxes are already throwaway. Settled threads older than a set age (default 90
  days) can be archived from Settings.

## The UI, in short

- The global side panel becomes the **issue's own column**. On the Inbox it opens as a sheet over the
  list, so you can step through issues with `J` / `K` and each thread follows.
- The thread header shows: anchor, state, provider and model, *What the agent knows*, *Copy brief*
  (for Cursor or a terminal), *New thread*.
- Starters stay. They come from the brief, as now, and change with the state ("Draft the fix" before
  a branch exists; "Open a draft PR" after).
- The header's *Ask the agent* stays, anchored to the scan.

See [the layouts](layouts.md) for the screens.
