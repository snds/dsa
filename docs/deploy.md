# Running dsa where the product is deployed

dsa can run next to the product it measures, wherever that is deployed, and show its dashboard at
`<site>/dsa/`. A scan then reflects only what is live in production. A branch or uncommitted work
never shows up as if it shipped.

This page covers the three settings that make that work, and one example per environment:

- [`live`](#live-what-is-in-production): what is in production, and where to see it.
- [`host`](#host-how-the-dashboard-is-hosted): how the dashboard is hosted, and what its buttons do.
- [`history`](#history-where-run-history-persists): where run history persists between runs.
- Examples: [a long-running server](#example-1-a-long-running-server),
  [CI plus any static host](#example-2-ci-plus-any-static-host),
  [GitHub Pages](#example-3-github-pages-private-or-public).

Each setting picks an adapter by name. Adapters sit behind small interfaces in
[`src/deploy/types.ts`](../src/deploy/types.ts), so the core never names a hosting service. dsa
ships a generic adapter and a GitHub one. An add-on can add more (see [Adapters](#adapters)).

## `live`: what is in production

```jsonc
"live": {
  "revision": { "endpoint": "https://example.com/version.json" },
  "onMismatch": "refuse",
  "app": { "url": "https://example.com/app/", "auth": ".dsa/auth/example.com.json" },
  "storybook": { "dir": "packages/ui/storybook-static" }
}
```

### The live revision

A run first learns which commit is live. It asks these sources in order, and the first that answers
wins:

| Source | Set with | Notes |
|---|---|---|
| `value` | `live.revision.value` | A deploy step can write the SHA into the config. |
| `endpoint` | `live.revision.endpoint` | A URL on the live site that reports its version, as JSON (`sha`, `commit`, `revision`, `version` or `git.sha`; or name it with `field`) or as text. A private site's endpoint gets the saved sign-in's cookies. |
| `github-deployment` | `host.adapter: "github"` | The newest deployment to `live.revision.environment` (default `github-pages`) that finished. Gives the time it went live too. |
| `env` | on by default | Common CI variables: `GITHUB_SHA`, `CI_COMMIT_SHA`, `BITBUCKET_COMMIT`, `CIRCLE_SHA1`, `BUILDKITE_COMMIT`, and others ([full list](../src/deploy/revision.ts)). Ignored on pull-request builds, whose commit is not live. Name your own with `env: ["DEPLOYED_SHA"]`, or turn it off with `env: false`. |

Change the order with `live.revision.sources`. A source that fails (the endpoint answers 403, say)
stops the run. It never falls through to a CI variable that might name some other commit.

Only trust `env` in the job that deploys. A scheduled job's `GITHUB_SHA` is the branch tip, which
may not be what is deployed. Use the endpoint or the deployment source there.

### The checkout check

dsa then compares the checkout with the live revision:

- **live**: `HEAD` is the live commit, or a commit with the same files, and no tracked file is modified.
- **other-commit**: `HEAD` is a different commit.
- **modified**: `HEAD` is live, but tracked files have uncommitted changes.
- **unknown**: no source found a live revision, or the folder isn't a git checkout.

Anything but **live** stops `dsa run`, `dsa shots`, `dsa render` and the dashboard's Run button.
Pass `--allow-unreleased`, or set `"onMismatch": "label"`, to run anyway. The report then carries a
red banner and a `NOT LIVE` label on every page. `dsa live` runs the check by itself, which is handy
as a first CI step.

Without a `live` section, dsa runs on the checkout as before. The report then says "not checked
against production".

The check is recorded with each run. The dashboard header shows the scanned revision and when it
went live.

### Where to see it

`live.app` (every app) or `live.apps.<name>` (one app) and `live.storybook` each take one of:

- `url`: the deployed site. Nothing is started. Add `auth` for a private site (see below).
- `dir`: the built folder that gets deployed (`dist`, `storybook-static`). dsa serves it on
  localhost for the run, mounted at `base` (default `/`). Use this in CI: the build is exactly what
  ships, and the job needs no access to the live site.

Apps without a live surface are started from the checkout as before. The checkout check still
applies to them.

The screenshot crawler stays read-only on a live site. It sends no writes, and nothing to other
hosts but images, fonts and styles. On a `url` it may GET the site's own `/api/` routes, so
signed-in pages load their data. Set `readApi: false` to block that too.

### Signing in to a private site

Run this once, on a machine with a screen:

```bash
npx dsa login https://example.com/app/ --out .dsa/auth/example.com.json
```

A browser opens. Sign in, then press Enter in the terminal or close the window. Point `auth` at
the file. It holds your session, so keep it out of git (dsa warns when it isn't ignored), and
never let history push it (it never does: see [`history`](#history-where-run-history-persists)).

Sessions expire. A CI job can't sign in by itself, so in CI prefer `dir`. If you must use `url` in
CI, store the file as a secret and write it out before the run.

## `host`: how the dashboard is hosted

There are two hosting modes, sharing one dashboard.

**Server mode: `dsa serve`.** The live dashboard. Re-scan, review decisions and Settings write
straight to the repo. To mount it at `<site>/dsa/` behind your reverse proxy:

```bash
npx dsa serve --host 0.0.0.0 --port 4319 --base /dsa/ --allow-host example.com
```

- `--base` (or `host.base`) is the sub-path. Requests outside it get a 404.
- `--allow-host` is required when listening beyond localhost. It keeps the Host-header check that
  stops DNS-rebinding attacks.
- dsa has **no sign-in of its own**, and its writes change the repo. Only expose it behind your
  organization's sign-in proxy.

**Static mode: `dsa publish`.** The dashboard as a folder of files, with the data embedded. Every
link is relative, so the folder works under any sub-path. Copy it to `<site>/dsa/` on any static
host. A static page can't write, so its Re-scan button and its decisions go where the host adapter
says:

| | `generic` adapter | `github` adapter |
|---|---|---|
| Re-scan | `host.rescan.url`: a page that starts the scan job (`method: "link"`), or a webhook dsa POSTs to (`"post"`). Add `status` (and `active`) URLs and the page follows the run. No button without `rescan`. | Starts the scan workflow (`host.github.workflow`) from the page through `workflow_dispatch`, with the viewer's own token, and follows it. `dispatch: false` only opens the workflow's page. |
| Decisions | `host.decisions.mode`: `export` downloads a file; `post` sends it to `host.decisions.url`. | `issue` (default) opens a new issue with the decisions in a `json` block and a label. A workflow applies it and commits. `pr` is the same, but the workflow opens a pull request. |
| Applying | `dsa apply-decisions --file <file>` (or `--url`, or `-` for stdin) | `dsa apply-decisions --issue <n> --close` |

### Re-scan from the page

Every host gets a runner with the same three calls: `trigger()` starts a scan, `status(id)` says
where a run stands (queued, step n of m, done, failed), and `listActive()` lists runs already going,
scheduled ones included. `dsa serve` runs the scan itself; a published page uses the runner its host
adapter names. The page shows the same feedback whatever the runner:

- **Starting…** as soon as Re-scan is pressed, then a banner while it runs.
- A scan already going when the page opens (a schedule, a teammate) shows in the banner too.
- When scans usually take over a minute, a progress dialog opens: completed steps, time left. Hide it
  and the banner stays.
- When the run has finished and the deployed page carries the new report, **Load the new report**.
- Errors say what went wrong, with a link to the run.

The estimate is the median of recent successful runs (from GitHub) or of recorded scans
(`<data>/scan-times.json`, which `dsa run` and `dsa serve` write). For a webhook, set
`host.rescan.estimateSeconds` if neither knows.

**The GitHub runner and tokens.** A static site has no server, so starting a workflow needs the
viewer's own credential. The first Re-scan asks for a fine-grained token: only the one repo, only
**Actions: read and write**, a short expiry (the dialog links to GitHub's form, filled in). The token
stays in that browser's local storage for the report's site, is sent only to GitHub's API, and never
goes into the report, history, logs or the repo. Settings → **Forget token** removes it. A viewer who
declines gets the workflow page instead, with what to press there. What the token allows: start,
re-run and cancel workflows in that repo and read their runs and logs; not the code, issues or
settings. Anyone with access to that browser profile, or script running on the report's site, could
use it, so keep the site's content to dsa's own page and the expiry short.

A webhook's `status` URL answers one run as `{ "status": "queued" | "running" | "done" | "failed", "steps": { "done", "total", "current" }, "url", "startedAt", "error" }`
(`{id}` in the URL is filled in); `active` answers `{ "runs": [ … ] }`. The trigger may answer
`{ "id", "url" }`. Requests carry the browser's cookies, for a sign-in in front of the hook.

`dsa apply-decisions` records each decision exactly as `dsa serve` would, in the app's decisions
file in the repo. Commit that file, or open a pull request with it. The next published scan shows
the decisions.

The github adapter takes the repo from `host.github.repo`, then `github.defaultRepo`, then
`GITHUB_REPOSITORY`. For GitHub Enterprise Server, set `host.github.server` (and `api` if it isn't
`<server>/api/v3`). It reads issues with `GITHUB_TOKEN` (or `GH_TOKEN`).

## `history`: where run history persists

Run history (the DuckDB file), screenshots, renderings and the review queue live in the data folder
(default `.dsa/`). On a server the folder simply stays put. A CI job starts empty, so it pulls the
folder before the run and pushes it after.

| `history.adapter` | What it does |
|---|---|
| `local` (default) | Nothing: the folder stays where it is. |
| `git-branch` | Keeps the folder on a branch of the measured repo (`history.branch`, default `dsa-data`), separate from the product's code. It uses the repo's own git and credentials, through a throwaway index, so the working tree and current branch are never touched. `keep: "latest"` holds the branch at one commit, which force-pushes that branch. |
| `command` | Runs your `history.pull` and `history.push` shell commands, with `{dir}` filled in. Use it for an object store or an artifact store. |

`dsa run` and `dsa apply-decisions` pull before and push after (`--no-history` skips both). For a
separate job, such as one that only publishes, run `dsa history pull` first.

These entries are never persisted: `secrets.json`, `auth/`, `site/`, `report/`, `remotes/`,
`agent/`, `serve/`, and `*.wal` and `*.tmp` files. Add more with `history.exclude`.

Review decisions are not part of history. They live in each app's decisions file in the repo,
where people can review them.

## Example 1: a long-running server

dsa runs on a machine that has a checkout of the product, behind the company's sign-in proxy at
`https://example.com/dsa/`. The deploy updates that checkout. The live site reports its version at
`/version.json`, so dsa can tell whether the checkout has caught up.

```jsonc
// dsa.config.json
{
  "system": { "name": "Acme UI", "packages": ["@acme/ui"] },
  "live": {
    "revision": { "endpoint": "https://example.com/version.json" },
    "app": { "url": "https://example.com/", "auth": ".dsa/auth/example.com.json" },
    "storybook": { "url": "https://example.com/storybook/", "auth": ".dsa/auth/example.com.json" }
  },
  "host": { "base": "/dsa/", "url": "https://example.com/dsa/" },
  "history": { "adapter": "local" }
}
```

```bash
npx dsa login https://example.com/ --out .dsa/auth/example.com.json
npx dsa serve --host 0.0.0.0 --base /dsa/ --allow-host example.com
```

Proxy `/dsa/` to `127.0.0.1:4319`, behind your sign-in. The Run button refuses while the checkout
isn't the live revision (between a deploy and the checkout update, say).

## Example 2: CI plus any static host

A pipeline builds the site and deploys it to a static host (an object store, a CDN, a plain web
server). The same pipeline, after the build, scans the built folder and publishes the dashboard
into it at `/dsa/`. History lives on a git branch.

```jsonc
// dsa.config.json
{
  "system": { "name": "Acme UI", "packages": ["@acme/ui"] },
  "live": {
    "revision": { "env": ["CI_COMMIT_SHA"] },
    "app": { "dir": "dist", "base": "/" },
    "storybook": { "dir": "packages/ui/storybook-static" }
  },
  "host": {
    "adapter": "generic",
    "rescan": { "url": "https://ci.example.com/acme/site/pipelines/new", "method": "link" },
    "decisions": { "mode": "post", "url": "https://hooks.example.com/dsa-decisions" }
  },
  "history": { "adapter": "git-branch", "branch": "dsa-data" }
}
```

The deploy job, in any CI (shown as shell steps):

```bash
npm ci
npm run build                      # → dist/, what gets deployed
npm run build-storybook            # → packages/ui/storybook-static
npx dsa setup                      # the headless browser (cache it between runs)
npx dsa run --shots                # checks CI_COMMIT_SHA, pulls and pushes history
npx dsa publish --out dist/dsa     # the dashboard, inside the site
# …then deploy dist/ as you already do
```

Point the webhook at a small job that runs `npx dsa apply-decisions --file -` with the request
body on stdin, then commits the decisions file. Or leave out `decisions` to download the file
instead.

## Example 3: GitHub Pages (private or public)

The product deploys to GitHub Pages from a workflow. CI can't load a private Pages site, so the
built folder is the live source. The dashboard goes into the same Pages artifact at `/dsa/`.
Re-scan starts the deploy workflow from the page and shows its progress; decisions come back as
issues.

```jsonc
// dsa.config.json
{
  "system": { "name": "Acme UI", "packages": ["@acme/ui"] },
  "live": {
    "revision": { "sources": ["env"] },
    "app": { "dir": "dist", "base": "/" },
    "storybook": { "dir": "packages/ui/storybook-static" }
  },
  "host": { "adapter": "github", "github": { "workflow": "pages.yml" }, "decisions": { "mode": "pr" } },
  "history": { "adapter": "git-branch" }
}
```

Add the dsa steps to the Pages workflow, between the build and the upload:

```yaml
# .github/workflows/pages.yml
name: pages
on:
  push: { branches: [main] }
  workflow_dispatch:            # the dashboard's Re-scan button starts this
permissions:
  contents: write               # push the dsa-data branch
  pages: write
  id-token: write
concurrency: { group: pages, cancel-in-progress: false }
jobs:
  deploy:
    runs-on: ubuntu-latest      # Linux: macOS and Windows minutes weigh 2–10× on private repos
    environment: github-pages
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }  # git history tells new code from old
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run build && npm run build-storybook
      - uses: actions/cache@v4
        with: { path: ~/.cache/ms-playwright, key: playwright-${{ runner.os }} }
      - run: npx dsa setup
      - run: npx dsa run --shots           # live revision: GITHUB_SHA, this deploy
      - run: npx dsa publish --out dist/dsa
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
      - uses: actions/deploy-pages@v4
```

And a workflow that applies decisions filed from the dashboard. It runs only for the label, and
only for people with access to the repo. With `mode: "pr"` it opens a pull request, so a person
reviews the decisions before they land:

```yaml
# .github/workflows/dsa-decisions.yml
name: dsa decisions
on:
  issues: { types: [opened, edited, labeled] }
permissions:
  contents: write
  issues: write
  pull-requests: write
jobs:
  apply:
    if: >-
      contains(github.event.issue.labels.*.name, 'dsa-decisions') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.issue.author_association)
    runs-on: ubuntu-latest
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      ISSUE: ${{ github.event.issue.number }}
      WHO: ${{ github.event.issue.user.login }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx dsa apply-decisions --issue "$ISSUE" --who "$WHO" --close
      - name: Open a pull request with the decisions
        run: |
          git switch -c "dsa/decisions-$ISSUE"
          git add -A -- ':!.dsa'
          git -c user.name=dsa -c user.email=dsa@users.noreply.github.com commit -m "Review decisions from #$ISSUE"
          git push -u origin "dsa/decisions-$ISSUE"
          gh pr create --fill --body "Decisions filed in #$ISSUE from the dashboard."
```

The issue's author and number reach the shell through `env`, never pasted into the script, so an
issue title or name can't inject commands.

For a scheduled re-scan that isn't the deploy job, use `"sources": ["github-deployment"]`, so the
live revision comes from the Pages deployment rather than the branch tip. Give the job
`deployments: read`.

## Adapters

Every seam is an interface in [`src/deploy/types.ts`](../src/deploy/types.ts):

- `RevisionSource`: one way to learn the live revision. Built in: `value`, `endpoint`, `env`. A host
  adapter adds its own through `revisionSources`.
- `HostAdapter`: `actions()` (what the static page's buttons do), `readDecisions(ref)` (where
  `dsa apply-decisions` reads from), `applied()` (close the loop, optional).
- `HistoryFactory` / `HistoryBackend`: `pull(dir)` and `push(dir, message)`.

An add-on offers more with `defineAddon({ hosts: [...], histories: [...] })`. The config picks one
by name, and a later adapter with the same name wins over a built-in one. An unknown name is an
error, never a silent fallback.

Built in: [`generic`](../src/deploy/host.ts), [`github`](../src/deploy/adapters/github.ts),
[`local`](../src/deploy/history.ts), [`git-branch`](../src/deploy/adapters/git-branch.ts),
[`command`](../src/deploy/adapters/command.ts).

## What isn't covered yet

- **Live previews in the component picker need `dsa serve` on the same machine as the browser.**
  The picker loads Storybook through a second proxy on localhost, which a remote proxy doesn't
  reach. Behind one, the picker's live previews don't load. The review's measured renderings and
  screenshots still show.
- **History is one writer at a time.** Two runs pushing the same `dsa-data` branch at once: the
  second fails and says to run again. Use your CI's concurrency setting.
