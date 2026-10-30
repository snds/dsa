# Add-ons

`@snds/dsa` (the repo root) is the core: scan, patterns, ratchet, `dsa run` with findings and issues, and element review.
It keeps light dependencies so a project that only wants the ratchet installs nothing heavy.

Heavier features ship as optional packages in this folder. Each depends on the core with
`workspace:*` and adds its own commands to the one `dsa` CLI when it is installed.

| Package | What it adds | Heavy dependency |
|---|---|---|
| `@snds/dsa-review` | Screenshots, flows and page placement for the element review; Storybook measurement (`shots`, `render`, `setup`) | Playwright |
| `@snds/dsa-dashboard` | `serve`, `report`, `publish`, the action queue, trends | React build (shipped) |
| `@snds/dsa-history` | Run history in DuckDB, used by trends | DuckDB (native) |
| `@snds/dsa-figma` | Figma library usage, as a `dsa run` stage | Figma API |
| `@snds/dsa-agent` | Agent workbench, `mcp`, `agent brief` | Agent CLIs |

All five exist. `@snds/dsa-history` came in Phase 2; the other four in Phase 3.

- `review` measures in a browser: it needs Playwright's Chromium (`dsa setup`
  or `npx playwright install chromium`).
- `dashboard` ships its built UI in `templates/ui`. The source is in
  `dashboard/ui`; rebuild it with `pnpm --filter @snds/dsa-dashboard build:ui`.
  It uses `review` (live previews) and `figma` (token check) when they are installed.
- `agent` depends on `dashboard` (the queue) and `review` (before/after pictures).

How an add-on plugs in is in
[docs/architecture.md](../docs/architecture.md#run-history-and-add-ons).
