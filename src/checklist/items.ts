import path from "node:path";
import { norm, subjectOf, type Facts } from "./facts.js";

/**
 * The design-system health checklist. Twelve areas cover the whole system; the thirteenth, agent
 * readiness, goes deeper on what an AI agent needs to build with it. An item with `detect` is
 * measured by the scan; one without is answered by the team (see `dsa.checklist.json`). A detector
 * that can't measure in this repo (no consumer code, say) returns null and the item is left to the
 * team too.
 */
export type MeasuredStatus = "done" | "partial" | "missing";

export interface Detection {
  status: MeasuredStatus;
  /** What was found or counted, one short line each. */
  evidence: string[];
}

export type Size = "S" | "M" | "L";

export interface ChecklistItem {
  id: string;
  area: AreaId;
  title: string;
  /** One sentence on what done looks like. */
  about: string;
  /** Rough effort to get it done. */
  size: Size;
  detect?: (f: Facts) => Detection | null;
}

export const AREAS = [
  { id: "tokens", title: "Tokens" },
  { id: "icons", title: "Icons" },
  { id: "components", title: "Components" },
  { id: "patterns", title: "Patterns" },
  { id: "design-tool", title: "Design tool" },
  { id: "accessibility", title: "Accessibility" },
  { id: "communication", title: "Communication" },
  { id: "docs", title: "Docs" },
  { id: "testing", title: "Testing" },
  { id: "infrastructure", title: "Infrastructure" },
  { id: "usage", title: "Usage in product code" },
  { id: "agents", title: "Agent readiness" },
  { id: "mobile", title: "Mobile" },
] as const;

export type AreaId = (typeof AREAS)[number]["id"];

const MAX_EVIDENCE = 5;
const list = (files: string[]): string[] => (files.length > MAX_EVIDENCE ? [...files.slice(0, MAX_EVIDENCE), `…and ${files.length - MAX_EVIDENCE} more`] : files);
const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** done when found, missing otherwise; the evidence is what was found or what was looked for. */
function found(files: string[], lookedFor: string): Detection {
  return files.length ? { status: "done", evidence: list(files) } : { status: "missing", evidence: [`none found (looked for ${lookedFor})`] };
}

/** Grade a count or share against two bars. */
function grade(value: number, done: number, partial: number): MeasuredStatus {
  return value >= done ? "done" : value >= partial && value > 0 ? "partial" : "missing";
}

function components(f: Facts) {
  return f.reading.concepts.filter((c) => c.role === "component");
}

/** The repo holds the system's own source: folders were found, or tokens, or components declared somewhere (not only inferred from imports). */
function hasSystem(f: Facts): boolean {
  return f.reading.sources.length > 0 || f.reading.tokens.length > 0 || components(f).some((c) => c.realizations.some((r) => !r.evidence.file.startsWith("(")));
}

function tokensIn(f: Facts, group: string) {
  return f.reading.tokens.filter((t) => t.group === group);
}

function tokenGroup(group: string, doneAt: number): (f: Facts) => Detection {
  return (f) => {
    const n = tokensIn(f, group).length;
    return { status: grade(n, doneAt, 1), evidence: [`${n} ${group} token${n === 1 ? "" : "s"} read`] };
  };
}

function depsMatching(f: Facts, test: RegExp): string[] {
  return [...f.deps].filter((d) => test.test(d)).sort();
}

/** Share of the system's components that some file in `files` speaks for (by name). */
function coverage(f: Facts, files: string[], what: string): Detection | null {
  const comps = components(f);
  if (!comps.length || !hasSystem(f)) return null;
  const subjects = new Set(files.map(subjectOf));
  const covered = comps.filter((c) => subjects.has(c.key) || subjects.has(norm(c.name)));
  const share = covered.length / comps.length;
  const missing = comps.filter((c) => !covered.includes(c)).map((c) => c.name);
  return {
    status: grade(share, 0.8, 0.3),
    evidence: [`${covered.length} of ${comps.length} components have ${what} (${pct(share)})`, ...(missing.length && covered.length ? [`without: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", …" : ""}`] : [])],
  };
}

const STORY = /\.(stories|story)\.(tsx?|jsx?|mdx|svelte|vue)$/;
const DOC = /(^|\/)(docs?|documentation|content|site|website|guides?)\/.*\.(mdx?|markdoc)$|\.(mdx|docs\.json)$|(^|\/)(components?|packages|src)\/.*(readme|usage|docs?)\.mdx?$/i;
const TEST = /\.(test|spec)\.(tsx?|jsx?|mjs|cjs)$|(^|\/)__tests__\//;
const STYLE_OR_SOURCE = /\.(css|scss|sass|less|tsx?|jsx?|vue|svelte)$/;

function storyFiles(f: Facts): string[] {
  return f.find(STORY);
}

function docFiles(f: Facts): string[] {
  return f.find(DOC).filter((x) => !/(^|\/)(changelog|license)/i.test(x));
}

