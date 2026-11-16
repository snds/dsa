# 3. Information architecture

**Short version:** the issue becomes the unit of work. Five top-level pages replace ten tabs. Every
issue has evidence, a recommendation, a status and a pinned agent thread.

## Five pages

| Page | Question it answers | What it replaces |
| --- | --- | --- |
| **Inbox** (home) | What needs doing, and what is waiting on me? | Overview's "What to do next", Actions, Element Review's queue, System's "needs a check", readiness fixes |
| **Components** | What is the system, and how is each part used? | System, System Usage, Design Files |
| **Apps** | How is each app or child library doing? | Apps (rows link to their issues) |
| **Health** | Are we getting better, and how sure is this scan? | Overview measures, Trends, "How sure is this scan", Agents & Benchmarks |
| **Settings** | How is DSA set up? | Settings (sources, tokens, measures), Rules, Notes, History, agent connection |

The app picker in the header stays. It filters every page, as it does today.

Old links keep working. `#queue/<id>` opens that issue. `#elements` opens the Inbox grouped by
component with review issues shown. `#system/...` opens Components.

## The issue

An issue is one thing a person should decide or do. It collects what today is spread over four views.

| Field | What it holds | Where it comes from today |
| --- | --- | --- |
| **Key** | Stable across scans | Finding ID, review-approval hash, `component:<name>:<check>` |
| **Kind** | Fix, Decide, Migrate, Gap, Upgrade, Tokens, Confirm, Readiness, Opportunity | Finding rule, review question, System filter, readiness check |
| **Component** | The system component it is about, if any | Finding scope, review decision, System row |
| **Apps** | Which apps it touches | `target`, `affected` |
| **Who acts** | System, a child library, or an app team | `owner`, `scope` |
| **Certainty** | *Measured*, *Inferred* or *Needs a person*, with a one-line reason | Definite / Recommendation, Measured / Estimated, review threshold |
| **Recommendation** | What to do, with confidence and "what would change this" | `fix`, review pick + alternatives |
| **Evidence** | Places (file:line), code, photos, drawings, counts, scanner reasons, history | Instances, element evals, shots, signatures |
| **Done when** | The test the next scan checks | `exit` |
| **Status** | Open → Discussing → Proposed → Approved → In PR → Done, or Dismissed | Queue state, review decided, issue closed |
| **Thread** | The pinned agent thread and its state | Agent session (today not linked) |

**Issue or opportunity?** Both are issues. An *opportunity* is a kind ("promote this unused
component", "document this pattern"). It is shown in a softer tone and sorted after problems.

### One word for how sure

Six scales become one, shown the same way everywhere:

- **Measured.** The scan counted it. The fix is known. *Example: two majors behind.*
- **Inferred.** The scan reasoned its way here. A person should agree. *Example: three apps override
  `DataTable` the same way, so it's probably a docs gap.*
- **Needs a person.** The scan's pick is below the review threshold. A person decides. *Example: this
  raw button could be `Button` or `Toggle`.*

The percentage and severity score stay, as detail on the issue page.

## The Inbox

- **Grouped by component** by default. Other groupings: by kind, by app, by who acts.
- **Filters** across the top: *Waiting on you*, *Needs a person*, *In PR*, *Done this week*.
- **A row** shows title, kind, certainty, apps, the number of places, and the **thread state** (see
  [the pinned chat](04-pinned-chat.md#thread-state)).
- **A group header** (for example `Select · 12 places · 3 issues`) has its own thread. It is the place
  for "one decision for all of these".
- Element Review's batch answering, keys and undo move here. Ticking rows across issues of the same
  component answers them together.

## The issue page

Two columns on a wide screen. One column, with the thread as a sheet, on a narrow one.

- **Left: the case.**
  1. Header: title, kind, certainty, who acts, status.
  2. Recommendation: what to do, confidence, why, what would change it.
  3. Evidence, open by default: one example up front (photo beside the proposal drawing, or the code),
     then tabs for *Places*, *Code*, *Numbers*, *History*.
  4. Decision bar: *Approve*, *Change to…*, *Dismiss with a reason*.
- **Right: the pinned thread.** Always for this issue. Opening another issue opens that issue's
  thread, and this one keeps its state.

## Components

One page per component replaces System's expandable rows.

- Summary: kind, variants, how it was found (in words, not shapes), deprecated or not.
- Use: per app, with look-alikes and overrides (from System and System Usage, one count, with a note
  when the two sources differ).
- **Its issues**: every open issue about this component.
- **A component thread**: for questions that span issues ("why do teams keep overriding this?").
- *Confirm* and *Correct* buttons for "needs a check", so that decision finally has a home.

## Health

- The five measures, each with its trend line beside it (Overview + Trends).
- How sure this scan is (moved from Overview, unchanged).
- Agent readiness per repo. Its failed checks become *Readiness* issues in the Inbox.
- Bench runs, as today.

## What moves where

| Today | After |
| --- | --- |
| Overview › measures | Health |
| Overview › What to do next | Inbox |
| Overview › How sure is this scan | Health; a one-line summary on the Inbox |
| Actions › findings | Inbox issues |
| Actions › review approvals | Status *Approved* on the review issue (no second item) |
| Actions › Agentic Completion Prompt | Gone. The group and issue threads do this job. *Copy brief* stays on each thread for Cursor or a terminal |
| Element Review | Inbox, grouped by component, kind *Decide* |
| Label Review | The one review screen another session is building |
| System, System Usage | Components |
| Agents & Benchmarks | Health; failed checks are Inbox issues |
| Trends | Health |
| Settings › Agents | Settings, plus a status chip in each thread header |
