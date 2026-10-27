# Add-ons

`@snds/dsa` (the repo root) is the core: scan, patterns, ratchet, and later findings and issues.
It keeps light dependencies so a project that only wants the ratchet installs nothing heavy.

Heavier features ship as optional packages in this folder. Each depends on the core with
`workspace:*` and adds its own commands to the one `dsa` CLI when it is installed.

| Package | What it adds | Heavy dependency |
|---|---|---|
| `@snds/dsa-review` | Element-by-element migration review: signatures, Storybook rendering, screenshots, placement, reachability, decisions, plan | Playwright |
| `@snds/dsa-dashboard` | `serve`, the HTML report, `publish`, the action queue, trends | React build |
| `@snds/dsa-history` | Run history in DuckDB, used by trends | DuckDB (native) |
| `@snds/dsa-figma` | Figma library usage | Figma API |
| `@snds/dsa-agent` | Agent workbench, MCP server, readiness providers | Agent CLIs |

None exist yet. They arrive in Phase 3 of the migration plan; see
[docs/architecture.md](../docs/architecture.md).
