# 5. Where the agent can run

**Short version:** the full pinned thread works in `dsa serve`, and only there, today. A published
copy is static files on GitHub Pages. It can't run an agent, hold a model key or push a branch. It
can show past threads read-only. To go further it needs either GitHub to do the work (issues, pull
requests and workflows) or a hosted service. GitHub first is the recommendation: it reuses what
already exists and adds no new server.

## Why a published page can't chat

- It is HTML, script and images. Nothing runs on a server when someone presses a button.
- An agent needs a model key, the repo checked out, and somewhere to run for minutes at a time.
- Putting a key in the page would hand it to every viewer. That is never acceptable.

## What works where

| Capability | `dsa serve` | Published, no service | Published + GitHub routes | Published + hosted service |
| --- | --- | --- | --- | --- |
| See issues, evidence, recommendations | Yes | Yes | Yes | Yes |
| See past threads, proposals, outcomes | Yes, live | Read-only, as of publish | Read-only, plus a link to the GitHub thread | Live |
| See thread state on rows | Live | As of publish | As of publish; GitHub shows live | Live |
| Chat with the agent | Yes, streaming | No | Yes, slowly: a comment, then a workflow replies in minutes | Yes, streaming |
| Answer a review | Saved at once | Through a PR (another session is building this) | Same | Same, or saved at once |
| Try a change in a sandbox | Yes, on this machine | No | Yes, in the workflow's runner | Yes, on the service's runner |
| Open a draft PR | Yes, with the person's `gh` sign-in | No | Yes, the workflow opens it | Yes |
| Who it is as | The person at the keyboard | — | The workflow's bot, triggered by a person with write access | The signed-in person |
| Cost of running it | None extra | None | Actions minutes and model spend per reply | A server, plus model spend |

## GitHub routes (recommended for published pages)

This is the same shape as Re-scan through a filled-in issue and review-by-PR, which another session
is building. Threads become GitHub conversations.

1. **Start or continue a thread.** The issue page's *Discuss on GitHub* opens a new GitHub issue (or
   the existing one for that anchor). The page fills in the title, a label (`dsa-thread`), and a hidden
   marker with the anchor key, like the approval marker the queue already uses. The person types the
   question there.
2. **The agent replies.** A workflow runs on `issue_comment` and `issues` events with the
   `dsa-thread` label. It checks the commenter has write access. It runs `dsa brief <anchor>` (new: it
   writes the same brief file the chat uses) and then an agent in the runner. The agent answers as a
   comment. Its proposals are a fenced JSON block, as review decisions are today.
3. **Approve.** A person with write access replies `/dsa accept P-1A2B3C` (or ticks a task-list box
   the workflow writes). The workflow applies it, as the decisions workflow does now.
4. **Draft a fix.** `/dsa draft-fix` makes the workflow run the sandbox steps in the runner, push a
   branch, and open a **draft** PR that links the thread.
5. **Back on the page.** The next publish reads the `dsa-thread` issues and shows their state on each
   row. Between publishes, the row links to the live GitHub thread.

What it costs and risks:

- **Slow.** Each reply takes a runner start plus the agent's turn, often one to three minutes.
- **Spend.** Each comment is a model call. The workflow needs a per-day limit and a write-access check.
- **Secrets.** The model key is a repository secret. It stays in Actions, never in the page.
- **Prompt injection.** Anyone who can comment can put text in front of the agent. Only replies to
  people with write access run the agent. Accepting a proposal is always a separate step from a
  write-access person.

## A hosted service (later, optional)

`docs/relay.md` already describes a small service that signs viewers in with GitHub, checks repo
access, holds a secret, and starts workflows. It could grow an agent endpoint:

- `POST /thread/:anchor/send` streams a reply, running the agent on the service or handing off to a
  runner.
- Same sign-in, same write-access bar, same per-viewer rate limits as Re-scan.

Why later:

- It needs somewhere to check out repos and run sandboxes. That is a real server, not a small
  function.
- It holds a model key and runs code from the repo. Its security bar is much higher than the relay's.
- The GitHub routes give most of the value with no new server.

## Recommendation

1. Build the pinned thread for `dsa serve` first. It is where maintainers and engineers do the work.
2. Publish thread history read-only, so reviewers on the static page see the reasoning.
3. Add the GitHub routes as the published page's way to start a thread and draft a fix.
4. Decide on the hosted service only after teams have used the GitHub routes for a while.
