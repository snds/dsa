# Changelog

All notable changes to `@snds/dsa` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
