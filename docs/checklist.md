# Design system checklist

`dsa checklist` scores how complete and healthy a design system is, with agent readiness
included. It runs the same scan as `dsa scan`, so it marks every item it can measure itself.
The team answers the rest in one small file. The result is one score per area, with evidence
for every item.

```sh
dsa checklist                 # -> .dsa/checklist.json and a summary in the terminal
dsa checklist --markdown      # also .dsa/checklist.md, a page to share
dsa --json checklist          # the report on stdout
```

Run it in the system's own repo to score the system. Run it in a product repo to score usage in
product code. Items about the system's own source (tokens, icons, components and some agent items)
are left to the team when the repo holds no system source. That way a product repo isn't marked
"missing" for tokens it imports.

## How an item is scored

| Status | Meaning | Counts as |
|---|---|---|
| done | Found, at or above the bar | 1 |
| partial | Found, below the bar | ½ |
| missing | Looked for, not found | 0 |
| n/a | The team says it doesn't apply | left out |
| unanswered | The scan can't measure it, and the team hasn't answered | left out, listed |

An area's score is done plus half of partial, divided by the items that apply. The overall score
works the same way over every item. Unanswered items are left out of the score but listed, so the
score always says how much of the checklist it covers.

Every item says where its status came from:

- **scan**: the scan measured it, and the evidence says what it found or looked for.
- **team**: an answer in `dsa.checklist.json`.
- **team (over scan)**: an answer that replaces what the scan found. The scan's result is kept
  beside it, so a disagreement stays visible.

## The team's answers

Put `dsa.checklist.json` next to `dsa.config.json` (or pass `--answers <file>`). Every key is an
item id from the tables below:

```json
{
  "$schema": "https://github.com/snds/dsa/schema/checklist-answers.json",
  "items": {
    "mobile.native": { "status": "na" },
    "patterns.forms": { "status": "partial", "note": "Form layout guide drafted, not published" },
    "agents.rules": { "status": "done", "note": "Rules ship in the docs repo, not this one" }
  }
}
```

A status is `done`, `partial`, `missing` or `na`. A note shows as the item's evidence. Unknown ids
are listed in the report, so a renamed item doesn't fail quietly.

## Where the checklist comes from

The twelve health areas follow the shape of the community's design-system field guides: tokens,
icons, components, patterns, the design tool, accessibility, communication, docs, testing,
infrastructure and mobile. The items are written here in dsa's own words.

Two areas are new:

- **Usage in product code** is what dsa measures and checklists usually leave to a guess:
  adoption, correct use, and a ratchet that keeps findings from growing.
- **Agent readiness** goes past a single "AI" line. It follows the maturity spectrum the field
  uses (none → emerging → invested → AI-native) and breaks it into six jobs:
  1. **Readable source**: a component manifest, tokens as data, llms.txt, and usage guidance as text.
  2. **Live access**: the system's own MCP server, and agents connected to the design file and docs.
  3. **Rules and skills**: instruction files and repeatable skills, for both audiences.
  4. **Guard rails**: lint rules, typed APIs and the ratchet, so off-system output fails fast.
  5. **Measurement**: agents given real tasks and scored for staying on-system.
  6. **Feedback**: gaps an agent finds become requests, not new components.

  MCP stands for Model Context Protocol, the standard way agents call tools.

A system's profile adds what files can't show. `profile.agent.mcpServer` marks the MCP server
done. `profile.readiness` (with bench runs) marks benchmarks done. `profile.files.elementMap`
counts as a guard rail.

## Limits

- Detection reads files, names and dependencies. It finds that a thing exists, not that it is
  good. A docs page counts whether or not it is current.
- Components are matched to docs, stories and tests by name (`button.stories.tsx`,
  `button/README.md`). Docs filed under other names aren't matched.
- Token coverage counts tokens the model reads: CSS custom properties, Sass variables and DTCG
  JSON. Styles written in JavaScript (CSS-in-JS theme objects) aren't read, so a system that only
  uses them scores low on tokens. Answer those items to override them.
- A docs site or MCP server kept in another repo isn't seen. Answer the item and say where it is.

## Items

### Tokens

