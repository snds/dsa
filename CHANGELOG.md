# Changelog

All notable changes to `@snds/dsa` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- One bad input no longer ends a run. A file its reader can't read is skipped and
  listed (`note: skipped N files`), a pnpm lockfile holding several YAML documents
  is read in full, an unreadable lockfile costs only the version rows, and a
  `<table>` from a reader that collects no table facts (Angular, Vue templates) is
  still classified. Found running dsa on ten open-source design systems.

## [0.3.1] - 2026-10-29

### Fixed

- Signatures follow a cva wrapped in a function declaration
  (`function buttonVariants(p) { return cn(variants(p)) }`), not only in an arrow
  function, so such a component's variants and sizes are read.

## [0.3.0] - 2026-10-29

Every feature of the earlier analytics suite now lives here (Phases 2–4), and the
add-ons can be installed outside this repo.

### Releases

- Releases: one version for the core and every add-on. Pushing a tag `vX.Y.Z`
  tests, packs, installs the tarballs into a fresh project and attaches them to a
  GitHub Release (`.github/workflows/release.yml`, `pnpm release:pack`,
  `pnpm release:smoke`). CI runs the pack and the install on every pull request.

- Add-ons name the core and each other as peer dependencies (`workspace:^`), so a
  consumer installs the release tarballs with no overrides. `@snds/dsa-agent`'s
  dashboard and review are peers now, not dependencies.
- `dsa mcp` reports the package's version instead of a fixed `0.1.0`.

### Fixed after the Unicron QA review

- Component signatures read components in subfolders of `src/` that the package's
  `src/index` re-exports (a shadcn layout keeps them in `src/components/ui/`).
  Files directly in `src/` are read as before; a deeper component never replaces
  one found there.
- An element passed as a component's `render` prop (`<Item render={<button />}>`)
  is the element that component draws as, not a raw look-alike. Content passed to
  other props (`action={<button>…</button>}`) still counts.
- A screenshot match tied with other elements on the page is as sure as a guess
  among them (at most 1 in N), so its placement no longer feeds the next
  evaluation.
- The report, dashboard, queue prompt and agent brief fall back to the system's
  name before the folder's.


### Added

- CI name check: `scripts/name-check.mjs` fails when a tracked file matches the
  `DSA_NAME_DENYLIST` pattern. In CI the pattern is a repository secret; it is
  required on pushes to `main` and skipped where secrets can't be read.
- Profiles: `defineProfile`, `loadProfile` and `resolveProfile`. A profile holds
  what one design system knows that config can't say (component list, role
  offers, its own tooling files, lab pages, an agent-readiness provider, its name
  in report wording). It lives in that system's repo; dsa ships a neutral
  default. Not yet read by any command; the config gains `profile` next.
- Source adapters: `buildGraph` takes `adapters`, readers for other markup
  languages that claim file extensions. React is the built-in `reactAdapter` and
  still reads every file no adapter claims. `FileGraph` gains `framework`.
- A pnpm workspace for optional add-ons under `packages/`, and
  `docs/architecture.md`.
- Config `profile`: the system's profile module, by path or package name.
  `loadRunContext` loads it and every run carries `ctx.profile`; the CLI runs
  through it. `createRunContext` takes `options.profile` and refuses a config
  that names a profile it can't import.
- Config sections for features still landing, in the schema now so configs can
  carry them: `system.children` and the core's `tagPrefixes` / `mainRef`; where
  code lives (`path`, `git`, `aliases`, `exclude`, `pin`, `owner`, `repo`);
  `consumers`, `extraRepos`, `internalConsumers`; `correctUse.elementMap`,
  `nativeLookalikes`, `exceptionsFile`, `deprecated`; `tokens`, `tailwind`,
  `apps`, `review`, `rendered`, `shots`, `modules`, `figma`, `github`,
  `agents`, `report`, `settings`. None has a default, so existing configs parse
  and report exactly as before.
- `dsa config migrate`: converts an analytics-suite config, listing every key
  that moved or was left out. Library: `migrateSuiteConfig`, `isSuiteConfig`.
- Exports `loadRunContext`, `scanFromContext`, `patternsFromContext`,
  `ratchetFromContext`.
- `dsa run`: the earlier analytics suite's engine, ported. It reads the repo's
  workspaces and other repos (a local folder, or a git URL it clones and only
  reads), package versions and pins, component use (React, Vue single-file
  components, Angular templates), native look-alikes, token compliance and
  Tailwind drift. It computes the catalog's metrics (`data/metric-catalog.yaml`),
  raises findings that open, update, hold and resolve across runs, and writes an
  issue draft for each open one.
- Element review: every native look-alike gets a recommendation, a confidence
  and its evidence, read from its classes, children and context and matched
  against the core's component signatures. Decisions are kept in each app's
  decisions file and calibrate later runs.
