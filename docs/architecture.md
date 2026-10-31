# Architecture

dsa measures how a design system is used in the code that consumes it. This note
describes how it is put together and where a design system plugs in. It is the
target shape for absorbing the earlier analytics suite; the phases at the end say
what exists today.

## Three rules

1. **dsa knows no design system by name.** Nothing in this repo names a real
   system, its packages, or its files. Everything specific to one system lives in
   that system's repo as a [profile](#profiles). CI enforces it: `scripts/name-check.mjs`
   fails on any tracked file that matches the `DSA_NAME_DENYLIST` secret, so the
   names themselves never land here either.
2. **The core stays light.** `@snds/dsa` installs five small dependencies. Anything
   that needs a browser, a native database or a UI build ships as an
   [add-on](../packages/README.md).
3. **One model, many readers.** Every markup language is read into the same
   file graph, so every metric works the same on React, Vue and Angular.

## Layout

```text
dsa/                     @snds/dsa: core library + the `dsa` CLI
  src/graph/             file graph, per-language readers (adapters)
  src/detect/            pattern candidates
  src/metrics/           adoption and correct use
  src/engine/            `dsa run`: repo discovery, scanners, findings, issues, element review
  src/addons.ts          how add-ons plug in
  src/profile.ts         the profile interface
  schema/                published JSON Schemas for config and reports
  data/                  neutral reference data (component families, pattern catalog)
packages/                optional add-ons (review, dashboard, history, figma, agent)
  dashboard/ui/          the dashboard's React source; its build is dashboard/templates/ui
docs/                    this note
```

The core stays at the repo root on purpose: consumers install it straight from
git, and editors fetch `schema/config.json` from the root on `main`.

## The file graph

A run reads every included file into a `FileGraph`:

- `framework`: which reader produced it (`react`, `vue`, `angular`).
- `roots`: the composition trees, one `ElementNode` per element, with its kind
  (`ds`, `local`, `html`, `external`), import source, literal shape props,
  location, override flags and children.
- `declared`: components declared in the file, with the root they render.
- `imports`: what each local identifier resolves to.

Adoption, look-alikes, raw elements, pattern candidates and the ratchet all read
this graph and nothing else.

### The system model

`dsa model` (`src/model/`) is the general replacement for both readers below. It
builds a graph of **concepts** (the system's components), their **realizations** (every
form one can be written in: export, tag, attribute selector, class block, macro) and
their **uses**, each with evidence. System-side extractors read declarations; consumer
readers turn every markup language into one element model; one matcher resolves an
element to a concept by any realization. It scored 754 of 774 documented components
and 571 of 587 hand-counted uses across ten open-source systems spanning React, Vue,
Angular, Svelte, web components, Nunjucks and plain CSS classes (the corpus lives
outside this repo, per rule 1). The rules were tuned on that corpus, so systems it
hasn't seen are the next test.

`scan`, `ratchet` and `run`'s instances read through it (`readRepo`, built lazily on
the run context). The React graph remains for `patterns` and is built only when they
run; `run`'s look-alikes and element review still come from the engine's scanner.

### Readers (adapters)

A `SourceAdapter` claims file extensions and creates one `FileReader` per run, so a
reader can keep a parser warm across files. React (TSX, JSX, TS, JS) is built in
with ts-morph and reads any file no other adapter claims.

`dsa run` does not read through the graph yet. Its engine (`src/engine/`) is the
suite's, ported as it was: it parses with Babel, reads Vue single-file components
with `@vue/compiler-sfc` and Angular templates with `htmlparser2`. Fitting it into
the graph would have changed its numbers, and the port had to store exactly what
the suite stored. The two readers meet in a later phase.

### Element facts (Phase 2)

Element review needs more about native elements than the graph carries:
literal attributes, handlers and what they do, resolved classes (through shared
constants, `cn`/`clsx` and conditionals), children (icon, label, badge, nested
controls) and context (ancestors, table cell, list, `.map()`, nav, form, gates).
The engine reads these (`ElementFeatures`, `src/engine/scanners/features.ts`) for
every look-alike in `dsa run`, and the rules that turn them into a
recommendation (`classify*`, roles, signatures, host context) are core code. They
are not a `facts` field on `ElementNode` yet; that waits for the readers to meet.

## Profiles