| Id | Item | Size | Measured by the scan |
|---|---|---|---|
| `tokens.primitive` | **Primitive tokens** — Raw values (color, spacing, type size, radius, shadow, z-index) are named tokens, not literals. | S | literal-valued tokens the model reads (done at 10+) |
| `tokens.semantic` | **Semantic tokens** — Tokens named for intent (surface, text-muted, danger) map onto primitives, so design and code share one vocabulary. | L | alias tokens: done at 10+ and 20% of all tokens |
| `tokens.component` | **Component tokens** — Components have their own tokens where semantic ones don't cover a decision. | M | tokens named for a component (done at 5+) |
| `tokens.bound` | **Components use tokens** — Components' own styles reference tokens instead of hard-coded values. | M | share of components whose styles reference tokens (done 60%, partial 20%) |
| `tokens.themes` | **Themes and modes** — Tokens switch for light/dark, high contrast, brand or density without touching components. | L | tokens set per mode, such as dark (done at 10+) |
| `tokens.color` | **Color** — Color roles for surfaces, text and borders, built with contrast in mind. | L | color tokens (done at 8+) |
| `tokens.typography` | **Typography** — A type scale with line heights, weights and letter spacing for each text role. | M | typography tokens (done at 4+) |
| `tokens.spacing` | **Spacing** — A spacing scale used everywhere, with room for semantic and density steps. | M | spacing tokens (done at 4+) |
| `tokens.motion` | **Motion** — Standard durations and easing curves, so animation is consistent. | M | duration and easing tokens (done at 2+) |
| `tokens.elevation` | **Elevation** — Shadow, layer and z-index tokens that define depth and stacking. | M | shadow and z-index tokens (done at 2+) |
| `tokens.breakpoints` | **Breakpoints** — A named list of breakpoints code and design both refer to. | S | breakpoint tokens (done at 2+) |

### Icons

| Id | Item | Size | Measured by the scan |
|---|---|---|---|
| `icons.library` | **Icon library** — One searchable icon set that design and code both use. | M | icon components, or SVG files in icon folders (done at 10+) |
| `icons.pipeline` | **Icon pipeline** — A defined path from the source of truth to optimized icons in code, by hand or automated. | M | svgo, svgr, an icon font tool or an icon build script |
| `icons.principles` | **Icon principles** — Guidelines for icon style, naming, and when and how to use them. | S | no — the team answers |
| `icons.illustrations` | **Illustrations** — An asset library and guidelines for spot illustrations. | M | no — the team answers |

### Components

| Id | Item | Size | Measured by the scan |
|---|---|---|---|
| `components.foundation` | **Foundational components** — The everyday set (button, input, select, checkbox, tooltip, badge, alert, card) covers most needs. | M | recognized kinds among button, text input, checkbox, select, tooltip, badge, alert, card (done at 6) |
| `components.complex` | **Complex components** — Harder pieces (data table, date picker, combobox, tree, editor, chart, stepper) are in the system, not rebuilt per product. | L | components named table, grid, date picker, combobox, tree, editor, chart, stepper… (done at 4) |
| `components.api` | **Shared API** — Props that mean the same thing are named the same (variant, size, onChange) across components and the design tool. | M | share with variant axes (40%) and an axis name shared by 3+ components |
| `components.anatomy` | **Named anatomy** — Compound components expose their parts (title, trigger, body) by name, so they are composed instead of re-built. | M | components with named parts or slots (done at 5) |
| `components.unique` | **Product-specific components** — Components for the experiences that set your product apart are part of the system too. | L | no — the team answers |
| `components.portable` | **Portable** — Components hold no business logic, so any product can use them. | M | no — the team answers |
| `components.modes` | **Context modes** — Components respond to density, touch, and right-to-left. | S | no — the team answers |

### Patterns

| Id | Item | Size | Measured by the scan |
|---|---|---|---|
| `patterns.named` | **Recurring compositions are named** — When the same arrangement of components keeps appearing, someone decides whether it becomes a pattern (`dsa patterns`). | M | pattern decisions recorded with `dsa patterns --ignore` (otherwise the team answers) |
| `patterns.sections` | **Page sections** — Larger pieces (a page header, a filtered table) built from tokens and components. | S | no — the team answers |
| `patterns.templates` | **Templates** — Page-level layouts as a starting point for design and code. | M | no — the team answers |
| `patterns.forms` | **Forms** — Guidance and examples for simple to complex form layouts, with do's and don'ts. | M | no — the team answers |
| `patterns.feedback` | **Notifications** — Rules for transient feedback: placement, stacking and timing. | S | no — the team answers |
| `patterns.more` | **More patterns** — Onboarding, multi-step flows, navigation, search and filtering. | S | no — the team answers |