function systemFiles(f: Facts): string[] {
  const dirs = f.reading.sources.map((s) => s.replace(/\\/g, "/").replace(/\/$/, ""));
  if (!dirs.length || dirs.includes(".") || dirs.includes("")) return f.files;
  return f.files.filter((x) => dirs.some((d) => x === d || x.startsWith(d + "/")));
}

const KIND_FOUNDATION = ["button", "text-input", "checkbox", "select", "tooltip", "badge-or-tag", "alert", "card"];
const COMPLEX = /(table|grid|datepicker|calendar|combobox|autocomplete|tree|editor|chart|stepper|wizard|sortable|draggable|dropzone|upload|carousel|virtual)/;

const RULE_FILES = /(^|\/)(AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.cursorrules|\.windsurfrules|\.github\/copilot-instructions\.md)$|(^|\/)\.cursor\/rules\/.+|(^|\/)\.claude\/rules\/.+\.md$|\.instructions\.md$/;
const MCP_SDK = /^(@modelcontextprotocol\/(sdk|server)|fastmcp|mcp-framework|mcp-handler|@vercel\/mcp-adapter)$/;
const MCP_CONFIG = /(^|\/)(\.mcp\.json|\.vscode\/mcp\.json|\.cursor\/mcp\.json)$/;
const MANIFEST = /(^|\/)(custom-elements\.json|web-types\.json|registry\.json|registry-item\.json)$|(^|\/)manifests\/components\.json$|(^|\/)generated\/components\.json$/;

/** A detector about the system's own source: it can't measure in a repo that only consumes the system. */
function system(detect: (f: Facts) => Detection | null): (f: Facts) => Detection | null {
  return (f) => (hasSystem(f) ? detect(f) : null);
}

const SYSTEM_SIDE = new Set<AreaId>(["tokens", "icons", "components"]);