A profile tells dsa what config values can't: where the system's component list
comes from, what it offers for each UI role, the files its own lint and docs keep,
its agent-readiness tool, and its name in report wording. dsa ships a neutral
default. A system keeps its profile in its own repo:

```js
// acme-design-system/dsa.profile.mjs
import { defineProfile } from "@snds/dsa";

export default defineProfile({
  name: "acme",
  label: "Acme",                       // "No Acme component fits"
  sources: ["@acme/"],                 // import scopes that are the system
  components: (root) => readAcmeComponentList(root),
  roles: { "icon-button": { use: "Button", from: "@acme/ui/button", props: { variant: "ghost" } } },
  files: {
    elementMap: "packages/lint/raw-elements.json",
    exceptions: "docs/raw-elements.exceptions.json",
    decisions: "docs/raw-elements.decisions.json",
  },
  labPaths: ["**/labs/**"],
  readiness: acmeBenchProvider,        // optional
});
```

The config's `profile` key names it, by a path relative to the config file or a
package name. `loadRunContext` loads it and every run carries the resolved
profile (`ctx.profile`); the CLI always runs that way. `createRunContext` stays
synchronous: it takes an already-loaded `options.profile`, and refuses a config
that names one it can't import. A config value for the same thing (an element
map path, a lab-page glob) wins over the profile's.

The element review reads more from the profile: `icons` (its icon exports),
`buttonTokens` (which classes show each Button variant and size), `controlHeights`
(its control-height custom properties), `navTokens`, `containers` (where a part's
container is imported from), and `metrics` the system adds to the catalog. The
engine takes the profile once per run (`useSystem`) and every rule reads it from
there, so no rule names a system. A system's own rules (beyond its metrics) are
not in the profile yet.

## Run history and add-ons

The core defines the history tables and a small `Store` interface (`exec`, `all`,
`insertMany`, `latestRunId`, `close`). `@snds/dsa-history` supplies the DuckDB
store. `dsa run` uses whatever store an installed add-on offers, and says what to
install when there is none.

An add-on is a package named `@snds/dsa-<name>` whose `package.json` has
`"dsa": { "addon": "<module>" }`. Its module's default export is
`defineAddon({ name, store?, stages?, commands? })`:

- `store` opens the run history.
- `stages` add steps to `dsa run`: "scan" stages run before metrics (a Figma
  crawl), "metrics" stages after, with the store open. A stage that fails costs
  only itself. The run's CLI flags reach a stage as `ctx.options`.
- `afterRun` hooks run after `dsa run` and `dsa reevaluate` have stored their
  results, in order: screenshots (10), the report (50), the agent snapshot (90).
  The dashboard's Run button runs the same hooks.
