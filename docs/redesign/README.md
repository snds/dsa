# DSA dashboard redesign: proposal

**Status:** proposal for Sean's review. No app code changes yet.

## The answer in five lines

1. **Make the issue the unit of work.** Today one problem shows up in Actions, Element Review, System
   and System Usage under different names. After, it is one issue with its evidence, a
   recommendation, a status and a thread.
2. **Pin an agent thread to every issue, group and component.** It builds on the existing agent
   (brief, proposals, sandbox, `AskAgent`, `canChat()`). It remembers its state and shows it on every
   row.
3. **Show the evidence and what the agent knows before the verdict.** That is what lets a reviewer
   reach high confidence in a recommendation, rather than take it on trust.
4. **The agent proposes, a person approves, one step at a time:** explain, propose, try in a
   sandbox, keep as a branch, open a draft PR.
5. **Full chat runs in `dsa serve`.** A published page shows thread history read-only. To start a
   thread there, GitHub does the work: issue comments and a workflow. A hosted service can come later.

## Decisions for Sean

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Replace ten tabs with five pages: Inbox, Components, Apps, Health, Settings | Yes |
| D2 | One certainty scale everywhere: *Measured*, *Inferred*, *Needs a person* | Yes |
| D3 | One thread per anchor, with *New thread* for a fresh start | Yes |
| D4 | The agent may open a **draft** PR after a person's click, with that person's own GitHub sign-in | Yes |
| D5 | Published pages: GitHub routes first, hosted service later | Yes |
| D6 | Thread transcripts on published pages: summaries and outcomes only, full text opt-in | Yes |

## The parts

1. [Audit of the current app](01-audit.md). Every view, what it is for, where people hunt.
2. [Who uses it](02-people.md). Maintainer, app engineer, reviewer: their jobs and shortest paths.
3. [Information architecture](03-information-architecture.md). Five pages, the issue, the Inbox.
4. [The pinned agent thread](04-pinned-chat.md). Anchors, context, actions, state, persistence.
5. [Where the agent can run](05-hosting.md). `dsa serve`, published pages, GitHub routes, a service.
6. [Build plan](06-build-plan.md). Nine stages, one PR each.
7. [Layouts](layouts.md). Five low-fidelity screens built from the dashboard's UI kit.

## What this assumes from other work

Another session is changing the published page: Re-scan through a filled-in issue, a tidier header,
one review screen that answers by PR, and PR comments with usage deltas. This proposal doesn't touch
that code. It assumes those changes land, and Stage 9 reuses their GitHub pattern.

## How this was made

- Read the dashboard (`packages/dashboard/ui/src`, `packages/dashboard/src`) and the agent package
  (`packages/agent/src`).
- Ran `dsa serve` on a throwaway copy of the test fixture. Never on a consumer repo. Details and
  limits are in the [audit](01-audit.md).