### Design tool

| Id | Item | Size | Measured by the scan |
|---|---|---|---|
| `design.library` | **Published library** — One published, versioned design library that designers actually use. | L | no — the team answers |
| `design.codeLinks` | **Design linked to code** — Design components map to code imports and snippets (for example Code Connect), so both sides show the same thing. | M | Code Connect files, config or package |
| `design.docLinks` | **Docs link to the design file** — Stories or docs pages link to the matching design component. | S | design-file links in stories and docs pages |
| `design.parity` | **Code parity** — Variant and property names in the design tool mirror the code API. | M | no — the team answers |
| `design.variables` | **Design variables** — Primitive, semantic and component tokens are published as variables and used by components. | M | no — the team answers |
| `design.current` | **Current with the tool** — The library keeps up with the design tool's new features (slots, modes, layout). | S | no — the team answers |

### Accessibility

| Id | Item | Size | Measured by the scan |
|---|---|---|---|
| `a11y.policy` | **Written policy** — A written standard for what accessible means here and who is responsible. | S | a Markdown file about accessibility |
| `a11y.automated` | **Automated checks** — Accessibility rules run in tests or stories, not only in lint. | M | axe, an a11y story addon or pa11y (lint plugins alone are partial) |
| `a11y.reducedMotion` | **Reduced motion** — Components respect the user's reduced-motion setting. | M | `prefers-reduced-motion` in the system's styles or source |
| `a11y.contrast` | **Color contrast** — Color tokens are built for predictable contrast, and pairs are checked against WCAG or APCA. | M | no — the team answers |
| `a11y.keyboard` | **Keyboard and structure** — Components and templates work by keyboard, with landmarks, roles and a sound heading order. | M | no — the team answers |
| `a11y.iconLabels` | **Icon labels** — Icon-only controls carry accessible names. | S | no — the team answers |
| `a11y.i18n` | **Internationalization** — Components handle long strings, language switching and right-to-left layout. | M | no — the team answers |
| `a11y.screenReaders` | **Screen-reader testing** — The team tests by hand with real assistive technology. | M | no — the team answers |

### Communication

| Id | Item | Size | Measured by the scan |
|---|---|---|---|
| `comms.owner` | **Point of contact** — A named team or person owns issues, education, the roadmap and requests. | M | a CODEOWNERS file |
| `comms.changelog` | **Changelog** — Releases come with a versioned changelog that consumers are told about. | S | CHANGELOG.md or changesets |
| `comms.decisions` | **Decision log** — A written record of why a token, component or design decision was made. | S | an `adr`, `decisions` or `rfcs` folder of Markdown records |
| `comms.intake` | **Request intake** — Anyone can file a bug or a component request through a template, and the backlog is visible. | M | issue templates (done at 2) |
| `comms.adoption` | **Adoption measurement** — Real component usage is measured over time, not guessed. | M | done with a ratchet baseline; partial on a one-off run |
| `comms.support` | **Support channel** — A place where anyone can ask a question and get an answer. | S | no — the team answers |
| `comms.officeHours` | **Office hours** — A recurring time for questions, feedback and training. | S | no — the team answers |

### Docs

| Id | Item | Size | Measured by the scan |
|---|---|---|---|
| `docs.start` | **Getting started** — A clear path to install, import and use the system the first time. | M | install steps in a top-level README |
| `docs.site` | **Docs site** — A browsable docs site or Storybook that shows every component. | L | Storybook, a docs-site config, or a `docs`/`website` app |
| `docs.components` | **Component docs** — Every component has a docs page. | L | share of components with a docs page by name (done 80%, partial 30%) |
| `docs.examples` | **Live examples** — Every component has stories or live examples. | M | share of components with stories (done 80%, partial 30%) |
| `docs.contributing` | **Contribution guide** — How to propose, build and review a change to the system. | S | CONTRIBUTING.md |

### Testing

| Id | Item | Size | Measured by the scan |
|---|---|---|---|
| `testing.unit` | **Component tests** — Every component has tests. | M | share of components with a test file (done 80%, partial 30%) |
| `testing.visual` | **Visual regression** — Screenshots catch unintended visual changes before release. | M | Chromatic, Percy, Loki, BackstopJS, Argos or a story test runner |
| `testing.ci` | **Continuous integration** — Tests and checks run on every change. | S | a CI workflow file |

