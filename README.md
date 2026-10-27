# @snds/dsa

Design-system analytics as a library and a CLI. `dsa` reads a TypeScript/JSX
codebase, builds a composition graph of how design-system components are
actually combined, and turns it into three things a design-system team can act
on: an **inventory with adoption and correct-use metrics**, a list of
**pattern candidates** (compositions that keep recurring and may deserve a
name), and a **ratchet** that stops correct-use violations from growing in CI.
It is vendor-neutral: point it at any React design system, shadcn-style owned
source or published package, through one small config file.

## The rule it implements

> A composition of two or more components in the same arrangement that appears
> **three or more times across two or more hosts** is a pattern candidate.
> **People decide; the tool suggests.** Output is a suggestion record, never an
> auto-created component.

That is the standing rule from the component and pattern framework's
*pattern-candidate detection* section (framework 09 §7a): a design system must
be able to notice its own patterns. Candidates are judged by pattern
uniqueness: different user job and different anatomy → **pattern**; shares a
parent component → **variant** or usage of that parent; one-off → **snowflake**,
left alone. Three is the rule of three; one or two occurrences stay host-local.
A candidate ignored three times is parked, not re-raised.

The measurement side follows the design-system analytics measurement model:
start with **adoption definition 1 (imports and instances)**, keep a
**correct-use** measure next to every count so wrappers and spread props cannot
inflate it, and **ratchet, don't big-bang**: freeze today's violation count and
fail CI if it grows.

## Install

```sh
# today: straight from GitHub (builds on install via `prepare`)
pnpm add -D github:snds/dsa

# later: from npm
pnpm add -D @snds/dsa
```

Requires Node 22+ and pnpm 10 (the package sets `engine-strict=true`).

## Commands

Every command accepts an optional `[dir]` (default `.`), discovers
`dsa.config.json` upward from that directory, writes its JSON report to
`output.dir` (default `.dsa/`) and prints a human summary. Add `--json` to
print the JSON to stdout instead of writing it.

### `dsa patterns [dir] [--all] [--ignore <id>]`

Pattern-candidate suggestion records → `.dsa/patterns.json`. Real output on
the fixture app in this repo (`node dist/cli.js patterns test/fixtures/app`):

```text
dsa patterns — fixture — 16 compositions seen, 3 candidates (rule: 3+ occurrences across 2+ files)

tier                name           occ  hosts  conf  nearest           anatomy
------------------  -------------  ---  -----  ----  ----------------  ------------------------------------------------------------
pattern             FilterBar        3      2  0.73  FilterBar (0.66)  div > Search + Chip + Toolbar(Button)
compound-component  ActionToolbar    3      2  0.69  -                 Toolbar > Button + Button
variant             CardRecipe       3      2  0.73  StatCard (0.73)   Card > CardHeader(CardTitle + CardDescription) + CardContent

FilterBar [50c138853f55] — 4 components from 3 families (Form, Data Display, Action) repeat 3 times across 2 files.
    src/screens/contacts.tsx:13:7
    src/screens/inbox.tsx:13:7
    src/screens/inbox.tsx:39:7
ActionToolbar [a4baad50413d] — Toolbar with 2 Action children repeats 3 times across 2 files: small and single-family, so a compound component.
    src/screens/contacts.tsx:28:7
    src/screens/dashboard.tsx:12:7
    src/screens/dashboard.tsx:37:9
CardRecipe [fae016e73469] — Card with only design-system children in one family (Layout) repeats 3 times across 2 files: a variant or usage of Card, not a new pattern.
    src/screens/contacts.tsx:34:7
    src/screens/dashboard.tsx:17:7
    src/screens/dashboard.tsx:25:7

People decide; the tool suggests. Nothing here was created.

wrote <repo>/test/fixtures/app/.dsa/patterns.json
```

The fixture has a filter-bar composition repeated three times across two
screens (→ pattern), a two-button toolbar repeated three times across two
screens (→ compound component), a Card composition made only of Card parts
repeated three times across two screens (→ variant of Card), and a dialog used
as a form three times **in one file** (→ snowflake, shown only with `--all`:
three occurrences but one host). The `Toolbar(Button)` inside the filter bar
is not reported on its own because it never appears outside it.

`--ignore <id>` records that a reviewer looked at a candidate and passed; after
`patterns.ignoreIgnoredTimes` ignores (default 3) it is parked and listed
under `parked` instead of being raised again. Decisions live in
`<output.dir>/decisions.json`, which you can commit.

### `dsa scan [dir]`

Component inventory + adoption + correct-use metrics → `.dsa/scan.json`.

