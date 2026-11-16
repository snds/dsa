# 6. Build plan

**Short version:** nine stages, each one pull request Sean can review on its own. The model and the
threads come first, behind today's screens. The new screens come after, so the app keeps working at
every step. Nothing here starts until Sean approves this proposal.

Each stage says what it changes, how to check it, and what it leaves alone.

## Stage 1 — One issue model (server only)

- **Change:** `packages/dashboard/src` builds one `issues` list in the report data. It merges queue
  findings, review groups, System's "needs a check" and "not used", and failed readiness checks.
  Each issue gets a stable key, a kind, and one certainty word (*Measured*, *Inferred*, *Needs a
  person*).
- **Check:** unit tests on the test fixture: every current queue item, review question and System
  flag maps to exactly one issue. Keys are the same across two scans.
- **Leaves alone:** every screen. Actions reads the new list but looks the same.

## Stage 2 — Thread anchors and state (agent package)

- **Change:** `Subject` gains `issue`, `group` and `component`. Old subjects map to issue keys.
  Sessions store `anchor`, `scanId` and `pr`. A `threads.json` index and
  `GET /api/agent/threads` return each anchor's thread and its state.
- **Check:** tests that old session files load and land on the right issue; that each state comes out
  of the stored facts (running, open proposals, sandbox diff, kept, PR).
- **Leaves alone:** the side panel. It just opens the anchor's thread instead of a new session.

## Stage 3 — Thread badges on today's screens

- **Change:** Actions rows and Element Review batches show the thread state badge. Open proposals
  show on the item, not only in the panel. A *Waiting on you* count joins the header.
- **Check:** start a thread, get a proposal, close the panel: the row still says *Waiting on you*.
- **Why now:** it gives value before any layout change and tests the state model on real use.

## Stage 4 — The Inbox

- **Change:** a new home page. Grouped by component (or kind, app, who acts). Filters. Element
  Review's batch answering, keys and undo move into it. Overview's "What to do next" and Actions are
  folded in. Old routes redirect.
- **Check:** the three people's shortest paths in [who uses it](02-people.md) each take one filter and
  one click. The test app's Overview links all still land somewhere sensible.
- **Leaves alone:** System, Apps, Trends, Settings.

## Stage 5 — The issue page with its pinned thread

- **Change:** the two-column issue page. Evidence open by default, one example up front. The thread
  docks on the right and follows `J` / `K`. The global panel stays only for the scan anchor.
- **Check:** keyboard review still works. On a narrow screen the thread is a sheet. Screen-reader
  labels on the badges and decision bar.

## Stage 6 — What the agent knows

- **Change:** the brief gains the system layer (usage guidelines, tokens in play) and the memory
  layer (past decisions and labels, rejected proposals, notes, related threads). New read-only tools:
  `past_decisions`, `component_guidelines`, `tokens_for`, `related_threads`. The *What the agent
  knows* drawer. *Out of date* when a newer scan changes the evidence.
- **Check:** use the existing bench to score agent answers on the test app with and without the new
  layers. Ship the layers that raise the score. This is how we show the recommendations deserve high
  confidence, not just say it.

## Stage 7 — Draft PR and dismissal

- **Change:** *Open draft PR* from a kept branch, with the person's own `gh` sign-in. A *dismissal*
  proposal kind that records a label and can propose a scanner hint.
- **Check:** on a scratch clone of the test app only. The PR is a draft, links the issue, and nothing
  is pushed without the click.

## Stage 8 — Components and Health pages

- **Change:** Components (System + System Usage + component thread + *Confirm* / *Correct*). Health
  (measures with trend lines, scan trust, readiness, bench). Tabs drop from ten to five.
- **Check:** every number on the old pages appears on a new one, or the PR says why it was dropped.

## Stage 9 — The published page

- **Change:** `dsa publish` writes read-only thread history into the page. *Discuss on GitHub* and a
  workflow template for the GitHub routes in [where the agent can run](05-hosting.md). `dsa brief
  <anchor>` on the command line.
- **Check:** on a test repository only: a comment from a write-access account gets a reply; one from
  a read-only account does not; `/dsa draft-fix` opens a draft PR.
- **Depends on:** the review-by-PR screen and Re-scan by issue from the other session, so the three
  GitHub routes share one pattern.

## Not planned

- A hosted agent service. Revisit after Stage 9 has been used.
- Multi-person live chat in `dsa serve`. It is a local, single-person tool today.

## Order and size

| Stage | Size | Depends on |
| --- | --- | --- |
| 1 Issue model | Medium | — |
| 2 Thread anchors | Medium | 1 |
| 3 Badges on today's screens | Small | 2 |
| 4 Inbox | Large | 1, 3 |
| 5 Issue page | Large | 4 |
| 6 What the agent knows | Medium | 2 |
| 7 Draft PR, dismissal | Small | 2 |
| 8 Components, Health | Medium | 4 |
| 9 Published page | Large | 5, the other session's GitHub routes |

Stages 6 and 7 can run beside 4 and 5. They touch the agent package, not the screens.