- Commands: `where`, `init`, `run`, `reevaluate`, `findings`, `issues draft`,
  `issues sync`, `snooze`, `settings`, `settings set`, `elements`,
  `signatures`, `explain`, `decide`, `plan`. Global options `--root`, `--data`,
  `--profile`.
- `@snds/dsa-history` (`packages/history`): run history in DuckDB. `dsa run` and
  the history commands use it when it is installed, and say what to install
  when it isn't.
- Add-ons: `defineAddon({ name, store, stages, commands })`. The CLI finds
  installed `@snds/dsa-*` packages and lets them add commands, `dsa run` stages
  and the history store.
- Profile fields for the element review: `icons`, `buttonTokens`,
  `controlHeights`, `navTokens`, `containers`, `metrics`; a role offer's
  `verdict`; and a readiness provider's `isSystemRepo`, `setupHint`,
  `missingNote` and extra metric rows. Every system-specific value the suite
  knew is behind these; dsa ships neutral defaults.
- `scripts/parity/`: runs the suite and dsa on one repo and checks they store
  the same data.
- Dependencies: `@babel/parser`, `@vue/compiler-sfc`, `htmlparser2`, `semver`,
  `yaml` (all plain JavaScript).

- Phase 3 add-ons, each adding its commands to the one CLI:
  - `@snds/dsa-dashboard`: `serve` (port 4319), `report`, `publish`, the action
    queue, and the React dashboard (its build ships in the package).
  - `@snds/dsa-review`: `shots`, `render`, `setup`, scripted flows, the
    Storybook preview proxy, and `run --shots` / `--no-shots`.
  - `@snds/dsa-figma`: the Figma crawl as a `dsa run` stage, and
    `run --figma` / `--no-figma`.
  - `@snds/dsa-agent`: `mcp`, `agent brief`, and the dashboard's agent
    workbench (sessions in a sandbox, proposals, before/after pictures).
- Add-on API: `afterRun` hooks (screenshots, the report, the agent snapshot run
  after `run` and `reevaluate`) and `routes` the dashboard mounts. Commands get
  `context`, `addons` and `requireStore`.
- `@snds/dsa/engine`: the engine's modules, for add-ons.
- Profile fields for add-ons: `usage`, `iconFont`, `agent` (docs, MCP server,
  checker, sandbox links), and a readiness provider's `usageMetric`,
  `reconcile` and `benchRuns`.
- Rendered comparison and fit scores (`compareRendered`, `computeFit`) are in
  the core, so the report needs no browser.
- `scripts/parity/` also compares the report, the published site, issue drafts,
  the review queue and screenshot manifests (`--shots`).

### Changed

- A config written for the analytics suite is converted in memory when it is
  loaded, instead of parsing as an empty dsa config.
- README provenance and NOTICE: dsa now absorbs the author's earlier analytics
  suite, which he owns.

## [0.2.0] - 2026-10-17

### Added

- `rawElements`, a fifth correct-use count: plain HTML controls written in a
  consumer where a design-system control belongs (`<button>` by default;
  `correctUse.rawElements` in the config lists the tags). An element handed to
  a component through a prop (`render={<button />}`) isn't counted. The scan
  report lists each one with its location, and the ratchet fails when the
  count grows. Raised from Mailbird's raw-button sweep (its ADR-0057), where
  44 plain `<button>`s were invisible to the other checks.
- The ratchet report's `untracked`: metrics the baseline doesn't have yet
  (added by a newer dsa). They're shown and not compared, so upgrading dsa
  never fails CI on its own; `--update` starts ratcheting them.

## [0.1.0] - 2026-10-15

### Added

- Composition graph built with ts-morph: one tree per JSX root, element kind
  (`ds` / `local` / `html` / `external`) resolved from import declarations and
  `dsa.config.json`, literal shape props, file/line/column, override and spread
  flags, declared local components with their render roots.
- `dsa scan`: component inventory, adoption counts (definition 1: imports and
  instances) per file, directory and total, custom ratio, and correct-use
  findings (className/style overrides on DS components, spread props on DS
  components, local look-alikes of DS names).
- `dsa patterns`: pattern-candidate detection. Canonical anatomy hashing,
  occurrence counting across hosts, the 3+ occurrences / 2+ hosts rule, the
  tier heuristic (pattern · compound-component · variant · snowflake),
  candidate naming by intent, nearest-existing matching against the framework
  pattern catalog and already-named local components, `--all` for snowflakes,
  `--ignore <id>` with parking after three ignores.
- `dsa ratchet`: freezes correct-use violation counts in a baseline and fails
  CI when any count grows; `--init` and `--update`.
- `--json` on every command; JSON reports in `output.dir` otherwise.
- Public API: `scan`, `patterns` / `detectPatterns`, `ratchet`, `buildGraph`,
  the zod schemas and all report types.
- Data files: the seven-pattern catalog and the 62-component → family map
  from the component and pattern framework.
- JSON Schema files generated from zod for the config, the scan report, the
  patterns report, the suggestion record and the ratchet report.