```text
dsa scan — fixture — 8 files, 92 elements (10 DS source files parsed, not counted)

directory              ds  local  html  external  total  custom
---------------------  --  -----  ----  --------  -----  ------
src/components          6      0     0         0      6    0.0%
src/components/legacy   0      0     1         0      1  100.0%
src/screens            63      3    18         1     85   24.7%
TOTAL                  69      3    19         1     92   23.9%

ds component     uses  files
---------------  ----  -----
Button             15      6
Toolbar             6      3
Card                4      3
CardHeader          4      3
CardTitle           4      3
CardContent         4      3
Input               4      2
Search              3      2
Chip                3      2
CardDescription     3      2
Dialog              3      1
DialogContent       3      1
DialogTitle         3      1
Form                3      1
Label               3      1

correct use
check                      count
-------------------------  -----
className overrides on DS      1
style overrides on DS          1
spread props on DS             2
local look-alikes              2
raw HTML controls              0

look-alike     resembles  score  uses
-------------  ---------  -----  ----
Badge          Badge       1.00     1
PrimaryButton  Button      0.80     1

wrote <repo>/test/fixtures/app/.dsa/scan.json
```

Adoption is **definition 1**: every JSX element is counted as `ds`, `local`,
`html` or `external`; the custom ratio is `(local + html) / total`. The design
system's own source files (resolved from `localAliases` through tsconfig
`paths`, and from `packages` through workspace `package.json` names) are parsed
for names but left out of the counts. Correct use records three things on DS
elements: `className` / `style` overrides, spread props, and local
**look-alikes**: a local component with the same name as a DS component, a
near-identical name, a thin wrapper whose name contains the DS name
(`PrimaryButton` rendering `<Button/>`), a small from-scratch rebuild under
such a name, or a known synonym (`Modal` when the DS has `Dialog`).
Compositions that merely use a DS component (`RenameDialog`, `StatCard`) are
not look-alikes.

It also counts **raw elements**: plain HTML controls written where a
design-system control belongs, `<button>` by default
(`correctUse.rawElements`). These bypass the system entirely, so none of the
checks above can see them. An element handed to a component through a prop,
such as `<Item render={<button />}>`, belongs to the component that renders it,
and isn't counted. Some raw controls are right: a calendar's day cells, a card
that is one big target. The ratchet only stops the number from growing, and
each one is a candidate to look at.

### `dsa ratchet [dir] [--init | --update]`

Compares the five correct-use counts against `ratchet.baseline` and exits 1 if
any grew. `--init` creates the baseline; `--update` rewrites it after growth
was accepted in review. A metric the baseline doesn't have yet (one added by a
newer dsa, like `rawElements`) is shown and not compared, so upgrading dsa
never fails CI by itself; `--update` starts ratcheting it.

```text
dsa ratchet — OK — baseline <repo>/test/fixtures/app/.dsa/baseline.json

metric              baseline  current  delta
------------------  --------  -------  -----
classNameOverrides         1        1      0
styleOverrides             1        1      0
spreadProps                2        2      0
lookAlikes                 2        2      0
rawElements                0        0      0

wrote <repo>/test/fixtures/app/.dsa/ratchet.json
```

## Configuration

`dsa.config.json` at the repository root. Every key is optional; these are the
defaults for a shadcn-style system called `unicron`:

```json
{
  "$schema": "https://github.com/snds/dsa/schema/config.json",
  "system": { "name": "unicron", "packages": ["@unicron/ui"], "localAliases": ["@/components/ui"] },
  "scan": { "include": ["apps/**/src/**/*.tsx", "packages/**/src/**/*.tsx"], "exclude": ["**/node_modules/**", "**/*.test.tsx", "**/*.stories.tsx"] },
  "hosts": { "by": "file" },
  "patterns": { "minOccurrences": 3, "minHosts": 2, "minComponents": 2, "ignoreIgnoredTimes": 3 },
  "correctUse": { "rawElements": ["button"] },
  "ratchet": { "baseline": ".dsa/baseline.json" },
  "output": { "dir": ".dsa" }
}
```