const ITEM_LIST: ChecklistItem[] = [
  // Tokens
  {
    id: "tokens.primitive", area: "tokens", size: "S", title: "Primitive tokens",
    about: "Raw values (color, spacing, type size, radius, shadow, z-index) are named tokens, not literals.",
    detect: (f) => {
      const n = f.reading.tokens.filter((t) => t.tier === "primitive").length;
      return { status: grade(n, 10, 1), evidence: [`${n} primitive tokens of ${f.reading.tokens.length} read`] };
    },
  },
  {
    id: "tokens.semantic", area: "tokens", size: "L", title: "Semantic tokens",
    about: "Tokens named for intent (surface, text-muted, danger) map onto primitives, so design and code share one vocabulary.",
    detect: (f) => {
      const all = f.reading.tokens.length;
      const n = f.reading.tokens.filter((t) => t.tier === "semantic").length;
      const share = all ? n / all : 0;
      return { status: n >= 10 && share >= 0.2 ? "done" : n > 0 ? "partial" : "missing", evidence: [`${n} semantic (alias) tokens, ${pct(share)} of all tokens`] };
    },
  },
  {
    id: "tokens.component", area: "tokens", size: "M", title: "Component tokens",
    about: "Components have their own tokens where semantic ones don't cover a decision.",
    detect: (f) => {
      const n = f.reading.tokens.filter((t) => t.tier === "component").length;
      return { status: grade(n, 5, 1), evidence: [`${n} component-level tokens`] };
    },
  },
  {
    id: "tokens.bound", area: "tokens", size: "M", title: "Components use tokens",
    about: "Components' own styles reference tokens instead of hard-coded values.",
    detect: (f) => {
      const comps = components(f);
      if (!comps.length || !f.reading.tokens.length) return null;
      const bound = comps.filter((c) => c.tokens?.length).length;
      return { status: grade(bound / comps.length, 0.6, 0.2), evidence: [`${bound} of ${comps.length} components reference tokens (${pct(bound / comps.length)})`] };
    },
  },
  {
    id: "tokens.themes", area: "tokens", size: "L", title: "Themes and modes",
    about: "Tokens switch for light/dark, high contrast, brand or density without touching components.",
    detect: (f) => {
      const withModes = f.reading.tokens.filter((t) => t.modes?.length);
      const modes = [...new Set(withModes.flatMap((t) => t.modes ?? []))];
      return { status: grade(withModes.length, 10, 1), evidence: [`${withModes.length} tokens set per mode${modes.length ? ` (${modes.slice(0, 6).join(", ")})` : ""}`] };
    },
  },
  { id: "tokens.color", area: "tokens", size: "L", title: "Color", about: "Color roles for surfaces, text and borders, built with contrast in mind.", detect: tokenGroup("color", 8) },
  { id: "tokens.typography", area: "tokens", size: "M", title: "Typography", about: "A type scale with line heights, weights and letter spacing for each text role.", detect: tokenGroup("typography", 4) },
  { id: "tokens.spacing", area: "tokens", size: "M", title: "Spacing", about: "A spacing scale used everywhere, with room for semantic and density steps.", detect: tokenGroup("spacing", 4) },
  { id: "tokens.motion", area: "tokens", size: "M", title: "Motion", about: "Standard durations and easing curves, so animation is consistent.", detect: tokenGroup("motion", 2) },
  { id: "tokens.elevation", area: "tokens", size: "M", title: "Elevation", about: "Shadow, layer and z-index tokens that define depth and stacking.", detect: tokenGroup("elevation", 2) },
  { id: "tokens.breakpoints", area: "tokens", size: "S", title: "Breakpoints", about: "A named list of breakpoints code and design both refer to.", detect: tokenGroup("breakpoints", 2) },

  // Icons
  {
    id: "icons.library", area: "icons", size: "M", title: "Icon library",
    about: "One searchable icon set that design and code both use.",
    detect: (f) => {
      const icons = f.reading.concepts.filter((c) => c.role === "icon").length;
      const svgs = f.find(/(^|\/)icons?\/.*\.svg$/i).length;
      const n = Math.max(icons, svgs);
      return { status: grade(n, 10, 1), evidence: [`${icons} icon components, ${svgs} SVG files in icon folders`] };
    },
  },
  {
    id: "icons.pipeline", area: "icons", size: "M", title: "Icon pipeline",
    about: "A defined path from the source of truth to optimized icons in code, by hand or automated.",
    detect: (f) => {
      const hits = [...depsMatching(f, /^(svgo|@svgr\/|svg-sprite|fantasticon|svgtofont|@iconify\/tools)/), ...f.find(/(^|\/)svgo\.config\.[cm]?[jt]s$/), ...f.packages.flatMap((p) => Object.keys(p.scripts).filter((s) => /icon/i.test(s)).map((s) => `${p.dir || "."}: script "${s}"`))];
      return found(hits, "svgo, svgr, an icon build script");
    },
  },
  { id: "icons.principles", area: "icons", size: "S", title: "Icon principles", about: "Guidelines for icon style, naming, and when and how to use them." },
  { id: "icons.illustrations", area: "icons", size: "M", title: "Illustrations", about: "An asset library and guidelines for spot illustrations." },

  // Components
  {
    id: "components.foundation", area: "components", size: "M", title: "Foundational components",
    about: "The everyday set (button, input, select, checkbox, tooltip, badge, alert, card) covers most needs.",
    detect: (f) => {
      const kinds = new Set(components(f).map((c) => c.kind?.kind).filter(Boolean));
      const have = KIND_FOUNDATION.filter((k) => kinds.has(k));
      const lacking = KIND_FOUNDATION.filter((k) => !kinds.has(k));
      return { status: grade(have.length, 6, 2), evidence: [`${have.length} of ${KIND_FOUNDATION.length} kinds recognized${have.length ? `: ${have.join(", ")}` : ""}`, ...(lacking.length ? [`not recognized: ${lacking.join(", ")}`] : [])] };
    },
  },
  {
    id: "components.complex", area: "components", size: "L", title: "Complex components",
    about: "Harder pieces (data table, date picker, combobox, tree, editor, chart, stepper) are in the system, not rebuilt per product.",
    detect: (f) => {
      const names = components(f).filter((c) => COMPLEX.test(c.key)).map((c) => c.name);
      return { status: grade(names.length, 4, 1), evidence: [names.length ? `${names.length}: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}` : "none recognized by name"] };
    },
  },
  {
    id: "components.api", area: "components", size: "M", title: "Shared API",
    about: "Props that mean the same thing are named the same (variant, size, onChange) across components and the design tool.",
    detect: (f) => {
      const comps = components(f);
      if (!comps.length) return null;
      const withAxes = comps.filter((c) => c.axes?.length);
      const byName = new Map<string, number>();
      for (const c of withAxes) for (const a of c.axes ?? []) byName.set(a.name, (byName.get(a.name) ?? 0) + 1);
      const shared = [...byName].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
      const share = withAxes.length / comps.length;
      return {
        status: share >= 0.4 && shared.length ? "done" : withAxes.length ? "partial" : "missing",
        evidence: [`${withAxes.length} of ${comps.length} components declare variant axes (${pct(share)})`, shared.length ? `shared across 3+ components: ${shared.slice(0, 6).map(([n, c]) => `${n} (${c})`).join(", ")}` : "no axis name shared by 3+ components"],
      };
    },
  },
  {
    id: "components.anatomy", area: "components", size: "M", title: "Named anatomy",
    about: "Compound components expose their parts (title, trigger, body) by name, so they are composed instead of re-built.",
    detect: (f) => {
      const comps = components(f);
      if (!comps.length) return null;
      const withParts = comps.filter((c) => c.parts?.length).length;
      return { status: grade(withParts, 5, 1), evidence: [`${withParts} components with named parts or slots`] };
    },
  },
  { id: "components.unique", area: "components", size: "L", title: "Product-specific components", about: "Components for the experiences that set your product apart are part of the system too." },
  { id: "components.portable", area: "components", size: "M", title: "Portable", about: "Components hold no business logic, so any product can use them." },
  { id: "components.modes", area: "components", size: "S", title: "Context modes", about: "Components respond to density, touch, and right-to-left." },

  // Patterns
  {
    id: "patterns.named", area: "patterns", size: "M", title: "Recurring compositions are named",
    about: "When the same arrangement of components keeps appearing, someone decides whether it becomes a pattern (`dsa patterns`).",
    detect: (f) => (f.patternDecisions ? { status: "done", evidence: [`pattern decisions kept in ${f.patternDecisions}`] } : null),
  },
  { id: "patterns.sections", area: "patterns", size: "S", title: "Page sections", about: "Larger pieces (a page header, a filtered table) built from tokens and components." },
  { id: "patterns.templates", area: "patterns", size: "M", title: "Templates", about: "Page-level layouts as a starting point for design and code." },
  { id: "patterns.forms", area: "patterns", size: "M", title: "Forms", about: "Guidance and examples for simple to complex form layouts, with do's and don'ts." },
  { id: "patterns.feedback", area: "patterns", size: "S", title: "Notifications", about: "Rules for transient feedback: placement, stacking and timing." },
  { id: "patterns.more", area: "patterns", size: "S", title: "More patterns", about: "Onboarding, multi-step flows, navigation, search and filtering." },

  // Design tool
  { id: "design.library", area: "design-tool", size: "L", title: "Published library", about: "One published, versioned design library that designers actually use." },
  {
    id: "design.codeLinks", area: "design-tool", size: "M", title: "Design linked to code",
    about: "Design components map to code imports and snippets (for example Code Connect), so both sides show the same thing.",
    detect: (f) => found([...f.find(/\.figma\.(tsx?|jsx?)$|(^|\/)figma\.config\.json$/), ...depsMatching(f, /^@figma\/code-connect$/)], "Code Connect files or config"),
  },
  {
    id: "design.docLinks", area: "design-tool", size: "S", title: "Docs link to the design file",
    about: "Stories or docs pages link to the matching design component.",
    detect: (f) => {
      const files = [...storyFiles(f), ...docFiles(f)];
      if (!files.length) return null;
      return found(f.grep(files.filter((x) => !/(^|\/)(blog|changelog|news)\//i.test(x)), /https:\/\/(www\.)?figma\.com\/(file|design)\//, 600), "design-file links in stories and docs");
    },
  },
  { id: "design.parity", area: "design-tool", size: "M", title: "Code parity", about: "Variant and property names in the design tool mirror the code API." },
  { id: "design.variables", area: "design-tool", size: "M", title: "Design variables", about: "Primitive, semantic and component tokens are published as variables and used by components." },
  { id: "design.current", area: "design-tool", size: "S", title: "Current with the tool", about: "The library keeps up with the design tool's new features (slots, modes, layout)." },

  // Accessibility
  {
    id: "a11y.policy", area: "accessibility", size: "S", title: "Written policy",
    about: "A written standard for what accessible means here and who is responsible.",
    detect: (f) => found(f.find(/(^|\/)[^/]*(accessibility|a11y)[^/]*\.mdx?$/i), "an accessibility doc"),
  },
  {
    id: "a11y.automated", area: "accessibility", size: "M", title: "Automated checks",
    about: "Accessibility rules run in tests or stories, not only in lint.",
    detect: (f) => {
      const tests = depsMatching(f, /^(axe-core|@axe-core\/.+|jest-axe|vitest-axe|@storybook\/addon-a11y|pa11y.*|cypress-axe|@chialab\/wtr-axe)$/);
      const lint = depsMatching(f, /^(eslint-plugin-jsx-a11y|eslint-plugin-vuejs-accessibility|eslint-plugin-svelte|eslint-plugin-lit-a11y|@angular-eslint\/template-plugin)$/);
      if (tests.length) return { status: "done", evidence: tests };
      if (lint.length) return { status: "partial", evidence: [`lint only: ${lint.join(", ")}`] };
      return { status: "missing", evidence: ["no axe, a11y addon or a11y lint plugin among dependencies"] };
    },
  },
  {
    id: "a11y.reducedMotion", area: "accessibility", size: "M", title: "Reduced motion",
    about: "Components respect the user's reduced-motion setting.",
    detect: (f) => {
      const hits = f.grep(systemFiles(f).filter((x) => STYLE_OR_SOURCE.test(x)), /prefers-reduced-motion/, 3000);
      return found(hits, "prefers-reduced-motion in the system's styles and source");
    },
  },
  { id: "a11y.contrast", area: "accessibility", size: "M", title: "Color contrast", about: "Color tokens are built for predictable contrast, and pairs are checked against WCAG or APCA." },
  { id: "a11y.keyboard", area: "accessibility", size: "M", title: "Keyboard and structure", about: "Components and templates work by keyboard, with landmarks, roles and a sound heading order." },
  { id: "a11y.iconLabels", area: "accessibility", size: "S", title: "Icon labels", about: "Icon-only controls carry accessible names." },
  { id: "a11y.i18n", area: "accessibility", size: "M", title: "Internationalization", about: "Components handle long strings, language switching and right-to-left layout." },
  { id: "a11y.screenReaders", area: "accessibility", size: "M", title: "Screen-reader testing", about: "The team tests by hand with real assistive technology." },

  // Communication
  {
    id: "comms.owner", area: "communication", size: "M", title: "Point of contact",
    about: "A named team or person owns issues, education, the roadmap and requests.",
    detect: (f) => found(f.find(/(^|\/)CODEOWNERS$/), "a CODEOWNERS file"),
  },
  {
    id: "comms.changelog", area: "communication", size: "S", title: "Changelog",
    about: "Releases come with a versioned changelog that consumers are told about.",
    detect: (f) => found([...f.find(/(^|\/)CHANGELOG\.mdx?$/i), ...f.find(/(^|\/)\.changeset\/config\.json$/)], "CHANGELOG.md or changesets"),
  },
  {
    id: "comms.decisions", area: "communication", size: "S", title: "Decision log",
    about: "A written record of why a token, component or design decision was made.",
    detect: (f) => {
      const hits = f.find(/(^|\/)(adrs?|decisions?|decision-records?|rfcs?)\/[^/]+\.mdx?$/i);
      return found(hits.length ? [`${hits.length} records, e.g. ${hits[0]}`] : [], "an adr, decisions or rfcs folder");
    },
  },
  {
    id: "comms.intake", area: "communication", size: "M", title: "Request intake",
    about: "Anyone can file a bug or a component request through a template, and the backlog is visible.",
    detect: (f) => {
      const t = f.find(/(^|\/)\.github\/ISSUE_TEMPLATE\/.+|(^|\/)\.gitlab\/issue_templates\/.+/);
      return { status: t.length >= 2 ? "done" : t.length ? "partial" : "missing", evidence: t.length ? list(t) : ["no issue templates"] };
    },
  },
  {
    id: "comms.adoption", area: "communication", size: "M", title: "Adoption measurement",
    about: "Real component usage is measured over time, not guessed.",
    detect: (f) => {
      if (f.baseline) return { status: "done", evidence: ["dsa ratchet baseline is kept"] };
      return { status: "partial", evidence: ["measured once by this run; keep a ratchet baseline or run history to track it"] };
    },
  },
  { id: "comms.support", area: "communication", size: "S", title: "Support channel", about: "A place where anyone can ask a question and get an answer." },
  { id: "comms.officeHours", area: "communication", size: "S", title: "Office hours", about: "A recurring time for questions, feedback and training." },

  // Docs
  {
    id: "docs.start", area: "docs", size: "M", title: "Getting started",
    about: "A clear path to install, import and use the system the first time.",
    detect: (f) => {
      const readmes = f.find(/(^|\/)README\.mdx?$/i).filter((x) => x.split("/").length <= 3);
      return found(f.grep(readmes, /\b(npm (i|install)|pnpm add|yarn add|bun add|npx |install)\b/i, 50), "install steps in a README");
    },
  },
  {
    id: "docs.site", area: "docs", size: "L", title: "Docs site",
    about: "A browsable docs site or Storybook that shows every component.",
    detect: (f) => found([
      ...f.find(/(^|\/)\.storybook\/main\.[cm]?[jt]s$|(^|\/)(docusaurus|vitepress|astro|nextra|vuepress|histoire|ladle)\.config\.[cm]?[jt]s$|(^|\/)\.vitepress\/config\.[cm]?[jt]s$|(^|\/)mkdocs\.ya?ml$|(^|\/)\.?eleventy(\.config)?\.[cm]?js$/),
      ...f.packages.filter((p) => /(^|\/)(docs|website|site|documentation)$/.test(p.dir)).map((p) => `docs app: ${p.dir}/`),
    ], "Storybook, a docs-site config or a docs app"),
  },
  { id: "docs.components", area: "docs", size: "L", title: "Component docs", about: "Every component has a docs page.", detect: (f) => coverage(f, docFiles(f), "a docs page") },
  { id: "docs.examples", area: "docs", size: "M", title: "Live examples", about: "Every component has stories or live examples.", detect: (f) => coverage(f, storyFiles(f), "stories") },
  {
    id: "docs.contributing", area: "docs", size: "S", title: "Contribution guide",
    about: "How to propose, build and review a change to the system.",
    detect: (f) => found(f.find(/(^|\/)CONTRIBUTING\.mdx?$/i), "CONTRIBUTING.md"),
  },

  // Testing
  { id: "testing.unit", area: "testing", size: "M", title: "Component tests", about: "Every component has tests.", detect: (f) => coverage(f, f.find(TEST), "a test file") },
  {
    id: "testing.visual", area: "testing", size: "M", title: "Visual regression",
    about: "Screenshots catch unintended visual changes before release.",
    detect: (f) => found(depsMatching(f, /^(chromatic|@chromatic-com\/.+|@percy\/.+|loki|backstopjs|reg-suit|@storybook\/test-runner|storycap|lost-pixel|@argos-ci\/.+)$/), "chromatic, percy, loki, backstop, argos or a story test runner"),
  },
  {
    id: "testing.ci", area: "testing", size: "S", title: "Continuous integration",
    about: "Tests and checks run on every change.",
    detect: (f) => found(f.find(/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)azure-pipelines\.ya?ml$|(^|\/)\.circleci\/config\.ya?ml$|(^|\/)Jenkinsfile$|(^|\/)bitbucket-pipelines\.ya?ml$/), "a CI workflow"),
  },

  // Infrastructure
  {
    id: "infra.published", area: "infrastructure", size: "M", title: "Published packages",
    about: "The system ships as versioned packages consumers install.",
    detect: (f) => {
      const own = new Set(f.config.system.packages ?? []);
      const pub = f.packages.filter((p) => p.name && p.version && !p.private).sort((a, b) => Number(own.has(b.name!)) - Number(own.has(a.name!)));
      return found(pub.map((p) => `${p.name}@${p.version}`), "a public package with a version");
    },
  },
  {
    id: "infra.release", area: "infrastructure", size: "M", title: "Release automation",
    about: "Versions, changelogs and publishing happen by a tool, not by hand.",
    detect: (f) => found([...depsMatching(f, /^(@changesets\/cli|semantic-release|release-it|lerna|@nx\/js|standard-version|release-please)$/), ...f.find(/(^|\/)\.release-please-manifest\.json$/)], "changesets, semantic-release, release-please or similar"),
  },
  {
    id: "infra.types", area: "infrastructure", size: "S", title: "Typed component API",
    about: "Components ship types, so wrong props fail at build time, for people and agents alike.",
    detect: (f) => {
      if (!hasSystem(f)) return null;
      const src = systemFiles(f).filter((x) => /\.(tsx?|jsx?|vue|svelte)$/.test(x) && !/\.d\.ts$/.test(x));
      if (!src.length) return null;
      const typed = src.filter((x) => /\.tsx?$/.test(x) || (/\.(vue|svelte)$/.test(x) && /lang=["']ts["']/.test(f.read(x)))).length;
      return { status: grade(typed / src.length, 0.8, 0.2), evidence: [`${typed} of ${src.length} system source files are TypeScript (${pct(typed / src.length)})`] };
    },
  },

  // Usage in product code (measured from the scan)
  {
    id: "usage.adoption", area: "usage", size: "L", title: "Adoption",
    about: "Product code builds with the system's components rather than local ones.",
    detect: (f) => {
      const t = f.adoption?.adoption.total;
      if (!t || t.ds + t.local === 0) return null;
      const share = t.ds / (t.ds + t.local);
      return { status: grade(share, 0.8, 0.5), evidence: [`${t.ds} system and ${t.local} local component instances in ${f.adoption!.files.length} files: ${pct(share)} from the system`] };
    },
  },
  {
    id: "usage.correctUse", area: "usage", size: "M", title: "Correct use",
    about: "System components are used as designed: few style overrides, spread props, look-alikes or raw controls.",
    detect: (f) => {
      const a = f.adoption;
      if (!a || a.adoption.total.ds === 0) return null;
      const c = a.correctUse.counts;
      const v = c.classNameOverrides + c.styleOverrides + c.spreadProps + c.lookAlikes + c.rawElements;
      const rate = v / a.adoption.total.ds;
      return { status: rate <= 0.05 ? "done" : rate <= 0.2 ? "partial" : "missing", evidence: [`${v} correct-use findings per ${a.adoption.total.ds} system instances (${pct(rate)})`, `overrides ${c.classNameOverrides + c.styleOverrides}, spread props ${c.spreadProps}, look-alikes ${c.lookAlikes}, raw controls ${c.rawElements}`] };
    },
  },
  {
    id: "usage.ratchet", area: "usage", size: "S", title: "Ratchet in CI",
    about: "Correct-use findings can't grow: a baseline is kept and checked on every change (`dsa ratchet`).",
    detect: (f) => {
      const workflows = f.find(/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)azure-pipelines\.ya?ml$/);
      const ci = f.grep(workflows, /\bdsa\s+(ratchet|run)\b/);
      if (f.baseline && ci.length) return { status: "done", evidence: ["baseline kept", ...list(ci)] };
      if (f.baseline || ci.length) return { status: "partial", evidence: [f.baseline ? "baseline kept, but no CI workflow runs dsa" : `CI runs dsa (${ci[0]}), but no baseline file`] };
      return { status: "missing", evidence: ["no ratchet baseline; run dsa ratchet --init"] };
    },
  },

  // Agent readiness
  {
    id: "agents.manifest", area: "agents", size: "M", title: "Component manifest",
    about: "A generated, machine-readable index of components (import, props, description, examples) an agent can load.",
    detect: (f) => {
      // Per-component records (`button.docs.json`) count when they speak for real components, not for a locale.
      const keys = new Set(components(f).flatMap((c) => [c.key, norm(c.name)]));
      const records = f.find(/\.docs\.json$/).filter((x) => keys.has(subjectOf(x)));
      const files = [...f.find(MANIFEST), ...(records.length >= 3 ? [`${records.length} per-component .docs.json records`] : [])];
      const fromManifest = components(f).filter((c) => c.realizations.some((r) => r.evidence.tier === "manifest")).length;
      if (files.length || fromManifest) return { status: "done", evidence: [...list(files), ...(fromManifest ? [`${fromManifest} components read from a manifest`] : [])] };
      const n = components(f).length;
      return n ? { status: "partial", evidence: [`dsa read ${n} components from source, but there is no generated index agents can load`] } : { status: "missing", evidence: ["no components and no manifest found"] };
    },
  },
  {
    id: "agents.tokenFile", area: "agents", size: "S", title: "Tokens as data",
    about: "Tokens are published in a machine format (DTCG JSON or DESIGN.md front matter), the closed set of legal values.",
    detect: (f) => {
      const json = f.grep(f.find(/\.json$/).filter((x) => /tokens?|design/i.test(x)), /"\$value"\s*:/, 300);
      const designMd = f.grep(f.find(/(^|\/)DESIGN\.md$/), /^---\s*\n[\s\S]*?\n---/);
      if (json.length || designMd.length) return { status: "done", evidence: list([...json, ...designMd]) };
      return f.reading.tokens.length ? { status: "partial", evidence: [`${f.reading.tokens.length} tokens, but only in CSS or Sass`] } : { status: "missing", evidence: ["no tokens found"] };
    },
  },
  {
    id: "agents.llms", area: "agents", size: "S", title: "llms.txt and Markdown docs",
    about: "The docs site publishes llms.txt (and ideally a full-text and per-page Markdown copy) for agents.",
    detect: (f) => found([...new Set(f.find(/(^|\/)llms(-full|-ctx(-full)?)?\.txt(\.[cm]?[jt]s)?$|(^|\/)[^/]*(build|generate)-?llms[^/]*(\/|\.[cm]?[jt]s$)/i).map((x) => x.replace(/^(.*(build|generate)-?llms[^/]*)\/.*$/i, "$1/")))], "llms.txt or its generator"),
  },
  {
    id: "agents.guidance", area: "agents", size: "M", title: "Usage guidance as text",
    about: "Docs say when to use a component, when not to, and what to use instead, not just its props.",
    detect: (f) => {
      const docs = docFiles(f).filter((x) => /\.(mdx?|markdoc)$/.test(x));
      if (!docs.length) return { status: "missing", evidence: ["no Markdown docs"] };
      const hits = f.grep(docs, /when (not )?to use|do'?s and don'?ts|\bdon'?t\b|\bavoid\b|best practices|usage guidelines|\balternatives?\b/i, 800);
      const subjects = new Set(hits.map(subjectOf));
      const comps = components(f);
      const covered = comps.filter((c) => subjects.has(c.key) || subjects.has(norm(c.name))).length;
      if (!comps.length) return { status: hits.length ? "partial" : "missing", evidence: [`${hits.length} docs pages carry usage guidance`] };
      return { status: grade(covered / comps.length, 0.5, 0.1), evidence: [`${covered} of ${comps.length} components have usage guidance in their docs (${pct(covered / comps.length)})`] };
    },
  },
  {
    id: "agents.rules", area: "agents", size: "M", title: "Agent rules",
    about: "Instruction files (AGENTS.md, editor rules) tell agents how to build with the system, and how to change it.",
    detect: (f) => {
      const files = f.find(RULE_FILES);
      const hasAgents = files.some((x) => /(^|\/)AGENTS\.md$/.test(x));
      return { status: hasAgents || files.length >= 2 ? "done" : files.length ? "partial" : "missing", evidence: files.length ? list(files) : ["no AGENTS.md, CLAUDE.md, Cursor, Copilot or Windsurf rules"] };
    },
  },
  {
    id: "agents.skills", area: "agents", size: "M", title: "Agent skills",
    about: "Repeatable task instructions (SKILL.md) for using the system and for maintaining it.",
    detect: (f) => {
      const skills = f.find(/(^|\/)SKILL\.md$/);
      return { status: grade(skills.length, 2, 1), evidence: skills.length ? list(skills.map((s) => path.posix.dirname(s))) : ["no SKILL.md files"] };
    },
  },
  {
    id: "agents.mcp", area: "agents", size: "L", title: "System MCP server",
    about: "The system runs its own MCP server, so any agent can query its components, tokens and docs live.",
    detect: (f) => {
      const pkgs = f.packages.filter((p) => p.deps.some((d) => MCP_SDK.test(d))).map((p) => p.name ?? (p.dir || "."));
      const fromProfile = f.profile.agent?.mcpServer ? [`the profile names an MCP server (${f.profile.name})`] : [];
      return found([...pkgs, ...fromProfile], "a package built on an MCP server SDK, or profile.agent.mcpServer");
    },
  },
  {
    id: "agents.toolAccess", area: "agents", size: "M", title: "Connected tools",
    about: "Agents are set up to reach the design file, Storybook and docs (an MCP config in the repo).",
    detect: (f) => {
      const configs = f.find(MCP_CONFIG);
      const servers = configs.flatMap((c) => {
        try {
          const j = JSON.parse(f.read(c)) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> };
          return Object.keys(j.mcpServers ?? j.servers ?? {});
        } catch {
          return [];
        }
      });
      return configs.length ? { status: servers.length ? "done" : "partial", evidence: [...list(configs), ...(servers.length ? [`servers: ${servers.join(", ")}`] : [])] } : { status: "missing", evidence: ["no .mcp.json, .vscode/mcp.json or .cursor/mcp.json"] };
    },
  },
  {
    id: "agents.guardRails", area: "agents", size: "M", title: "Guard rails",
    about: "Lint rules reject hard-coded values and raw elements where the system has a token or component, so off-system output fails fast.",
    detect: (f) => {
      const deps = depsMatching(f, /^(stylelint-declaration-strict-value|@stylistic\/stylelint-plugin|eslint-plugin-no-hardcoded.*|.*design-tokens?-lint.*|eslint-plugin-.*(design|tokens?).*)$/);
      const local = f.find(/(^|\/)(eslint|stylelint|lint)[^/]*\/.*(token|raw-element|hard-?coded|no-restricted)[^/]*\.[cm]?[jt]s$/i);
      const map = f.profile.files.elementMap ? [`element map: ${f.profile.files.elementMap}`] : [];
      return found([...deps, ...local, ...map], "token or raw-element lint rules");
    },
  },
  {
    id: "agents.evals", area: "agents", size: "M", title: "Agent benchmarks",
    about: "Agents are given real tasks on a schedule and their output is scored for staying on-system.",
    detect: (f) => {
      // An eval folder, or a benchmark that is about agents (a performance benchmark is not).
      const evals = f.find(/(^|\/)evals?\/[^/]+\.(json|ya?ml|[cm]?[jt]s|md)$|(^|\/)evals?\.json$/i);
      const bench = f.grep(f.find(/(^|\/)(benchmarks?|bench)\/[^/]+\.(json|ya?ml|[cm]?[jt]s|md)$/i), /\b(agent|prompt|llm|claude|gpt|model output)\b/i, 100);
      const files = [...evals, ...bench];
      const provider = f.profile.readiness ? [`readiness provider: ${f.profile.readiness.id}${f.profile.readiness.benchRuns ? " (with bench runs)" : ""}`] : [];
      if (files.length && (provider.length || f.profile.readiness?.benchRuns)) return { status: "done", evidence: [...list(files), ...provider] };
      if (files.length || provider.length) return { status: f.profile.readiness?.benchRuns ? "done" : "partial", evidence: [...list(files), ...provider] };
      return { status: "missing", evidence: ["no evals or bench folder, and no readiness provider in the profile"] };
    },
  },
  { id: "agents.audience", area: "agents", size: "S", title: "Both audiences covered", about: "Agent files say whether they are for contributors (changing the system) or consumers (building with it), and both exist." },
  { id: "agents.genUi", area: "agents", size: "L", title: "Generative-UI catalog", about: "If agents render UI at run time, they pick from a closed catalog of blessed components with prop schemas." },
  { id: "agents.feedback", area: "agents", size: "S", title: "Gaps flow back", about: "When an agent finds no fitting component, it files a request instead of inventing one." },

  // Mobile
  { id: "mobile.native", area: "mobile", size: "L", title: "Native components", about: "A native library for iOS, Android or a cross-platform framework." },
  { id: "mobile.platform", area: "mobile", size: "M", title: "Platform conventions", about: "Design adapts to each platform's own guidelines." },
];

/** Agent items that read the system's own source too. */
const SYSTEM_ITEMS = new Set(["agents.manifest", "agents.tokenFile", "agents.guidance"]);

export const ITEMS: ChecklistItem[] = ITEM_LIST.map((i) => (i.detect && ((SYSTEM_SIDE.has(i.area) && i.id !== "icons.pipeline") || SYSTEM_ITEMS.has(i.id)) ? { ...i, detect: system(i.detect) } : i));