### Infrastructure

| Id | Item | Size | Measured by the scan |
|---|---|---|---|
| `infra.published` | **Published packages** — The system ships as versioned packages consumers install. | M | a public package with a version |
| `infra.release` | **Release automation** — Versions, changelogs and publishing happen by a tool, not by hand. | M | changesets, semantic-release, release-please, Lerna or similar |
| `infra.types` | **Typed component API** — Components ship types, so wrong props fail at build time, for people and agents alike. | S | share of the system's source in TypeScript (done 80%) |

### Usage in product code

| Id | Item | Size | Measured by the scan |
|---|---|---|---|
| `usage.adoption` | **Adoption** — Product code builds with the system's components rather than local ones. | L | system instances over system + local ones in product code (done 80%, partial 50%) |
| `usage.correctUse` | **Correct use** — System components are used as designed: few style overrides, spread props, look-alikes or raw controls. | M | overrides, spread props, look-alikes and raw controls per system instance (done ≤5%, partial ≤20%) |
| `usage.ratchet` | **Ratchet in CI** — Correct-use findings can't grow: a baseline is kept and checked on every change (`dsa ratchet`). | S | a ratchet baseline and a CI workflow that runs dsa (one of them is partial) |

### Agent readiness

| Id | Item | Size | Measured by the scan |
|---|---|---|---|
| `agents.manifest` | **Component manifest** — A generated, machine-readable index of components (import, props, description, examples) an agent can load. | M | custom-elements.json, web-types, a registry, a components manifest, or per-component docs records; partial when dsa can read components only from source |
| `agents.tokenFile` | **Tokens as data** — Tokens are published in a machine format (DTCG JSON or DESIGN.md front matter), the closed set of legal values. | S | DTCG JSON (`$value`) or DESIGN.md front matter; partial when tokens are only in CSS or Sass |
| `agents.llms` | **llms.txt and Markdown docs** — The docs site publishes llms.txt (and ideally a full-text and per-page Markdown copy) for agents. | S | llms.txt, llms-full.txt, or a script that builds them |
| `agents.guidance` | **Usage guidance as text** — Docs say when to use a component, when not to, and what to use instead, not just its props. | M | share of components whose docs say when to use, when not to, or what instead (done 50%) |
| `agents.rules` | **Agent rules** — Instruction files (AGENTS.md, editor rules) tell agents how to build with the system, and how to change it. | M | AGENTS.md, or two of CLAUDE.md, Cursor, Copilot, Windsurf or Claude rules |
| `agents.skills` | **Agent skills** — Repeatable task instructions (SKILL.md) for using the system and for maintaining it. | M | SKILL.md files (done at 2) |
| `agents.mcp` | **System MCP server** — The system runs its own MCP server, so any agent can query its components, tokens and docs live. | L | a package built on an MCP server SDK, or `profile.agent.mcpServer` |
| `agents.toolAccess` | **Connected tools** — Agents are set up to reach the design file, Storybook and docs (an MCP config in the repo). | M | an MCP config in the repo that names servers |
| `agents.guardRails` | **Guard rails** — Lint rules reject hard-coded values and raw elements where the system has a token or component, so off-system output fails fast. | M | token or raw-element lint rules, or the profile's element map |
| `agents.evals` | **Agent benchmarks** — Agents are given real tasks on a schedule and their output is scored for staying on-system. | M | an evals folder or agent benchmark, with the profile's readiness provider or bench runs |
| `agents.audience` | **Both audiences covered** — Agent files say whether they are for contributors (changing the system) or consumers (building with it), and both exist. | S | no — the team answers |
| `agents.genUi` | **Generative-UI catalog** — If agents render UI at run time, they pick from a closed catalog of blessed components with prop schemas. | L | no — the team answers |
| `agents.feedback` | **Gaps flow back** — When an agent finds no fitting component, it files a request instead of inventing one. | S | no — the team answers |

### Mobile

| Id | Item | Size | Measured by the scan |
|---|---|---|---|
| `mobile.native` | **Native components** — A native library for iOS, Android or a cross-platform framework. | L | no — the team answers |
| `mobile.platform` | **Platform conventions** — Design adapts to each platform's own guidelines. | M | no — the team answers |