| Key | Meaning |
|---|---|
| `system.name` | Human name used in summaries. |
| `system.packages` | Import sources that count as design-system components. A source matches if it is the entry or a subpath of it (`@unicron/ui`, `@unicron/ui/button`). |
| `system.localAliases` | In-repo import sources that *are* the design system (owned source, shadcn style). Matched the same way. |
| `scan.include` / `scan.exclude` | fast-glob patterns relative to the config root. |
| `hosts.by` | `file` (default) or `dir`: what counts as one host when measuring a composition's spread. |
| `patterns.minOccurrences` | Occurrences needed before a composition is more than a snowflake. Default 3. |
| `patterns.minHosts` | Distinct hosts needed. Default 2. |
| `patterns.minComponents` | Minimum DS + local components in a composition for it to be considered. Default 2. |
| `patterns.ignoreIgnoredTimes` | Ignores before a candidate is parked. Default 3. |
| `correctUse.rawElements` | Plain HTML tags counted as raw elements (bypasses of the system). Default `["button"]`; add `"a"`, `"input"`, or `"select"` if your system covers them, or `[]` to turn the check off. |
| `ratchet.baseline` | Baseline path, relative to the config root. |
| `output.dir` | Where reports go. Gitignore it except `baseline.json` (and `decisions.json` if you keep review decisions). |

How a JSX element gets its kind: **ds** if its tag resolves to an import from
`packages` or `localAliases`; **local** if it resolves to any other in-repo
module (relative import, a tsconfig `paths` alias, `@/`, `~/`, `#`, or a
component declared in the same file); **html** if it is a lowercase intrinsic;
**external** otherwise. Dotted tags (`Dialog.Title`) resolve through their root
identifier.

The schema for the config file is published at
[`schema/config.json`](schema/config.json); the raw URL on `main` is
`https://raw.githubusercontent.com/snds/dsa/main/schema/config.json` if your
editor needs a fetchable `$schema`.

## The suggestion record

Each candidate in `patterns.json` is one record ([schema](schema/suggestion-record.json)):

```ts
type Tier = "pattern" | "compound-component" | "variant" | "snowflake";

interface SuggestionRecord {
  id: string;                 // stable hash of the anatomy (12 hex chars)
  name: string;               // candidate name by intent, e.g. "FilterBar", "FormDialog"
  anatomy: AnatomyNode;       // slot tree
  occurrences: { file: string; line: number; column: number }[];
  hosts: string[];            // distinct hosts (files by default)
  tier: Tier;
  confidence: number;         // 0..1
  nearestExisting?: { name: string; score: number; source: "catalog" | "local" };
  reason: string;             // one plain sentence
}

interface AnatomyNode {
  component: string;          // tag as written
  kind: "ds" | "local" | "html";
  shapeProps: Record<string, string>;   // literal string / number / boolean props
  children: AnatomyNode[];
}
```

- **Shape props** are props whose value is a string, number or boolean literal
  (`variant`, `size`, `side`, `align`…). Content-like props (`placeholder`,
  `title`, `href`, `className`, `style`, `key`, `data-*`, `aria-*`…), handlers,
  expressions and text content are ignored, so two filter bars with different
  placeholder text are the same anatomy.
- **External elements** (a router `Link`, a motion wrapper) are not part of
  the design-system composition; they are transparent in the anatomy and their
  children are hoisted.
- **Tier heuristic.** Below `minOccurrences` or `minHosts` → `snowflake`
  (reported only with `--all`). Otherwise: two or more distinct component
  families (Action · Form · Navigation · Feedback · Data Display · Layout ·
  Overlay · Disclosure · Content) → `pattern`; one family and 2–3 nodes →
  `compound-component`; one family, 4+ nodes, a DS root and only DS children →
  `variant` of the root ("Dialog used as a form"); one family under a wrapper
  → `pattern` with the family named in the reason.
- **Naming.** A composition identical to a component the repo already named
  keeps that name. A close match to the framework's pattern catalog (Form /
  data entry, Master–detail, Dashboard, Wizard, Async triad, Confirmation,
  Filtering) takes the catalog name (`FilterBar`, `ConfirmDialog`…). Otherwise
  the name is a role word from the children plus the root (`FormDialog`,
  `ActionToolbar`, `StatPanel`).
- **nearestExisting** is the best of two comparisons: the catalog, by
  family-sequence similarity plus component overlap, and already-named local
  components, by anatomy similarity. Below 0.35 it is omitted.
- **Confidence** blends occurrence strength, host spread, the share of DS
  components and size; snowflakes are capped at 0.3.

A record on the fixture:

