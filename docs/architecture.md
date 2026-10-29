# Architecture

dsa measures how a design system is used in the code that consumes it. This note
describes how it is put together and where a design system plugs in. It is the
target shape for absorbing the earlier analytics suite; the phases at the end say
what exists today.

## Three rules

1. **dsa knows no design system by name.** Nothing in this repo names a real
   system, its packages, or its files. Everything specific to one system lives in
   that system's repo as a [profile](#profiles). CI enforces it (Phase 4).
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
  src/profile.ts         the profile interface
  schema/                published JSON Schemas for config and reports
  data/                  neutral reference data (component families, pattern catalog)
packages/                optional add-ons (review, dashboard, history, figma, agent)
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

### Readers (adapters)

A `SourceAdapter` claims file extensions and creates one `FileReader` per run, so a
reader can keep a parser warm across files. React (TSX, JSX, TS, JS) is built in
with ts-morph and reads any file no other adapter claims. Vue single-file
components and Angular templates arrive as adapters in Phase 2, ported from the
suite.

### Element facts (Phase 2)

Element review needs more about native elements than the graph carries today:
literal attributes, handlers and what they do, resolved classes (through shared
constants, `cn`/`clsx` and conditionals), children (icon, label, badge, nested
controls) and context (ancestors, table cell, list, `.map()`, nav, form, gates).
These land as an optional `facts` field on `ElementNode`, filled only when the
review add-on asks for them, so the core's scan stays as fast as it is.

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

Rules and metrics a system adds on top of the catalog join the profile in Phase 2,
when the catalog and rules move into the core.

## Phases

| Phase | What lands | State |
|---|---|---|
| 0 | Workspace, provenance, profile interface, reader seam, this note | done |
| 1 | Extended config (tiers, other repos, per-app switches, `profile`) and `dsa config migrate` | done |
| 2 | Core ports: repo discovery, Vue/Angular readers, versions, tokens, Tailwind drift, findings, issues; element facts | next |
| 3 | Add-ons: review, dashboard, history, figma, agent | |
| 4 | Neutralize: every system-specific name behind the profile; CI name check; port the suite's tests | |
| 5 | A consuming system switches to dsa as a dependency, after a parity run | |

Every phase keeps today's numbers: the fixture app's scan, patterns and ratchet
reports don't change, and existing configs keep working.
