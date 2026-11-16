# Pull-request comments

`dsa pr-comment` tells the people reviewing a pull request what it does to design-system use. A
workflow runs it on every pull request, and it keeps one comment up to date. The comment leads with
a headline, then lists each new problem with its file and line:

- **New hard-coded style values**: colours and pixel sizes written into the code where a design
  token belongs.
- **New custom look-alikes**: a local component that copies a system component, or a plain HTML
  control (`<button>` by default) where the system has a component.
- **Components used against their guidelines**: a system component given its own `className` or
  inline `style`, or spread props that hide what it receives.
- **Improvements**: problems the pull request removes.

A sample comment:

```markdown
**Design system:** this change adds 2 problems and fixes 1.

hard-coded style values: 1 · components used against their guidelines: 1

**New hard-coded style values (1).** Use a design token instead.
- `src/screens/inbox.tsx:50` hard-coded colour `#3b82f6`

**Components used against their guidelines (1).** Use the component's own props and variants.
- `src/screens/inbox.tsx:22` `Card` is given its own `className`, which changes its look

**Improvements (1).** Thank you.
- `src/screens/settings.tsx:30` removed plain `<button>` where the system has a component

<sub>dsa compared this pull request with main (1a2b3c4). Totals: className overrides 0 → 1, plain HTML controls 1 → 0, hard-coded style values 2 → 3.</sub>
```

In the posted comment each location links to that line on the pull request's head commit. When
nothing changed, the comment is one line: "no change to design-system use".

## How it compares

It scans the pull request's head and its base with the same config, and compares the two scans.

- The correct-use counts are compared the way [`dsa ratchet`](../README.md#dsa-ratchet-dir---init----update)
  compares them with its baseline (`compareCounts` in [`src/ratchet.ts`](../src/ratchet.ts)). They
  are the totals in the footnote.
- The items behind the counts are matched by what they are and where: the file, the component or
  value, and the kind of problem. A line that only moved isn't new. When a file has more of the same
  item than before, the ones on new lines are listed.

The base is read from git, in a temporary worktree that is removed afterwards. It uses the head's
config and profile, and the head's installed packages, so a pull request that adds dsa still has a
base to compare with. By default the base is:

1. the first parent of a merge commit, which is how Actions checks out a pull request, or
2. where the branch left the base branch (from `GITHUB_EVENT_PATH` or `GITHUB_BASE_REF`).

The checkout needs that commit: use `fetch-depth: 0`.

Hard-coded values come from the scan (`styleValues` in `scan.json`). They are read only where style
is written: stylesheets and `<style>` blocks, `style` attributes and objects, `styled`/`css`
templates, colour string literals, and arbitrary utility classes such as `bg-[#0af]` or `p-[13px]`.
Custom properties (`--brand: #0af`) and preprocessor variables define tokens, so they don't count.
Neither do the system's own source folders, or zero. The ratchet doesn't count hard-coded values.

## Usage

```text
dsa pr-comment [dir] [--base <ref> | --base-scan <scan.json>] [--head-scan <scan.json>]
               [--out <file>] [--post] [--pr <number>] [--repo <owner/name>]
               [--host <adapter>] [--quiet-when-clean] [--limit <n>]
```

| Option | What it does |
|---|---|
| `[dir]` | The head to scan (default `.`). |
| `--base <ref>` | The git ref to compare against. The default is the pull request's base (see above). |
| `--base-scan <file>` | A `scan.json` of the base, made earlier with `dsa scan`. Nothing is read from git. |
| `--head-scan <file>` | A `scan.json` of the head, instead of scanning `[dir]` now. |
| `--out <file>` | Write the Markdown here. Without it, the Markdown goes to stdout. |
| `--post` | Create or update the pull request's comment. |
| `--pr <number>` | The pull request. The default comes from `GITHUB_EVENT_PATH`. |
| `--repo <owner/name>` | The repo. The default is `GITHUB_REPOSITORY`, then `host.github.repo`. |
| `--host <adapter>` | The host adapter that posts. The default is `host.adapter`, or `github` when `GITHUB_REPOSITORY` is set. |
| `--quiet-when-clean` | When nothing changed, don't start a comment. An earlier comment is still updated to say so. |
| `--limit <n>` | Items listed per section before "and N more" (default 10). |

With the global `--json`, it prints `{ clean, delta, markdown }` instead.

The comment carries a hidden marker, `<!-- dsa:pr-comment -->`. A rerun finds the comment by that
marker and edits it, so a pull request never collects more than one. When the text is the same,
nothing is sent. The command exits 0 whatever it finds: to fail a pull request on growth, run
`dsa ratchet` as well.

## The workflow

Add this to the repo that uses dsa, as `.github/workflows/dsa-pr-comment.yml`:

```yaml
name: Design system check
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
concurrency: { group: dsa-pr-${{ github.event.pull_request.number }}, cancel-in-progress: true }
jobs:
  comment:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }      # the base commit, to compare with
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx dsa pr-comment --post --quiet-when-clean
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

With pnpm, add `pnpm/action-setup@v4` before `setup-node`, use `cache: pnpm`, and run
`pnpm install --frozen-lockfile` and `pnpm exec dsa pr-comment --post --quiet-when-clean`.

Pull requests from forks get a read-only `GITHUB_TOKEN`, so posting answers 403. The Markdown is
still printed in the job log. To keep such runs green, add `continue-on-error: true` to the step.

## Posting from another host

Posting goes through the host adapter (`prComment` in
[`src/deploy/types.ts`](../src/deploy/types.ts)), like the dashboard's buttons. dsa ships it for
the github adapter. An add-on adapter can add its own. Without one, run `dsa pr-comment --out
comment.md` and post the file with the host's own tools.
