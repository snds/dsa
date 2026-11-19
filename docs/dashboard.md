# The dashboard

`dsa serve` runs it on your machine (http://localhost:4319). `dsa publish` writes it as a static page
for any host. Both show the same five tabs; the published page can't change anything itself, and the
differences are at the end.

## Where to start: the Inbox

The Inbox is every issue the scan raised, one row each: a finding, a question the scanner can't
answer alone, a component to confirm, an unused component, or an agent-readiness gap.

**Each issue has one certainty word**, the same everywhere in dsa:

| Word | Means |
|---|---|
| **Measured** | Counted from the code, with a known fix. |
| **Inferred** | The scan's reading of the code. A person checks it before acting. |
| **Needs a person** | The scan can't decide. Someone has to look. |

**Filters** narrow the list (Waiting on you, Needs a person, Measured, Inferred, Done), and **Group by**
sorts it by component, app or kind. The **App** picker at the top narrows every tab to one app.

**Keys:** <kbd>J</kbd> / <kbd>K</kbd> move between issues, <kbd>X</kbd> ticks one, <kbd>Esc</kbd> clears the
ticks. Inside a question's places, <kbd>J</kbd> / <kbd>K</kbd> move between places, and
<kbd>Shift</kbd>+<kbd>J</kbd> / <kbd>K</kbd> still move between issues.

**When you act on an issue** (answer it, confirm the component, dismiss it), it leaves the open list and
the next one is shown. Done keeps everything that was closed, resolved by a scan, or dismissed.

**Dismiss this issue…** closes one that shouldn't be there, with a reason: the scanner read it wrong,
it's meant to be this way, it isn't worth fixing, or another issue covers it. Undo is in the message
that follows, and on the dismissed issue under Done. "The scanner read this wrong" is the one to teach
from: ask the agent to propose a scanner hint, so the next scan doesn't raise it again.

## Answering a question: the places

A question lists the places (elements in the code) the scanner wants a person to look at, grouped by
the component they could become, with a photo of each in the running app when the scan took one.

- Tick places, then answer them together; shift-click ticks a range.
- <kbd>C</kbd> confirms the focused place's suggestion, <kbd>E</kbd> changes it, <kbd>N</kbd> adds a note,
  <kbd>O</kbd> opens it on its own, <kbd>U</kbd> undoes the last answer.
- A place marked **Needs evidence** has too little to go on (no photo, or code the scanner couldn't
  read in context). Open it on its own and answer it directly, or re-scan with photos (the Re-scan
  menu: retake photos).
- The percentage on a place is how well it matches the suggested component, not a certainty word.

Each answer becomes a decision in the app's decisions file and a label the scanner learns from.

## The conversation

The Inbox's right column is a conversation with the agent (on a narrower screen, **Open the
conversation** opens it in the side panel).

- **What it's about** shows as chips under *About:*. It's the issues you've ticked, or the open issue
  when none are ticked. Each chip names the issue's app. ✕ leaves one out.
- **Sending fixes the scope.** Tick more afterwards and the column asks: **Add to this** widens the same
  conversation (the agent re-reads its brief), **Start new** begins another.
- **Every conversation is kept.** The **Conversations** tab lists them: what each is about, where it
  stands (waiting on you, changes ready, in a PR, settled), and when it last moved. Filter by state or
  star, find one by issue, component or app, rename it, and **Open** it to carry on. **History** in the
  column lists the conversations about the issues in view.
- **Ask** in plain words. The agent reads the scan's evidence first and answers with it.
- **What the agent knows** lists every source it was given, and says which are missing or stale: an
  answer resting on a missing source says so.
- It never decides. A change it suggests comes back as a **proposal** you accept or reject. Accepted
  decisions land in the decisions file; accepted hints in `dsa.hints.json`.
- **Advise** (the default) only reads. **Try in sandbox** lets it edit a copy of the repo; you see the
  changes, then keep them on a local branch or throw them away. Nothing is pushed until you open a
  draft pull request yourself.

## The other tabs

- **Components:** the system's inventory as the scan sees it, usage by library, and design files (with
  the Figma add-on). **Needs a check** lists components the scan found by name alone, only in app code,
  or with an unclear kind: confirm each, or correct it so the next scan learns.
- **Apps:** each app's version, correct use, look-alikes (hand-built elements that imitate a system
  component) and token use.
- **Health:** open issues (counted as the Inbox counts them), the measures and their trend, how far to
  trust this scan, and agent readiness.
- **Settings** (the gear): sources, what to measure, notes, rules, agents and history.

## On a published page

A published page is a snapshot. It can't run the scan or the agent, so its buttons hand work to your
repo instead:

- **Re-scan** opens a filled-in issue (or starts the deploy through the scan relay), and the page shows
  when the new scan lands.
- **Answers** wait in your browser; the bar at the bottom sends them as one issue that a workflow
  applies, or as a file to download.
- **Discuss on GitHub** opens an issue for the conversation: the open issue, or every ticked issue in
  one. A workflow answers people with write access there. **Find the discussion** searches for one
  already open.
- **Conversations** lists each conversation as of publishing: what it was about, the question, the last
  answer and its state, with **Show in Inbox** and a link to it on GitHub.

Setting these up: [deploy.md](deploy.md), *Setup checklist*.
