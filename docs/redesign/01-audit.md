# 1. Audit of the current dashboard

**Short version:** each view answers its own question well. The trouble is between views. The same
problem shows up in four places under four names, and the agent sits in one global side panel that
forgets which problem you opened it from.

How this was checked:

- Read every view in `packages/dashboard/ui/src/views` and the agent code in
  `packages/dashboard/ui/src/agent` and `packages/agent/src`.
- Ran `dsa serve` on a throwaway copy of the test fixture (`test/fixtures/acme-monorepo` with the
  `review-demo` overlay), at 1440 × 900. Not on any consumer repo.
- The local sandbox blocked the browser download, so the scan had no photos. Element Review showed
  "No photo" on every row. Everything else had real data.
- The build used was the main checkout's, from 3 November. It predates the latest Element Review PRs ([snds/dsa#51](https://github.com/snds/dsa/pull/51) to [snds/dsa#57](https://github.com/snds/dsa/pull/57)), so
  Element Review was also read from source.

## View by view

Each entry says what the view is for, what works, and where people hunt or decide without context.

### Overview

- **For:** "Are we healthy, what next, and can I trust this scan?"
- **Works:** five measures with status dots. "What to do next" splits *Do now* (measured, known fix)
  from *Decide* (inferred). "How sure is this scan" is honest about its own limits.
- **Hunting:** "What to do next" is a second copy of Actions with less detail. Clicking a row jumps
  to Actions, so the first screen is a waypoint, not a place to act.
- **Without context:** "Custom look-alikes: 24 · Estimated" gives no hint of which components or apps
  hold them. The trust panel says "4 need a check", but the check lives in System.

### Actions (`#queue`)

- **For:** everything someone must act on: findings and review approvals, each with a drafted issue.
- **Works:** the detail pane says who acts, why them, evidence, and "Done when". "Ask the agent" sits
  on every item.
- **Hunting:** the list is sorted by a severity score (75, 66, 51…). The score has no label in the row.
  Items for the same component (three `DataTable` and `Select` rows) sit apart, so you can't see
  "everything about Select" in one place.
- **Without context:** the evidence is one sentence ("15 className overrides … 15 places"). The code
  and the places are folded under *Technical details*. A reviewer approves a recommendation without
  seeing a single example.
- **A workaround in plain sight:** the *Agentic Completion Prompt* card is one long prompt to copy
  into another tool. It exists because the agent can't yet work through the queue with you.

### System (`#system`)

- **For:** what the scan believes the system is: each component's kind, use, and how it was found.
- **Works:** filters for "Needs a check", "Not used by apps", "Deprecated".
- **Without context:** "Found by" uses circle, diamond and square shapes. The key is a paragraph under
  the table. "Needs a check" asks a maintainer to confirm a component, but there is no button to
  confirm it here. That decision has nowhere to go.

### Apps (`#federation`)

- **For:** each child library and consumer app: version, use, tokens, open findings.
- **Works:** one dense table per role. Good for leadership.
- **Hunting:** "Open findings: 7" is a number, not a link to those seven.

### Element Review (`#elements`)

- **For:** a human answers the scanner's questions about native elements (a raw `<button>`, a
  hand-built select), grouped by the component they should become.
- **Works:** grouping by component, batch answers, notes, undo and keyboard review ([snds/dsa#51](https://github.com/snds/dsa/pull/51) to [snds/dsa#57](https://github.com/snds/dsa/pull/57)). It
  is the best decision surface in the app.
- **Without context:** a row shows "82% · Needs evidence". It doesn't say *what* evidence is missing
  or how to get it. The proposal drawing and the photo carry the decision. When either is missing,
  the reviewer is guessing.
- **Duplication:** an approved answer becomes a "Review approval" in Actions, a separate item with a
  separate thread.

### Label Review (`#review`, published copy only)

- **For:** one-at-a-time labelling on a static page, where answers download as a file.
- **Note:** another session is replacing this with one review screen that answers by PR. This
  proposal assumes that change.

### System Usage (`#usage`)

- **For:** where the system's tokens and components are used, per library, from the system's own
  usage scan.
- **Hunting:** "Components no child product imports" repeats System's "Not used by apps" filter from
  a different source. Two lists, two counts, no note on why they differ.

### Agents & Benchmarks (`#readiness`)

- **For:** how well agents can build with the system in each repo, plus bench runs.
- **Without context:** each check shows a score and a one-line fix. The fix is not an action
  anywhere. It can't be assigned, tracked or handed to the agent, though the agent can already brief
  itself on it (`readiness` subjects).

### Trends

- **For:** each measure over time.
- **Works:** honest empty state ("Trends start at the second run").
- **Hunting:** separate from the Overview measures that need it. A dropped number on Overview has no
  line to explain it.

### Settings

- **For:** sources, tokens, measures, modules; plus Agents, Notes, Rules and History tabs.
- **Hunting:** four different jobs behind a gear icon. Notes and Rules shape every recommendation,
  yet they are the hardest things to find. The agent connection is here, far from the agent.

## Patterns across the app

1. **One problem, four homes.** A component like `Select` can appear as an Action, an Element Review
   batch, a System "needs a check" row, and a System Usage row. Each has its own status and its own
   (or no) agent thread.
2. **Too many words for "how sure".** Definite / Recommendation, Do now / Decide, Measured /
   Estimated, Needs evidence / Proposed / Decided, an 82% confidence, and a severity score of 75. A
   reviewer has to translate six scales to know whether to trust a row.
3. **Evidence is one click too far.** Code, places and photos sit under *Details* or *Technical
   details*. The recommendation is up front. That is the reverse of what builds confidence.
4. **The agent is global, not pinned.** `Ask the agent` opens one side panel holding one session.
   Opening another item replaces it. Earlier sessions hide behind a clock icon, listed by title. No row
   shows that a thread exists, that it is waiting on you, or that it left a branch.
5. **Proposals live only in the chat.** An agent's proposed decision shows in the panel. It doesn't
   show on the item it is about, so closing the panel hides work waiting for approval.
6. **Ten tabs, some that come and go.** Label Review, System Usage, Agents & Benchmarks and Design
   Files appear only with certain data. People can't build a stable map.
7. **The published copy hides its limits.** "The agent needs dsa serve" is a tooltip on the header.
   On the page itself, agent buttons are disabled without saying why until you hover.

## What already works and must be kept

- The agent's **brief** (`packages/agent/src/context.ts`): evidence, design-system entries, intent,
  starters. The same file feeds the chat, Cursor and a terminal. This is the base of the pinned
  thread.
- **Proposals, not actions** (`propose_decision`, `propose_policy`, `propose_hint`,
  `propose_scanner_note`, `propose_issue`). The agent never decides; a human accepts.
- **The sandbox** with before-and-after photos, *Keep* to a local branch, and nothing pushed.
- **Element Review's** batch answers, notes, undo and keys.
- **Stable IDs:** findings keep their IDs across scans, and review approvals hash from app + decision.
  Threads can anchor on them.
