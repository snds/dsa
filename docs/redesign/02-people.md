# 2. Who uses it, and what they come to do

**Short version:** three people use DSA. Each comes with one question. Today each answer takes three
to five tabs. The redesign makes each one an Inbox filter plus one issue page.

## The design-system maintainer

Owns the system's code, docs and tokens.

- **Comes to ask:** "What in the system is causing pain, and what do I fix first?"
- **Jobs:**
  - Spot API or docs gaps (many apps override the same component the same way).
  - Confirm what the scanner thinks the system is (components found by naming alone).
  - Decide policies ("everything styled by this class is a Button").
  - Teach the scanner when it reads something wrong.
  - Promote, document or retire unused components.
- **Today:** Overview → Actions (find the system rows among app rows) → System (needs a check, no way
  to confirm) → System Usage (a second unused list) → Settings › Rules.
- **Shortest path after:** Inbox, filter *Who acts: System*, grouped by component → open
  `DataTable` → read the evidence → ask the pinned thread to draft the docs or API change → approve
  the proposal or the pull request.

## The app engineer

Owns one consumer app.

- **Comes to ask:** "What do I need to change in my app, and how do I do it safely?"
- **Jobs:**
  - See only their app's issues.
  - Get the exact change: which component, which props, which files.
  - Apply it as a branch or pull request they review like any other.
  - Know when it is done (the next scan agrees).
- **Today:** pick the app in the header → Actions → open an item → *Technical details* for the
  places → *Ask the agent* → *Try in sandbox* → *Keep* → push and open a PR by hand.
- **Shortest path after:** a shared link opens the Inbox already on their app → open an issue → *Draft
  the fix* in its thread → look at the diff and before-and-after photos → *Open draft PR*. The issue
  shows "In PR" until the next scan closes it.

## The design lead or reviewer

Decides whether a recommendation is right. Often not a coder.

- **Comes to ask:** "Is this recommendation right, and can I trust it enough to approve?"
- **Jobs:**
  - Answer review questions (is this raw button really a `Button`, and which variant?).
  - Approve or reject what an agent proposed.
  - See whether the system is getting healthier.
- **Today:** Element Review for questions, the agent panel for proposals (only while it is open), and
  Overview plus Trends for health.
- **Shortest path after:** Inbox, filter *Waiting on you* → each issue opens on the evidence (photo,
  proposal drawing, code) beside the recommendation and its confidence → answer, or ask the thread
  "why not a Toggle?" → approve. Health has its own page for the weekly look.

## Who is not a main user

- **Leadership** reads Health and Apps. They don't act in the app, so they shape no main flow.
- **The agent** is a participant, not a user. It reads the same evidence and proposes; it never
  decides.

## What all three need to trust a recommendation

These come from the jobs above. Each one is a rule for every issue page.

1. **The evidence is on screen before the verdict is.** At least one example: a photo, a drawing or
   the code.
2. **One word for how sure.** *Measured*, *Inferred* or *Needs a person*, with the reason.
3. **What would change the answer.** The agent's persona already asks for this. The page shows it
   too.
4. **What the agent was told.** A visible list of the context it got, so a reviewer can spot a gap.
5. **What was decided before.** Past decisions, labels and rejected proposals for the same component.