- `routes` are mounted by `dsa serve` (the agent workbench's API).
- `hosts` and `histories` add host adapters and history backends ([Where it is deployed](#where-it-is-deployed)).
- `commands(program, api)` adds commands to the one CLI, or options to the
  core's (`run --shots`). `api.context(cmd)` loads config and profile from the
  global options, the way core commands do.

Add-ons import the engine from `@snds/dsa/engine`. Code without a heavy
dependency that two add-ons need lives in the core: rendered comparison and fit
scores (the report and the review both use them) and Figma link parsing
(Settings). Each package keeps the suite's TypeScript strictness for its ported
code (`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` off); the core
keeps both on.

What a system knows that the add-ons need comes from its profile: `label` (every
place the UI or a brief names the system), `usage` (the Usage view), `iconFont`,
`readiness.usageMetric`, `reconcile` and `benchRuns`, and `agent` (its docs,
component entries, MCP server, checker, and folders a sandbox links).

The CLI finds add-ons in `node_modules/@snds` next to the repo it runs on and next
to dsa, and in this checkout's `packages/`.

## Where it is deployed

A run can measure the product where it is deployed. Three seams, all interfaces in
`src/deploy/types.ts`, each picked by name from the config ([deploy.md](deploy.md)):

- `RevisionSource`: which commit is live (`live.revision`). `checkLive` compares it with the
  checkout and refuses, or labels, anything else; every run records the result in its `sources`.
- `HostAdapter`: what a static dashboard's Re-scan and decision buttons do, and where
  `dsa apply-decisions` reads decisions from (`host.adapter`).
- `HistoryBackend`: where the data folder persists between runs (`history.adapter`).

Live surfaces (`live.app`, `live.apps`, `live.storybook`) are a deployed URL or a built folder
served on localhost; the review add-on opens them instead of starting a dev server. The generic and
GitHub hosts and the local, git-branch and command histories ship in `src/deploy/`; add-ons add
more with `hosts` and `histories`. Core code reaches all of them only through the interfaces.

## Parity with the suite

`scripts/parity/run.mjs` runs the suite and dsa on one repo with git history,
Figma and the registry off and fixed times, each side twice, each time as two
runs a day apart. It dumps every table as sorted JSON (run ids renumbered,
timestamps blanked) and compares. Phase 2 ended with no differences on the
fixture monorepo (222 rows) and on the system the suite was built for (9,512
rows, agent readiness included).

Since Phase 3 each side also writes what its CLI writes for people, and those
are compared: the report and the published site (their embedded data by
top-level key, and the HTML around the UI's script and stylesheet), issue
drafts, the review queue, and screenshot and Storybook manifests (ids, files,
routes; never pixels). `--shots` takes screenshots on both sides first. A few
field names changed on purpose (the suite named them after its system; dsa says
`system`, as in `systemShot`) and two sentences changed wording; `dump.mjs`
lists them and maps the suite's side.

## Phases

| Phase | What lands | State |
|---|---|---|
| 0 | Workspace, provenance, profile interface, reader seam, this note | done |
| 1 | Extended config (tiers, other repos, per-app switches, `profile`) and `dsa config migrate` | done |
| 2 | Core ports: repo discovery, Vue/Angular reading, versions, tokens, Tailwind drift, findings, issues, element review; run history (`@snds/dsa-history`); add-on API | done |
| 3 | Add-ons: review (screenshots, Storybook measurement), dashboard (`serve`, `report`, `publish`), figma, agent (`mcp`, `agent brief`) | done |
| 4 | Neutralize: every system-specific name behind the profile; CI name check; port the suite's tests (132 of 133; the last one checks a system's own usage tool, so it lives with that system's profile) | done |
| 5 | A consuming system switches to dsa as a dependency, after a parity run | next |

Every phase keeps today's numbers: the fixture app's scan, patterns and ratchet
reports don't change, and existing configs keep working.

### Phase 2 notes

- The engine was ported as it was rather than through the graph's readers (see
  [Readers](#readers-adapters)). Element facts live in the engine, not on `ElementNode`.
- Run history moved up from Phase 3: `dsa run` needs it, so `@snds/dsa-history`
  exists now.
- Moved to Phase 3, because they need a browser, a UI build or an agent CLI:
  `serve`, `report`, `publish`, `shots`, `render`, `setup`, `mcp`, `agent brief`,
  the screenshots and report that `run` used to add, the rendered evidence
  `reevaluate` used to apply, and the Figma crawl.
- Neutral defaults: no lab pages; exceptions and decisions in
  `docs/raw-elements.exceptions.json` and `docs/raw-elements.decisions.json`; no
  import paths in the role map. A profile sets its own.
- `--root` names the repo for `dsa run`, and the config's paths resolve against
  it (the suite's rule). Without it, the config's folder is the repo.
- From `scan.exclude`, the engine skips the extra entries that name one folder
  (`legacy/**`); other globs only shape the graph.


### Phase 3 notes

- Four packages: `review`, `dashboard`, `figma`, `agent`. `agent` depends on
  `dashboard` (the queue) and `review` (before/after pictures). `dashboard`
  uses `review` and `figma` only when they are installed.
- Moved to the core instead of an add-on: rendered comparison, fit scores and
  Figma link parsing (no heavy dependency, needed by two packages).
- The system-specific parts of the suite's agent code (its component list,
  contract and decision records, MCP server, usage checker, bench runs, usage
  scan, icon font) are profile hooks. A system without them gets a working
  workbench that only uses dsa's own tools.
- `dsa publish` writes to `<data>/site` by default (the suite wrote to its own
  folder). The queue's agent prompt names the configured decisions file and
  `dsa run --no-shots`.
- The UI takes the system's name from the profile (`label`). Recharts calls its
  polar layout by a word the name check forbids; the UI build renames that one
  internal value.
- Agent sandboxes live in `~/.cache/dsa/sandboxes`.