```json
{
  "id": "50c138853f55",
  "name": "FilterBar",
  "anatomy": {
    "component": "div",
    "kind": "html",
    "shapeProps": {},
    "children": [
      {
        "component": "Search",
        "kind": "ds",
        "shapeProps": {},
        "children": []
      },
      {
        "component": "Chip",
        "kind": "ds",
        "shapeProps": {
          "variant": "removable"
        },
        "children": []
      },
      {
        "component": "Toolbar",
        "kind": "ds",
        "shapeProps": {},
        "children": [
          {
            "component": "Button",
            "kind": "ds",
            "shapeProps": {
              "size": "sm",
              "variant": "ghost"
            },
            "children": []
          }
        ]
      }
    ]
  },
  "occurrences": [
    {
      "file": "src/screens/contacts.tsx",
      "line": 13,
      "column": 7
    },
    {
      "file": "src/screens/inbox.tsx",
      "line": 13,
      "column": 7
    },
    {
      "file": "src/screens/inbox.tsx",
      "line": 39,
      "column": 7
    }
  ],
  "hosts": [
    "src/screens/contacts.tsx",
    "src/screens/inbox.tsx"
  ],
  "tier": "pattern",
  "confidence": 0.73,
  "reason": "4 components from 3 families (Form, Data Display, Action) repeat 3 times across 2 files.",
  "nearestExisting": {
    "name": "FilterBar",
    "score": 0.66,
    "source": "catalog"
  }
}
```

## Wiring it into a consumer's CI

For a design-system monorepo such as `unicron`:

```jsonc
// package.json
{
  "devDependencies": { "@snds/dsa": "github:snds/dsa#main" },
  "scripts": {
    "ds:scan": "dsa scan",
    "ds:patterns": "dsa patterns",
    "ds:ratchet": "dsa ratchet"
  }
}
```

```gitignore
.dsa/*
!.dsa/baseline.json
!.dsa/decisions.json
```

Freeze the bar once (`pnpm ds:ratchet --init`, commit `.dsa/baseline.json`),
then run `dsa ratchet` after typecheck, lint and build:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm typecheck
- run: pnpm lint
- run: pnpm --filter @unicron/tokens build
- run: pnpm --filter @unicron/ui build
- run: pnpm ds:ratchet            # exit 1 if any correct-use count grew
- run: pnpm ds:patterns           # advisory: upload .dsa/patterns.json as an artifact
```

When a violation is removed, run `dsa ratchet --update` to lower the bar.
When growth is accepted in review, do the same on purpose. Nothing lowers or
raises the baseline by itself.

## Library use

```ts
import { scan, patterns, ratchet } from "@snds/dsa";

const report = scan({ dir: "." });
console.log(report.adoption.total.customRatio);

const found = patterns({ dir: ".", all: false });
for (const c of found.candidates) console.log(c.tier, c.name, c.occurrences.length, c.hosts.length);

const gate = ratchet({ dir: "." });
if (!gate.ok) process.exit(1);
```

`buildGraph`, `detectPatternsInGraph`, `computeAdoption`, the zod schemas
(`schemas.*`) and every report type are exported too, so other tools can reuse
the graph or validate reports.

## Roadmap

- **Figma adapter.** Read instance nesting through a Figma plugin or the Figma
  MCP and emit the same suggestion-record schema, so code and design
  candidates sit in one list.
- **Adoption definition 3 (rendered).** A build-time stamp (`data-ds-element`)
  plus a sampled DOM count in production; structure only, never content,
  behind a feature flag.
- **Snapshot pipeline.** `dsa scan --json` per CI run → DuckDB or Postgres →
  Apache Superset, so adoption and correct use are time series per team, not
  one-off numbers.
- **Skill adapters.** Thin `component-audit` and `drift-detection` readers
  that consume `patterns.json` and `scan.json` instead of re-implementing the
  rule.
- **Vue / Svelte templates** once the JSX path has settled.

## Scope and provenance

`@snds/dsa` is written and owned by Sean Sands. It draws on public,
vendor-neutral practice: the Atomic Design reuse gradient
(components / recipes / snowflakes), the open component taxonomies behind the
62-component family map, and the published measurement work of design-system
teams (import counts, correct-use measures, lint ratchets). It also absorbs
Sean's earlier design-system analytics suite (findings, element review,
dashboards), which he wrote and holds the rights to, contributed here under the
same license.

It contains no design-system data of its own and no data from any employer or
client. It is designed so that **any** design system, including employer or
client systems, can consume it as a dependency: the tool reads the repository
it is pointed at and writes reports into that repository. Anything specific to
one system (its component names, file conventions, agent tools) lives in that
system's own repo as a profile (see [docs/architecture.md](docs/architecture.md));
nothing about that system ever lives in this package.

Licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm schema            # regenerate schema/*.json from the zod sources (after build)
node dist/cli.js patterns test/fixtures/app
```

The fixture under `test/fixtures/app/` is a tiny fake app with a shadcn-style
design system in `src/components/ui/`; the tests assert the exact tiers,
counts and findings shown above.
